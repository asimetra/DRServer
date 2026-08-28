/**
 * How long somebody is kept out, and what it takes to get there.
 *
 * The point of a suspension here is not to identify a cheater — this server
 * cannot, and should be honest about why. The client sends a fixed placeholder
 * where a credential belongs (its own build calls it "FakeToken This Should Use
 * Steam And Populate From The Server Instead"), and `loadAccount` hands out
 * whatever account id is asked for, creating one if it has never seen it. So an
 * account id is a claim, not an identity.
 *
 * What a suspension does instead is take away the only thing a cheater actually
 * values, which is the account they built. Changing the id to escape one drops
 * them onto a fresh empty account: no hero, no gold, no weapons. That is the
 * cost, and it is the reason the account is the right anchor rather than the
 * connection — a VPN changes an address in a second and cannot restore a maxed
 * character.
 *
 * Two things this deliberately does not claim:
 *
 * It is not tamper-proof. Somebody willing to lose their progress can keep
 * making accounts, and nothing here stops that; it only prices it.
 *
 * And it can be aimed. A client that names somebody else's account id can
 * collect strikes against it. That hole is not opened here — anyone can already
 * claim any account and empty it — but this does make it worth doing. Closing
 * it needs the client to fetch a credential from this server, which is a client
 * change and outside what can be done today.
 */

const HOUR = 60 * 60 * 1000;

/**
 * Persistent punishment is intentionally not wired.
 *
 * The socket account id is still an unauthenticated client claim. Persisting a
 * suspension against it would let an attacker submit deterministic violations
 * in somebody else's name and take that account away. The ladder below remains
 * a pure, tested future policy; it is not safe to apply until login derives the
 * account from a server-verifiable credential.
 */
export const PERSISTENT_SANCTIONS_READY = false;

export const DISPOSITION = Object.freeze({
  OBSERVE: "observe",
  REJECT_ONLY: "reject_only",
  REJECT_AND_TERMINATE_PATTERN: "reject_and_terminate_pattern",
  OPERATIONAL_CLOSE: "operational_close",
});

/**
 * One place that says what evidence is allowed to do.
 *
 * A session pattern is reserved for rules which are always rejected at their
 * call site and have zero honest examples in the capture corpus. Rules behind
 * audit/enforcement switches are never on that list: a check the server does
 * not always trust to drop has no business ending a session.
 */
const POLICY = new Map([
  ["combat.forged_attacker", DISPOSITION.REJECT_AND_TERMINATE_PATTERN],
  ["combat.malformed_proposal", DISPOSITION.REJECT_AND_TERMINATE_PATTERN],
  ["position.not_a_place", DISPOSITION.REJECT_AND_TERMINATE_PATTERN],
  ["movement.endpoint_off_tile", DISPOSITION.REJECT_AND_TERMINATE_PATTERN],
  ["movement.segment_left_authored_tiles", DISPOSITION.REJECT_AND_TERMINATE_PATTERN],
  ["movement.step_too_large", DISPOSITION.REJECT_AND_TERMINATE_PATTERN],

  ["movement.budget_exceeded", DISPOSITION.REJECT_ONLY],
  ["cast.not_granted", DISPOSITION.REJECT_ONLY],
  ["combat.no_matching_cast", DISPOSITION.REJECT_ONLY],
  ["combat.bomb_without_revive", DISPOSITION.REJECT_ONLY],
  ["combat.bomb_budget_exceeded", DISPOSITION.REJECT_ONLY],
  ["placement.no_permit", DISPOSITION.REJECT_ONLY],

  ["session.malformed_frame", DISPOSITION.OPERATIONAL_CLOSE],
  ["session.packet_rate", DISPOSITION.OPERATIONAL_CLOSE],

  ["combat.out_of_reach", DISPOSITION.OBSERVE],
  ["placement.crossed_geometry", DISPOSITION.OBSERVE],
  ["movement.endpoint_inside_geometry", DISPOSITION.OBSERVE],
  ["movement.segment_crossed_geometry", DISPOSITION.OBSERVE],
  ["protocol.unknown_opcode", DISPOSITION.OBSERVE],
  ["protocol.unknown_field", DISPOSITION.OBSERVE],
]);

export const dispositionFor = (rule) => POLICY.get(rule) ?? DISPOSITION.OBSERVE;

/** Same shape as the future account ladder, but scoped to this socket only. */
export const SESSION_STRIKES_PER_TERMINATION = 3;
export const SESSION_STRIKE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Counts one deterministic rule without mixing unrelated rules together.
 *
 * Three different findings do not become a pattern merely because they share
 * a timestamp. The map is bounded by the fixed policy keys and each list by the
 * three-strike threshold.
 */
export const recordSessionViolation = (session, rule, now = Date.now()) => {
  const disposition = dispositionFor(rule);
  if (disposition !== DISPOSITION.REJECT_AND_TERMINATE_PATTERN) {
    return { disposition, terminate: false };
  }

  session.securityStrikes ??= new Map();
  const recent = [...(session.securityStrikes.get(rule) ?? []), now].filter(
    (at) => now - at < SESSION_STRIKE_WINDOW_MS
  );
  if (recent.length < SESSION_STRIKES_PER_TERMINATION) {
    session.securityStrikes.set(rule, recent);
    return { disposition, terminate: false, strikes: recent.length };
  }

  session.securityStrikes.delete(rule);
  return {
    disposition,
    terminate: true,
    strikes: recent.length,
    reason: `${rule}: ${recent.length} deterministic violations in 10 minutes`,
  };
};

/**
 * The ladder: two hours, doubling, with a year at the top.
 *
 * Short first, because the first one is the one most likely to be wrong. Every
 * rule that can put somebody here has a measured false-positive count of zero
 * against the recordings, but zero observed is not zero possible, and two hours
 * is a mistake somebody recovers from.
 *
 * It keeps doubling rather than stopping somewhere modest, because each rung
 * costs three more violations of something an unmodified client cannot send —
 * so the far end is not somewhere anybody arrives by accident. Reaching a year
 * takes fourteen escalations and forty-two of them:
 *
 *   2  4  8  16  32  64  128  256  512  1024  2048  4096  8192  8760
 *
 * A year is the cap rather than "for ever" because a permanent decision should
 * be a person's. Somebody still there after a year is a case to look at, not a
 * counter to keep multiplying.
 */
const YEAR_HOURS = 365 * 24;

export const ladderHours = (step) => Math.min(2 ** Math.max(1, step), YEAR_HOURS);

/** How many rungs there are: the first step at which the doubling meets the cap. */
export const LADDER_STEPS = Math.ceil(Math.log2(YEAR_HOURS));

/**
 * How many deterministic violations inside one window it takes.
 *
 * Not one. A rule that refuses a packet can afford to be wrong about a single
 * message; a rule that takes somebody's evening cannot. Three occurrences of
 * something an unmodified client cannot produce is a pattern, and a pattern is
 * what this is meant to answer.
 */
export const STRIKES_PER_STEP = 3;
export const STRIKE_WINDOW_MS = 10 * 60 * 1000;

/**
 * And how long a clean account takes to climb back down one rung.
 *
 * Without this the ladder only ever rises, so somebody caught once a year ago
 * starts their next mistake at sixteen hours. Thirty days of not doing it again
 * is the answer to having done it.
 */
export const DECAY_MS = 30 * 24 * HOUR;

/**
 * Only rules with no honest traffic on the other side of them.
 *
 * Each of these refuses something an unmodified client cannot send: a result in
 * another actor's name, an attack no weapon grants, a slot that is not one. The
 * counts are in the audit's status table and every one of them is zero across
 * the recordings.
 *
 * The ones left out are left out on purpose. Reach, placement geometry, packet
 * rate and the wall rules all still count rather than refuse, because their
 * false-positive rate is either nonzero or unmeasured — and a rule that is not
 * trusted to drop a packet has no business ending somebody's session.
 */
export const SANCTIONABLE = new Set([
  "combat.forged_attacker",
  "combat.malformed_proposal",
  "position.not_a_place",
]);

/** A fresh sheet. Stored beside the account rather than in it: not the client's. */
export const emptyRecord = () => ({ step: 0, strikes: [], until: 0, lastStrikeAt: 0 });

/**
 * Records one, and says whether it was the one that tipped.
 *
 * The window is rolling and the strikes inside it are kept rather than counted,
 * because "three in ten minutes" cannot be answered by a number alone. There
 * are at most three of them, so the list is its own bound.
 */
export const strike = (record, rule, now = Date.now()) => {
  if (!SANCTIONABLE.has(rule)) return { record, suspended: false };

  const sheet = decay(record ?? emptyRecord(), now);
  const strikes = [...sheet.strikes, now].filter((at) => now - at < STRIKE_WINDOW_MS);
  if (strikes.length < STRIKES_PER_STEP) {
    return { record: { ...sheet, strikes, lastStrikeAt: now }, suspended: false };
  }

  const step = Math.min(sheet.step + 1, LADDER_STEPS);
  const hours = ladderHours(step);
  return {
    record: { step, strikes: [], until: now + hours * HOUR, lastStrikeAt: now },
    suspended: true,
    hours,
  };
};

/**
 * Steps back down for staying out of trouble, one rung per clean period.
 *
 * Counted from whichever came later, the last strike or the end of the
 * suspension it earned. Serving the time is not what walks it back — being able
 * to do it again and not doing it is, and somebody locked out for a hundred and
 * seventy days is not demonstrating anything while they are locked out.
 *
 * Measuring from the strike alone made the ladder unable to climb: by the time
 * a long suspension ended, more clean periods had passed than it had rungs, so
 * the next offence always started near the bottom however many there had been.
 */
const decay = (record, now) => {
  if (!record.step) return record;
  const from = Math.max(record.lastStrikeAt ?? 0, record.until ?? 0);
  if (!from) return record;
  const clean = Math.floor((now - from) / DECAY_MS);
  if (clean <= 0) return record;
  return { ...record, step: Math.max(0, record.step - clean) };
};

/** How much longer they are out, in milliseconds. Zero means they are not. */
export const suspensionRemaining = (record, now = Date.now()) =>
  Math.max(0, (record?.until ?? 0) - now);
