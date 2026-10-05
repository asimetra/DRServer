/**
 * One ranked pairing, from the match to its result.
 *
 * Every outcome rule in docs/ranked.md ("Outcomes") is decided here and
 * nowhere else. The race knows two players, a spec and a clock it is handed;
 * it knows nothing of sockets, floors or clients, so the same rules hold
 * whichever adapter started it.
 *
 *   paired ─▶ loading ─▶ running ─▶ finished
 *      └──────────┴─────────┴──▶ cancelled / void
 *
 * Each player's clock starts when their own floor is ready (`started`), not
 * when the race was asked to begin: a client that takes longer to load the
 * drawn dungeon's art does not start behind.
 */

export const RACE_STATES = Object.freeze(["paired", "loading", "running", "finished", "cancelled", "void"]);
export const LOSS_CAUSES = Object.freeze(["left", "dropped", "failed"]);

const DECIDED = new Set(["finished", "cancelled", "void"]);

class Race {
  constructor({ id, spec, players, rules, at }) {
    if (!Array.isArray(players) || players.length !== 2 || players[0] === players[1]) {
      throw new Error("a race is two different players");
    }
    this.id = id;
    this.spec = spec;
    this.rules = rules;
    this.state = "paired";
    this.pairedAt = at;
    this.result = null;
    this.timeline = [];
    /** player -> { startedAt, finishedAt, elapsedMs, lostAt, cause } */
    this.players = new Map(players.map((player) => [player, {}]));
    /** The first loss while running, held for the draw window. */
    this.pendingLoss = null;
    this.record(at, null, "paired");
  }

  get ids() {
    return [...this.players.keys()];
  }

  opponentOf(player) {
    return this.ids.find((id) => id !== player);
  }

  playerOf(player) {
    const entry = this.players.get(player);
    if (!entry) throw new Error(`${player} is not in race ${this.id}`);
    return entry;
  }

  get decided() {
    return DECIDED.has(this.state);
  }

  record(at, player, type, detail) {
    this.timeline.push({ at, ...(player == null ? {} : { player }), type, ...(detail ? { detail } : {}) });
  }

  decide(at, state, fields) {
    this.state = state;
    this.result = { state, winner: null, at, ...fields };
    this.record(at, null, "decided", this.result);
  }

  /** The start adapter has been asked to put both players into the race. */
  loading(at) {
    if (this.state !== "paired") return;
    this.state = "loading";
    this.loadingAt = at;
    this.record(at, null, "loading");
  }

  /** This player's first race floor is built and their clock starts. */
  started(player, at) {
    const entry = this.playerOf(player);
    if (this.decided || entry.startedAt !== undefined) return;
    entry.startedAt = at;
    this.record(at, player, "started");
    if (this.ids.every((id) => this.players.get(id).startedAt !== undefined)) {
      this.state = "running";
      this.record(at, null, "running");
    }
  }

  /** Something worth keeping for whoever reviews the match later. */
  note(player, type, detail, at) {
    if (player != null) this.playerOf(player);
    this.record(at, player, type, detail);
  }

  /** This player cleared the last floor. */
  finished(player, at) {
    const entry = this.playerOf(player);
    if (this.state !== "running" || entry.finishedAt !== undefined || entry.lostAt !== undefined) return;
    entry.finishedAt = at;
    entry.elapsedMs = at - entry.startedAt;
    this.record(at, player, "finished", { elapsedMs: entry.elapsedMs });

    const other = this.players.get(this.opponentOf(player));
    if (other.lostAt !== undefined) {
      this.decide(at, "finished", { winner: player, reason: "opponent_lost", ...this.forfeitOf(this.opponentOf(player)) });
      return;
    }
    if (other.finishedAt !== undefined) {
      this.compareTimes(at);
      return;
    }
    this.tick(at);
  }

  /** This player is out: left the dungeon, dropped, or their run failed. */
  lost(player, at, cause) {
    if (!LOSS_CAUSES.includes(cause)) throw new Error(`unknown loss cause ${cause}`);
    const entry = this.playerOf(player);
    if (this.decided || entry.lostAt !== undefined || entry.finishedAt !== undefined) return;
    entry.lostAt = at;
    entry.cause = cause;
    this.record(at, player, "lost", { cause });

    if (this.state !== "running") {
      // Nothing was played; nobody's rating moves, but somebody caused it.
      this.decide(at, "cancelled", { reason: cause, blame: player });
      return;
    }
    const opponent = this.opponentOf(player);
    if (this.players.get(opponent).finishedAt !== undefined) {
      this.decide(at, "finished", { winner: opponent, reason: "opponent_lost", ...this.forfeitOf(player) });
      return;
    }
    if (this.pendingLoss && at - this.pendingLoss.at <= this.rules.drawWindowMs) {
      this.decide(at, "finished", { reason: "both_lost" });
      return;
    }
    if (!this.pendingLoss) this.pendingLoss = { player, at };
  }

  /**
   * This player asks to call the race off. Both asking ends it void — nobody's
   * rating moves, nobody is blamed — which is for a run that went wrong on the
   * server's side, a door that will not open, and not for a race somebody is
   * losing: the other has to agree. True once both have.
   */
  offerDraw(player, at) {
    const entry = this.playerOf(player);
    if (this.decided || entry.drawOfferedAt !== undefined) return false;
    entry.drawOfferedAt = at;
    this.record(at, player, "draw_offered");
    if (this.ids.every((id) => this.players.get(id).drawOfferedAt !== undefined)) {
      this.decide(at, "void", { reason: "agreed" });
      return true;
    }
    return false;
  }

  /** The server cannot run this race: it stopped, a worker died, the start failed. */
  voided(at, reason) {
    if (this.decided) return;
    this.decide(at, "void", { reason });
  }

  /** Decisions that only time makes: the load limit, the draw window, a clock passing a finish, the limit. */
  tick(at) {
    if (this.state === "loading") {
      this.loadExpired(at);
      return;
    }
    if (this.state !== "running") return;

    if (this.pendingLoss && at - this.pendingLoss.at >= this.rules.drawWindowMs) {
      const loser = this.pendingLoss.player;
      this.decide(at, "finished", { winner: this.opponentOf(loser), reason: "opponent_lost", ...this.forfeitOf(loser) });
      return;
    }
    if (this.pendingLoss) return;

    const finishers = this.ids.filter((id) => this.players.get(id).finishedAt !== undefined);
    if (finishers.length === 1) {
      const [finisher] = finishers;
      const time = this.players.get(finisher).elapsedMs;
      const other = this.players.get(this.opponentOf(finisher));
      if (at - other.startedAt >= time) {
        this.decide(at, "finished", { winner: finisher, reason: "faster" });
      }
      return;
    }

    const limit = this.rules.maxDurationMs;
    if (!finishers.length && this.ids.every((id) => at - this.players.get(id).startedAt >= limit)) {
      this.decide(at, "finished", { reason: "time" });
    }
  }

  /**
   * A first floor never built ends the race once `loadTimeoutMs` has passed:
   * a client that hangs while still connected would otherwise hold both
   * players in loading for good. Whoever never started is to blame; with
   * neither started it is more likely the drawn dungeon than either player.
   */
  loadExpired(at) {
    const limit = this.rules.loadTimeoutMs;
    if (!(limit > 0) || at - this.loadingAt < limit) return;
    const stuck = this.ids.filter((id) => this.players.get(id).startedAt === undefined);
    if (stuck.length === 1) this.decide(at, "cancelled", { reason: "load_timeout", blame: stuck[0] });
    else this.decide(at, "void", { reason: "load_timeout" });
  }

  compareTimes(at) {
    const [first, second] = this.ids.map((id) => [id, this.players.get(id).elapsedMs]);
    if (first[1] === second[1]) {
      this.decide(at, "finished", { reason: "same_time" });
      return;
    }
    const winner = first[1] < second[1] ? first[0] : second[0];
    this.decide(at, "finished", { winner, reason: "faster" });
  }

  /** `{ forfeit: player }` when they lost inside the forfeit window, else nothing. */
  forfeitOf(player) {
    const entry = this.players.get(player);
    if (entry.lostAt === undefined || entry.startedAt === undefined) return {};
    return entry.lostAt - entry.startedAt < this.rules.forfeitWindowMs ? { forfeit: player } : {};
  }
}

export const createRace = (options) => new Race(options);
