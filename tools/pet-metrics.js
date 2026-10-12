/**
 * What the pets of a run did, counted as the analysis of the captures counts
 * a played pet (`tools/ai-sim.js --stats`, through tools/ai-sim-census.js):
 * every quarter second, per pet row, from the row's own TetherDist,
 * ReturnDist and AggroRadius.
 *
 *   staring    the share of its time it stood (under 15 units in 2 s), had
 *              not swung for 2 s, and had a monster for a target that a
 *              wall hid from it
 *   leash      stretches of more than 15 s farther than TetherDist from its
 *              owner, and the farthest it got
 *   heading back  of the seconds that began with it between TetherDist and
 *              1.5 TetherDist from an owner who then stood (under 60) in its
 *              sight, the share it closed 50 or more on him in. In sight,
 *              because two of the harness's heroes walk through walls and
 *              leave it no way back; an official owner does not
 *   swings     its swings, and the share at a target farther than
 *              TetherDist from its owner
 *   rest       where it stands from its owner, as a share of ReturnDist,
 *              when no monster is within its aggro radius, its owner has
 *              moved under 20 in the last second and it under 15 in two
 *   behind owner  the share of its time it stood and had not swung, as for
 *              staring, with a monster for a target in its sight and its
 *              owner's body across the line to it
 *   held back  of the quarter seconds it was farther than TetherDist from
 *              its owner with a monster's body touching it (within 5) in
 *              its way to him (70 degrees), the share it stood (under 15)
 *              the next second; and the same with none touching
 *   snaps      the times it was put back beside its owner from afar
 *              (behaviours/pet.js `snapBackSpot`): over 1000 in one tick,
 *              which a teleporting pet's come-back beside its victim is too
 *   overlap    of the quarter seconds it moved 5 or more, the share it
 *              ended more than 5 inside its owner's body; and of those it
 *              stood (as for rest), the share it stood so
 *
 * The official, over the solo captures (WOLF_PET, RHINO_PET, DRAGON_PET):
 * staring 3.8%, 4.4%, 0.0% of the time; no leash stretch over 15 s; heading
 * back 66%, 87%, 85-95%; swings beyond TetherDist 4%, 8%, 31% (n 401, 117,
 * 13); rest p50 0.61, 0.68, 0.55 of ReturnDist, in 7, 17 and 5 stands;
 * overlapping its owner moving 2.2%, 1.4%, 1.8% (radius 29.4 against the
 * hero's 25.87); snaps 1, 13, 0, from 1996-2205; held back 10.6%, 31.7%,
 * 0.0% (n 189, 60, 18) against 12.1%, 8.8%, 1.4% with none touching.
 */

const CHOREOGRAPHY = 143;
const FIELD_UPDATE = 124;
const TICKS_PER_SECOND = 4;
const STARE_TICKS = 2 * TICKS_PER_SECOND;
const LEASH_TICKS = 15 * TICKS_PER_SECOND;

const emptyRow = () => ({
  ticks: 0,
  staring: 0,
  leashStretches: 0,
  farthest: 0,
  backChances: 0,
  backs: 0,
  swings: 0,
  swingsBeyond: 0,
  rest: [],
  behindOwner: 0,
  snaps: 0,
  heldBack: 0,
  heldBackStood: 0,
  freeBack: 0,
  freeBackStood: 0,
  moving: 0,
  overlapMoving: 0,
  standing: 0,
  overlapStanding: 0,
});

/** A move longer than this in one tick is no walk: a snap back. */
const SNAP_TRAVEL = 1000;

/** How far off its way to its owner a monster touching it is still in it, as a cosine. */
const AHEAD = Math.cos((70 * Math.PI) / 180);

/** How far inside its owner's body a pet has to be to count as overlapping him. */
const OVERLAP_SLACK = 5;

/** Whether a circle at `centre` of `radius` crosses the segment from `a` to `b`. */
const crosses = (a, b, centre, radius) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length > 0 ? Math.max(0, Math.min(1, ((centre.x - a.x) * dx + (centre.y - a.y) * dy) / length)) : 0;
  return Math.hypot(a.x + t * dx - centre.x, a.y + t * dy - centre.y) < radius;
};

const hypot = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * `rowsByConstant` the NPC rows, `sees(navigation, from, to)` the root's
 * sight line between two points, `bodyOf(actor)` where its body is.
 */
export const createPetMetrics = ({ rowsByConstant, sees, bodyOf }) => {
  const rows = new Map();
  const tracks = new Map();
  const rowOf = (constant) => {
    let row = rows.get(constant);
    if (!row) rows.set(constant, (row = emptyRow()));
    return row;
  };

  const tick = (session, frames) => {
    const swung = new Set();
    for (const frame of frames) {
      if (frame.length >= 10 && frame.readUInt16LE(2) === FIELD_UPDATE && frame.readUInt16LE(8) === CHOREOGRAPHY) {
        swung.add(frame.readUInt32LE(4));
      }
    }
    for (const [doid, actor] of session.actors) {
      const { ai } = actor;
      if (ai?.kind !== "pet" || actor.dead || actor.teleportHidden || !actor.position) continue;
      const source = rowsByConstant.get(actor.constant);
      const ownerActor = session.actors.get(ai.ownerDoid);
      const owner = ai.ownerDoid === session.heroDoid ? (session.heroPosition ?? ownerActor?.position) : ownerActor?.position;
      if (!source || !owner) continue;
      const tether = Number(source.TetherDist ?? 0) || Infinity;
      const row = rowOf(actor.constant);
      row.ticks++;
      const track = tracks.get(doid) ?? { pet: [], owner: [], swung: [], beyond: 0, backs: [], ticks: 0 };
      tracks.set(doid, track);
      track.pet.push({ ...actor.position });
      track.owner.push({ ...owner });
      track.swung.push(swung.has(doid));
      for (const list of [track.pet, track.owner, track.swung]) if (list.length > STARE_TICKS + 1) list.shift();
      const ownerDistance = hypot(actor.position, owner);
      const target = session.actors.get(ai.targetDoid);
      const enemy = target && !target.dead && target.position && target.isEnemy ? target : null;

      if (swung.has(doid)) {
        row.swings++;
        if (enemy && hypot(enemy.position, owner) > tether) row.swingsBeyond++;
      }

      const span = track.pet.length - 1;
      const stood = span >= STARE_TICKS && hypot(track.pet[0], actor.position) < 15;
      const inSight = enemy && (!session.navigation || sees(session.navigation, bodyOf(actor), bodyOf(enemy)));
      if (stood && !track.swung.some(Boolean) && enemy && !inSight) row.staring++;
      const ownerRadius = Math.max(12, ownerActor?.collisionRadius ?? 35);
      if (stood && !track.swung.some(Boolean) && inSight && crosses(actor.position, enemy.position, owner, ownerRadius)) {
        row.behindOwner++;
      }
      const inside = ownerDistance < Math.max(12, ai.collisionRadius ?? 35) + ownerRadius - OVERLAP_SLACK;
      if (span >= 1 && hypot(track.pet[span - 1], actor.position) > SNAP_TRAVEL) row.snaps++;
      if (span >= 1 && hypot(track.pet[span - 1], actor.position) >= 5) {
        row.moving++;
        if (inside) row.overlapMoving++;
      }

      // A quarter second walking back, judged a second on.
      track.ticks++;
      while (track.backs.length && track.backs[0].tick <= track.ticks - TICKS_PER_SECOND) {
        const { at, held } = track.backs.shift();
        const stoodStill = hypot(at, actor.position) < 15;
        if (held) { row.heldBack++; if (stoodStill) row.heldBackStood++; }
        else { row.freeBack++; if (stoodStill) row.freeBackStood++; }
      }
      if (ownerDistance > tether && ownerDistance > 0) {
        const way = { x: (owner.x - actor.position.x) / ownerDistance, y: (owner.y - actor.position.y) / ownerDistance };
        const own = bodyOf(actor);
        const reach = Math.max(12, ai.collisionRadius ?? 35) + 5;
        const held = [...session.actors.values()].some((other) => {
          if (!other.isEnemy || other.dead || !other.position || other.teleportHidden) return false;
          const at = bodyOf(other);
          const dx = at.x - own.x;
          const dy = at.y - own.y;
          const apart = Math.hypot(dx, dy);
          return apart < reach + Math.max(12, other.ai?.collisionRadius ?? other.collisionRadius ?? 35) &&
            (apart < 0.001 || (dx * way.x + dy * way.y) / apart >= AHEAD);
        });
        track.backs.push({ tick: track.ticks, at: { ...actor.position }, held });
      }
      if (ownerDistance > tether) {
        track.beyond++;
        if (track.beyond === LEASH_TICKS + 1) row.leashStretches++;
        row.farthest = Math.max(row.farthest, ownerDistance);
      } else track.beyond = 0;

      const back = span >= TICKS_PER_SECOND ? TICKS_PER_SECOND : 0;
      if (back) {
        const thenPet = track.pet[span - back];
        const thenOwner = track.owner[span - back];
        const then = hypot(thenPet, thenOwner);
        const ownerInSight = !session.navigation || sees(session.navigation, bodyOf(actor), owner);
        if (then > tether && then <= 1.5 * tether && hypot(thenOwner, owner) < 60 && ownerInSight) {
          row.backChances++;
          if (ownerDistance <= then - 50) row.backs++;
        }
      }

      const aggro = Number(source.AggroRadius ?? 0);
      const quiet = ![...session.actors.values()].some(
        (other) => other.isEnemy && !other.dead && other.hitPoints > 0 && other.position && hypot(other.position, actor.position) <= aggro
      );
      const ownerStill = span >= TICKS_PER_SECOND && hypot(track.owner[span - TICKS_PER_SECOND], owner) < 20;
      if (quiet && stood && ownerStill && Number(source.ReturnDist) > 0) {
        row.rest.push(Math.round((100 * ownerDistance) / Number(source.ReturnDist)) / 100);
        row.standing++;
        if (inside) row.overlapStanding++;
      }
    }
  };

  return { tick, result: () => Object.fromEntries(rows) };
};

/** Several runs' pets, summed per row. */
export const mergePets = (results) => {
  const rows = {};
  for (const result of results) {
    for (const [constant, counts] of Object.entries(result ?? {})) {
      const row = (rows[constant] ??= emptyRow());
      for (const key of Object.keys(row)) {
        if (key === "rest") row.rest.push(...(counts.rest ?? []));
        else if (key === "farthest") row.farthest = Math.max(row.farthest, counts.farthest ?? 0);
        else row[key] += counts[key] ?? 0;
      }
    }
  }
  return rows;
};

const quantile = (values, q) => {
  if (!values.length) return "-";
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(2);
};
const share = (part, whole) => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "-");

/** The pets as text, a line per row. */
export const describePets = (rows) =>
  Object.entries(rows ?? {}).map(
    ([constant, row]) =>
      `  pet ${constant.padEnd(22)} ${(row.ticks / TICKS_PER_SECOND).toFixed(0).padStart(6)} s  ` +
      `staring ${share(row.staring, row.ticks).padStart(6)}  leash >15 s ${row.leashStretches} (farthest ${row.farthest.toFixed(0)}, snaps ${row.snaps})  ` +
      `heading back ${share(row.backs, row.backChances)} of ${row.backChances}  ` +
      `swings ${row.swings}, beyond TetherDist ${share(row.swingsBeyond, row.swings)}  ` +
      `rest/ReturnDist p10/50/90 ${quantile(row.rest, 0.1)}/${quantile(row.rest, 0.5)}/${quantile(row.rest, 0.9)} (n ${row.rest.length})  ` +
      `behind owner ${share(row.behindOwner, row.ticks)}  ` +
      `in owner moving ${share(row.overlapMoving, row.moving)} of ${row.moving}, resting ${share(row.overlapStanding, row.standing)}  ` +
      `held back stood ${share(row.heldBackStood, row.heldBack)} of ${row.heldBack}, free ${share(row.freeBackStood, row.freeBack)} of ${row.freeBack}`
  );
