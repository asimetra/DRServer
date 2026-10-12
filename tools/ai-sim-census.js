/**
 * What the monsters of one run did, counted: `tools/ai-sim.js --stats`.
 *
 * The hashes say whether two roots did the same thing; when a change is meant
 * to make them differ, they cannot say by how much, or whether towards the
 * official. This counts what the corpus was measured on, over the monsters an
 * enemy row put on the floor, per row and in total, beside the hashes and
 * without touching what they hash: nothing here draws a random or writes to
 * the session.
 *
 *   engaged     monster-seconds engaged with a target, alive and on the floor
 *   headings    heading updates sent (field 133), per engaged second
 *   duplicates  heading updates beyond the first one a monster got in a tick
 *   flips       sent headings that turned it from facing left to right or
 *               back, per engaged second: the sprite mirrors on each
 *   swings      choreographies sent (field 143), and the share of them with
 *               a heading in the same tick
 *   in walls    of the samples (a monster engaged, each tick),
 *               the share whose body circle overlaps the scenery, and whose
 *               circle drawn at the feet does; "touching" the same with two
 *               units more. The body is the library's circle above the feet
 *               at the size the monster is drawn — the generate's scale where
 *               the actor carries it, the row's `Scale` where it does not —
 *               worked out here the same way for every root, so it measures
 *               where a root puts its monsters, not how it reckons bodies.
 *
 *   pets        what the player's pet did: staring at a monster behind a
 *               wall, its leash, where it rests (tools/pet-metrics.js)
 *
 *   crowd       how the monsters crowd round the hero, counted by
 *               tools/crowd-metrics.js as tools/crowd-corpus.js counts the
 *               official: bodies overlapping, what a chaser held behind
 *               another does, and whether a swing comes at the end of its
 *               walk or on the way in.
 *
 * The official, over 70 captures and 3400 monsters (18,668 engaged seconds):
 * 1.62 headings and 0.196 flips a second, no duplicate in 195,700 headings,
 * and a heading in the tick of 97% of 11,140 choreographies. Of about 472,000
 * official monster samples, the body circle touches the scenery in 13.4% and
 * the feet circle in 4.3%; the body overlaps it in 0-2.3% a row, the feet in
 * 3-18%.
 */

import { attackClassOf, createCrowdMetrics, crowdProfile, describeCrowd, mergeCrowd } from "./crowd-metrics.js";
import { createPetMetrics, describePets, mergePets } from "./pet-metrics.js";

const FIELD_UPDATE = 124;
/** Every hero's body as the corpus is counted with (tools/crowd-corpus.js): radius 25.87, its middle as far above the feet. */
const HERO_RADIUS = 25.87;
const HEADING = 133;
const CHOREOGRAPHY = 143;

const emptyRow = () => ({
  engagedTicks: 0,
  headings: 0,
  duplicates: 0,
  flips: 0,
  swings: 0,
  swingsFaced: 0,
  samples: 0,
  bodyIn: 0,
  feetIn: 0,
  bodyTouching: 0,
  feetTouching: 0,
});
const TOUCH = 2;

/** The doid, field and frame of a field update, or null for anything else. */
const fieldUpdateOf = (frame) =>
  frame.length >= 10 && frame.readUInt16LE(2) === FIELD_UPDATE
    ? { doid: frame.readUInt32LE(4), field: frame.readUInt16LE(8) }
    : null;

const facesRight = (heading) => Math.cos((heading * Math.PI) / 180) >= 0;

/**
 * A census of one run; `tick` after each AI tick, with its clock, `result` at the end.
 * `modules` are the root's (tools/ai-sim-lib.js `loadRoot`), for its
 * navigation and its NPC rows.
 */
export const createCensus = async (modules) => {
  const gm = await modules.gamemaster.loadGameMaster();
  const scaleOf = new Map((gm.raw.Npc ?? []).map((row) => [row.Constant, Number(row.Scale ?? 1) || 1]));
  const { navigationEntryFor, isPositionBlocked, hasLineOfSight } = modules.navigation;
  /** Its body: the library's circle above the feet, at the size it is drawn. */
  const bodyOf = (actor) => {
    const shape = navigationEntryFor(actor.constant)?.navCollisions?.[0];
    const scale = Number(actor.scale) > 0 ? Number(actor.scale) : (scaleOf.get(actor.constant) ?? 1);
    const feet = actor.position;
    return shape ? { x: feet.x + Number(shape.x ?? 0) * scale, y: feet.y + Number(shape.y ?? 0) * scale } : feet;
  };
  const sample = (navigation, actor, row) => {
    const feet = actor.position;
    const body = bodyOf(actor);
    const radius = Math.max(12, actor.ai?.collisionRadius ?? actor.collisionRadius ?? 35);
    row.samples++;
    if (isPositionBlocked(navigation, body, radius)) row.bodyIn++;
    if (isPositionBlocked(navigation, feet, radius)) row.feetIn++;
    if (isPositionBlocked(navigation, body, radius + TOUCH)) row.bodyTouching++;
    if (isPositionBlocked(navigation, feet, radius + TOUCH)) row.feetTouching++;
  };
  const rows = new Map();
  const petCensus = createPetMetrics({
    rowsByConstant: new Map((gm.raw.Npc ?? []).map((row) => [row.Constant, row])),
    sees: (navigation, from, to) => hasLineOfSight(navigation, from, to, 0),
    bodyOf,
  });
  const lastHeading = new Map();
  const attackRows = new Map((gm.raw.Attack ?? []).map((attack) => [attack.Id, attack]));
  const crowd = createCrowdMetrics({ tickMs: 250 });
  let sampleClock = 0;
  const profiles = new Map();
  const profileOf = (actor) => {
    let profile = profiles.get(actor);
    if (!profile) {
      const { ai } = actor;
      profile = crowdProfile(
        {
          behavior: ai.behavior,
          moveSpeed: ai.moveSpeed ?? 0,
          radius: Math.max(12, ai.collisionRadius ?? actor.collisionRadius ?? 35),
          attacks: ai.attacks ?? [{ range: ai.attackRange ?? 0, projectile: ai.projectile }],
          keepDistance: ai.keepDistance ?? 0,
          attackRange: ai.attackRange,
          attackTimerMs: ai.attackTimerMs ?? 1500,
        },
        HERO_RADIUS
      );
      profiles.set(actor, profile);
    }
    return profile;
  };
  const sampleCrowd = (session, swings) => {
    const heroActor = session.actors.get(session.heroDoid);
    const at = heroActor && !heroActor.dead ? (session.heroPosition ?? heroActor.position) : null;
    const hero = at ? { x: at.x, y: at.y, bx: at.x, by: at.y - HERO_RADIUS, r: HERO_RADIUS } : null;
    const monsters = [];
    const pets = [];
    for (const [doid, actor] of session.actors) {
      if (actor.dead || actor.teleportHidden || !actor.position || !actor.ai) continue;
      if (actor.ai.kind === "pet") pets.push({ x: actor.position.x, y: actor.position.y });
      if (!isMonster(actor) || !(actor.hitPoints > 0)) continue;
      const profile = profileOf(actor);
      if (!profile.kind) continue;
      const body = bodyOf(actor);
      monsters.push({ id: doid, constant: actor.constant, ...profile, x: actor.position.x, y: actor.position.y, bx: body.x, by: body.y });
    }
    crowd.sample(sampleClock, hero, monsters, swings, pets);
    sampleClock += 250;
  };
  const rowOf = (constant) => {
    let row = rows.get(constant);
    if (!row) rows.set(constant, (row = emptyRow()));
    return row;
  };
  const isMonster = (actor) => actor?.ai?.kind === "enemy";

  /**
   * Frozen chasers: a CHASE_AI that walks, engaged, not stunned, rooted,
   * staggered or thrown, its route found and not ending short, chasing (not
   * swinging, locked or lunging), with no other monster's body in its
   * way — within 70 degrees of the way to its next waypoint, touching or 12
   * off — nor pinched between two, and standing within a unit of one spot
   * for 3 s or more. Nothing explains such a stand; the run fails on any
   * (tools/ai-sim.js).
   *
   * Pinched: touching a body (to two units) on each side of its way, one of
   * them ahead of its middle. Neither is in its way, so its wait ends and
   * its pass goes round nothing, but the walk slid along the one runs into
   * the other: two SKELETON_WARRIORs of smashing seed 1 smasher stood so
   * 3 s and more, between bodies 79 and 85, and 79 and 96 degrees off their
   * way (d5b4eae), and walked on when one of the two moved.
   */
  const stands = new Map();
  let frozen = 0;
  const frozenSeen = new Set();
  const frozenAt = [];
  const inTheWay = (session, actor, to) => {
    const at = bodyOf(actor);
    const radius = Math.max(12, actor.ai?.collisionRadius ?? 35);
    const length = Math.hypot(to.x - actor.position.x, to.y - actor.position.y) || 1;
    const ux = (to.x - actor.position.x) / length;
    const uy = (to.y - actor.position.y) / length;
    let left = false;
    let right = false;
    let ahead = false;
    for (const other of session.actors.values()) {
      if (other === actor || !other.ai || other.dead || !other.position) continue;
      const b = bodyOf(other);
      const dx = b.x - at.x;
      const dy = b.y - at.y;
      const d = Math.hypot(dx, dy);
      const touching = radius + Math.max(12, other.ai.collisionRadius ?? 35);
      if (d > touching + 12) continue;
      const along = (dx * ux + dy * uy) / (d || 1);
      if (along >= Math.cos((70 * Math.PI) / 180)) return true;
      if (d > touching + 2) continue;
      if (dx * uy - dy * ux > 0) left = true;
      else right = true;
      if (along > 0) ahead = true;
    }
    return left && right && ahead;
  };
  const sampleFrozen = (session, now) => {
    for (const [doid, actor] of session.actors) {
      const ai = actor.ai;
      if (!isMonster(actor) || actor.dead || !actor.position || !ai.engaged || ai.state !== "chase") continue;
      // A chaser that walks; held by a hit or a debuff it may not.
      const rooted = [...(session.activeBuffs?.values() ?? [])].some(
        (active) => active.affectedActor === doid && Number(active.buff?.MOVEMENT ?? 1) === 0
      );
      if (ai.behavior !== "CHASE_AI" || !(ai.moveSpeed > 0) || rooted || ai.shove || now < (ai.staggeredUntil ?? 0)) {
        stands.delete(doid);
        continue;
      }
      const points = ai.routing?.points;
      const next = points?.[ai.routing.next ?? 0];
      const fine = points?.length && !points.endsShort && !ai.routing.failed && next;
      const busy = now < (ai.attackLockedUntil ?? 0) || (ai.lunge && now < ai.lunge.until);
      const last = stands.get(doid);
      if (!fine || busy || inTheWay(session, actor, next)) {
        stands.delete(doid);
        continue;
      }
      if (last && Math.hypot(actor.position.x - last.x, actor.position.y - last.y) <= 1) {
        last.ticks++;
        if (last.ticks >= 12 && !frozenSeen.has(`${doid}@${last.since}`)) {
          frozenSeen.add(`${doid}@${last.since}`);
          frozen++;
          if (frozenAt.length < 5) frozenAt.push(`${session.id} ${actor.constant} ${doid} at ${Math.round(actor.position.x)},${Math.round(actor.position.y)}`);
        }
      } else stands.set(doid, { x: actor.position.x, y: actor.position.y, ticks: 0, since: now });
    }
  };
  const tick = (session, frames, now) => {
    sampleFrozen(session, now);
    for (const actor of session.actors.values()) {
      if (!isMonster(actor) || actor.dead || actor.teleportHidden || !actor.ai.engaged || !actor.position) continue;
      rowOf(actor.constant).engagedTicks++;
      if (session.navigation) sample(session.navigation, actor, rowOf(actor.constant));
    }
    const headingsThisTick = new Map();
    const swungThisTick = new Set();
    const crowdSwings = [];
    for (const frame of frames) {
      const update = fieldUpdateOf(frame);
      if (!update) continue;
      const actor = session.actors.get(update.doid);
      if (!isMonster(actor)) continue;
      const row = rowOf(actor.constant);
      if (update.field === CHOREOGRAPHY) {
        row.swings++;
        swungThisTick.add(update.doid);
        // After the field: i8 weapon slot, u8 consumable, u32 attack (combat-wire.js).
        const attack = frame.length >= 16 ? attackRows.get(frame.readUInt32LE(12)) : null;
        crowdSwings.push({ id: update.doid, what: attackClassOf(attack) });
      } else if (update.field === HEADING && frame.length >= 14) {
        const heading = frame.readFloatLE(10);
        row.headings++;
        const seen = headingsThisTick.get(update.doid) ?? 0;
        if (seen) row.duplicates++;
        headingsThisTick.set(update.doid, seen + 1);
        const before = lastHeading.get(update.doid);
        if (before !== undefined && facesRight(before) !== facesRight(heading)) row.flips++;
        lastHeading.set(update.doid, heading);
      }
    }
    for (const doid of swungThisTick) {
      if (headingsThisTick.has(doid)) rowOf(session.actors.get(doid).constant).swingsFaced++;
    }
    sampleCrowd(session, crowdSwings);
    petCensus.tick(session, frames);
  };

  return {
    tick,
    result: () => ({ rows: Object.fromEntries(rows), crowd: crowd.result(), frozen, frozenAt, pets: petCensus.result() }),
  };
};

/** Several runs' results, summed per row, and their crowds. */
export const mergeCensus = (results) => {
  const rows = {};
  for (const result of results) {
    for (const [constant, counts] of Object.entries(result.rows ?? {})) {
      const row = (rows[constant] ??= emptyRow());
      for (const key of Object.keys(row)) row[key] += counts[key] ?? 0;
    }
  }
  return {
    rows,
    crowd: mergeCrowd(results.map((result) => result.crowd).filter(Boolean)),
    frozen: results.reduce((sum, result) => sum + (result.frozen ?? 0), 0),
    frozenAt: results.flatMap((result) => result.frozenAt ?? []).slice(0, 8),
    pets: mergePets(results.map((result) => result.pets)),
  };
};

const line = (name, row, tickSeconds) => {
  const seconds = row.engagedTicks * tickSeconds;
  const perSecond = (count) => (seconds > 0 ? (count / seconds).toFixed(2) : "-");
  const share = (part, whole) => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "-");
  return (
    `  ${name.padEnd(26)} ${seconds.toFixed(0).padStart(7)} s  ` +
    `headings ${perSecond(row.headings).padStart(5)}/s  dup ${share(row.duplicates, row.headings).padStart(6)}  ` +
    `flips ${perSecond(row.flips).padStart(5)}/s  swings ${String(row.swings).padStart(5)} faced ${share(row.swingsFaced, row.swings).padStart(6)}  ` +
    `in walls body ${share(row.bodyIn, row.samples).padStart(6)} feet ${share(row.feetIn, row.samples).padStart(6)}  ` +
    `touching body ${share(row.bodyTouching, row.samples).padStart(6)} feet ${share(row.feetTouching, row.samples).padStart(6)}`
  );
};

/** The census as text: the total, then the rows with the most engaged time. */
export const describeCensus = (label, { rows, crowd, frozen = 0, frozenAt = [], pets = {} }, tickSeconds, { top = 8 } = {}) => {
  const total = rows;
  const sum = Object.values(total).reduce((into, row) => {
    for (const key of Object.keys(into)) into[key] += row[key];
    return into;
  }, emptyRow());
  const lines = [`${label}`, line("all monsters", sum, tickSeconds)];
  const ranked = Object.entries(total).sort((a, b) => b[1].engagedTicks - a[1].engagedTicks).slice(0, top);
  for (const [constant, row] of ranked) lines.push(line(constant, row, tickSeconds));
  if (crowd) lines.push(...describeCrowd(crowd));
  lines.push(`  frozen chasers (engaged, a route, nothing in the way, still 3 s or more): ${frozen}`);
  for (const where of frozenAt) lines.push(`    ${where}`);
  lines.push(...describePets(pets));
  return lines;
};
