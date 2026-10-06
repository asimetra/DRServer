import { TILE_SIZE } from "./tilegen.js";
import { isPositionBlocked } from "./navigation.js";
import { xpWeightOf } from "./run-xp.js";

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

const enemyPopulationRow = (gm, tierConstant) =>
  (gm?.raw?.DungeonEnemy ?? []).find((entry) => entry.Constant === tierConstant) ?? null;

/** Whether this tier fills authored role markers from a population quota. */
export const tierHasEnemyPopulation = (gm, tierConstant) =>
  Boolean(enemyPopulationRow(gm, tierConstant));

/** A role marker consumed by this tier's quota rather than spawned itself. */
export const isStockedRoleMarker = (gm, tierConstant, npcConstant) =>
  tierHasEnemyPopulation(gm, tierConstant) && Boolean(SPAWN_MARKERS[npcConstant]);

/**
 * Which enemies a tier draws on, by role.
 *
 * A tier with no row is a tier that stocks nothing — boss floors bring their
 * own cast — and returns empty lists rather than a default, so nothing is
 * invented for a floor the data is silent about.
 */
export const enemyPoolFor = (gm, tierConstant) => {
  const pool = { fodder: [], bruiser: [], miniboss: [] };
  const row = enemyPopulationRow(gm, tierConstant);
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

/** A small deterministic generator (mulberry32), for a draw two floors must agree on. */
export const seededRandom = (seed) => {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * This floor's minibosses, out of the dungeon's.
 *
 * Fodder and bruisers are a floor's quota: every captured floor of a two-floor
 * dungeon carries the tier's full count of each. Minibosses are the
 * dungeon's: ARENA_D asks 4-6 and its floors carry 2+2, 1+4, 2+3, 2+4;
 * CATACOMBS_D asks 5-10 and carries 6+4, 6+4, 3+6, 2+6, 5+4, 2+8, 2+7 — the
 * two floors together inside the quota every time, and a single-floor tier
 * (ICE_CAVES_C, TEMPLE_A, CATACOMBS_B) inside it on its one floor. Where
 * they fall follows the markers: a floor with none gets none while the other
 * carries the whole count (ICE_CAVES_D: 0 and 10), and 10 over markers of 2
 * and 1 came as 6 and 4, 10 over 1 and 4 as 2 and 8. So each miniboss is
 * dealt to one marker drawn from the whole dungeon's, and a floor takes the
 * ones that fell on its own (37 two-floor runs across five tiers).
 *
 * `share` is `{ seed, byFloor, index }`: the run's seed, every floor's
 * miniboss marker count in order, and which floor this is. The draw runs on
 * the seed alone, so each floor arrives at the same dealing on its own.
 */
export const minibossesForFloor = (tier, { seed, byFloor, index }) => {
  const total = byFloor.reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0);
  const here = Math.max(0, Number(byFloor[index]) || 0);
  if (!total || !here) return 0;
  const random = seededRandom(seed);
  const quota = between(random, Number(tier.MinMiniboss), Number(tier.MaxMiniboss));
  const from = byFloor.slice(0, index).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0);
  let mine = 0;
  for (let i = 0; i < quota; i += 1) {
    const marker = Math.floor(random() * total);
    if (marker >= from && marker < from + here) mine += 1;
  }
  return mine;
};

/**
 * How many of each role this floor wants, and which constants fill them.
 *
 * Roles are drawn round-robin rather than uniformly at random: the arena floor
 * that carried 31 fodder spread them over four constants at 8/8/8/7, which is
 * a deal rather than a dice roll.
 */
export const populationFor = (
  gm,
  tier,
  random = Math.random,
  { infiniteDefinition = null, floorNumber = 1, allMinibosses = false, minibossShare = null } = {}
) => {
  if (!tier) return [];
  const pool = enemyPoolFor(gm, tier.Constant);
  const wanted = {
    fodder: between(random, Number(tier.MinFodder), Number(tier.MaxFodder)),
    bruiser: between(random, Number(tier.MinBruiser), Number(tier.MaxBruiser)),
    miniboss: minibossShare
      ? minibossesForFloor(tier, minibossShare)
      : between(random, Number(tier.MinMiniboss), Number(tier.MaxMiniboss)),
  };
  if (infiniteDefinition) {
    const floorsPastFirst = Math.max(0, Number(floorNumber) - 1);
    /**
     * A role falls by its drop per floor to its authored floor. Fodder and
     * bruisers do exactly that on the captured Infinite runs (fodder 39, 35,
     * 31, 27, 23, 19, 15, 13, 13 at -0.1 to 0.35; bruisers 25, 23, 22, 21, 20,
     * 18, 18 at -0.05 to 0.75). Minibosses author a drop of 0 and a floor of
     * 0, and the official reads that as none at all: 97 Infinite floors
     * across seven themes carry one miniboss between them, from the first
     * floor on. A drop of nothing leaves the role at its floor, not at the
     * tier's full count — which is what this server put on every Infinite
     * floor, five to ten Juggernauts the official never sent.
     */
    const scale = (role, dropField, minimumField) => {
      const drop = Number(infiniteDefinition[dropField] ?? 0);
      const floor = Number(infiniteDefinition[minimumField] ?? 0);
      const multiplier = drop === 0 ? floor : Math.max(floor, 1 + drop * floorsPastFirst);
      wanted[role] = Math.max(0, Math.round(wanted[role] * multiplier));
    };
    scale("fodder", "FodderCountDropPerFloor", "FodderMultiplierMin");
    scale("bruiser", "BruiserCountDropPerFloor", "BruiserMultiplierMin");
    scale("miniboss", "MinibossCountDropPerFloor", "MinibossMultiplierMin");
  }

  const chosen = [];
  for (const [role, count] of Object.entries(wanted)) {
    const constants = pool[role];
    if (!constants.length) continue;
    for (let i = 0; i < count; i += 1) {
      const poolForConstant = allMinibosses && pool.miniboss.length
        ? pool.miniboss
        : constants;
      chosen.push({ constant: poolForConstant[i % poolForConstant.length], role });
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

/** A copy in a random order, Fisher-Yates over `random`. */
const shuffled = (items, random) => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
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
export const stockFloor = (
  gm,
  {
    floor,
    navigation,
    tier,
    random = Math.random,
    infiniteDefinition = null,
    floorNumber = 1,
    allMinibosses = false,
    minibossShare = null,
  }
) => {
  const wanted = populationFor(gm, tier, random, {
    infiniteDefinition,
    floorNumber,
    allMinibosses,
    minibossShare,
  });
  if (!wanted.length) return [];

  const markers = markersFor(floor);
  const byRole = new Map();
  for (const entry of wanted) {
    if (!byRole.has(entry.role)) byRole.set(entry.role, []);
    byRole.get(entry.role).push(entry);
  }

  /**
   * Which markers take a quota smaller than their number is drawn, not read
   * off the tiles' order. The quota is usually short of the markers for
   * minibosses (two to five against three to six on a Catacombs floor) and
   * for fodder (25-30 against 43-58), and the official's choice of which
   * stand empty shows no order: on 109 captured floors the empty ones are
   * anywhere. Dealt in tile order, the markers of the tile laid last — the
   * exit tile, often — were empty on every floor of this server, and a room
   * the tiles meant to be guarded never was. A floor's tiles are its seed's,
   * and so is this draw.
   */
  const stock = [];
  for (const [role, entries] of byRole) {
    const points = placeAround(shuffled(markers[role], random), entries.length, navigation, random, 35);
    entries.slice(0, points.length).forEach((entry, index) => {
      stock.push({ ...entry, ...points[index] });
    });
  }
  return stock;
};

/** The rooms a floor keeps sealed: built on reveal, but planned from the start. */
const sealedNpcsOf = (floor) =>
  (floor?.secrets ?? []).flatMap((room) => room.placements?.npc ?? []);

/**
 * What a floor that has not been built yet will weigh, for pricing a run on its
 * first floor — see run-xp.js.
 *
 * Everything the build will put there: the monsters the map names outright,
 * sealed rooms included; the tier's quota wherever the map offers that role a
 * marker; and what its generators will make. Read without placing anything, so
 * a quota is taken as placed in full — and the build does fall short of that,
 * by a quarter to a third on a crowded map (79 planned against 56 built on one
 * boss floor). The error is one-sided: a floor planned heavier than it turns
 * out makes each kill pay a little less, never more.
 */
export const plannedXpWeight = (gm, floor, tier, options = {}) => {
  const rowFor = (constant) => gm?.npcByConstant?.get(constant);
  const stocked = tierHasEnemyPopulation(gm, tier?.Constant);

  let weight = 0;
  for (const placement of [...(floor?.placements?.npc ?? []), ...sealedNpcsOf(floor)]) {
    if (stocked && SPAWN_MARKERS[placement.constant]) continue;
    weight += xpWeightOf(rowFor(placement.constant));
  }

  const markers = markersFor(floor);
  for (const entry of populationFor(gm, tier, options.random ?? Math.random, options)) {
    if (markers[entry.role].length) weight += xpWeightOf(rowFor(entry.constant));
  }
  for (const room of floor?.secrets ?? []) weight += generatorXpWeight(gm, room, options.resolve);
  return weight + generatorXpWeight(gm, floor, options.resolve);
};

/**
 * What a sealed room holds, which the build will not count until it is opened
 * and which the run is priced on all the same.
 */
export const sealedXpWeight = (gm, floor, tier, resolve) => {
  const stocked = tierHasEnemyPopulation(gm, tier?.Constant);
  let weight = 0;
  for (const placement of sealedNpcsOf(floor)) {
    if (stocked && SPAWN_MARKERS[placement.constant]) continue;
    weight += xpWeightOf(gm?.npcByConstant?.get(placement.constant));
  }
  for (const room of floor?.secrets ?? []) weight += generatorXpWeight(gm, room, resolve);
  return weight;
};

/**
 * What a floor's generators will make, at their authored limit.
 *
 * `maxSpawns` is what the map says a generator may produce, and it is what the
 * official counts: the tutorial's two floors author thirty-four spawns between
 * them, and its 0.6 a unit only comes out with all of them in the sum. Where a
 * limit is a ceiling rather than a plan — the golem's four generators, a
 * hundred each "while it lives" — the floor is priced as though they all came,
 * and each one that does is worth correspondingly little.
 *
 * `resolve` turns a role placeholder into this dungeon's monster, as the build
 * does; a spawn it cannot name weighs nothing.
 */
export const generatorXpWeight = (gm, floor, resolve = (constant) => constant) => {
  let weight = 0;
  for (const generator of floor?.placements?.generator ?? []) {
    const row = gm?.npcByConstant?.get(resolve(generator.spawnConstant));
    weight += xpWeightOf(row) * Math.max(0, Math.trunc(Number(generator.maxSpawns ?? 1)) || 0);
  }
  return weight;
};
