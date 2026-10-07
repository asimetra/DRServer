import { buildFloorEnding, dungeonFloorNumber, floorTilesUpdate, floorBaseLining, dungeonFloorGenerate, objectDisable } from "./objects.js";
import { loadFloorAt } from "./floors.js";
import { modeHooks } from "../modes/hooks.js";
import { loadGameMaster } from "../gamemaster.js";
import { matchHost } from "./match-host.js";
import { activeInfiniteModifiers, infiniteEpoch, plannedModifiers } from "../infinite.js";
import { CLID } from "./opcodes.js";
import { clearHazardBeats } from "./triggers.js";
import { forgetVoices } from "./speech.js";
import { cancelVictory, clearFloorFailing, completeFloor } from "./floorstate.js";
import { collisionPointOf } from "./navigation.js";
import { config } from "../config.js";
import { info, warn } from "../log.js";
import { cancelDungeonSummary, removeHeroFromFloor } from "./summary.js";
import { settleDungeonAccount } from "./settle-account.js";
import { hasRunSaves, whenRunSaved } from "./run-saves.js";
import { clearDungeonBuffs } from "./buffs.js";
import { clearDungeonPowerups } from "./powerups.js";
import { clearDungeonPlaceables } from "./placeables.js";
import { clearEntryHandshake } from "./entry-handshake.js";
import { endFloorScope, worldOf } from "./match-world.js";
import { saveChangedAccounts } from "./rewards.js";
import { clearInfiniteModifierTimers, cancelPetRespawn } from "./floor-population.js";
import { buildFloorWorld } from "./floor-world.js";
import { clearSecurityState, sleep, dungeonMembers, clearFloorRuntime } from "./dungeon.js";

/**
 * Leaving: the exit check at a floor's end, advancing to the next floor, and
 * `leaveDungeon`.
 */

/**
 * Watches the hero for the exit. Called from the position stream, which is the
 * only signal there is — the client sends nothing when a floor is done.
 *
 * The gate in front of the exit is what clearing the floor opens; this fires
 * once the hero has actually walked through it.
 */
export const checkFloorExit = (session, position) => {
  /**
   * Reaching the exit is enough, and the attempt to demand more is recorded
   * here so it is not made a second time.
   *
   * The reasoning was that a wide damage circle can let a precise path slip
   * between two spike rows and touch the exit without the wave being fought, so
   * `checkFloorCleared` should be the authority and the gate merely its
   * picture. That holds only if this server's clearing rule is the game's, and
   * it is not: clearing demands every generator on the floor report itself
   * complete, and a laid-out floor is full of cages nobody is obliged to open.
   * Measured over twenty-five floors in five libraries — 356 generators, every
   * enemy dead — not one floor cleared.
   *
   * So the demand did not close a gap, it closed the exit. The floors stopped
   * ending and the runs stopped advancing.
   */
  if (session.floorTransition || !session.floorExits?.length) return false;

  const hero = session.actors?.get(session.heroDoid);
  const body = collisionPointOf(hero, position) ?? position;
  const bodyRadius = Math.max(0, Number(hero?.collisionRadius ?? 0));
  const reached = session.floorExits.find((exit) => {
    const dx = body.x - exit.x;
    const dy = body.y - exit.y;
    const contactRadius = Math.max(0, Number(exit.radius ?? 0)) + bodyRadius;
    return dx * dx + dy * dy <= contactRadius * contactRadius;
  });
  if (!reached) return false;

  session.floorTransition = true;
  info(`[${session.id}] hero reached the exit at (${reached.x}, ${reached.y})`);

  /**
   * Walking out is leaving, so the hero goes now and there is no loot countdown
   * to wait out. The seven seconds belong to a boss chest appearing; a player
   * who has walked through the door is done, so the win goes at once and the
   * summary follows it by the usual five.
   *
   * Only on the last floor. A floor change removes the hero itself, just before
   * it swaps, and doing it here as well sent the disable twice.
   */
  if ((session.floorIndex ?? 0) + 1 >= (session.floorCount ?? 1)) {
    removeHeroFromFloor(session);
  }
  session.victoryDelayMs = 0;

  // Routed through completeFloor so both ways of ending a floor — this and the
  // FLOOR_COMPLETION_IMMEDIATE triggerable — make the same decision.
  completeFloor(session);
  return true;
};

/**
 * Walks the hero to the next floor.
 *
 * The sequence is taken from a captured two-floor run, and the notable thing is
 * what the client does *not* do: it never asks. The last message before
 * floorEnding is an ordinary position update. Clearing a floor only opens the
 * gate in front of the exit; reaching the exit trigger behind it is what
 * advances the dungeon, and the server is the one watching.
 *
 *   126 disable(hero)  ->  area.floorEnding  ->  new floor generate
 *   ->  floor.tiles  ->  floor.baseLining  ->  hero generate under the new floor
 *
 * The hero keeps its doid across the move; only its parent changes.
 */
const advanceFloorUnlocked = async (session) => {
  const next = (session.floorIndex ?? 0) + 1;
  if (next >= (session.floorCount ?? 1) || !session.areaDoid) return false;

  const dungeonEpoch = session.dungeonEpoch;
  const isActive = () => session.dungeonActive && session.dungeonEpoch === dungeonEpoch;

  // What the floor paid is written as it ends — see saveChangedAccounts.
  saveChangedAccounts(session);

  // Per-floor work belongs to the floor that is ending.
  const party = dungeonMembers(session);
  if (!endFloorScope(session)) clearFloorRuntime(session);

  const floor = await loadFloorAt(session.floorPlan, next);
  if (!isActive()) return false;

  /**
   * A floor that belongs to another node makes it the run's: a ranked lobby
   * hands over to the race this way. The client reads the node off each floor
   * and sets the hero up again under it; experience, presence and the summary
   * here read the run's.
   */
  const floorNode = session.floorPlan.floors?.[next]?.node;
  if (floorNode && floorNode.Id !== session.mapNodeId) {
    info(`[${session.id}] run moves from node ${session.mapNodeId} to ${floorNode.Id} "${floorNode.Name}"`);
    session.mapNodeId = floorNode.Id;
    session.tierConstant = floorNode.TierRank ?? "";
    session.mapPage = floorNode;
    for (const member of party) matchHost().setPresenceLocation(member, floorNode.Id);
  }
  // A floor may say what number the client shows for it (`numbered`): a race's
  // first floor is floor 1 of the race, whatever came before it in the run.
  const numbered = session.floorPlan.floors?.[next]?.numbered;
  const shownNumber = numbered
    ? dungeonFloorNumber(numbered.of, numbered.index)
    : dungeonFloorNumber(session.floorCount, next);

  for (const recipient of party) {
    const ordered = [recipient, ...party.filter((member) => member !== recipient)];
    for (const owner of ordered) {
      recipient.send(objectDisable(owner.heroDoid, owner === recipient));
    }
  }
  session.send(buildFloorEnding(session.areaDoid));

  // Everything that belonged to the old floor goes with it. The floor object
  // itself is disabled last so its children are gone before their parent.
  const memberDoids = new Set(
    party.flatMap((member) => [member.playerDoid, member.heroDoid])
  );
  const stale = [...(session.objects?.entries() ?? [])].filter(
    ([doid]) =>
      doid !== session.matchMakerDoid &&
      doid !== session.areaDoid &&
      !memberDoids.has(doid)
  );
  for (const [doid, clid] of stale.sort(
    ([, a], [, b]) => disablePriority(a) - disablePriority(b)
  )) {
    session.send(objectDisable(doid));
    session.objects.delete(doid);
  }
  // Who is down as this floor ends, before the actors that say so go: standing
  // on the next floor is a revive, as a mode hears it (dungeon.js, buildPartyHeroes).
  session.downAtFloorEnd = new Set(
    party.filter((member) => session.actors?.get(member.heroDoid)?.dead === true).map((member) => member.heroDoid)
  );
  session.actors?.clear();
  session.doobers?.clear();
  session.playerActors?.clear();
  for (const member of party) {
    session.objects.delete(member.heroDoid);
    member.objects?.delete(member.heroDoid);
  }

  // A late join after this point needs only the new floor. Keep the area create
  // and discard every compacted child/update from the floor that just ended.
  session.world?.beginFloorSnapshot?.();

  session.floorIndex = next;
  // With the index, so the two never name different floors while this one is
  // on its way: the build below is where everything else about it is set.
  session.currentFloor = floor;
  session.floorCleared = false;
  session.enemiesSeen = 0;
  // A floor plan may name this floor's modifiers itself; otherwise Infinite's schedule says.
  const plannedHere = session.floorPlan.floors?.[next]?.modifiers;
  session.infiniteActiveModifiers = Array.isArray(plannedHere)
    ? plannedModifiers(await loadGameMaster(), plannedHere, session.infiniteActiveModifiers ?? [], (line) =>
      warn(`[${session.id}] ${line}`)
    )
    : activeInfiniteModifiers(await loadGameMaster(), session.infiniteDefinition, session.infiniteModifierIds ?? [], next + 1);

  const floorDoid = session.allocateDoid(CLID.DistributedDungeonFloor);
  session.floorDoid = floorDoid;
  session.send(
    dungeonFloorGenerate({
      doid: floorDoid,
      parent: session.areaDoid,
      mapNodeId: session.mapNodeId,
      floor,
      floorNumber: shownNumber,
      tierConstant: session.tierConstant ?? "",
      activeDungeonModifiers: (session.infiniteActiveModifiers ?? []).map((row) => ({
        id: row.Id,
        newThisFloor: row.newThisFloor,
      })),
      // Later floors are generated bare and told their layout straight after.
      tiles: [],
    })
  );
  session.send(floorTilesUpdate(floorDoid, floor.tiles));
  session.send(floorBaseLining(floorDoid));
  info(`[${session.id}] floor ${next + 1}/${session.floorCount} "${floor.name}" generated doid=${floorDoid}`);

  await sleep(config.floorDelayMs);
  if (!isActive()) return false;

  return buildFloorWorld(session, { floor, floorDoid, isActive });
};

/** Joins and floor rebuilds may never expose the same world half-built. */
export const advanceFloor = (session) => {
  const world = worldOf(session);
  return world
    ? world.runExclusive(() => advanceFloorUnlocked(session))
    : advanceFloorUnlocked(session);
};

const disablePriority = (clid) => {
  if (clid === CLID.HeroGameObject) return 0;
  if (clid === CLID.DistributedDungeonFloor) return 2;
  if (clid === CLID.DistributedDungionArea) return 3;
  if (clid === CLID.PlayerGameObject) return 4;
  return 1;
};

/**
 * Stops per-dungeon work while preserving the session's MatchMaker/login.
 *
 * Synchronous, and stays that way: three callers rely on the world being torn
 * down by the time this returns. Settling the account is the one thing still
 * running when it does, and it is handed back for a caller that wants to wait —
 * production does not, tests do. It is a no-op when the report screen already
 * wrote the run down, which is the ordinary ending.
 */
export const leaveDungeon = (session, { notifyClient = false } = {}) => {
  // Out of a ranked lobby or race: by the connection going, or by walking out.
  // Asked on every leave: a world's member arrives here raw, and `dungeonActive`
  // is the world's, so the member reads it as never set. Ranked knows its own
  // players, and for anybody else this is nothing.
  modeHooks.runLeft(session, session.closed || session.member?.closed ? "dropped" : "left");
  const settled = settleDungeonAccount(session);
  clearEntryHandshake(session);
  clearInfiniteModifierTimers(session);
  cancelPetRespawn(session);

  // Back in town, which the client reads as online and not in a dungeon.
  matchHost().setPresenceLocation(session, 0);
  session.dungeonEpoch = (session.dungeonEpoch ?? 0) + 1;
  session.dungeonActive = false;
  // Shared scopes belong to MatchWorld and are disposed when its final member
  // closes it. Standalone sessions (including direct floor fixtures) own both.
  if (!worldOf(session)) {
    endFloorScope(session);
    session.runScope?.dispose();
    session.runScope = null;
  }
  session.stopTriggers?.();
  session.stopTriggers = null;
  session.stopAi?.();
  session.stopAi = null;
  session.stopManaRegen?.();
  session.stopManaRegen = null;
  session.stopAfkWatch?.();
  session.stopAfkWatch = null;
  session.stopTrapProjectiles?.();
  session.stopTrapProjectiles = null;
  cancelVictory(session);
  cancelDungeonSummary(session);
  clearFloorFailing(session);
  clearHazardBeats(session);
  forgetVoices(session);
  clearDungeonBuffs(session);
  clearDungeonPowerups(session);
  clearDungeonPlaceables(session);
  clearSecurityState(session);

  // Production disables every dungeon object before ClientExitComplete. Merely
  // forgetting them server-side leaves native client views and inventory/HUD
  // references alive while ReloadTownState rebuilds the account, which can
  // segfault. Children go before floor/area; owner hero/player objects use 126.
  const dungeonObjects = [...(session.objects?.entries() ?? [])]
    .filter(([doid]) => doid !== session.matchMakerDoid)
    .sort(([doidA, clidA], [doidB, clidB]) => {
      const priority = disablePriority(clidA) - disablePriority(clidB);
      return priority || doidA - doidB;
    });
  if (notifyClient) {
    for (const [doid, clid] of dungeonObjects) {
      const owner = clid === CLID.HeroGameObject || clid === CLID.PlayerGameObject;
      session.send(objectDisable(doid, owner));
    }
  }
  for (const [doid] of dungeonObjects) {
    session.objects.delete(doid);
  }
  session.actors?.clear();
  session.doobers?.clear();

  /**
   * Let go of the shared account — once it is written down.
   *
   * Released for this session rather than when the socket closes, because this
   * is where the session stops being one of the people playing it: from now on
   * it changes nothing, so the next JSON-RPC should read storage again rather
   * than a copy this run happened to leave behind.
   *
   * But not before storage has what the run changed. Let go at once, with the
   * settle above still on its way, a request arriving in between read the
   * account as storage had it — a second copy, and then one of the two
   * overwrote the other. And a save storage refused left nothing behind at all.
   * While the account is held, that request gets this very object instead.
   */
  if (session.dungeonAccount) {
    const accountId = session.dungeonAccount.id;
    const host = matchHost();
    if (hasRunSaves(accountId)) void whenRunSaved(accountId).then(() => host.releaseAccount(accountId));
    else host.releaseAccount(accountId);
  }

  for (const key of [
    "areaDoid",
    "floorDoid",
    "currentFloor",
    "heroDoid",
    "heroPosition",
    "reportedHeroPosition",
    "heroPositionAt",
    "reportedHeroPositionAt",
    "movementCredit",
    "movementCreditAt",
    "movementStallCredit",
    "movementStallUntil",
    "movementBehind",
    "navigation",
    "generators",
    "triggerableDoids",
    "triggerableHazards",
    "summaryDoid",
    "dungeonAccount",
    "dungeonAvatar",
    "dungeonStart",
    "heroWeapons",
    "playerDoid",
    "dungeonZone",
    "mapNodeId",
    "dungeonRewards",
    "dungeonContribution",
    "dungeonTreasures",
    "runAssisted",
    "accountChanged",
    "healthBombsUsed",
    "partyBombsUsed",
    // The run's remaining chest allowance, rolled once from the node.
    "treasuresOwed",
    "accountSettled",
    "completionAwarded",
    "receivedTrophy",
    "completionXpBase",
    "completionXpBonus",
    "completionTeamXpBonus",
    "heroConsumables",
    "heroStats",
    "heroSpawn",
    "petSpawn",
    "petDoid",
    "petRespawnTimer",
    "dungeonBusterAttack",
    "dungeonBusterPoints",
    "maxDungeonBusterPoints",
    "heroManaPoints",
    "maxHeroManaPoints",
    "floorCleared",
    "signalTargets",
    "signalIncoming",
    "signalValues",
    "logicGates",
    "logicGateTimers",
    "generatorHandlers",
    "triggerableAttacks",
    "triggerableStatefulAttacks",
    "triggers",
    "releaseProximityActor",
    "weaponPower",
    "rewardSavePromise",
    "persistDungeonAccount",
    "buffTimers",
    "activeBuffs",
    "powerupSpawnTimers",
    "powerupCooldownUntil",
    "scalingChargeStarts",
    "dooberTimers",
    "activeTrapProjectiles",
    "fullDooberNotices",
    "infiniteStartScore",
    "infiniteClaimedBeforeRun",
    "infiniteClaimedThisRun",
    "infiniteEpoch",
    "infiniteDefinition",
    "infiniteModifierIds",
    "infiniteActiveModifiers",
    "infiniteAwardedFloors",
    "infiniteModifierTimers",
    // Whatever else is added here, note that per-run state kept anywhere *but*
    // this list survives into the next dungeon — see removeHeroFromFloor, where
    // a flag that did exactly that crashed the client on the second run.
  ]) {
    delete session[key];
  }

  return settled;
};
