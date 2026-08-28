import { warn } from "../log.js";
import { recordSessionViolation } from "../sanctions.js";

/**
 * What a rule saw, counted rather than narrated.
 *
 * Every check added so far writes a line per occurrence, and the occurrences
 * are not paced by anything this server controls. A refused proposal vector can
 * carry eight results; a client that has decided to keep sending them does so
 * as fast as its socket allows. So the log — the one place an operator would
 * look to decide whether a flag is safe to turn on — is the first thing a
 * determined client can drown, and the loudest rule buries the rest.
 *
 * The shape is the smallest one that stays useful: say the first of a kind at
 * once, because the first is the interesting one, then count and say how many
 * when the window closes. Nothing is lost and the volume is bounded by the
 * number of rules rather than by the number of packets.
 *
 * Lazy, like the cast and permit ledgers: the window is closed by the next
 * event of that kind, or by whoever asks for a summary. No timers, and nothing
 * to clean up on a socket that goes away mid-window.
 */
const WINDOW_MS = 10_000;

/** Rule names, so a typo cannot quietly open a new bucket. */
export const RULE = {
  forgedAttacker: "combat.forged_attacker",
  noCast: "combat.no_matching_cast",
  outOfReach: "combat.out_of_reach",
  malformedProposal: "combat.malformed_proposal",
  bombWithoutRevive: "combat.bomb_without_revive",
  bombBudget: "combat.bomb_budget_exceeded",
  reviveWithoutAttempt: "revive.no_matching_attempt",
  reviveOutOfReach: "revive.out_of_reach",
  placementWithoutThrow: "placement.no_permit",
  placementThroughWall: "placement.crossed_geometry",
  implausibleCoordinate: "position.not_a_place",
  movementEndpointOffTile: "movement.endpoint_off_tile",
  movementSegmentOffTile: "movement.segment_left_authored_tiles",
  movementStepTooLarge: "movement.step_too_large",
  movementBudgetExceeded: "movement.budget_exceeded",
  movementEndpointInsideGeometry: "movement.endpoint_inside_geometry",
  movementSegmentCrossedGeometry: "movement.segment_crossed_geometry",
  unownedAttack: "cast.not_granted",
  oversizedChat: "chat.longer_than_typed",
  trafficRate: "session.packet_rate",
  malformedFrame: "session.malformed_frame",
  unknownOpcode: "protocol.unknown_opcode",
  unknownField: "protocol.unknown_field",
};

const describe = (session) => `[${session?.id ?? "?"}]`;

/**
 * Records one occurrence, and says something about it when that is useful.
 *
 * Returns true when it wrote a line, which is only so callers can tell whether
 * this was the noisy one; nothing depends on it.
 */
export const noteViolation = (session, rule, detail, now = Date.now()) => {
  if (!session) return false;
  session.violations ??= new Map();

  /**
   * Gameplay rejection remains at the rule's call site; this decides only what
   * the evidence may do to the current session. Persistent account punishment
   * is deliberately absent until login identity is verifiable.
   */
  const decision = recordSessionViolation(session, rule, now);
  if (decision.terminate && !session.terminationRequested) {
    session.terminationRequested = {
      rule,
      reason: decision.reason,
      requestedAt: now,
    };
    warn(`${describe(session)} session termination requested: ${decision.reason}`);
  }

  const bucket = session.violations.get(rule);
  if (!bucket) {
    session.violations.set(rule, { count: 1, since: now, detail });
    warn(`${describe(session)} ${rule}: ${detail}`);
    return true;
  }

  bucket.count += 1;
  bucket.detail = detail;
  if (now - bucket.since < WINDOW_MS) return false;

  const seconds = Math.round((now - bucket.since) / 1000);
  warn(
    `${describe(session)} ${rule}: ${bucket.count} in ${seconds}s, ` +
      `most recently ${bucket.detail}`
  );
  session.violations.set(rule, { count: 0, since: now, detail });
  return true;
};

/**
 * How fast a client may keep talking.
 *
 * Not a defence on its own — the work behind one packet is bounded now, and a
 * socket that floods gets Node's own backpressure — but the ladder's top rungs
 * need something that can say "this one has been doing it for a while", and
 * nothing could.
 *
 * Measured over a ten-second window rather than one second, for the same reason
 * the speed rule is: a connection that stalls delivers its backlog in a burst,
 * and a one-second view cannot tell that from abuse. Honest play peaks at 144
 * packets a second over one second, 101 over five, and **78 over ten**. The
 * bound is three times the last of those.
 */
const TRAFFIC_WINDOW_MS = 10_000;
const TRAFFIC_LIMIT_PER_SECOND = 240;

export const noteTraffic = (session, frames = 1, now = Date.now()) => {
  if (!session) return false;
  session.traffic ??= { since: now, frames: 0 };
  const traffic = session.traffic;
  traffic.frames += frames;
  if (now - traffic.since < TRAFFIC_WINDOW_MS) return false;

  const perSecond = traffic.frames / ((now - traffic.since) / 1000);
  traffic.since = now;
  traffic.frames = 0;
  if (perSecond <= TRAFFIC_LIMIT_PER_SECOND) return false;

  noteViolation(
    session,
    RULE.trafficRate,
    `${perSecond.toFixed(0)} packets/s sustained, against an honest peak of 78`,
    now
  );
  return true;
};

/**
 * Everything still uncounted, for a session that is ending.
 *
 * A run that ends inside a window would otherwise take its tail with it, and
 * the tail is the part that says whether a rule fires once or constantly.
 */
export const flushViolations = (session, now = Date.now()) => {
  for (const [rule, bucket] of session?.violations ?? []) {
    if (!bucket.count) continue;
    const seconds = Math.max(1, Math.round((now - bucket.since) / 1000));
    warn(`${describe(session)} ${rule}: ${bucket.count} more in ${seconds}s at close`);
  }
  session?.violations?.clear();
};
