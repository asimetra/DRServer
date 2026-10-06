import { floorTilesUpdate, interestClosure, infiniteRewardDataUpdate } from "./objects.js";
import { loadFloorAt, exitsOf, rewardGeneratorIds } from "./floors.js";
import { loadGameMaster } from "../gamemaster.js";
import { infiniteDamageBonus, infiniteDepthBonus } from "../npc-stats.js";
import {
  generatorXpWeight,
  isStockedRoleMarker,
  plannedXpWeight,
  sealedXpWeight,
  stockFloor,
  tierHasEnemyPopulation,
  markersFor,
} from "./population.js";
import { infiniteFloorGold, infiniteRewards } from "../infinite.js";
import { trackTriggers, startTimerTriggers } from "./triggers.js";
import { completeFloor, playFloorSound, reportFloorFailed, shakeFloorCamera, showFloorText, zoomFloorCamera } from "./floorstate.js";
import { startNpcAi } from "./ai.js";
import { startManaRegen } from "./regen.js";
import { startAfkWatch } from "./afk.js";
import { createNavigationState } from "./navigation.js";
import { envFlag } from "../env.js";
import { info, warn } from "../log.js";
import { settleFloorXp } from "./run-xp.js";
import { scheduleSummons } from "./summons.js";
import { startTrapProjectiles, killAllEnemies } from "./combat.js";
import { noteInfiniteFloorReached } from "./rewards.js";
import { spawnNpc } from "./npc-spawn.js";
import { startInfiniteModifierSpawns, spawnEquippedPet, buildNpcs } from "./floor-population.js";
import { buildCollectables } from "./floor-collectables.js";
import { buildGenerators } from "./floor-generators.js";
import { buildTriggerables, spawnResolverFor } from "./floor-triggerables.js";
import { advanceFloor } from "./floor-exit.js";
import { contextForMember, ownFloorRuntime, buildPartyHeroes } from "./dungeon.js";

/**
 * A floor as a whole: `buildFloorWorld` lays one floor out through the
 * builders, and a secret room is revealed onto a floor already built.
 */

/**
 * What the run's floors still to come are expected to weigh, for pricing a
 * kill on this one — see run-xp.js.
 *
 * An authored floor is read from its map, which is cached and costs nothing to
 * look at early. A laid-out one would have to be generated to be read, so it is
 * taken to weigh what the floor in hand does: same tier, same quota, and on an
 * Infinite node fifty-four of them. Floors already behind the party are not
 * counted — they held nothing, or the run would have been priced on them.
 */
const plannedXpElsewhere = async (session, gm, tier, here) => {
  const floors = session.floorPlan?.floors ?? [];
  const index = session.floorIndex ?? 0;
  let weight = 0;
  for (const [at, descriptor] of floors.entries()) {
    if (at <= index) continue;
    if (!descriptor.authored) {
      weight += here;
      continue;
    }
    const floor = await loadFloorAt(session.floorPlan, at);
    weight += plannedXpWeight(gm, floor, tier, {
      floorNumber: at + 1,
      resolve: await spawnResolverFor(session, floor),
    });
  }
  return weight;
};

/**
 * The run's miniboss markers, floor by floor, for the dungeon's share of
 * minibosses (population.js, minibossesForFloor). Read once per run and kept
 * on the plan; a layout is its seed's, so another floor's can be laid out
 * here without being built. Not for an Infinite run — its floors are many
 * and its minibosses scale by depth — and not needed for a run of one floor.
 */
const minibossShareFor = async (session) => {
  const plan = session.floorPlan;
  const floors = plan?.floors ?? [];
  if (!plan || floors.length < 2 || session.infiniteDefinition) return null;
  if (!plan.minibossMarkers) {
    const byFloor = [];
    for (const [at] of floors.entries()) {
      try {
        byFloor.push(markersFor(await loadFloorAt(plan, at)).miniboss.length);
      } catch (problem) {
        warn(`[${session.id}] could not read floor ${at + 1}'s markers for the miniboss share: ${problem.message}`);
        byFloor.push(0);
      }
    }
    plan.minibossMarkers = byFloor;
  }
  const seed = Number(floors.find((descriptor) => descriptor.generated)?.generated.seed);
  if (!Number.isFinite(seed)) return null;
  return { seed, byFloor: plan.minibossMarkers, index: session.floorIndex ?? 0 };
};

/**
 * What builds each kind of placement, by the floor file's name for it. Read
 * when a floor is built rather than once here: the builders live in modules
 * that import this one back (floor-population.js reaches dungeon.js, which
 * reaches here), and a table made at load would find them uninitialised.
 */
const builders = () => ({
  npc: buildNpcs,
  collectable: buildCollectables,
  generator: buildGenerators,
  triggerable: buildTriggerables,
});

/**
 * A secret room arriving on a floor that has already been built.
 *
 * The wall in its doorway has just lost its last hit point, and this is the
 * whole of what the official does next: hand the floor a tile list with the
 * room's tile appended, then generate everything standing in it. Node 50088
 * reads 8 tiles, then 9 sixty milliseconds after the wall breaks, then the
 * creates for a secret wall, an iron maiden, a torture chair, a weapon table
 * and four knights — the room and its contents in one breath.
 *
 * The list goes out whole rather than as a delta because that is what the field
 * is: `DistributedDungeonFloor.tiles` is a list, not a stream. Re-sending the
 * tiles the client already has costs nothing, because it dedupes them by
 * (x, y) and only builds placements it has not seen — the same property that
 * lets production repeat the list on every floor after the first.
 *
 * Which rooms are withheld, and why only the ones sealed by a *neighbour's*
 * wall, is written down in secrets.js.
 */
const revealSecretRoom = async (context, floor, floorDoid, placementId) => {
  const { session, isActive } = context;
  const index = (floor.secrets ?? []).findIndex((room) => room.openedBy.includes(placementId));
  if (index < 0 || !isActive() || session.revealedRooms?.has(index)) return;

  /**
   * Tracked on the session and never on the floor. `loadFloor` caches an
   * authored floor by name and hands the same object to every run that asks
   * for it, so a `revealed` flag written there would open the room for the
   * next player before they had swung at anything.
   */
  session.revealedRooms.add(index);
  const room = floor.secrets[index];
  session.revealedTiles.push(room.tile);
  session.send(floorTilesUpdate(floorDoid, [...floor.tiles, ...session.revealedTiles]));

  for (const [kind, build] of Object.entries(builders())) {
    if (!isActive()) return;
    const placements = room.placements[kind] ?? [];
    if (placements.length) {
      const revealContext = kind === "npc"
        ? { ...context, skipStockedRoleMarkers: false }
        : context;
      await build(revealContext, placements);
    }
  }
  info(
    `[${session.id}] secret room revealed at ${room.tile.x},${room.tile.y} ` +
      `by ${placementId}`
  );
};

/**
 * Populates one floor: the hero at its spawn, then every server-owned object
 * the tiles declare.
 *
 * Shared by the first floor and every one after it, so a floor change is the
 * same work as an entry minus the area, the player and the account lookup.
 */
/**
 * Builds a floor into a session. Exported so a test can build a real one.
 *
 * Nothing else here reaches this far. 288 tests passed while a `gm` that was
 * never in scope threw on the first NPC of every floor — the reported black
 * screen — because no test had ever built one. The same gap let a heading
 * mirrored twice turn every flipped wall trap in the game around, and a mine
 * generated on the enemies' team sit where no hero could set it off.
 *
 * The cost of that gap is not the bugs; it is that each of them needed a person
 * to play, notice, and report before anyone could see it.
 */
export const buildFloorWorld = async (session, { floor, floorDoid, isActive }) => {
  ownFloorRuntime(session);
  const heroDoid = session.heroDoid;

  /**
   * Whether *this* floor was laid out rather than authored, which decides
   * whether anything on it can be stranded at all.
   *
   * Set here rather than by the two callers that reach this function, for the
   * same reason the depth bonus is: a test builds a floor through
   * `buildFloorWorld` and never through either of them, so `isInert` was
   * switched off for the whole suite and every rule that depends on it went
   * uncovered. A run mixes the two — a boss node lays out its approach and
   * then loads an authored map — so it belongs per floor.
   */
  session.floorGenerated = Boolean(floor.generated);
  // The floor itself, for anything that has to say where on it something is —
  // its name is the map or the seed, and its tiles are what a position is on.
  session.currentFloor = floor;
  /**
   * How much of the NPC level counts, which on an infinite run grows with the
   * depth. Set here rather than once per run because `floorIndex` moves under
   * it: the same session builds floor one and floor forty, and the monsters on
   * the fortieth are far past what the level alone would price them at — the
   * level column stops at 100 and every infinite tier starts there.
   */
  session.npcDepthBonus = infiniteDepthBonus(
    await loadGameMaster(),
    session.floorPlan?.tier,
    (session.floorIndex ?? 0) + 1
  );
  session.npcDamageDepthBonus = infiniteDamageBonus(
    await loadGameMaster(),
    session.floorPlan?.tier,
    (session.floorIndex ?? 0) + 1
  );

  const party = await buildPartyHeroes(session, floor, floorDoid);
  for (const member of party) {
    noteInfiniteFloorReached(contextForMember(member));
  }

  session.navigation = createNavigationState(floor.navigation);
  // The trigger graph reaches these by name; wiring them here keeps triggers.js
  // free of any knowledge about floors and dungeons.
  session.completeFloor = completeFloor;
  session.showFloorText = showFloorText;
  session.playFloorSound = playFloorSound;
  session.shakeFloorCamera = shakeFloorCamera;
  session.zoomFloorCamera = zoomFloorCamera;
  session.reportFloorFailed = reportFloorFailed;
  session.killAllEnemies = killAllEnemies;
  session.advanceFloor = (target) =>
    advanceFloor(target).catch((err) =>
      warn(`[${target.id}] floor advance failed: ${err.message}`)
    );
  session.floorFinished = false;
  session.floorSettled = false;
  // Placement ids are floor-local. Keeping either direction across a floor
  // change can aim a later NPC event at an actor that no longer exists.
  session.npcDoids = new Map();
  session.npcPlacementIds = new Map();
  trackTriggers(session, floor);

  const gm = await loadGameMaster();
  const tier = session.floorPlan?.tier;
  const context = {
    session,
    floorDoid,
    heroDoid,
    mapNodeId: session.mapNodeId,
    // Carried rather than reached for per NPC: spawnNpc prices an enemy's health
    // from the Stats table, and the load is cached but the await is not free
    // once per placement on a floor that has thousands.
    gm,
    tierConstant: tier?.Constant,
    skipStockedRoleMarkers: tierHasEnemyPopulation(gm, tier?.Constant),
    isActive,
  };
  const summary = [];

  /**
   * Reset per floor, because both live on the session and a run has several
   * floors: carrying the last floor's revealed tiles into the next one appends
   * rooms from a layout that is no longer there.
   */
  session.revealedRooms = new Set();
  session.revealedTiles = [];
  session.revealSecretRoom = (placementId) =>
    revealSecretRoom(context, floor, floorDoid, placementId).catch((error) =>
      warn(`secret reveal ${placementId}: ${error.message ?? error}`)
    );
  /**
   * What an enemy's attack calls up — see summons.js. Built here because an
   * enemy is built from the floor's own context, like every other one on it.
   */
  session.summon = (casterDoid, attack, playSpeed, { dying = false } = {}) =>
    scheduleSummons(session, {
      casterDoid,
      attack,
      playSpeed,
      dying,
      spawn: (constant, position, { level, heading }) =>
        spawnNpc(context, constant, position, undefined, {
          returnDoid: true,
          level,
          heading,
          engaged: true,
          countsForFloor: false,
          suppressTriggerReporting: true,
        }),
    }).catch((error) => warn(`summons from ${casterDoid}: ${error.message ?? error}`));

  let petsBuilt = 0;
  for (const member of party) {
    const petDoid = await spawnEquippedPet(
      {
        ...context,
        session: contextForMember(member),
        heroDoid: member.heroDoid,
      },
      member
    );
    if (petDoid) petsBuilt += 1;
  }
  if (petsBuilt) summary.push(`pet ${petsBuilt}/${party.length}`);

  for (const [kind, build] of Object.entries(builders())) {
    if (!isActive()) return false;
    const candidates = floor.placements[kind] ?? [];
    const placements = kind === "npc" && context.skipStockedRoleMarkers
      ? candidates.filter((placement) =>
          !isStockedRoleMarker(gm, context.tierConstant, placement.constant))
      : candidates;
    if (!placements.length) continue;
    const built = await build(context, placements);
    summary.push(`${kind} ${built}/${placements.length}`);
  }

  /**
   * The monsters the tiles do not name.
   *
   * A floor is stocked from its tier's quota rather than from its map, and
   * without this an arena floor arrived with the four enemies its ten tiles
   * happen to author against the official's sixty-one. See src/socket/
   * population.js for where the quota and the pool are written down.
   *
   * After the placed builders, so the stocking sees their navigation obstacles
   * and does not drop a knight inside a spike bed.
   */
  if (tier && isActive()) {
    const stock = stockFloor(context.gm, {
      floor,
      navigation: session.navigation,
      tier,
      infiniteDefinition: session.infiniteDefinition,
      floorNumber: (session.floorIndex ?? 0) + 1,
      allMinibosses: (session.infiniteActiveModifiers ?? []).some(
        (modifier) => modifier.AllEnemiesAreMinibosses
      ),
      minibossShare: await minibossShareFor(session),
    });
    let stocked = 0;
    for (const entry of stock) {
      if (!isActive()) break;
      stocked += await spawnNpc(context, entry.constant, entry, undefined, { engaged: false });
    }
    if (stocked) summary.push(`stock ${stocked}/${stock.length}`);
  }

  if (!isActive()) return false;

  // Where this floor ends. An empty list means the last floor, and clearing it
  // finishes the dungeon rather than opening a door.
  session.debugTriggers = envFlag("DEBUG_TRIGGERS");
  session.debugAi = envFlag("DEBUG_AI");
  session.rewardGenerators = rewardGeneratorIds(floor);
  session.floorExits = exitsOf(floor);
  session.floorTransition = false;
  // Everything is placed and its opening state applied; from here a trigger
  // going on means the player did something. See fireSuicide.
  session.suicideFired = new Set();
  if (session.runXp && session.runXp.unit === null) {
    // What is standing was counted as it was placed. The rest of the floor is
    // still to come: what its generators will make, and its sealed rooms.
    const resolve = await spawnResolverFor(session, floor);
    const toCome =
      generatorXpWeight(gm, floor, resolve) + sealedXpWeight(gm, floor, tier, resolve);
    const here = session.runXp.weight + toCome;
    const elsewhere = here > 0 ? await plannedXpElsewhere(session, gm, tier, here) : 0;
    const xpUnit = settleFloorXp(session, elsewhere, toCome);
    if (xpUnit !== null) {
      info(
        `[${session.id}] experience — ${session.mapPage?.TotalEnemyXP} over weight ` +
          `${here} here and ${elsewhere} on the other floor(s): ${xpUnit.toFixed(2)} a unit`
      );
    }
  }
  session.floorSettled = true;

  /**
   * The floor is complete, and the client is told so.
   *
   * The one message in the protocol this server never sent. Its handler sets
   * `pastInitialLoad` on the floor and dispatches `FLOOR_INTEREST_CLOSURE`,
   * which the loading screen answers with `AssetLoader.stopTrackingLoads()` —
   * so without it the client never learns a floor has finished arriving.
   *
   * Immediately after the last child, which is where the corpus puts all 184 of
   * them: floor at line 14, its 144 children through line 162, closure at 163.
   */
  session.send(interestClosure(floorDoid));
  if (session.infiniteDefinition && session.areaDoid) {
    const floorNumber = (session.floorIndex ?? 0) + 1;
    for (const member of party) {
      session.send(
        infiniteRewardDataUpdate(session.areaDoid, {
          avatarDoid: member.dungeonAvatar?.id ?? member.heroDoid,
          startScore: member.infiniteStartScore ?? 0,
          goldReward: infiniteFloorGold(session.infiniteDefinition, floorNumber),
          rewards: infiniteRewards(session.infiniteDefinition, floorNumber, {
            alreadyClaimed: [...(member.infiniteClaimedBeforeRun ?? [])],
            claimedThisRun: [...(member.infiniteClaimedThisRun ?? [])],
          }),
        })
      );
    }
  }

  info(
    `[${session.id}] world built — ${summary.join(", ")}` +
      (session.armedTraps ? `, ${session.armedTraps} trap(s) armed` : "") +
      ` (floor ${(session.floorIndex ?? 0) + 1}/${session.floorCount ?? 1}` +
      `${session.floorExits.length ? "" : ", final"})`
  );
  /**
   * Which traps arrived unable to do anything, by name.
   *
   * "There are still traps that never activate" is a common and completely
   * true-sounding report that nothing in a capture can answer, because it is
   * about this floor rather than the official's. Naming them turns it into
   * something checkable in one line — and the count is expected to be large on
   * a laid-out floor, where a hundred spike beds per ice cave inherit no wiring
   * and the official leaves those silent too.
   */
  if (session.stuckArmed?.size) {
    const named = [...session.stuckArmed]
      .sort((a, b) => b[1] - a[1])
      .map(([constant, count]) => `${constant}x${count}`)
      .join(" ");
    info(`[${session.id}] armed with nothing able to switch them off — ${named}`);
  }
  if (session.inertTraps?.size) {
    const named = [...session.inertTraps]
      .sort((a, b) => b[1] - a[1])
      .map(([constant, count]) => `${constant}x${count}`)
      .join(" ");
    info(`[${session.id}] inert traps — ${named}`);
  }
  session.stopTrapProjectiles?.();
  session.stopTrapProjectiles = startTrapProjectiles(session);
  session.stopTriggers = startTimerTriggers(session);
  session.stopAi?.();
  session.stopAi = startNpcAi(session);
  startInfiniteModifierSpawns(context);
  for (const member of party) {
    const context = contextForMember(member);
    context.stopManaRegen?.();
    context.stopManaRegen = await startManaRegen(context);
    context.stopAfkWatch?.();
    context.stopAfkWatch = startAfkWatch(context);
  }
  return true;
};
