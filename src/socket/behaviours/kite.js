/**
 * A kiter's back-off: KITE_AI keeps its distance by backing off now and then
 * from whoever stands inside its keep distance, not by holding a ring.
 *
 * What a back-off is made of is the kiter's own, behind this module's small
 * API: `ai.fleeUntil`, when the back-off it is on ends, and `ai.targetSeen`,
 * where its target stood on the last tick, from which it tells a moving
 * target from a still one. `backOffTurn` rolls for one; `backingOff` says
 * whether one is on; `backOffStep` is its step, and `backOffHeadway` ends one
 * that got nowhere; `endBackOff` ends one for any other reason (it shot);
 * `forgetBackOff` drops both with the target.
 */

const distanceTo = (from, to) => Math.hypot(to.x - from.x, to.y - from.y);

/**
 * How a kiter backs off: measured, not authored.
 *
 * Every official capture, every KITE_AI monster with a keep distance, the
 * player inside it, neither side swinging nor hit in the last second, rebuilt
 * from the monster's own position updates (549 back-offs, 1244 s solo):
 *
 *   starts     about 0.4 per second pooled, the same for every ranged kiter
 *              within noise (marksman, both axe throwers, archer, imp,
 *              savage bow), and the same however deep inside the player
 *              stands. In open ground it is about 0.35 against a player
 *              standing still and 0.8 against one moving, toward it or not.
 *              With a monster close behind it is a third of that, which the
 *              body in the way gives here (a back-off that gets nowhere ends).
 *   ends       when it is back out at its keep distance (43%), blocked (25%),
 *              when it shoots (16%), when hit (6%); otherwise about 12% a
 *              250 ms tick, a mean near 2 s. p50 0.5 s, longest 3.25 s of 500.
 *   shoots     in about a fifth of them, standing for the shot.
 *
 * `FleeTimer` and `FleeTimerRand` do not govern it: SAVAGE_BOW, which authors
 * FleeTimer 0, backs off as often as the rows authoring 4, and a 4-7 s pause
 * between back-offs fits the corpus worst of the models tried. Not modelled:
 * a second back-off follows within 1.5 s more often than chance, then 2-4 s
 * are quieter than chance (29 against 48 expected); and the official decides
 * moves on a roughly 500 ms beat.
 */
const BACK_OFF_STILL_PER_SECOND = 0.35;
const BACK_OFF_MOVING_PER_SECOND = 0.8;
/** A player covering this much ground a second counts as moving. */
const BACK_OFF_MOVING_SPEED = 60;
const BACK_OFF_MEAN_MS = 2000;
const BACK_OFF_MOST_MS = 3250;

/**
 * Whether a kiter or a ranged pet may back off from its target, given the
 * route to it: when it sees the target, and when it has no route to it.
 *
 * The second half is today's behaviour kept on purpose, not a rule anyone
 * chose for both. c13780e made a failed route hand out the target as a
 * "direct" waypoint so that the walk would end at the standoff, and both
 * back-offs read that same flag. For the kiter it was meant — the commit
 * says "a kiter backs off as from any target in sight", from the captures'
 * "kiters keep their distance", and test/no-route-walk.test.js holds it. For
 * the pet's MinRange retreat it came along unasked (and no placed pet has a
 * keep distance today, so it does not run). A target with a route that is
 * not in sight is not backed off from, and a body escaping the scenery backs
 * off from nothing.
 *
 * DECISION FOR THE MAINTAINER: should a pet or a kiter back off from a target
 * it has no route to?
 */
export const backsOffFrom = (route) => route.sees || (route.blocked && !route.escaping);

/**
 * Away from everyone inside its keep distance, nearer ones counting more, or
 * null when nobody is inside or it is pressed from opposite sides — backing
 * off one player into another is not getting away. `depth` is how far the
 * deepest one stands inside: no step backs off further than that.
 */
export const awayFromThreats = (actor, threats, keep) => {
  let x = 0;
  let y = 0;
  let strongest = 0;
  for (const { position } of threats) {
    const dx = actor.position.x - position.x;
    const dy = actor.position.y - position.y;
    const distance = Math.hypot(dx, dy);
    // A step of exactly `depth` lands on the keep distance give or take a
    // rounding error; landed is out.
    if (distance >= keep - 1e-6 || distance < 0.001) continue;
    const weight = (keep - distance) / keep;
    x += (dx / distance) * weight;
    y += (dy / distance) * weight;
    strongest = Math.max(strongest, weight);
  }
  const length = Math.hypot(x, y);
  if (!strongest || length < strongest * 0.25) return null;
  return { x: x / length, y: y / length, depth: strongest * keep };
};

/**
 * This tick's back-off for a kiter, given its route and the walk's stopping
 * point: the way away from whoever stands inside its keep distance, or null.
 *
 * A kiter backs off now and then, for a moment, from whoever stands
 * inside its keep distance, more often while its target is moving. It is
 * a chance each tick, not a timer: there is no window to wait out and
 * nothing to re-arm. A back-off ends when its time is up, when it is back
 * out at its keep distance, when it swings, or when it cannot get away.
 *
 * No roll while it is `swinging` — locked in its own attack or lunging.
 */
export const backOffTurn = (
  session,
  actor,
  victim,
  { route, stopAt, bodies, mobility, heroes, swinging, now, deltaSeconds }
) => {
  const { ai } = actor;
  const target = victim.position;
  const canBackOff = stopAt > bodies && backsOffFrom(route) && mobility > 0;
  const threats = heroes.some(({ doid: heroDoid }) => heroDoid === victim.doid)
    ? heroes
    : [...heroes, { position: target }];
  const away = canBackOff ? awayFromThreats(actor, threats, stopAt) : null;
  const seen = ai.targetSeen;
  const targetMoving =
    seen?.doid === victim.doid &&
    now > seen.at &&
    distanceTo(seen, target) / ((now - seen.at) / 1000) > BACK_OFF_MOVING_SPEED;
  ai.targetSeen = { doid: victim.doid, x: target.x, y: target.y, at: now };
  if (!away) {
    ai.fleeUntil = 0;
  } else if (now >= (ai.fleeUntil ?? 0) && !swinging) {
    const random = session.random ?? Math.random;
    const rate = targetMoving ? BACK_OFF_MOVING_PER_SECOND : BACK_OFF_STILL_PER_SECOND;
    if (random() < 1 - Math.exp(-rate * deltaSeconds)) {
      const length = -Math.log(1 - Math.min(0.999999, random())) * BACK_OFF_MEAN_MS;
      ai.fleeUntil = now + Math.min(BACK_OFF_MOST_MS, length);
    }
  }
  return away;
};

/** Whether it is on a back-off: somebody to back off from, and time left on it. */
export const backingOff = (ai, away, now) => Boolean(away) && now < (ai.fleeUntil ?? 0);

/** The back-off is over before its time: it shot, it got nowhere, or it has nowhere left to go. */
export const endBackOff = (ai) => {
  ai.fleeUntil = 0;
};

/** The target is gone: no back-off, and nothing remembered of where it stood. */
export const forgetBackOff = (ai) => {
  ai.fleeUntil = 0;
  ai.targetSeen = null;
};

/**
 * The step a back-off takes this tick, or null when it has nowhere left to go,
 * which ends it.
 */
export const backOffStep = (ai, away, topSpeed, deltaSeconds) => {
  // Out to its keep distance and no further: past it, the chase would
  // only walk it back in, a hop out and back on every back-off.
  const step = Math.min(topSpeed * deltaSeconds, away.depth);
  if (step > 0.001) return { x: away.x * step, y: away.y * step };
  // Nowhere left to go: a back-off kept alive here would follow a
  // player walking in, step for step.
  endBackOff(ai);
  return null;
};

/**
 * After a back-off's step, from `before`: a wall, a crowd or a player in the
 * way, and it fights from where it stands. Progress is measured along the
 * way out, so a neighbour's shove sideways does not count as getting away.
 */
export const backOffHeadway = (actor, away, before, topSpeed, deltaSeconds) => {
  if (
    (actor.position.x - before.x) * away.x + (actor.position.y - before.y) * away.y <
      0.25 * Math.min(topSpeed * deltaSeconds, away.depth)
  ) {
    endBackOff(actor.ai);
  }
};
