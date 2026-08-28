#!/usr/bin/env node
/**
 * Builds the official's own floor on this server, and diffs the two streams.
 *
 *   node tools/replay-floor.js <capture.jsonl>
 *   node tools/replay-floor.js <capture.jsonl> --floor 2
 *   node tools/replay-floor.js <capture.jsonl> --keep   # leave the floor file
 *
 * Every comparison in this repository so far has been between *a* floor of ours
 * and *a* floor of theirs. Those are different rooms, so the only things
 * comparable were aggregates — how many of a constant, which values a field
 * ever took — and an aggregate hides the thing you want: this object, here,
 * differs.
 *
 * It does not have to be that way. A floor generate carries its whole tile
 * layout as `DungeonTileUsage` records, so the official tells us exactly which
 * rooms it laid and where. Writing those back out as an authored floor and
 * building it here puts both servers on the same ground, and then every object
 * can be matched by position and constant and compared field by field.
 *
 * The three rules this found by hand each took hours and each was a whole
 * class: `DefaultLayer` read as a fallback, `rotation` read as `heading`, and
 * a team chosen by "PROP or else enemy". This is that comparison done in one
 * command, against any of the 54 recordings.
 *
 * What it cannot do is see the client. A field that matches here can still
 * arrive somewhere that will not draw it — see docs/client-contract.md for the
 * four places that happens silently.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGameMaster, npcForConstant } from "../src/gamemaster.js";
import { loadFloor } from "../src/socket/floors.js";
import { loadNavigationLibrary } from "../src/socket/navigation.js";
import { buildFloorWorld } from "../src/socket/dungeon.js";
import { createMatchWorld } from "../src/socket/match-world.js";
import { CLID } from "../src/socket/opcodes.js";
import {
  classForClid,
  decodeFieldUpdate,
  decodeGenerate,
  framesOf,
  GENERATE_OPS,
} from "./wire.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const levels = path.join(root, "local-data", "Resources", "Levels");

const argument = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};

const FLOOR_DOID = 1002;
const HERO_DOID = 1003;
/**
 * The generate, as the schema says to read it rather than as a hand-counted
 * offset guesses.
 *
 * The readers this replaces were correct, but three of their siblings written
 * elsewhere in the same style were not, and every one of them looked just as
 * convincing — an official capture sends most objects under op 135, which
 * carries two bytes more than op 134, and a field counted from the end of the
 * frame therefore reads one thing here and another there. `decodeGenerate`
 * reports whether it consumed the frame exactly, so a misread announces itself
 * instead of turning into a finding.
 */
const npcFrom = ({ fields }) => ({
  type: fields.type,
  level: fields.level,
  x: Math.round(fields.position[0]),
  y: Math.round(fields.position[1]),
  heading: Math.round(fields.heading),
  scale: Number(fields.scale.toFixed(2)),
  flip: fields.flip,
  hitPoints: fields.hitPoints,
  /**
   * Carried, because adding it to `COMPARED` alone did nothing: the projection
   * dropped it, so the comparison had nothing to look at and the list stayed
   * silent. Two layers of the same omission, and the second was invisible.
   */
  weaponDetails: fields.weaponDetails,
  state: fields.state,
  team: fields.team,
  layer: fields.layer,
  triggerState: fields.remoteTriggerState,
  masterId: fields.masterId,
});

/** Every floor in a capture, with the objects the official parented to it. */
const readCapture = async (file) => {
  const floors = new Map();
  let unreadable = 0;

  const floorClass = classForClid(CLID.DistributedDungeonFloor);

  for await (const { body } of framesOf(file)) {
    // The later floors' layouts, sent as a field update just after the generate.
    if (body.readUInt16LE(0) === 124 && body.length >= 8 && body.readUInt16LE(6) === 195) {
      const floor = floors.get(body.readUInt32LE(2));
      if (!floor) continue;
      const update = decodeFieldUpdate(body, floorClass);
      if (update.error || !Array.isArray(update.value)) continue;
      floor.tiles = update.value.map(([x, y, tileId]) => ({ x, y, tileId }));
      continue;
    }
    if (!GENERATE_OPS.has(body.readUInt16LE(0))) continue;
    const decoded = decodeGenerate(body);
    if (decoded.error || decoded.trailing !== 0) { unreadable += 1; continue; }

    // Owner and remote heroes are children of the floor they actually belong
    // to. Counting unique hero doids across the whole file combines later
    // floors and later runs into one imaginary party.
    if (decoded.class?.replace(/Owner$/, "") === "HeroGameObject") {
      floors.get(decoded.parent)?.heroes.add(decoded.doid);
    }

    if (decoded.class === "DistributedDungeonFloor") {
      const { mapNodeId, coliseumTierConstant, tileLibrary, tiles } = decoded.fields;
      /**
       * Kept even when it arrives with no layout at all.
       *
       * Only the first floor of a run carries its tiles inside the generate.
       * Every floor after it is generated empty and told its layout a moment
       * later through field 195 — so gating on `tiles.length` here quietly
       * replayed 5 floors of a 24 floor recording and said nothing about the
       * other 19. The rare mechanisms are in those: both counter puzzles and
       * all three damage-statue floors of the catacombs capture.
       */
      floors.set(decoded.doid, {
        doid: decoded.doid,
        mapNodeId,
        tier: coliseumTierConstant,
        library: tileLibrary,
        tiles: tiles.map(([x, y, tileId]) => ({ x, y, tileId })),
        npcs: [],
        heroes: new Set(),
      });
      continue;
    }
    if (decoded.class === "DistributedNPCGameObject") {
      floors.get(decoded.parent)?.npcs.push(npcFrom(decoded));
    }
  }
  return {
    // A floor that never received a layout is one the recording only mentions.
    floors: [...floors.values()]
      .filter((floor) => floor.tiles.length)
      .map((floor) => ({ ...floor, partySize: Math.max(1, floor.heroes.size) })),
    unreadable,
  };
};

/** Writes the official's layout as an authored floor this server can load. */
const writeFloorFile = async (floor, name) => {
  const file = path.join("replay", `${name}.json`);
  await fs.promises.mkdir(path.join(levels, "replay"), { recursive: true });
  await fs.promises.writeFile(
    path.join(levels, file),
    `${JSON.stringify({
      _comment: `replayed from a capture — node ${floor.mapNodeId}, tier ${floor.tier}`,
      tileLibrary: floor.library,
      tiles: floor.tiles.map(({ x, y, tileId }) => ({ type: "LEFloorTile", tileId, x, y })),
    }, null, 1)}\n`
  );
  return file;
};

/** Builds it here, and returns the NPCs we put on the wire. */
const buildHere = async (file, { tier, npcLevel, partySize = 1 }) => {
  await loadNavigationLibrary();
  const floor = await loadFloor(file);
  const sent = [];
  let next = 1100;
  const makeMember = (index) => ({
    id: 800 + index,
    accountId: 800 + index,
    playerDoid: 900 + index,
    heroDoid: HERO_DOID + index,
    dungeonZone: 10,
    heroPosition: { x: floor.spawn?.x ?? 0, y: floor.spawn?.y ?? 0 },
    heroSpawn: {
      doid: HERO_DOID + index,
      heroType: 101,
      skinType: 151,
      playerId: 900 + index,
      screenName: `Replay${index + 1}`,
      experiencePoints: 0,
      slotPoints: [0, 0, 0, 0],
      weapons: [],
      consumables: [],
      hitPoints: 200,
      manaPoints: 100,
      effectiveHitPoints: 200,
      collisionRadius: 22,
      constant: "RANGER",
    },
    heroManaPoints: 100,
    maxHeroManaPoints: 100,
    dungeonBusterPoints: 0,
    objects: new Map(),
    actors: new Map(),
    doobers: new Map(),
    socket: { destroyed: false },
    allocateDoid(clid) {
      const doid = next++;
      if (clid !== undefined) this.objects.set(doid, clid);
      return doid;
    },
    send: index === 0 ? (frame) => sent.push(frame) : () => {},
  });
  const members = Array.from(
    { length: Math.max(1, Math.min(5, partySize)) },
    (_, index) => makeMember(index)
  );
  const seed = members[0];
  Object.assign(seed, {
    dungeonActive: true,
    dungeonEpoch: 1,
    mapNodeId: 50002,
    floorDoid: FLOOR_DOID,
    floorIndex: 0,
    floorCount: 1,
    npcLevel,
    floorPlan: { floors: [{ authored: file }], tier, npcLevel },
  });
  seed.objects.set(FLOOR_DOID, CLID.DistributedDungeonFloor);
  const world = createMatchWorld(
    { id: 1, members: new Set(members), floorIndex: 0 },
    seed
  );
  for (const member of members.slice(1)) world.contextFor(member);
  const session = world.contextFor(seed);

  try {
    await buildFloorWorld(session, { floor, floorDoid: FLOOR_DOID, isActive: () => true });
  } catch (error) {
    world.destroy();
    throw error;
  }

  // Read back through the same decoder the official's side goes through, so a
  // difference is a difference in what was sent and never in how it was read.
  const npcs = [];
  for (const frame of sent) {
    const body = frame.subarray(2);
    if (body.length < 16 || !GENERATE_OPS.has(body.readUInt16LE(0))) continue;
    const decoded = decodeGenerate(body);
    if (decoded.class !== "DistributedNPCGameObject") continue;
    if (decoded.error || decoded.trailing !== 0) {
      throw new Error(`this server emitted a generate we cannot read: ${decoded.error ?? `${decoded.trailing}B over`}`);
    }
    npcs.push({ ...npcFrom(decoded), doid: decoded.doid });
  }

  /**
   * What each triggerable was hanging off when we decided its state.
   *
   * A rate on its own says a rule is wrong somewhere; this says where. The
   * catacombs turned up `SPIKES_SKELETONSTATUE` generated on twelve times of
   * 191 where the official generates it off, and the useful half of that
   * sentence — which of its five wiring shapes the twelve are — took a separate
   * script to get at. It belongs in the report.
   */
  const gateOf = new Map((floor.placements.logicGate ?? []).map((g) => [g.id, g.constant]));
  const trigOf = new Map((floor.placements.trigger ?? []).map((t) => [t.id, t.constant]));
  const nameOf = (id) => gateOf.get(id) ?? trigOf.get(id) ?? "unplaced";
  const describe = (id, depth = 0) => {
    const sources = session.signalIncoming?.get(id) ?? [];
    if (!sources.length) return depth ? "nothing" : "nothing";
    return sources
      .map((source) =>
        gateOf.has(source) && depth < 1
          ? `${nameOf(source)}(${describe(source, depth + 1)})`
          : nameOf(source)
      )
      .sort()
      .join(" + ");
  };
  const wiring = new Map();
  for (const [placementId, doid] of session.triggerableDoids ?? []) {
    wiring.set(doid, describe(placementId));
  }
  for (const npc of npcs) npc.wiring = wiring.get(npc.doid);

  world.destroy();
  return npcs;
};

/**
 * Every field of the required block except the two that cannot disagree.
 *
 * `type` and `position` are the match key, so they are equal by construction.
 * `level` and `masterId` were missing from this list for as long as it existed
 * — the first is what feeds the health formula, and the second is the link a
 * trap holds to whatever drives it, so leaving them out hid exactly the kind of
 * difference the tool is for.
 *
 * `weaponDetails` was the third. The comment above this list used to say it was
 * "compared as a whole" and it was not compared at all — which is how a
 * difference found by hand, the official filling its empty weapon slots with
 * `requiredlevel` and `rarity` of 1 where this server leaves zeroes, went
 * through every replay report untouched.
 */
const COMPARED = [
  "level", "heading", "scale", "flip", "layer",
  "triggerState", "team", "hitPoints", "state", "masterId", "weaponDetails",
];

/** Four slots of numbers; compared by value, not by identity. */
const valueOf = (field) => (Array.isArray(field) ? JSON.stringify(field) : field);

/** One official floor, rebuilt here, matched object for object. */
const replay = async (floor, { gm, nameOf, label, into, partySize }) => {
  const file = await writeFloorFile(floor, `replay_${label}`);
  const tier = gm.raw.ColiseumTiers.find((row) => row.Constant === floor.tier) ?? null;

  let ours;
  try {
    ours = await buildHere(file, {
      tier,
      npcLevel: floor.npcs[0]?.level ?? 1,
      partySize,
    });
  } finally {
    if (!process.argv.includes("--keep")) {
      await fs.promises.rm(path.join(levels, file), { force: true });
    }
  }

  /**
   * Matched on the ground both servers stand on: a place and a constant.
   *
   * Held as lists rather than single values, because a square can hold more
   * than one of the same thing — the temple stacks nine mines within a few
   * units of each other, and a `Map` keyed this way quietly kept the last of
   * them and reported the rest as neither matched nor missing. Pairing them off
   * in order is arbitrary between identical objects and exact for the count.
   */
  const key = (npc) => `${npc.x},${npc.y}|${nameOf.get(npc.type) ?? npc.type}`;
  const group = (list) => {
    const by = new Map();
    for (const npc of list) by.set(key(npc), [...(by.get(key(npc)) ?? []), npc]);
    return by;
  };
  const theirs = group(floor.npcs);
  const mine = group(ours);

  /**
   * Counted per constant as well as per place, because "the official put one
   * here and we did not" and "we put ours somewhere else" are different faults
   * and the position key alone cannot tell them apart. Sixty-two ice
   * stalagmites read as missing until this was split; every one of them was
   * being placed, at a position we derive differently.
   */
  const tallyOf = (constant) => {
    const seen = into.perConstant.get(constant) ?? { theirs: 0, ours: 0, matched: 0 };
    into.perConstant.set(constant, seen);
    return seen;
  };
  for (const npc of floor.npcs) tallyOf(nameOf.get(npc.type) ?? String(npc.type)).theirs += 1;
  for (const npc of ours) tallyOf(nameOf.get(npc.type) ?? String(npc.type)).ours += 1;

  for (const [at, officials] of theirs) {
    const locals = mine.get(at) ?? [];
    const constant = at.split("|")[1];
    for (let n = officials.length; n > locals.length; n -= 1) {
      into.onlyTheirs.set(constant, (into.onlyTheirs.get(constant) ?? 0) + 1);
    }
    for (const [index, official] of officials.entries()) {
      const local = locals[index];
      if (!local) continue;
      tallyOf(constant).matched += 1;
      into.matched += 1;
      /**
       * Counted against how often the same pair agreed, because a raw tally
       * cannot tell a rule from a rounding. Three leads were chased and dropped
       * on this list before it kept a denominator: the official puts
       * CASTLE_SPIKES_SOUNDOBJ on layer 10 a hundred and sixty-seven times and
       * on 20 four times, and only the four reached the report.
       */
      for (const field of COMPARED) {
        const seen = into.perField.get(`${constant}.${field}`) ?? { same: 0, differ: 0, examples: new Map() };
        into.perField.set(`${constant}.${field}`, seen);
        if (valueOf(official[field]) === valueOf(local[field])) { seen.same += 1; continue; }
        seen.differ += 1;
        const example =
          `at ${at.split("|")[0]}: official ${JSON.stringify(official[field])}, ` +
          `ours ${JSON.stringify(local[field])}` +
          (local.wiring ? `  — wired to ${local.wiring}` : "");
        seen.examples.set(example, (seen.examples.get(example) ?? 0) + 1);
      }
    }
  }
  for (const [at, npcs] of mine) {
    const spare = npcs.length - (theirs.get(at)?.length ?? 0);
    const constant = at.split("|")[1];
    for (let n = 0; n < spare; n += 1) {
      into.onlyOurs.set(constant, (into.onlyOurs.get(constant) ?? 0) + 1);
    }
  }
  into.floors += 1;
  into.ours += ours.length;
  into.theirs += floor.npcs.length;
};

/**
 * A constant only the official placed is either something we drop or something
 * it populates from a quota; one only we placed is the reverse. Enemies
 * dominate both lists and mean nothing — neither server puts them in the same
 * square — so they are counted rather than named.
 */
const say = async (label, counts) => {
  if (!counts.size) return;
  const props = [];
  let enemies = 0;
  for (const [constant, count] of counts) {
    const row = await npcForConstant(constant);
    if (row?.CharType === "ENEMY") enemies += count;
    else props.push([constant, count]);
  }
  console.log(`\n${label}`);
  for (const [constant, count] of props.sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`   x${String(count).padStart(4)}  ${constant}`);
  }
  if (enemies) console.log(`   (and ${enemies} stocked monsters, which neither server places alike)`);
};

const main = async () => {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node tools/replay-floor.js <capture.jsonl|logs-dir> [--floor N] [--keep]");
    process.exit(2);
  }

  const gm = await loadGameMaster();
  const nameOf = new Map();
  for (const row of Object.values(gm.raw).flat()) {
    if (row && row.Id && row.CharType && row.Constant) nameOf.set(row.Id, row.Constant);
  }

  const captures = fs.statSync(target).isDirectory()
    ? fs.readdirSync(target).filter((n) => n.startsWith("socket-") && n.endsWith(".jsonl")).sort()
        .map((n) => path.join(target, n))
    : [target];

  const into = {
    floors: 0, matched: 0, ours: 0, theirs: 0, unreadable: 0, partyFloors: 0,
    differences: new Map(), onlyTheirs: new Map(), onlyOurs: new Map(), perConstant: new Map(), perField: new Map(),
  };
  const only = argument("floor") ? Number(argument("floor")) - 1 : null;

  /**
   * Progress on stderr, because the thing being measured writes its own combat
   * log to stdout. A corpus run takes long enough to be interrupted, so it says
   * where it is rather than going quiet until the end.
   */
  for (const [index, capture] of captures.entries()) {
    const { floors, unreadable } = await readCapture(capture);
    into.unreadable += unreadable;
    if (!floors.length) continue;
    const wanted = only === null ? floors : [floors[Math.min(Math.max(0, only), floors.length - 1)]];
    for (const floor of wanted) {
      const label = `${path.basename(capture, ".jsonl")}_${floors.indexOf(floor) + 1}`;
      try {
        await replay(floor, { gm, nameOf, label, into, partySize: floor.partySize });
        if (floor.partySize > 1) into.partyFloors += 1;
      } catch (error) {
        console.error(`   ${label}: ${error.message}`);
      }
    }
    process.stderr.write(
      `[${index + 1}/${captures.length}] ${into.floors} floors, ` +
        `${into.matched} matched, ` +
        `${[...into.perField.values()].filter((f) => f.differ > 0).length} pair(s) disagreeing\n`
    );
  }

  if (!into.floors) {
    console.log("no floor in this capture carries a tile layout — the official sends one per run");
    return;
  }

  console.log(
    `replayed ${into.floors} official floor(s) from ${captures.length} capture(s): ` +
      `${into.theirs} objects there, ${into.ours} here, ${into.matched} standing in the same place.`
  );
  if (into.unreadable) console.log(`${into.unreadable} generate(s) skipped as unreadable.`);
  if (into.partyFloors) {
    console.log(
      `${into.partyFloors} floor(s) replayed with their captured party size; ` +
        "PlayerScale health was compared rather than skipped."
    );
  }

  /**
   * Ranked by how *consistently* a pair disagrees rather than how often, and
   * only where there is enough of it to mean something. A field that differs
   * every single time is a rule we have wrong; one that differs twice in a
   * hundred is the official disagreeing with itself.
   */
  // A focused exact-floor replay is already the requested sample; hiding a
  // one-off difference there defeats the purpose. Corpus mode keeps the noise
  // floor so random spawn variation does not dominate the report.
  const MIN_SAMPLE = only === null ? 4 : 1;
  const ranked = [...into.perField]
    .filter(([, s]) => s.differ > 0 && s.same + s.differ >= MIN_SAMPLE)
    .map(([key, s]) => [key, s, s.differ / (s.same + s.differ)])
    .sort((a, b) => b[2] - a[2] || b[1].differ - a[1].differ);

  if (ranked.length) {
    console.log("\nfields that differ, worst rate first (differ/total on that constant):");
    for (const [key, seen, rate] of ranked.slice(0, 20)) {
      const example = [...seen.examples].sort((a, b) => b[1] - a[1])[0][0];
      console.log(
        `   ${String(Math.round(rate * 100)).padStart(3)}%  ${String(seen.differ).padStart(4)}/${String(seen.same + seen.differ).padEnd(5)} ${key}` +
          `\n              ${example}`
      );
    }
    const noise = [...into.perField].filter(([, s]) => s.differ > 0).length - ranked.length;
    if (noise) console.log(`\n${noise} more pair(s) differ but were seen fewer than ${MIN_SAMPLE} times.`);
  } else {
    console.log("\nno field differs on any object both servers placed.");
  }

  /**
   * Both servers place it, neither puts it in the same square. That is a
   * position rule we get wrong rather than an object we drop, and it is the
   * more useful of the two lists because the object is right there to compare.
   */
  const misplaced = [...into.perConstant]
    .filter(([, t]) => t.theirs > 0 && t.ours > 0 && t.matched < Math.min(t.theirs, t.ours))
    .sort((a, b) => (b[1].theirs - b[1].matched) - (a[1].theirs - a[1].matched));
  if (misplaced.length) {
    console.log("\nplaced by both servers, in different positions:");
    for (const [constant, t] of misplaced.slice(0, 20)) {
      console.log(
        `   ${String(t.theirs).padStart(4)} theirs / ${String(t.ours).padStart(4)} ours, ` +
          `${String(t.matched).padStart(4)} in the same square   ${constant}`
      );
    }
  }

  await say("placed by the official and not by us:", into.onlyTheirs);
  await say("placed by us and not by the official:", into.onlyOurs);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
