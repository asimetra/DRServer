/**
 * How a crowd of monsters behaves round one hero, counted the same way for
 * the official corpus (tools/crowd-corpus.js) and for our own AI in the
 * harness (tools/ai-sim-census.js).
 *
 * Both feed it the same thing: a sample every `tickMs` of where the hero and
 * every living monster stand, and which monsters swung since the sample
 * before. The definitions live here once, so a number for the official and a
 * number for ours mean the same thing.
 *
 *   engaged     a monster sample with its feet within 400 of the hero's
 *   overlap     an engaged sample whose body is more than 10 inside another
 *               monster's body (body point and radius as body.js has them)
 *   blocked     a chaser out of contact (its body 30 or more off the
 *               hero's), within 350, with another monster's body in its way:
 *               ahead of it, nearer the hero, within both radii and 25 along
 *               the line to the hero and 0.8 of both radii across it. What
 *               it did over the next second: `waits` (moved under 15),
 *               `slides` round it, `pushes` it ahead, `backs` off, the other
 *               stepped `aside`, or `jitters`; split by whether the hero moved
 *               15 or more in that second
 *   swings      every swing at the hero (no pet nearer), by what the
 *               attack is (`attackClassOf`), with whether its
 *               body was where its walk ends — touching the hero for a
 *               chaser, at its standoff for a kiter, 15 of slack — and
 *               whether it was still advancing: 10 or more nearer the hero
 *               over the half second before
 *   due         monster samples in reach of the hero, its cadence floor
 *               (`AttackTimer`) past since its last swing: how often a swing
 *               starts on the sample when it is at its walk's end or
 *               advancing ("allowed") against when it is neither ("held")
 */

export const ENGAGED_WITHIN = 400;
export const OVERLAP_DEPTH = 10;
const BLOCKED_WITHIN = 350;
const BLOCKED_GAP = 30;
const LOOKAHEAD_MS = 1000;
const WAIT_MOVE = 15;
const ADVANCE_LOOKBACK_MS = 500;
const ADVANCE_MIN = 10;
const ARRIVED_SLACK = 15;
const REACH_SLACK = 2;

/**
 * What a monster is to these counts apart from where it stands, from the
 * fields an `ai` is built with (npc-spawn.js), worked out here rather than
 * asked of a root so that every root and the corpus are measured alike:
 * `reach` and the standoff are body.js's `furthestReach` and `standoff`.
 */
export const crowdProfile = ({ behavior, moveSpeed, radius, attacks = [], keepDistance = 0, attackRange, attackTimerMs = 1500 }, heroRadius) => {
  const bodies = radius + heroRadius;
  const reach = Math.max(
    bodies,
    ...attacks.map((attack) => (attack.projectile ? Math.max(Number(attack.range ?? 0), bodies) : Number(attack.range ?? 0) + bodies))
  );
  const swing = Math.max(12, (attackRange ?? bodies) - 8);
  const standoff = Math.max(bodies, Math.min(keepDistance, swing));
  return {
    kind: KINDS[behavior] ?? null,
    mover: moveSpeed > 0,
    r: radius,
    reach,
    standoffGap: standoff - bodies,
    cadenceMs: attackTimerMs,
  };
};
const KINDS = { CHASE_AI: "chase", KITE_AI: "kite", TELEPORT_AI: "teleport" };

/**
 * What an attack row is to the swing counts: a `shot` throws a projectile, a
 * `contact` swing neither throws nor moves the monster and reaches 140 or
 * less (npc-act.js `isContactAttack`), and anything else — a lunge, a long
 * aura — is `other`.
 */
export const attackClassOf = (attack) =>
  attack?.Projectile ? "shot" : Number(attack?.MoveAmount) > 0 || Number(attack?.Range ?? 0) > 140 ? "other" : "contact";

const emptyKind = () => ({ swings: 0, arrived: 0, advancing: 0, allowed: 0 });
const emptyOutcomes = () => ({ n: 0, waits: 0, slides: 0, pushes: 0, aside: 0, backs: 0, jitters: 0, overlapping: 0 });

export const emptyCrowd = () => ({
  samples: 0,
  engaged: 0,
  overlap: 0,
  overlapAny: 0,
  blocked: emptyOutcomes(),
  blockedHeroStill: emptyOutcomes(),
  blockedHeroMoved: emptyOutcomes(),
  swings: Object.fromEntries(
    ["chase", "kite", "teleport"].flatMap((kind) => ["contact", "other", "shot"].map((what) => [`${kind} ${what}`, emptyKind()]))
  ),
  due: { allowed: 0, allowedSwung: 0, held: 0, heldSwung: 0 },
});

const hypot = (x, y) => Math.hypot(x, y);

/**
 * A monster in a sample: `{ id, kind: "chase"|"kite"|"teleport", mover, x, y
 * (feet), bx, by (body), r, reach, standoffGap, cadenceMs }`. `reach` is the
 * furthest it may swing from, middle to middle, given its body and the
 * hero's; `standoffGap` how far its body stops off the hero's (0 for a
 * chaser). `onSwing` and `onDue`, when given, are handed each swing and each
 * due sample with the gap and the advance it was counted by.
 */
export const createCrowdMetrics = ({ tickMs = 250, onSwing = null, onDue = null } = {}) => {
  const counts = emptyCrowd();
  const history = new Map();
  const lastSwing = new Map();
  const pending = [];
  const lookbackTicks = Math.round(ADVANCE_LOOKBACK_MS / tickMs);
  const lookaheadMs = LOOKAHEAD_MS;

  /** How much nearer the hero it came over the lookback, null when it was not there. */
  const advanceOf = (monster, hero, t) => {
    const past = history.get(monster.id);
    const before = past?.find((entry) => entry.t === t - lookbackTicks * tickMs);
    if (!before) return null;
    const toX = hero.bx - monster.bx;
    const toY = hero.by - monster.by;
    const length = hypot(toX, toY) || 1;
    return ((monster.bx - before.bx) * toX + (monster.by - before.by) * toY) / length;
  };

  const resolveBlocked = (entry, byId, hero) => {
    const a = byId.get(entry.a);
    const b = byId.get(entry.b);
    if (!a || !hero) return;
    const dx = a.bx - entry.ax;
    const dy = a.by - entry.ay;
    const advance = dx * entry.ux + dy * entry.uy;
    const across = Math.abs(-dx * entry.uy + dy * entry.ux);
    const moved = hypot(dx, dy);
    const bdx = b ? b.bx - entry.bx : 0;
    const bdy = b ? b.by - entry.by : 0;
    const pushB = bdx * entry.ux + bdy * entry.uy;
    const asideB = Math.abs(-bdx * entry.uy + bdy * entry.ux);
    const outcome =
      moved < WAIT_MOVE
        ? "waits"
        : advance < -20
          ? "backs"
          : asideB > 25 && advance > 15
            ? "aside"
            : pushB > 15 && advance > 15
              ? "pushes"
              : across > 20
                ? "slides"
                : "jitters";
    const heroMoved = hypot(hero.x - entry.hx, hero.y - entry.hy) >= WAIT_MOVE;
    for (const into of [counts.blocked, heroMoved ? counts.blockedHeroMoved : counts.blockedHeroStill]) {
      into.n++;
      into[outcome]++;
      if (b && hypot(a.bx - b.bx, a.by - b.by) < a.r + b.r - OVERLAP_DEPTH) into.overlapping++;
    }
  };

  /**
   * One sample at `t`: `hero` `{ x, y, bx, by, r }` or null, `monsters` the
   * living ones, `swung` the ids that swung since the sample before, `pets`
   * the victims a monster might be swinging at instead, `{ x, y }`.
   */
  const sample = (t, hero, monsters, swung = [], pets = []) => {
    counts.samples++;
    const byId = new Map(monsters.map((monster) => [monster.id, monster]));
    while (pending.length && pending[0].due <= t) resolveBlocked(pending.shift(), byId, hero);
    if (hero) {
      const swungNow = new Map(swung.map((swing) => [swing.id, swing]));
      for (const a of monsters) {
        const feet = hypot(a.x - hero.x, a.y - hero.y);
        if (feet > ENGAGED_WITHIN) continue;
        counts.engaged++;
        let deepest = -Infinity;
        for (const b of monsters) {
          if (b === a) continue;
          deepest = Math.max(deepest, a.r + b.r - hypot(a.bx - b.bx, a.by - b.by));
        }
        if (deepest > OVERLAP_DEPTH) counts.overlap++;
        if (deepest > 0) counts.overlapAny++;

        const toHero = hypot(hero.bx - a.bx, hero.by - a.by);
        const gap = toHero - a.r - hero.r;
        const ux = (hero.bx - a.bx) / (toHero || 1);
        const uy = (hero.by - a.by) / (toHero || 1);
        if (a.kind === "chase" && a.mover && feet <= BLOCKED_WITHIN && gap >= BLOCKED_GAP) {
          let blocker = null;
          let nearest = Infinity;
          for (const b of monsters) {
            if (b === a) continue;
            const dx = b.bx - a.bx;
            const dy = b.by - a.by;
            const along = dx * ux + dy * uy;
            const across = Math.abs(-dx * uy + dy * ux);
            const span = a.r + b.r;
            if (along <= 0 || along >= span + 25 || across >= span * 0.8) continue;
            if (hypot(hero.bx - b.bx, hero.by - b.by) >= toHero) continue;
            const distance = hypot(dx, dy);
            if (distance < nearest) {
              nearest = distance;
              blocker = b;
            }
          }
          if (blocker) {
            pending.push({
              due: t + lookaheadMs,
              a: a.id,
              b: blocker.id,
              ax: a.bx,
              ay: a.by,
              bx: blocker.bx,
              by: blocker.by,
              ux,
              uy,
              hx: hero.x,
              hy: hero.y,
            });
          }
        }

        const nearerPet = pets.some((pet) => hypot(pet.x - a.x, pet.y - a.y) < feet);
        const arrived = gap <= (a.standoffGap ?? 0) + ARRIVED_SLACK;
        const advance = advanceOf(a, hero, t);
        const advancing = advance !== null && advance >= ADVANCE_MIN;
        const allowed = arrived || advancing;
        const swings = swungNow.has(a.id);
        if (swings && !nearerPet) {
          const kind = counts.swings[`${a.kind} ${swungNow.get(a.id).what ?? "contact"}`];
          kind.swings++;
          if (arrived) kind.arrived++;
          if (advancing) kind.advancing++;
          if (allowed) kind.allowed++;
          onSwing?.({ t, monster: a, gap, advance, toHero });
        }
        const inReach = toHero <= a.reach + REACH_SLACK;
        const due = t - (lastSwing.get(a.id) ?? -Infinity) >= (a.cadenceMs ?? 0);
        if (inReach && due && !nearerPet) onDue?.({ t, monster: a, gap, advance, toHero, allowed, swings, since: t - (lastSwing.get(a.id) ?? -Infinity) });
        if (inReach && due && !nearerPet && a.kind !== "teleport") {
          if (allowed) {
            counts.due.allowed++;
            if (swings) counts.due.allowedSwung++;
          } else {
            counts.due.held++;
            if (swings) counts.due.heldSwung++;
          }
        }
      }
    }
    for (const { id } of swung) lastSwing.set(id, t);
    for (const monster of monsters) {
      const past = history.get(monster.id) ?? [];
      past.push({ t, bx: monster.bx, by: monster.by });
      while (past.length > lookbackTicks + 1) past.shift();
      history.set(monster.id, past);
    }
  };

  return { sample, result: () => counts };
};

/** Several results summed. */
export const mergeCrowd = (results) => {
  const into = emptyCrowd();
  const add = (target, source) => {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (typeof value === "number") target[key] = (target[key] ?? 0) + value;
      else add((target[key] ??= {}), value);
    }
  };
  for (const result of results) add(into, result);
  return into;
};

const share = (part, whole) => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "-");

/** The counts as lines of text. */
export const describeCrowd = (crowd) => {
  const lines = [];
  lines.push(
    `  crowd: engaged ${crowd.engaged}  body overlap >${OVERLAP_DEPTH} ${share(crowd.overlap, crowd.engaged)}  any ${share(crowd.overlapAny, crowd.engaged)}`
  );
  const outcomes = (label, o) =>
    `  ${label.padEnd(18)} n ${String(o.n).padStart(6)}  waits ${share(o.waits, o.n).padStart(6)}  slides ${share(o.slides, o.n).padStart(6)}  ` +
    `pushes ${share(o.pushes, o.n).padStart(6)}  aside ${share(o.aside, o.n).padStart(6)}  backs ${share(o.backs, o.n).padStart(6)}  ` +
    `jitters ${share(o.jitters, o.n).padStart(6)}  ends overlapping ${share(o.overlapping, o.n).padStart(6)}`;
  lines.push(outcomes("blocked", crowd.blocked));
  lines.push(outcomes("  hero still", crowd.blockedHeroStill));
  lines.push(outcomes("  hero moved", crowd.blockedHeroMoved));
  for (const [kind, k] of Object.entries(crowd.swings)) {
    if (!k.swings) continue;
    lines.push(
      `  swings ${kind.padEnd(14)} n ${String(k.swings).padStart(6)}  at walk's end ${share(k.arrived, k.swings).padStart(6)}  ` +
        `advancing ${share(k.advancing, k.swings).padStart(6)}  either ${share(k.allowed, k.swings).padStart(6)}`
    );
  }
  const d = crowd.due;
  lines.push(
    `  due in reach: allowed ${d.allowed} swung ${share(d.allowedSwung, d.allowed)}  held ${d.held} swung ${share(d.heldSwung, d.held)}`
  );
  return lines;
};
