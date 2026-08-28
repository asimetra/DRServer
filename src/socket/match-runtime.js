/**
 * Bridges matchmaking admission to one authoritative DungeonMatch.world.
 *
 * Admission, world construction and late-join replay are deliberately separate:
 * a registry member is not broadcast-live until its complete snapshot has been
 * sent. That prevents a joiner from receiving the tail of a floor build before
 * it has the area/floor parents those objects require.
 */

import { info } from "../log.js";
import { config } from "../config.js";
import { grantBuff } from "./buffs.js";
import { hitPointsUpdate, stateUpdate } from "./combat.js";
import {
  enterDungeon,
  leaveDungeon,
  prepareDungeonMember,
  rescaleNpcHealthForParty,
} from "./dungeon.js";
import { createMatchWorld, isLiveMember, membersOf } from "./match-world.js";
import { dungeonMatches } from "./matches.js";
import {
  heroGenerate,
  heroOwnerGenerate,
  objectDisable,
  playerGenerate,
  playerOwnerGenerate,
} from "./objects.js";
import { CLID, TEAM } from "./opcodes.js";
import { setPresenceLocation } from "./presence.js";
import { startManaRegen } from "./regen.js";

const directSend = (member, frame) => {
  if (!member || member.closed || member.socket?.destroyed || typeof member.send !== "function") {
    return false;
  }
  member.send(frame);
  return true;
};

const requireOpenMember = (member) => {
  if (!member || member.closed || member.destroyed || member.socket?.destroyed) {
    throw new Error(`match member ${member?.accountId ?? "(unknown)"} disconnected during entry`);
  }
};

const waitForFloorAssets = () =>
  new Promise((resolve) => setTimeout(resolve, config.floorDelayMs));

const memberPosition = (member, fallback = { x: 0, y: 0 }) =>
  member?.heroPosition ?? member?.actors?.get(member?.heroDoid)?.position ?? fallback;

const playerFrame = (member, owner, areaDoid) => {
  const details = {
    doid: member.playerDoid,
    parent: owner ? 0 : areaDoid,
    zone: member.dungeonZone ?? 10,
    screenName: member.dungeonAccount?.name ?? `Player${member.accountId}`,
    basicCurrency: member.dungeonAccount?.basic_currency ?? 0,
  };
  return owner ? playerOwnerGenerate(details) : playerGenerate(details);
};

const heroFrame = (member, owner, floorDoid, position) => {
  const spawn = member.heroSpawn;
  if (!spawn) throw new Error(`member ${member.accountId} has no prepared hero`);
  const details = {
    ...spawn,
    doid: member.heroDoid,
    parent: floorDoid,
    zone: member.dungeonZone ?? 10,
    position,
    dungeonBusterPoints: member.dungeonBusterPoints ?? 0,
  };
  return owner ? heroOwnerGenerate(details) : heroGenerate(details);
};

const rememberMemberObjects = (member, world) => {
  for (const peer of membersOf(world)) {
    if (peer === member) continue;
    if (peer.playerDoid === member.playerDoid) {
      throw new Error(`duplicate player doid ${member.playerDoid} in match ${world.match.id}`);
    }
    if (peer.heroDoid === member.heroDoid) {
      throw new Error(`duplicate hero doid ${member.heroDoid} in match ${world.match.id}`);
    }
  }
  member.objects.set(member.playerDoid, CLID.PlayerGameObject);
  member.objects.set(member.heroDoid, CLID.HeroGameObject);
  world.objects.set(member.playerDoid, CLID.PlayerGameObject);
  world.objects.set(member.heroDoid, CLID.HeroGameObject);
};

const installHeroActor = (member, world, position) => {
  const spawn = member.heroSpawn;
  world.actors.set(member.heroDoid, {
    hitPoints: spawn.effectiveHitPoints,
    maxHitPoints: spawn.effectiveHitPoints,
    collisionRadius: spawn.collisionRadius,
    constant: spawn.constant,
    position: { ...position },
    team: TEAM.PLAYERS,
  });
  world.playerActors ??= new Set();
  world.playerActors.add(member.heroDoid);
  member.heroPosition = { ...position };
  member.reportedHeroPosition = { ...position };
  member.heroPositionAt = Date.now();
  member.reportedHeroPositionAt = member.heroPositionAt;
  member.movementCredit = 1000;
  member.movementCreditAt = member.heroPositionAt;
};

const sendRemoteHeroState = (recipient, peer, world) => {
  const actor = world.actors.get(peer.heroDoid);
  if (!actor) return;
  directSend(
    recipient,
    hitPointsUpdate(peer.heroDoid, CLID.HeroGameObject, actor.hitPoints)
  );
  if (actor.dead) {
    directSend(recipient, stateUpdate(peer.heroDoid, CLID.HeroGameObject, "down"));
  }
};

/**
 * Builds the first member or replays the current world to a late joiner.
 * The successful MatchMaker response is sent by the caller immediately before
 * this function, matching the captured wire order.
 */
export const joinDungeonMatch = async (
  session,
  result,
  request,
  {
    buildFirstMember = enterDungeon,
    prepareMember = prepareDungeonMember,
    beginManaRegen = startManaRegen,
    grantArrivalBuff = grantBuff,
    waitForAssets = waitForFloorAssets,
  } = {}
) => {
  const match = result?.match;
  if (!match) throw new Error("joinDungeonMatch needs an admitted match");
  requireOpenMember(session);

  if (!match.world) {
    const world = createMatchWorld(match, session);
    const context = world.contextFor(session);
    const built = await buildFirstMember(context, match.mapNodeId);
    requireOpenMember(session);
    if (world.destroyed) throw new Error(`match ${match.id} world closed during build`);
    if (!built) {
      world.destroy();
      throw new Error(`match ${match.id} world build was cancelled`);
    }
    rememberMemberObjects(session, world);
    world.playerActors ??= new Set();
    world.playerActors.add(session.heroDoid);
    match.floorIndex = world.floorIndex ?? 0;
    world.markReady();
    info(`[${session.id}] match ${match.id} world ready with host ${session.accountId}`);
    return { match, world, lateJoin: false };
  }

  const world = match.world;
  if (!(await world.readyPromise) || world.destroyed) {
    throw new Error(`match ${match.id} world did not become ready`);
  }
  requireOpenMember(session);

  const prepared = await prepareMember(session, { sendPlayerOwner: false });
  requireOpenMember(session);
  if (!prepared) throw new Error(`member ${session.accountId} preparation was cancelled`);
  session.dungeonActive = true;
  session.dungeonZone = world.dungeonZone ?? 10;
  session.mapNodeId = match.mapNodeId;
  session.floorIndex = world.floorIndex ?? match.floorIndex ?? 0;
  setPresenceLocation(session, match.mapNodeId);

  const existing = [...membersOf(world)];
  const friend = request.friendId
    ? existing.find((member) => member.accountId === Number(request.friendId))
    : null;
  const fallback = world.floorPlan?.spawn ?? existing[0]?.heroPosition ?? { x: 0, y: 0 };
  const position = memberPosition(friend, fallback);

  rememberMemberObjects(session, world);
  installHeroActor(session, world, position);
  // The floor may have been generated while only the host was attached. Bring
  // every live NPC to the new party scale before this member receives its
  // compact snapshot; existing members see the same authoritative HP update.
  if (existing[0]) {
    rescaleNpcHealthForParty(world.contextFor(existing[0]), existing.length + 1);
  }

  // Captured order: local player, area, remote players, floor, local hero,
  // remote heroes, current floor children/state, interest closure.
  directSend(session, playerFrame(session, true, world.areaDoid));
  world.sendSnapshot(session, "area");
  for (const peer of existing) directSend(session, playerFrame(peer, false, world.areaDoid));
  // DistributedDungionArea starts asynchronous tile-library/cache loading.
  // The ordinary first-member path waits before creating its floor; replay must
  // preserve that gap or TileFactory reads a library that is not in cache yet.
  await waitForAssets();
  requireOpenMember(session);
  world.sendSnapshot(session, "floor");
  directSend(session, heroFrame(session, true, world.floorDoid, position));
  for (const peer of existing) {
    directSend(session, heroFrame(peer, false, world.floorDoid, memberPosition(peer, position)));
    sendRemoteHeroState(session, peer, world);
  }
  world.sendSnapshot(session, "children");

  // Existing clients already have the world; they receive only the new member.
  for (const peer of existing) {
    directSend(peer, playerFrame(session, false, world.areaDoid));
    directSend(peer, heroFrame(session, false, world.floorDoid, position));
  }

  const context = world.contextFor(session);
  await grantArrivalBuff(context, "SPAWN_INVULNERBILITY", {
    affectedActor: session.heroDoid,
  });
  session.stopManaRegen?.();
  session.stopManaRegen = await beginManaRegen(context);
  info(`[${session.id}] joined match ${match.id} on floor ${session.floorIndex + 1}`);
  return { match, world, lateJoin: true };
};

const disablePriority = (clid) => {
  if (clid === CLID.HeroGameObject) return 0;
  if (clid === CLID.DistributedDungeonFloor) return 2;
  if (clid === CLID.DistributedDungionArea) return 3;
  if (clid === CLID.PlayerGameObject) return 4;
  return 1;
};

/**
 * A matched client sees owner and remote objects in one scene, so they must be
 * disabled in one globally ordered pass as well. In particular an owner hero
 * still asks its Tile to remove it while being destroyed. Sending floor/area
 * first leaves that Tile allocated but with its owned-object Set destroyed,
 * which crashes the native client in Tile.hasOwnedFloorObject().
 */
export const dungeonTeardownFor = (session, world) =>
  [...world.objects.entries()]
    .sort(([doidA, clidA], [doidB, clidB]) => {
      const priority = disablePriority(clidA) - disablePriority(clidB);
      return priority || doidA - doidB;
    })
    .map(([doid]) => ({
      doid,
      owner: doid === session.heroDoid || doid === session.playerDoid,
    }));

/** Leaves one member without clearing the shared maps/timers of everybody else. */
export const leaveDungeonSession = (
  session,
  { notifyClient = false, registry = dungeonMatches } = {}
) => {
  const world = session?.world;
  if (!world) {
    leaveDungeon(session, { notifyClient });
    registry.remove(session);
    return false;
  }

  /**
   * Only members still reachable, not merely the other ones.
   *
   * Two players dropping in the same tick each run this, and the first to run
   * used to count the second — whose own close handler had already marked it
   * closed. That cost twice: `contextFor` throws on a closed member, and there
   * is nothing above a socket `close` handler to catch it, so the process
   * exits; and the party size below would have counted somebody who had
   * already gone, rescaling the floor's health for a party larger than the one
   * left playing.
   */
  const peers = [...membersOf(world)].filter(
    (member) => member !== session && isLiveMember(member)
  );
  if (notifyClient) {
    for (const { doid, owner } of dungeonTeardownFor(session, world)) {
      directSend(session, objectDisable(doid, owner));
    }
  }
  for (const peer of peers) {
    directSend(peer, objectDisable(session.heroDoid));
    directSend(peer, objectDisable(session.playerDoid));
  }

  world.playerActors?.delete(session.heroDoid);
  world.actors.delete(session.heroDoid);
  world.objects.delete(session.heroDoid);
  world.objects.delete(session.playerDoid);

  // Raw member maps contain only its owner objects; shared maps live on world.
  // The complete recipient-specific teardown was sent above. The raw member
  // map contains its owner objects and must only be cleared here; notifying a
  // second time would append owner hero/player after floor/area again.
  leaveDungeon(session, { notifyClient: false });
  registry.remove(session);
  if (peers[0]) {
    rescaleNpcHealthForParty(world.contextFor(peers[0]), peers.length);
  }
  return true;
};
