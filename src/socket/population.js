import { TILE_SIZE } from "./tilegen.js";
import { isPositionBlocked } from "./navigation.js";

/**
 * The monsters a floor is stocked with, which its tiles do not name.
 *
 * A tile authors its props, its traps and its wiring, and almost none of its
 * monsters. Rebuilding every floor whose layout the official sent, from our own
 * copy of the tile data, matched 8,738 objects by exact position and constant —
 * and left **10,169** generated actors with no placement to match, every one of
 * them an enemy: 980 ice imps, 879 baby yetis, 752 freeze imps, 602 knights.
 *
 * So the floor is populated from a quota rather than from the map, and both
 * halves of the quota are in the GameMaster:
 *
 *   ColiseumTiers   MinFodder/MaxFodder, MinBruiser/MaxBruiser,
 *                   MinMiniboss/MaxMiniboss — how many, per tier
 *   DungeonEnemy    keyed by the same tier constant, naming each enemy's role
 *                   as "F", "B" or "M" — which ones
 *
 * The corpus agrees closely once respawns are excluded by looking only at a
 * floor's opening two seconds. `CASTLE_TIER1` authors exactly six bruisers and
 * the official sends exactly six; `ARENA_D` authors 55-65 fodder and every
 * recorded floor lands in it. Of 130 floors, 81 sit inside both quotas and the
 * rest fall short because the recording stops mid-build.
 *
 * Until this, a floor here carried only what its tiles named — which for the
 * arena is nothing. Four generated arena floors held 0, 4, 1 and 0 enemies
 * against the official's 61 on a floor of the same ten tiles.
 */

/** DungeonEnemy marks each constant with the role it fills. */
const ROLE_BY_LETTER = { F: "fodder", B: "bruiser", M: "miniboss" };

const NOT_A_ROLE = new Set(["Id", "Constant", "Name", "Release"]);

/**
 * Which enemies a tier draws on, by role.
 *
 * A tier with no row is a tier that stocks nothing — boss floors bring their
 * own cast — and returns empty lists rather than a default, so nothing is
 * invented for a floor the data is silent about.
 */
export const enemyPoolFor = (gm, tierConstant) => {
  const pool = { fodder: [], bruiser: [], miniboss: [] };
  const row = (gm?.raw?.DungeonEnemy ?? []).find((entry) => entry.Constant === tierConstant);
  if (!row) return pool;

  for (const [constant, letter] of Object.entries(row)) {
    if (NOT_A_ROLE.has(constant)) continue;
    const role = ROLE_BY_LETTER[String(letter).trim().toUpperCase()];
    if (role) pool[role].push(constant);
  }
  return pool;
};

/** Inclusive, and tolerant of a tier that names only one bound. */
const between = (random, low, high) => {
  const min = Number.isFinite(low) ? low : 0;
  const max = Number.isFinite(high) ? high : min;
  if (max <= min) return Math.max(0, min);
  return min + Math.floor(random() * (max - min + 1));
};

/**
 * How many of each role this floor wants, and which constants fill them.
 *
 * Roles are drawn round-robin rather than uniformly at random: the arena floor
 * that carried 31 fodder spread them over four constants at 8/8/8/7, which is
 * a deal rather than a dice roll.
 */
export const populationFor = (gm, tier, random = Math.random) => {
  if (!tier) return [];
  const pool = enemyPoolFor(gm, tier.Constant);
  const wanted = {
    fodder: between(random, Number(tier.MinFodder), Number(tier.MaxFodder)),
    bruiser: between(random, Number(tier.MinBruiser), Number(tier.MaxBruiser)),
    miniboss: between(random, Number(tier.MinMiniboss), Number(tier.MaxMiniboss)),
  };

  const chosen = [];
  for (const [role, count] of Object.entries(wanted)) {
    const constants = pool[role];
    if (!constants.length) continue;
    for (let i = 0; i < count; i += 1) {
      chosen.push({ constant: constants[i % constants.length], role });
    }
  }
  return chosen;
};

/**
 * Where they stand: on the markers the tile authors, and around them.
 *
 * A tile does not name its monsters, but it does say where they go. Among its
 * `LENPC` objects sit placeholders — `FODDER`, `BRUISER` and `MINIBOSS`, 2,081
 * and 1,095 and 183 of them across the nine libraries — and the official fills
 * each with a concrete enemy of that role. The corpus catches it in the act:
 * where a tile says `FODDER` the wire carries an ICE_IMP 334 times, a BABY_YETI
 * 312, a SKELETON_WARRIOR 118; where it says `BRUISER`, a FREEZE_IMP or a
 * CRAZED_YETI.
 *
 * They are not placed one to a marker. Across 108 recorded layouts, 9,195
 * enemies stand against 3,370 markers — about 2.7 apiece — and they gather:
 * 13% land exactly on one, 62% within 80 units, 78% within 150.
 *
 * The first cut of this scattered packs around random points inside each tile.
 * It matched the *spacing* almost exactly and still played wrong, because the
 * spacing was never the point — the marker is a place a designer chose, and a
 * knight standing in the middle of a corridor is not the same floor as one
 * waiting behind the door. Right shape, wrong centres.
 */
export const SPAWN_MARKERS = { FODDER: "fodder", BRUISER: "bruiser", MINIBOSS: "miniboss" };

/** How far a marker's group spreads; the corpus median is 56 and p75 126. */
const PACK_REACH = 110;
const ATTEMPTS = 12;

/** The markers a floor offers, by role. */
export const markersFor = (floor) => {
  const byRole = { fodder: [], bruiser: [], miniboss: [] };
  for (const placement of floor?.placements?.npc ?? []) {
    const role = SPAWN_MARKERS[placement.constant];
    if (role) byRole[role].push(placement);
  }
  return byRole;
};

/**
 * Deals `count` monsters over a role's markers, each marker taking its turn.
 * The first on a marker stands exactly on it, as an eighth of the corpus does;
 * the rest gather round.
 */
const placeAround = (markers, count, navigation, random, radius) => {
  if (!markers.length || count <= 0) return [];
  const points = [];
  const clear = (position) => !isPositionBlocked(navigation, position, radius);

  for (let i = 0; points.length < count; i += 1) {
    const marker = markers[i % markers.length];
    const first = i < markers.length;
    if (first && clear(marker)) {
      points.push({ x: marker.x, y: marker.y });
      continue;
    }
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const angle = random() * Math.PI * 2;
      const reach = Math.sqrt(random()) * PACK_REACH;
      const position = {
        x: marker.x + Math.cos(angle) * reach,
        y: marker.y + Math.sin(angle) * reach,
      };
      if (!clear(position)) continue;
      points.push(position);
      break;
    }
    // Every marker tried once round and none of them could take another.
    if (i > markers.length * 4) break;
  }
  return points;
};

/**
 * The floor's stock: a tier's quota of monsters, on the floor's own markers.
 *
 * A floor with no markers stocks nothing rather than inventing places, which is
 * what an authored boss map wants — it brings its own cast and its own layout.
 */
export const stockFloor = (gm, { floor, navigation, tier, random = Math.random }) => {
  const wanted = populationFor(gm, tier, random);
  if (!wanted.length) return [];

  const markers = markersFor(floor);
  const byRole = new Map();
  for (const entry of wanted) {
    if (!byRole.has(entry.role)) byRole.set(entry.role, []);
    byRole.get(entry.role).push(entry);
  }

  const stock = [];
  for (const [role, entries] of byRole) {
    const points = placeAround(markers[role], entries.length, navigation, random, 35);
    entries.slice(0, points.length).forEach((entry, index) => {
      stock.push({ ...entry, ...points[index] });
    });
  }
  return stock;
};
