import { config } from "../config.js";
import { attackTimelineFrames, FRAMES_PER_SECOND } from "../gamemaster.js";
import { RULE, noteViolation } from "./security-events.js";
import { claimedReachOf } from "./hit-pricing.js";

/**
 * Whether a proposed hit may be believed: the cast that must precede it, how
 * many hits a cast may land and on whom, a bomb's own window, and a hit's
 * reach against its attack's. Violations go through security-events.js.
 */

/**
 * How far past its reach a claimed hit was, or nothing when it was within it.
 *
 * Exported so the projectile branch is exercised by a test: the first version
 * of this shipped with `projectileForConstant` missing from the imports, and
 * the melee-only test never reached the line that needed it.
 */
/**
 * Two attacks the hero lands without ever casting them.
 *
 * `HEALTH_BOMB_ATTACK` and `PARTY_BOMB_ATTACK` go out through the revive path
 * rather than through a choreography. They are the whole of the exception: of
 * 5447 hero hit claims in the official recordings, 4998 follow a choreography
 * of the same attack and the 449 that do not are these two and nothing else.
 */
export const CASTLESS_ATTACKS = new Set(["HEALTH_BOMB_ATTACK", "PARTY_BOMB_ATTACK"]);

/**
 * Remembers that an attack was *accepted*, which is the point.
 *
 * A refusal in `handleProposeAttackChoreography` used to be cosmetic. Costing
 * nothing and spawning nothing, it still let the damage through, because hit
 * results arrive on their own field and nothing tied the two together — so a
 * client could skip the cast entirely and land the attack for free: no Mana, no
 * Crowd points, no cooldown.
 *
 * The Battle Chef showed it by accident. Its Dungeon Buster was refused for
 * months by a guard that should never have caught it, and the meteors never
 * spawned and the bar never emptied — and the damage landed every time.
 */
/**
 * How long one cast may still be answering for hits, and how many it may
 * answer for. Both are bounds on honest play rather than models of it.
 *
 * The recordings say what honest looks like, over 14297 hits matched back to
 * the cast that preceded them: the gap is 108ms at the median and 249 at p90,
 * but the tail is long and legitimate — `DBUSTER_MEATEOR_SHOWER` lands 124 hits
 * from one cast, and `LAZY_BOOMERANG` was still hitting 22.0 seconds after it
 * was thrown, 66 times. A window drawn near the median would delete those.
 *
 * So these sit above the observed maximum with room to spare and do not try to
 * be exact. Being exact per attack means deriving flight time and lifetime from
 * the authored timeline, and a formula of ours that comes out short refuses
 * hits the player earned — which is how the cooldown gap behaved before it was
 * measured. A generous finite bound is the honest version of what is knowable
 * now, and it is the whole of what was missing: the map had no expiry and no
 * budget at all, so one accepted cast authorised that attack for the rest of
 * the socket's life.
 */
const CAST_WINDOW_MS = 30_000;
const WHEN_AUDIT_GRACE_MS = 500;

/**
 * Measures CombatResult.when without using an unproven bound to reject hits.
 *
 * Standalone results carry the authored timeline frame. Embedded choreography
 * results carry 255 as "not frame-bound", so that sentinel is deliberately
 * excluded. ODS_CAST_MODE=audit enables these observations; enforce currently
 * keeps the same audit because neither finding changes gameplay yet.
 */
export const auditCombatResultWhen = async (
  session,
  proposal,
  attack,
  acceptedCast,
  now = Date.now()
) => {
  if (config.castMode === "off" || proposal?.when === 255 || !attack) return false;

  let found = false;
  const when = Number(proposal?.when ?? 0);
  const totalFrames = await attackTimelineFrames(attack.AttackTimeline);
  if (totalFrames > 0 && when > totalFrames) {
    noteViolation(
      session,
      RULE.whenPastTimeline,
      `${attack.Constant ?? attack.Id} frame ${when} past timeline ${totalFrames}`,
      now
    );
    found = true;
  }

  if (acceptedCast?.at != null) {
    const elapsedMs = now - Number(acceptedCast.at);
    const frameMs = when * (1000 / FRAMES_PER_SECOND);
    if (elapsedMs > frameMs + WHEN_AUDIT_GRACE_MS) {
      noteViolation(
        session,
        RULE.whenLate,
        `${attack.Constant ?? attack.Id} frame ${when} arrived ${Math.round(elapsedMs)}ms ` +
          `after cast (${Math.round(elapsedMs - frameMs)}ms past frame time)`,
        now
      );
      found = true;
    }
  }
  return found;
};

/**
 * How many results one accepted cast may answer for.
 *
 * 124 is the most any single cast has ever landed — a Battle Chef's meteor
 * shower — with a boomerang next at 66 and an ordinary combo at 35. The bound
 * is a little over the widest of those rather than the 256 it was, which was
 * picked to clear the meteor shower and gave an axe swing the same allowance.
 *
 * Per-attack budgets would be better and are not yet derivable. The authored
 * `MaxCollisions` is 30 on every row in the game, and two attacks beat it
 * outright, because one cast can spawn several projectiles and each carries its
 * own. The recordings only cover 18 of 573 attacks, so a table built from them
 * would be a guess everywhere else and would rot as the rest arrived.
 */
const CAST_HIT_BUDGET = 160;

/**
 * How many accepted casts a hero may have in flight.
 *
 * Bounded so a client cannot make this server remember an unbounded number of
 * them, and large enough that nothing honest is displaced — which is where the
 * first attempt at this went wrong. Thirty-two sounded generous and is not:
 * honest play has up to 322 casts live inside one 30-second window, and 137 of
 * a single attack and slot, because a combo chain and a meteor shower each send
 * many choreographies for one visible action. Dropping the oldest would have
 * refused the hits still arriving for it.
 *
 * What bounds damage is the tally below, not this. This only bounds memory.
 */
const MAX_LIVE_CASTS = 512;

/**
 * What one body may absorb from one attack and slot, across the window.
 *
 * This is the bound that matters, and it deliberately sits outside the cast
 * records. Per-record ceilings multiply: a client that sends many
 * choreographies — which honest clients do, 137 of one attack and slot inside
 * thirty seconds — gets a fresh allowance with each, so 24 a record was 3000
 * against the same boss.
 *
 * One tally per attack, slot and target instead, over the same 30-second
 * window. Honest play's worst is 30, a Battle Chef's cleaver combo against one
 * monster; 96 is more than three times that.
 *
 * Uniqueness on `(target, generation)` would be tighter and is not safe: honest
 * play repeats those pairs 3683 times inside a single cast, because a melee
 * attack has no projectile and every one of its hits is generation zero.
 */
const HITS_PER_TARGET = 96;

/** Bounded like everything else, and pruned on the packet already running. */
const MAX_TARGET_TALLIES = 4096;

/**
 * Remembers that an attack was *accepted*, which is the point.
 *
 * A refusal in `handleProposeAttackChoreography` used to be cosmetic. Costing
 * nothing and spawning nothing, it still let the damage through, because hit
 * results arrive on their own field and nothing tied the two together — so a
 * client could skip the cast entirely and land the attack for free: no Mana, no
 * Crowd points, no cooldown.
 *
 * The Battle Chef showed it by accident. Its Dungeon Buster was refused for
 * months by a guard that should never have caught it, and the meteors never
 * spawned and the bar never emptied — and the damage landed every time.
 */
export const noteCast = (
  session,
  attack,
  weaponSlot = 0,
  now = Date.now(),
  maxPowerMultiplier = 1
) => {
  if (!attack?.Id) return false;
  session.acceptedCasts ??= [];

  /**
   * A list rather than one record per attack id.
   *
   * Keyed by the attack, a second swing overwrote the first and handed back a
   * full budget — so the budget bounded nothing a client could not renew by
   * asking again. Casts of the same attack now coexist and are spent oldest
   * first, which is the order they were made in.
   *
   * The slot rides along because a result names one, and a hit made with the
   * axe should not be answered for by the cast of the staff.
   */
  const live = session.acceptedCasts.filter((record) => now - record.at <= CAST_WINDOW_MS);
  // Lazily, on the packet that is already here: no timers.
  live.push({
    attackId: Number(attack.Id),
    weaponSlot: Number(weaponSlot ?? 0),
    at: now,
    hits: 0,
    maxPowerMultiplier: Math.max(1, Number(maxPowerMultiplier) || 1),
  });
  session.acceptedCasts = live.slice(-MAX_LIVE_CASTS);
  return true;
};

/**
 * How long after a revive its bomb may still be landing.
 *
 * The two bombs send no choreography of their own, which is why they are exempt
 * from the cast rule — but they are not uncaused. Every one of the 18
 * detonations in the recordings follows a `ProposeSelfRevive` that this server
 * accepted and charged an account bomb for, and the gap is remarkably tight:
 * 2331ms at the shortest, 2394 at the median, 3411 at the longest.
 *
 * Ten seconds is three times the widest of those. It does not need to be close,
 * only finite: what was wrong was that the exemption was unconditional.
 */
const BOMB_WINDOW_MS = 10_000;

/**
 * And how many bodies one detonation may reach.
 *
 * The window alone said when, not how much, so one paid bomb answered for
 * every result that arrived inside ten seconds — enough to clear a floor from a
 * single item. A bomb is one blast: across the recordings the health bomb lands
 * a median of 9 hits and at most 27, the party bomb 5 and at most 16, and every
 * burst finishes within 3 milliseconds.
 *
 * Sixty-four is well over twice the widest of those. The authored row agrees
 * about the shape — `MaxCollisions` 30, `HitsPerCollision` 1 — so this is a
 * ceiling rather than a model of the blast.
 */
const BOMB_HIT_BUDGET = 64;

/**
 * A blast reaches a body once or twice, never sixty-four times. The health bomb
 * has hit the same target twice in the recordings and the party bomb once, so
 * eight is four times the worst seen and still closes "erase a boss with one
 * item".
 */
const BOMB_HITS_PER_TARGET = 8;

const BOMB_ATTACK_FOR = { party: "PARTY_BOMB_ATTACK", health: "HEALTH_BOMB_ATTACK" };

/**
 * A revive is the bomb's cast.
 *
 * `handleProposeSelfRevive` is where the bomb is actually paid for — it spends
 * one from the account and refuses when there is none — so nothing further is
 * charged here. All that was missing is that the *results* were accepted
 * whatever had happened, so a modified client could land a bomb's damage having
 * never revived and never spent anything.
 */
export const noteBombCast = (session, reviveAll, now = Date.now()) => {
  session.bombCasts ??= new Map();
  session.bombCasts.set(BOMB_ATTACK_FOR[reviveAll ? "party" : "health"], {
    at: now,
    hits: 0,
    perTarget: new Map(),
  });
  return true;
};

/** Nothing survives the floor it was thrown on. */
export const clearBombCasts = (session) => {
  session.bombCasts?.clear();
};

const bombWasCast = (session, attack, targetDoid, now) => {
  const record = session.bombCasts?.get(attack?.Constant);
  if (!record || now - record.at > BOMB_WINDOW_MS) {
    noteViolation(session, RULE.bombWithoutRevive, `${attack?.Constant} with no revive behind it`);
    return false;
  }
  const onThisOne = record.perTarget.get(targetDoid) ?? 0;
  if (record.hits >= BOMB_HIT_BUDGET || onThisOne >= BOMB_HITS_PER_TARGET) {
    noteViolation(
      session,
      RULE.bombBudget,
      `${attack?.Constant} past what one blast reaches (${record.hits} hits, ${onThisOne} on this body)`
    );
    return false;
  }

  // Spent by landing, or the budget means nothing.
  record.hits += 1;
  record.perTarget.set(targetDoid, onThisOne + 1);
  return true;
};

/**
 * One body's share of one attack and slot, counted across the window rather
 * than per cast, and spent by landing.
 */
const spendOnTarget = (session, source, targetDoid, now) => {
  session.targetTally ??= new Map();
  const key = `${source}|${targetDoid}`;
  const seen = session.targetTally.get(key);

  if (!seen || now - seen.at > CAST_WINDOW_MS) {
    if (session.targetTally.size >= MAX_TARGET_TALLIES) {
      for (const [old, record] of session.targetTally) {
        if (now - record.at > CAST_WINDOW_MS) session.targetTally.delete(old);
      }
      // Still full of live tallies: that is more bodies than a floor holds.
      if (session.targetTally.size >= MAX_TARGET_TALLIES) return false;
    }
    session.targetTally.set(key, { at: now, hits: 1 });
    return true;
  }

  if (seen.hits >= HITS_PER_TARGET) return false;
  seen.hits += 1;
  return true;
};

/**
 * Whether this hit belongs to an attack the hero was allowed to make, and is
 * still within what that permission covers.
 *
 * Consuming rather than asking: the window and the budget only mean something
 * if landing a hit spends them.
 */
export const consumeAcceptedCast = (
  session,
  attack,
  attackType,
  weaponSlot = 0,
  targetDoid = 0,
  now = Date.now(),
  claimedPowerMultiplier = 1
) => {
  if (CASTLESS_ATTACKS.has(attack?.Constant)) {
    return bombWasCast(session, attack, targetDoid, now)
      ? { maxPowerMultiplier: 1 }
      : null;
  }

  // Oldest first: a hit belongs to the earliest cast still able to answer for
  // it, which is the one that was made first — and which still has room both
  // overall and for this particular body.
  const candidates = (session.acceptedCasts ?? []).filter(
    (candidate) =>
      candidate.attackId === Number(attackType) &&
      candidate.weaponSlot === Number(weaponSlot ?? 0) &&
      now - candidate.at <= CAST_WINDOW_MS &&
      candidate.hits < CAST_HIT_BUDGET
  );
  const claimed = Math.max(1, Number(claimedPowerMultiplier) || 1);
  // Several arrows may still be flying. A full-charge result cannot belong to
  // an earlier half-charge cast whose server-timed ceiling is lower; choose the
  // oldest live cast capable of producing the claimed value, then retain the
  // old oldest-first fallback so an excessive claim is bounded rather than
  // turned into a way to choose a later record.
  const record = candidates.find(
    (candidate) => (candidate.maxPowerMultiplier ?? 1) + 0.01 >= claimed
  ) ?? candidates[0];
  if (!record) return null;
  if (!spendOnTarget(session, `${attackType}|${weaponSlot ?? 0}`, targetDoid, now)) return null;

  record.hits += 1;
  return record;
};

/** Public boolean form retained for callers that only need authorization. */
export const castAccepted = async (...args) => Boolean(consumeAcceptedCast(...args));

/** Nothing authorises anything across a floor or a dungeon. */
export const clearAcceptedCasts = (session) => {
  session.acceptedCasts = [];
  session.targetTally?.clear();
  session.scalingChargeStarts?.clear();
};

export const reachExcess = async (session, proposal, attack) => {
  const victim = session.actors?.get(proposal.attackee);
  const from = session.heroPosition;
  const at = victim?.position;
  if (!from || !at) return null;

  /**
   * Judged against the last position this server accepted, whatever its age.
   * That position is not stale in the sense of wrong: the client sends one when
   * it changes, so an old one means the hero has not moved. Turning age into
   * either a wider bound or a refusal to answer both handed the decision to the
   * one party this rule exists to check.
   */
  const staleMs = Date.now() - (session.heroPositionAt ?? Date.now());
  const distance = Math.hypot(from.x - at.x, from.y - at.y);
  const allowed = await claimedReachOf(attack);
  return distance > allowed ? { distance, allowed, staleMs } : null;
};
