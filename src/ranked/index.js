/**
 * The ranked service: the core of docs/ranked.md, wired together.
 *
 * It knows no client. Adapters reach it through three ports:
 *
 *   entry   — join, leave, ready: who is waiting, and who can start now;
 *   notices — onNotice: what happened, for whatever tells the player;
 *   start   — the `start` function it is given, which gets both players of a
 *             race into it. Whatever started them reports back through
 *             `runEvent`: started, progress, finished, left, dropped, failed.
 *
 * Everything is decided against `clock()`, so a test turns time by hand.
 */
import { randomUUID } from "node:crypto";
import { createQueue } from "./queue.js";
import { createRace } from "./race.js";
import { byStanding, displayRating, newPlayer, rateMatch, ratingRules, replayRatings } from "./rating.js";
import { info, warn } from "../log.js";

const RUN_LOSSES = new Set(["left", "dropped", "failed"]);

class RankedService {
  constructor({ records, picker, rules, rating, clock = Date.now, start, queue = createQueue(), newId = randomUUID }) {
    this.records = records;
    /** The rating scale: where everybody starts, the most a race moves, the floor (rating.js). */
    this.rating = ratingRules(rating);
    this.picker = picker;
    this.rules = rules;
    this.clock = clock;
    this.startRace = start;
    this.queue = queue;
    this.newId = newId;
    this.ratings = new Map();
    this.listeners = new Set();
    /** race id -> { race, countdownUntil, queuedAt: Map(accountId -> joinedAt) } */
    this.races = new Map();
    /** accountId -> race id */
    this.raceOf = new Map();
    /**
     * Decided matches the log refused (storage down, disk full), oldest first.
     * Their ratings have already moved here; written later, in order, so the log
     * — which the board on the website and the next start replay — catches up.
     */
    this.unwritten = [];
    this.writing = false;
  }

  /** Ratings from the log. Called once, before the service takes anybody. */
  async load() {
    this.ratings = replayRatings(await this.records.all(), this.rating);
  }

  onNotice(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  tell(accountId, notice) {
    for (const listener of this.listeners) {
      try {
        listener(accountId, notice);
      } catch (problem) {
        warn(`ranked: a notice listener failed: ${problem.stack ?? problem}`);
      }
    }
  }

  ratingOf(accountId) {
    return this.ratings.get(accountId) ?? { ...newPlayer(this.rating), games: 0 };
  }

  // --- Entry port ---------------------------------------------------------------

  join(accountId) {
    if (this.raceOf.has(accountId)) return { ok: false, reason: "in_race" };
    const answer = this.queue.join({ accountId, rating: this.ratingOf(accountId).rating, at: this.clock() });
    if (answer.ok) this.tell(accountId, { type: "queued", ...this.queue.counts() });
    return answer.ok ? { ok: true } : { ok: false, reason: answer.reason, until: answer.until };
  }

  leave(accountId) {
    return this.queue.leave(accountId);
  }

  /** The adapter says whether this player could start a race right now. */
  ready(accountId, yes) {
    return this.queue.setReady(accountId, yes);
  }

  statusOf(accountId) {
    const rating = displayRating(this.ratingOf(accountId));
    const raceId = this.raceOf.get(accountId);
    if (raceId) {
      const { race } = this.races.get(raceId);
      return { state: "in_race", race: race.id, raceState: race.state, opponent: race.opponentOf(accountId), rating };
    }
    if (this.queue.entry(accountId)) return { state: "queued", ...this.queue.counts(), rating };
    return { state: "idle", rating };
  }

  /** Everybody who has played, best first. */
  board() {
    return [...this.ratings.entries()]
      .filter(([, rating]) => rating.games > 0)
      .map(([accountId, rating]) => ({ accountId, games: rating.games, ...displayRating(rating) }))
      .sort(byStanding);
  }

  // --- Time ---------------------------------------------------------------------

  /** Pair whoever can be paired, start whatever has counted down, decide what time decides. */
  async tick() {
    const now = this.clock();
    for (const [first, second] of this.queue.pairUp(now)) this.pair(first, second, now);

    for (const entry of [...this.races.values()]) {
      const { race } = entry;
      if (race.state === "paired" && now >= entry.countdownUntil) await this.begin(entry, now);
      else race.tick(now);
      await this.settle(entry);
    }
    await this.writeHeld();
  }

  pair(first, second, at) {
    const spec = this.picker();
    const race = createRace({
      id: this.newId(),
      spec,
      players: [first.accountId, second.accountId],
      rules: this.rules,
      at,
    });
    const entry = {
      race,
      countdownUntil: at + this.rules.countdownMs,
      queuedAt: new Map([[first.accountId, first.joinedAt], [second.accountId, second.joinedAt]]),
    };
    this.races.set(race.id, entry);
    this.raceOf.set(first.accountId, race.id);
    this.raceOf.set(second.accountId, race.id);
    this.queue.rememberOpponents(first.accountId, second.accountId);
    info(`ranked: race ${race.id} — ${first.accountId} v ${second.accountId} on node ${spec.mapNodeId} seed ${spec.seed}`);

    const countdownSeconds = Math.round(this.rules.countdownMs / 1000);
    for (const [me, them] of [[first, second], [second, first]]) {
      this.tell(me.accountId, {
        type: "paired",
        race: race.id,
        opponent: them.accountId,
        opponentRating: displayRating(this.ratingOf(them.accountId)),
        countdownSeconds,
      });
    }
  }

  async begin(entry, at) {
    const { race } = entry;
    race.loading(at);
    try {
      await this.startRace(race);
    } catch (problem) {
      warn(`ranked: race ${race.id} could not be started: ${problem.message}`);
      race.voided(this.clock(), "start_failed");
    }
  }

  // --- Run events (from whatever started the race) ------------------------------

  /**
   * started | progress | finished | left | dropped | failed. Returns the
   * write of the record when the event decided the race.
   */
  runEvent(accountId, type, detail) {
    const raceId = this.raceOf.get(accountId);
    const entry = raceId && this.races.get(raceId);
    if (!entry) return Promise.resolve();
    const { race } = entry;
    const at = this.clock();

    if (type === "started") {
      race.started(accountId, at);
      if (race.state === "running") for (const id of race.ids) this.tell(id, { type: "started", race: race.id });
    } else if (type === "progress") {
      race.note(accountId, "progress", detail, at);
      this.tell(race.opponentOf(accountId), { type: "progress", race: race.id, ...detail });
    } else if (type === "finished") {
      race.finished(accountId, at);
    } else if (type === "draw") {
      // Offered: the rival is asked; agreed by both: the race ends void (settle).
      if (!race.offerDraw(accountId, at)) {
        this.tell(race.opponentOf(accountId), { type: "draw_offered", race: race.id });
      }
    } else if (RUN_LOSSES.has(type)) {
      race.lost(accountId, at, type);
    } else {
      warn(`ranked: unknown run event ${type} for ${accountId}`);
      return Promise.resolve();
    }
    return this.settle(entry);
  }

  // --- Results ------------------------------------------------------------------

  /**
   * A decided race: ratings, penalties and notices at once, so players hear the
   * result the moment it is certain; the returned promise is the record being
   * written, which nothing has to wait for.
   */
  settle(entry) {
    const { race } = entry;
    if (!race.decided || entry.settled) return Promise.resolve();
    entry.settled = true;
    this.races.delete(race.id);
    for (const id of race.ids) this.raceOf.delete(id);

    const result = race.result;
    const [first, second] = race.ids;
    const before = { [first]: this.ratingOf(first), [second]: this.ratingOf(second) };
    // Where both stood on the board, before and after: the top league is a share of it (leagues.js).
    const placesBefore = this.placesOf(race.ids);
    let after = null;
    if (result.state === "finished") {
      const score = result.winner == null ? 0.5 : result.winner === first ? 1 : 0;
      const rated = rateMatch(before[first], before[second], score, this.rating);
      after = {
        [first]: { ...rated.first, games: before[first].games + 1 },
        [second]: { ...rated.second, games: before[second].games + 1 },
      };
      this.ratings.set(first, after[first]);
      this.ratings.set(second, after[second]);
    }

    this.penalties(race);
    this.announce(race, entry, before, after, { before: placesBefore, after: this.placesOf(race.ids) });
    return this.keep(this.recordOf(race, before, after));
  }

  /** Writes a decided match, or holds it for the next try; true once it is in the log. */
  async keep(record) {
    // Behind others still waiting: in order, or the log would replay them out of it.
    if (this.unwritten.length) {
      this.unwritten.push(record);
      return false;
    }
    if (await this.records.append(record)) return true;
    this.unwritten.push(record);
    warn(`ranked: match ${record.id} is held until the log takes it (${this.unwritten.length} waiting)`);
    return false;
  }

  /** The held matches, oldest first, for as long as the log takes them. */
  async writeHeld() {
    if (this.writing || !this.unwritten.length) return;
    this.writing = true;
    try {
      while (this.unwritten.length) {
        if (!(await this.records.append(this.unwritten[0]))) return;
        const written = this.unwritten.shift();
        info(`ranked: match ${written.id} written late (${this.unwritten.length} still waiting)`);
      }
    } finally {
      this.writing = false;
    }
  }

  /** `{ [accountId]: { place, of } }` on the board as it stands; no place for somebody not on it. */
  placesOf(ids) {
    const board = this.board();
    return Object.fromEntries(
      ids.map((id) => {
        const index = board.findIndex((row) => Number(row.accountId) === Number(id));
        return [id, { place: index >= 0 ? index + 1 : null, of: board.length }];
      })
    );
  }

  recordOf(race, before, after) {
    const { state, winner, reason, blame, forfeit, at } = race.result;
    return {
      id: race.id,
      state,
      players: race.ids,
      winner: winner ?? null,
      reason,
      ...(blame == null ? {} : { blame }),
      ...(forfeit == null ? {} : { forfeit }),
      spec: { mapNodeId: race.spec.mapNodeId, seed: race.spec.seed, rules: { ...race.spec.rules } },
      pairedAt: race.pairedAt,
      decidedAt: at,
      ratings: Object.fromEntries(
        race.ids.map((id) => [id, { before: displayRating(before[id]), after: after ? displayRating(after[id]) : null }])
      ),
      players_detail: Object.fromEntries(race.ids.map((id) => [id, { ...race.players.get(id) }])),
      timeline: race.timeline,
    };
  }

  penalties(race) {
    const { state, blame, forfeit } = race.result;
    const at = this.clock();
    if (state === "cancelled" && blame != null) this.queue.penalise(blame, at);
    if (forfeit != null) this.queue.penalise(forfeit, at);
    if (state === "finished") for (const id of race.ids) if (id !== forfeit) this.queue.forgive(id);
  }

  announce(race, entry, before, after, places) {
    const { state, winner, reason, blame, forfeit } = race.result;
    for (const id of race.ids) {
      if (state === "finished") {
        this.tell(id, {
          type: "finished",
          race: race.id,
          result: winner == null ? "draw" : winner === id ? "win" : "loss",
          reason,
          forfeit: forfeit === id,
          rating: displayRating(after[id]),
          ratingChange: Math.round(after[id].rating - before[id].rating),
          ...places.after[id],
          was: places.before[id],
          // Each from that racer's own start, as the race measured them; null for one who did not finish.
          times: {
            own: race.players.get(id).elapsedMs ?? null,
            rival: race.players.get(race.opponentOf(id)).elapsedMs ?? null,
          },
        });
        continue;
      }
      // Cancelled before anybody raced: whoever was not to blame goes back in
      // line where they were, as long as they had not started loading yet.
      const requeued = state === "cancelled" && id !== blame && race.timeline.every((e) => e.type !== "loading");
      // Back in line where they were — and unready, as any entry starts: whether
      // they can start now is the adapter's to say again, since it alone knows
      // whether they went idle, or are between floors, while the countdown ran.
      if (requeued) this.queue.join({ accountId: id, rating: this.ratingOf(id).rating, at: entry.queuedAt.get(id) });
      this.tell(id, { type: "cancelled", race: race.id, reason, requeued });
    }
  }

  /** The server is going away: races still under way end, and count for nobody. */
  async stop() {
    for (const entry of [...this.races.values()]) {
      entry.race.voided(this.clock(), "server_stopped");
      await this.settle(entry);
    }
    // A last try for what the log refused: what is still held now is lost with the process.
    await this.writeHeld();
    if (this.unwritten.length) {
      warn(`ranked: ${this.unwritten.length} decided match(es) never reached the log: ${this.unwritten.map((r) => r.id).join(", ")}`);
    }
  }
}

export const createRankedService = (options) => new RankedService(options);
