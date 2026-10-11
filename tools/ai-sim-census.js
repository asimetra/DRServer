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
 * The official, over 70 captures and 3400 monsters (18,668 engaged seconds):
 * 1.62 headings and 0.196 flips a second, no duplicate in 195,700 headings,
 * and a heading in the tick of 97% of 11,140 choreographies. Of about 472,000
 * official monster samples, the body circle touches the scenery in 13.4% and
 * the feet circle in 4.3%; the body overlaps it in 0-2.3% a row, the feet in
 * 3-18%.
 */

const FIELD_UPDATE = 124;
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
 * A census of one run; `tick` after each AI tick, `result` at the end.
 * `modules` are the root's (tools/ai-sim-lib.js `loadRoot`), for its
 * navigation and its NPC rows.
 */
export const createCensus = async (modules) => {
  const gm = await modules.gamemaster.loadGameMaster();
  const scaleOf = new Map((gm.raw.Npc ?? []).map((row) => [row.Constant, Number(row.Scale ?? 1) || 1]));
  const { navigationEntryFor, isPositionBlocked } = modules.navigation;
  const sample = (navigation, actor, row) => {
    const shape = navigationEntryFor(actor.constant)?.navCollisions?.[0];
    const scale = Number(actor.scale) > 0 ? Number(actor.scale) : (scaleOf.get(actor.constant) ?? 1);
    const feet = actor.position;
    const body = shape ? { x: feet.x + Number(shape.x ?? 0) * scale, y: feet.y + Number(shape.y ?? 0) * scale } : feet;
    const radius = Math.max(12, actor.ai?.collisionRadius ?? actor.collisionRadius ?? 35);
    row.samples++;
    if (isPositionBlocked(navigation, body, radius)) row.bodyIn++;
    if (isPositionBlocked(navigation, feet, radius)) row.feetIn++;
    if (isPositionBlocked(navigation, body, radius + TOUCH)) row.bodyTouching++;
    if (isPositionBlocked(navigation, feet, radius + TOUCH)) row.feetTouching++;
  };
  const rows = new Map();
  const lastHeading = new Map();
  const rowOf = (constant) => {
    let row = rows.get(constant);
    if (!row) rows.set(constant, (row = emptyRow()));
    return row;
  };
  const isMonster = (actor) => actor?.ai?.kind === "enemy";

  const tick = (session, frames) => {
    for (const actor of session.actors.values()) {
      if (!isMonster(actor) || actor.dead || actor.teleportHidden || !actor.ai.engaged || !actor.position) continue;
      rowOf(actor.constant).engagedTicks++;
      if (session.navigation) sample(session.navigation, actor, rowOf(actor.constant));
    }
    const headingsThisTick = new Map();
    const swungThisTick = new Set();
    for (const frame of frames) {
      const update = fieldUpdateOf(frame);
      if (!update) continue;
      const actor = session.actors.get(update.doid);
      if (!isMonster(actor)) continue;
      const row = rowOf(actor.constant);
      if (update.field === CHOREOGRAPHY) {
        row.swings++;
        swungThisTick.add(update.doid);
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
  };

  return { tick, result: () => Object.fromEntries(rows) };
};

/** Several runs' results, summed per row. */
export const mergeCensus = (results) => {
  const rows = {};
  for (const result of results) {
    for (const [constant, counts] of Object.entries(result)) {
      const row = (rows[constant] ??= emptyRow());
      for (const key of Object.keys(row)) row[key] += counts[key] ?? 0;
    }
  }
  return rows;
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
export const describeCensus = (label, rows, tickSeconds, { top = 8 } = {}) => {
  const total = mergeCensus([rows]);
  const sum = Object.values(total).reduce((into, row) => {
    for (const key of Object.keys(into)) into[key] += row[key];
    return into;
  }, emptyRow());
  const lines = [`${label}`, line("all monsters", sum, tickSeconds)];
  const ranked = Object.entries(total).sort((a, b) => b[1].engagedTicks - a[1].engagedTicks).slice(0, top);
  for (const [constant, row] of ranked) lines.push(line(constant, row, tickSeconds));
  return lines;
};
