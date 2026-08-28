#!/usr/bin/env node
/**
 * What this server's navigation would have said about honest play.
 *
 *   node tools/wall-audit.js <capture.jsonl> [more...]
 *   node tools/wall-audit.js logs/*.jsonl --radius 22
 *
 * The cheat-mitigation audit proposes catching a client that deletes its walls
 * by testing each claimed position against our own colliders, and keeping an
 * `acceptedHeroPosition` that gameplay reads instead of the claim. Every part of
 * that rests on one assumption nobody had checked: that our navigation agrees
 * with the collision the game actually enforces.
 *
 * It is checkable. The recordings were made by the official client on the
 * official server, so every position in them is legal by construction. Rebuild
 * the floor the official laid — the tile layout is in the generate, and in field
 * 195 for the floors after the first — and ask `isPositionBlocked` about each
 * one. Whatever it calls blocked is a false positive, because there is no true
 * positive in this corpus.
 *
 * Two things a first version of this got wrong, both of which made the server
 * look worse than it is, and both worth stating because they are the errors
 * this kind of tool invites:
 *
 * It tested the raw field-147 coordinate. Every hero's authored nav shape is a
 * radius-22 circle offset by `(0, -22)`, so the reported point is the feet and
 * the body sits a full radius above it — an error the same size as the thing
 * being measured.
 *
 * And it queried every floor at its generated defaults, so a spike the official
 * had lowered was still up here. Trigger state is replayed now, in the order it
 * arrived, which is why this reads the capture twice: the floor has to exist
 * before its gates can be opened, and the layout only arrives with the floor.
 *
 * The audit's own classification is what gets measured, so the halves are
 * reported apart:
 *
 *   off-tile    outside the authored floor altogether
 *   center      the hero's body centre inside geometry — "high confidence"
 *   body        its full circle overlapping — "not confident"
 *
 * and the centre is split again by which geometry disagreed, since our tile
 * collision being wrong and our idea of what is raised being wrong are
 * different repairs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFloor } from "../src/socket/floors.js";
import {
  collisionPointOf,
  createNavigationState,
  hasLineOfSight,
  isPositionBlocked,
  isOnAuthoredTile,
  loadNavigationLibrary,
  moveWithNavigation,
  segmentStaysOnAuthoredTiles,
  setNavigationTriggerState,
} from "../src/socket/navigation.js";
import { classForClid, decodeFieldUpdate, decodeGenerate, framesOf, GENERATE_OPS } from "./wire.js";
import { CLID } from "../src/socket/opcodes.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const levels = path.join(root, "local-data", "Resources", "Levels");

const argument = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};

const FLID_POSITION = 147;
const FLID_TRIGGER_STATE = 141;
const FLID_FLOOR_TILES = 195;
const OP_FIELD_UPDATE = 124;

/**
 * Field 147 is where the hero *stands*, not where it collides: every hero
 * authors a radius-22 circle offset by (0, -22), which is how a foot-anchored
 * sprite works. All six are identical, so the constant only matters if that
 * stops being true.
 */
const DEFAULT_HERO = "RANGER";
const DEFAULT_RADIUS = 22;

/** First pass: the floors this recording laid, and the tiles of each. */
const readFloors = async (file) => {
  const floors = new Map();
  const floorClass = classForClid(CLID.DistributedDungeonFloor);

  for await (const { body } of framesOf(file)) {
    const op = body.readUInt16LE(0);

    // The later floors' layouts arrive just after their empty generate.
    if (op === OP_FIELD_UPDATE && body.length >= 8 && body.readUInt16LE(6) === FLID_FLOOR_TILES) {
      const floor = floors.get(body.readUInt32LE(2));
      if (!floor) continue;
      const update = decodeFieldUpdate(body, floorClass);
      if (update.error || !Array.isArray(update.value)) continue;
      floor.tiles = update.value.map(([x, y, tileId]) => ({ x, y, tileId }));
      continue;
    }

    if (!GENERATE_OPS.has(op)) continue;
    const decoded = decodeGenerate(body);
    if (decoded.error || decoded.class !== "DistributedDungeonFloor") continue;

    const { mapNodeId, coliseumTierConstant, tileLibrary, tiles } = decoded.fields;
    floors.set(decoded.doid, {
      doid: decoded.doid,
      mapNodeId,
      tier: coliseumTierConstant,
      library: tileLibrary,
      tiles: (tiles ?? []).map(([x, y, tileId]) => ({ x, y, tileId })),
    });
  }

  return floors;
};

const positionKey = (x, y) => `${Math.round(x)},${Math.round(y)}`;

const sourceKey = (collider) =>
  `${collider.sourceKind ?? "unknown"}:${collider.sourceConstant ?? "unknown"}` +
  (collider.sourceState ? `:${collider.sourceState}` : "");

const bump = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);

/**
 * Builds one of those floors here, with the map that lets the recording's own
 * trigger updates be applied to it.
 *
 * The recording's doids are the official server's and mean nothing here, so a
 * trap is matched by where it stands: a triggerable is authored at a tile
 * position and generated there, and this server does not move it.
 */
const buildFloor = async (floor, label) => {
  const file = path.join("wall-audit", `${label}.json`);
  await fs.promises.mkdir(path.join(levels, "wall-audit"), { recursive: true });
  await fs.promises.writeFile(
    path.join(levels, file),
    `${JSON.stringify({
      _comment: `wall audit — node ${floor.mapNodeId}, tier ${floor.tier}`,
      tileLibrary: floor.library,
      tiles: floor.tiles.map(({ x, y, tileId }) => ({ type: "LEFloorTile", tileId, x, y })),
    })}\n`
  );

  const loaded = await loadFloor(file);
  const navigation = createNavigationState(loaded.navigation);
  const triggerAt = new Map();
  for (const triggerable of loaded.placements?.triggerable ?? []) {
    triggerAt.set(positionKey(triggerable.x, triggerable.y), triggerable.id);
  }
  return {
    navigation,
    triggerAt,
    file,
    // Runtime continuity starts at the server-authored hero spawn, not at the
    // first claim the client happens to send.
    spawn: collisionPointOf({ constant: DEFAULT_HERO }, loaded.spawn),
  };
};

const classify = (navigation, at, radius, total) => {
  /**
   * A missing tile can sit inside the floor's rectangular bounds. The first
   * audit classified that as static geometry because `isPositionBlocked` folds
   * tile membership into its answer, then only used the outer rectangle to name
   * off-floor points. Ask the actual tile set first or the exact rule is scored
   * against the wrong bucket.
   */
  if (!isOnAuthoredTile(navigation, at)) {
    total.offTile += 1;
    return;
  }
  const centerBlocked = isPositionBlocked(navigation, at, 0);
  const bodyBlocked = centerBlocked || isPositionBlocked(navigation, at, radius);
  if (!bodyBlocked) return;

  if (!centerBlocked) {
    total.body += 1;
    return;
  }

  // `isPositionBlocked` folds "off the authored floor" into its answer, and
  // that is a different accusation from "inside a wall".
  const { bounds } = navigation;
  if (
    at.x < bounds.minX ||
    at.x > bounds.maxX ||
    at.y < bounds.minY ||
    at.y > bounds.maxY
  ) {
    total.offTile += 1;
    return;
  }

  total.center += 1;
  for (const collider of navigation.colliders) {
    if (isPositionBlocked({ ...navigation, colliders: [collider] }, at, 0)) {
      bump(total.endpointSources, sourceKey(collider));
    }
  }
  const staticOnly = { ...navigation, colliders: navigation.staticColliders };
  if (isPositionBlocked(staticOnly, at, 0)) total.centerStatic += 1;
  else total.centerTrigger += 1;
};

/**
 * Second pass: walk the recording in order, keeping the floor's gates in the
 * state the official had them in, and ask about each claimed position as it
 * arrives.
 */
const replay = async (file, built, radius, total) => {
  let active = null;
  let accepted = null;
  const boundTo = new Map(); // recording's npc doid -> our placement id

  let budgetPosition = active?.spawn ?? null;
  let movementCredit = 1000;
  let movementAt = null;

  for await (const { body, out, at: receivedAt } of framesOf(file)) {
    const op = body.readUInt16LE(0);

    if (GENERATE_OPS.has(op)) {
      const decoded = decodeGenerate(body);
      if (decoded.error) continue;

      if (decoded.class === "DistributedDungeonFloor") {
        active = built.get(decoded.doid) ?? null;
        accepted = active?.spawn ?? null;
        budgetPosition = accepted;
        movementCredit = 1000;
        movementAt = Number.isFinite(receivedAt) ? receivedAt : null;
        boundTo.clear();
        if (active) total.floors += 1;
        continue;
      }

      /**
       * The official may generate the owner beside a friend rather than at the
       * tile's default hero spawn. That server-authored position is the real
       * movement baseline; comparing it with the floor file invents a teleport.
       */
      if (decoded.class === "HeroGameObjectOwner" && active) {
        const [x, y] = decoded.fields?.position ?? [];
        if (Number.isFinite(x) && Number.isFinite(y)) {
          accepted = collisionPointOf({ constant: DEFAULT_HERO }, { x, y });
          budgetPosition = accepted;
          movementCredit = 1000;
          movementAt = Number.isFinite(receivedAt) ? receivedAt : null;
        }
        continue;
      }

      // A trap generated where one of ours stands is that one, whatever the
      // official called it.
      if (decoded.class === "DistributedNPCGameObject" && active) {
        const [x, y] = decoded.fields?.position ?? [];
        const id = active.triggerAt.get(positionKey(x, y));
        if (id !== undefined) boundTo.set(decoded.doid, id);
      }
      continue;
    }

    if (op !== OP_FIELD_UPDATE || body.length < 8 || !active) continue;
    const doid = body.readUInt32LE(2);
    const field = body.readUInt16LE(6);

    if (field === FLID_TRIGGER_STATE && body.length >= 9) {
      const id = boundTo.get(doid);
      if (id !== undefined) {
        setNavigationTriggerState(active.navigation, id, body.readUInt8(8) !== 0);
      }
      continue;
    }

    /**
     * Only the client's own claims. The direction is the whole test: a position
     * can only be *proposed* by the one client that owns the hero, so an
     * outbound 147 is the local hero's whatever doid it carries.
     */
    if (field === FLID_POSITION && out && body.length >= 16) {
      total.positions += 1;
      // Where the body is, not where the feet are reported.
      const at = collisionPointOf(
        { constant: DEFAULT_HERO },
        { x: body.readFloatLE(8), y: body.readFloatLE(12) }
      );
      const from = accepted;
      if (budgetPosition && Number.isFinite(receivedAt)) {
        const elapsed = movementAt === null ? 0 : Math.max(0, receivedAt - movementAt);
        movementCredit = Math.min(1000, movementCredit + elapsed);
        const required = Math.hypot(at.x - budgetPosition.x, at.y - budgetPosition.y);
        if (required > movementCredit) total.movementBudgetExceeded += 1;
        else {
          movementCredit -= required;
          budgetPosition = at;
        }
        movementAt = receivedAt;
      }
      const endpointOnTile = isOnAuthoredTile(active.navigation, at);
      const continuous =
        endpointOnTile &&
        (!from || segmentStaysOnAuthoredTiles(active.navigation, from, at));
      if (from && Math.hypot(at.x - from.x, at.y - from.y) > 1000) total.stepTooLarge += 1;
      if (endpointOnTile && from && !continuous) total.crossedMissingTile += 1;
      if (
        continuous &&
        from &&
        !isPositionBlocked(active.navigation, at, 0) &&
        Math.hypot(at.x - from.x, at.y - from.y) <= 1000 &&
        !hasLineOfSight(active.navigation, from, at, 0)
      ) {
        total.crossedGeometry += 1;
        const projected = moveWithNavigation(
          active.navigation,
          from,
          { x: at.x - from.x, y: at.y - from.y },
          0
        );
        total.geometryProjectionErrors.push(Math.hypot(projected.x - at.x, projected.y - at.y));
        for (const collider of active.navigation.colliders) {
          if (!hasLineOfSight({ ...active.navigation, colliders: [collider] }, from, at, 0)) {
            bump(total.segmentSources, sourceKey(collider));
          }
        }
      }
      // Mirror the proposed runtime rule: a rejected claim never becomes the
      // baseline from which a later re-entry is judged.
      if (continuous) accepted = at;
      classify(active.navigation, at, radius, total);
    }
  }
};

const main = async () => {
  const files = process.argv.slice(2).filter((arg) => arg.endsWith(".jsonl"));
  if (!files.length) {
    console.error("usage: node tools/wall-audit.js <capture.jsonl> [more...] [--radius N]");
    process.exit(1);
  }
  const radius = Number(argument("radius") ?? DEFAULT_RADIUS);
  const keep = process.argv.includes("--keep");

  await loadNavigationLibrary();

  const total = {
    positions: 0,
    floors: 0,
    offTile: 0,
    center: 0,
    body: 0,
    centerStatic: 0,
    centerTrigger: 0,
    crossedMissingTile: 0,
    crossedGeometry: 0,
    geometryProjectionErrors: [],
    endpointSources: new Map(),
    segmentSources: new Map(),
    stepTooLarge: 0,
    movementBudgetExceeded: 0,
  };

  for (const file of files) {
    let floors;
    try {
      floors = await readFloors(file);
    } catch (error) {
      console.error(`${path.basename(file)}: unreadable — ${error.message}`);
      continue;
    }

    const built = new Map();
    for (const [doid, floor] of floors) {
      if (!floor.tiles.length) continue;
      try {
        built.set(doid, await buildFloor(floor, `${path.basename(file, ".jsonl")}_${doid}`));
      } catch (error) {
        console.error(`${path.basename(file)} floor ${doid}: could not build — ${error.message}`);
      }
    }
    if (!built.size) continue;

    try {
      await replay(file, built, radius, total);
    } catch (error) {
      console.error(`${path.basename(file)}: replay failed — ${error.message}`);
    }
  }

  if (!keep) {
    await fs.promises.rm(path.join(levels, "wall-audit"), { recursive: true, force: true });
  }

  const share = (n) => (total.positions ? `${((n / total.positions) * 100).toFixed(2)}%` : "—");
  console.log(`\n${total.floors} floor(s), ${total.positions} claimed position(s), radius ${radius}`);
  console.log(`  off an authored tile   : ${total.offTile} (${share(total.offTile)})`);
  console.log(
    `  segment crossed no tile : ${total.crossedMissingTile} (${share(total.crossedMissingTile)})`
  );
  console.log(
    `  segment crossed geometry: ${total.crossedGeometry} (${share(total.crossedGeometry)})`
  );
  console.log(`  step exceeded 1000     : ${total.stepTooLarge} (${share(total.stepTooLarge)})`);
  console.log(
    `  1000u token budget hit  : ${total.movementBudgetExceeded} ` +
      `(${share(total.movementBudgetExceeded)})`
  );
  if (total.geometryProjectionErrors.length) {
    const errors = total.geometryProjectionErrors.sort((left, right) => left - right);
    const percentile = (share) => errors[Math.min(errors.length - 1, Math.floor(errors.length * share))];
    console.log(
      `    projection error      : med ${percentile(0.5).toFixed(1)} ` +
        `p90 ${percentile(0.9).toFixed(1)} p99 ${percentile(0.99).toFixed(1)} ` +
        `max ${errors.at(-1).toFixed(1)}`
    );
    console.log(
      `    error >16/32/64       : ` +
        `${errors.filter((value) => value > 16).length}/` +
        `${errors.filter((value) => value > 32).length}/` +
        `${errors.filter((value) => value > 64).length}`
    );
  }
  const printSources = (label, counts) => {
    const rows = [...counts].sort((left, right) => right[1] - left[1]).slice(0, 12);
    if (!rows.length) return;
    console.log(`    ${label}:`);
    for (const [source, count] of rows) console.log(`      ${String(count).padStart(4)}  ${source}`);
  };
  printSources("segment sources", total.segmentSources);
  console.log(`  center inside geometry : ${total.center} (${share(total.center)})`);
  console.log(`      of which static    : ${total.centerStatic}  (our tile collision)`);
  console.log(`      of which trigger   : ${total.centerTrigger}  (our raised/lowered state)`);
  console.log(`  body overlapping       : ${total.body} (${share(total.body)})`);
  printSources("endpoint sources", total.endpointSources);
  console.log(
    `\nEvery one of these is a false positive: the official client made them all.\n` +
      `A rule is deployable only where that count is zero.`
  );
};

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});
