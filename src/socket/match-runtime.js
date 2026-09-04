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
  cancelPetRespawn,
  enterDungeon,
  leaveDungeon,
  prepareDungeonMember,
  rescaleNpcHealthForParty,
  spawnEquippedPet,
} from "./dungeon.js";
import { refreshFloorFailing } from "./floorstate.js";
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

const requireJoinableWorld = (match, world, member) => {
  if (
    !match?.members?.has(member) ||
    match?.state === "closed" ||
    match?.state === "finished" ||
    world?.destroyed ||
    world?.quiesced ||
    world?.dungeonActive === false
  ) {
    throw new Error(`match ${match?.id ?? "(unknown)"} no longer accepts joins`);
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
    // Keep authoritative current HP equal to the value generated to clients;
    // Stamina changes only the separately tracked maximum.
    hitPoints: spawn.hitPoints,
    maxHitPoints: spawn.effectiveHitPoints,
    collisionRadius: spawn.collisionRadius,
    constant: spawn.constant,
    // Carried on the actor so the floor can price a hit without asking whose
    // connection this is; a monster's come from its constant the same way.
    stats: member.heroStats,
    position: { ...position },
    team: TEAM.PLAYERS,
  });
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
const joinDungeonMatchLocked = async (
  session,
  result,
  request,
  world,
  buildHost,
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

  if (buildHost) {
    const context = world.contextFor(session);
    const built = await buildFirstMember(context, match.mapNodeId, {
      account: result.account,
    });
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

  if (!(await world.readyPromise) || world.destroyed) {
    throw new Error(`match ${match.id} world did not become ready`);
  }
  requireJoinableWorld(match, world, session);
  requireOpenMember(session);

  const prepared = await prepareMember(session, {
    sendPlayerOwner: false,
    account: result.account,
  });
  requireOpenMember(session);
  requireJoinableWorld(match, world, session);
  if (!prepared) throw new Error(`member ${session.accountId} preparation was cancelled`);
  session.dungeonActive = true;
  session.dungeonZone = world.dungeonZone ?? 10;
  session.mapNodeId = match.mapNodeId;
  session.floorIndex = world.floorIndex ?? match.floorIndex ?? 0;
  setPresenceLocation(session, match.mapNodeId);
  // Bound for teardown, but deliberately absent from liveMembers until the
  // ordered snapshot has created this member's area/floor/owner objects.
  const context = world.contextFor(session, { activate: false });

  const existing = [...membersOf(world)];
  const friend = request.friendId
    ? existing.find((member) => member.accountId === Number(request.friendId))
    : null;
  const fallback = world.floorPlan?.spawn ?? existing[0]?.heroPosition ?? { x: 0, y: 0 };
  const position = memberPosition(friend, fallback);

  rememberMemberObjects(session, world);
  installHeroActor(session, world, position);
  const liveExisting = () => existing.filter(
    (member) => isLiveMember(member) && membersOf(world).has(member)
  );

  // Captured order: local player, area, remote players, floor, local hero,
  // remote heroes, current floor children/state, interest closure.
  directSend(session, playerFrame(session, true, world.areaDoid));
  world.sendSnapshot(session, "area");
  for (const peer of liveExisting()) {
    directSend(session, playerFrame(peer, false, world.areaDoid));
  }
  // DistributedDungionArea starts asynchronous tile-library/cache loading.
  // The ordinary first-member path waits before creating its floor; replay must
  // preserve that gap or TileFactory reads a library that is not in cache yet.
  await waitForAssets();
  requireOpenMember(session);
  requireJoinableWorld(match, world, session);
  // Bring every live NPC to the party size that will exist when this member is
  // activated. Publishing through the pending context updates incumbents and
  // the compact snapshot, but not the joiner before its floor exists.
  rescaleNpcHealthForParty(context, membersOf(world).size + 1);
  world.sendSnapshot(session, "floor");
  directSend(session, heroFrame(session, true, world.floorDoid, position));
  const peers = liveExisting();
  for (const peer of peers) {
    directSend(session, heroFrame(peer, false, world.floorDoid, memberPosition(peer, position)));
    sendRemoteHeroState(session, peer, world);
  }
  await spawnEquippedPet(
    {
      session: context,
      floorDoid: world.floorDoid,
      heroDoid: session.heroDoid,
      mapNodeId: match.mapNodeId,
      partySize: membersOf(world).size + 1,
      isActive: () =>
        match.members.has(session) &&
        !session.closed &&
        !world.destroyed &&
        world.floorDoid != null,
    },
    session
  );
  requireOpenMember(session);
  requireJoinableWorld(match, world, session);
  world.sendSnapshot(session, "children");

  // Existing clients already have the world; they receive only the new member.
  for (const peer of peers) {
    directSend(peer, playerFrame(session, false, world.areaDoid));
    directSend(peer, heroFrame(session, false, world.floorDoid, position));
  }

  requireJoinableWorld(match, world, session);
  world.playerActors ??= new Set();
  world.playerActors.add(session.heroDoid);
  world.contextFor(session);
  /** A joiner arrives standing, so a wipe in progress is no longer a wipe. */
  refreshFloorFailing(context);
  await grantArrivalBuff(context, "SPAWN_INVULNERBILITY", {
    affectedActor: session.heroDoid,
  });
  session.stopManaRegen?.();
  session.stopManaRegen = await beginManaRegen(context);
  info(`[${session.id}] joined match ${match.id} on floor ${session.floorIndex + 1}`);
  return { match, world, lateJoin: true };
};

export const joinDungeonMatch = async (session, result, request, options = {}) => {
  const match = result?.match;
  if (!match) throw new Error("joinDungeonMatch needs an admitted match");
  requireOpenMember(session);
  const buildHost = !match.world;
  const world = match.world ?? createMatchWorld(match, session);
  try {
    return await world.runExclusive(() =>
      joinDungeonMatchLocked(session, result, request, world, buildHost, options)
    );
  } catch (error) {
    // A joiner can already be queued behind the first build. If that build
    // throws without settling readiness, every queued member waits forever and
    // the still-public match keeps accepting more of them.
    if (buildHost && !world.ready) {
      match.state = "failed";
      world.destroy();
    }
    throw error;
  }
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
  cancelPetRespawn(session);
  if (peers[0] && typeof world.releaseProximityActor === "function") {
    world.releaseProximityActor(world.contextFor(peers[0]), session.heroDoid);
  }
  if (notifyClient) {
    for (const { doid, owner } of dungeonTeardownFor(session, world)) {
      directSend(session, objectDisable(doid, owner));
    }
  }
  for (const peer of peers) {
    if (session.petDoid) directSend(peer, objectDisable(session.petDoid));
    directSend(peer, objectDisable(session.heroDoid));
    directSend(peer, objectDisable(session.playerDoid));
  }

  if (session.petDoid) {
    world.actors.delete(session.petDoid);
    world.objects.delete(session.petDoid);
    world.forgetObject(session.petDoid);
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
    /**
     * Leaving changes who is standing as much as dying does.
     *
     * The last player on their feet walking out leaves a floor of corpses.
     * Nothing else would ever fail it — the countdown starts on a death, and
     * there is no death left to come — so the run hung with no ending on the
     * way. Asked after the departing member is out of the shared maps, so the
     * question is about the party that remains.
     */
    refreshFloorFailing(world.contextFor(peers[0]));
  }
  return true;
};
