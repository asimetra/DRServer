import { dungeonFloorNumber, dungeonAreaGenerate, dungeonFloorGenerate, heroGenerate, heroOwnerGenerate, playerOwnerGenerate } from "./objects.js";
import { loadFloorAt, floorCountOf, floorPlanForMapNode, tileLibrariesFor } from "./floors.js";
import { modeHooks } from "../modes/hooks.js";
import { heroById, attackForConstant, loadGameMaster, mapNode } from "../gamemaster.js";
import { maxHitPoints, maxManaPoints, effectiveMaxHitPoints, effectiveMaxManaPoints, wireSlotPoints, statTotals } from "../hero-stats.js";
import { equippedPetSpawn } from "../pets.js";
import { preloadFor } from "./precache.js";
import { matchHost } from "./match-host.js";
import { activeInfiniteModifiers, infiniteDefinitionForNode, infiniteEpoch, infiniteModifierIdsForNode, infiniteProgressFor } from "../infinite.js";
import {
  CLIENT_PERSISTENT_OBJECT_ID_MAX,
  isClientLocalObjectId,
} from "../account-object-ids.js";
import { CLID, TEAM } from "./opcodes.js";
import { clearHazardBeats } from "./triggers.js";
import { forgetVoices } from "./speech.js";
import { clearFloorFailing } from "./floorstate.js";
export { npcAttackChoices } from "./npc-attacks.js";
import { config } from "../config.js";
import { envSetting } from "../env.js";
import { info, warn } from "../log.js";
import { beginRunXp } from "./run-xp.js";
import { clearDungeonBuffs, grantBuff, grantBuffInstance } from "./buffs.js";
import { clearDungeonPowerups } from "./powerups.js";
import { clearDungeonPlaceables, clearPlacementPermits } from "./placeables.js";
import { clearCooldowns } from "./cooldowns.js";
import { PLAYER_REQUEST_ENTRY, PLAYER_REQUEST_HERO, waitForEntryHandshake } from "./entry-handshake.js";
import { clearAcceptedCasts, clearBombCasts, startHealthDrain } from "./combat.js";
import { beginFloorScope, isLiveMember, membersOf } from "./match-world.js";
import { startRunCheckpoints } from "./rewards.js";
import { clearInfiniteModifierTimers, cancelPetRespawn } from "./floor-population.js";
import { buildFloorWorld } from "./floor-world.js";
import { leaveDungeon } from "./floor-exit.js";
export { deathEffectMsFor, npcAwarenessProfile } from "./npc-spawn.js";
export { cancelPetRespawn, spawnEquippedPet, rescaleNpcHealthForParty } from "./floor-population.js";
export { isRewardPlaceholder } from "./floor-collectables.js";
export { createPackDoor, nearestPartyHeroPosition, generatorSpawn, generatorCadenceFor, completeGenerator } from "./floor-generators.js";
export { isInert, restingTriggerState } from "./floor-triggerables.js";
export { buildFloorWorld } from "./floor-world.js";
export { checkFloorExit, advanceFloor, leaveDungeon } from "./floor-exit.js";

/**
 * A dungeon run: entering it, a member's hero and floor runtime, and the
 * floors in between. This file keeps the entry and the party, and re-exports
 * what the rest of the server has always imported from here. The floor
 * itself is built and left by concern:
 *
 *   floor-world.js          one floor laid out, and a secret room revealed
 *   npc-spawn.js            one NPC onto the floor
 *   floor-population.js     the floor's NPCs, the pet, Infinite spawns
 *   floor-collectables.js   treasures and doobers
 *   floor-generators.js     doors and spawners, waves and packs
 *   floor-triggerables.js   traps, levers, bombs and their resting state
 *   floor-exit.js           the exit, the next floor, leaving
 */

/**
 * Everything a client earned the right to do, forgotten together.
 *
 * These were three unrelated keys on the session and only the cooldowns were
 * ever cleared, so an accepted cast authorised its attack across floor changes
 * and into the next dungeon on the same socket, and permits for a floor that no
 * longer exists stayed in the list. Named once and called from both teardown
 * paths, so a fourth kind of permission is added here and not remembered.
 */
export const clearSecurityState = (session) => {
  clearCooldowns(session);
  clearAcceptedCasts(session);
  delete session.allyReviveAttempt;
  // Untouchable time is a property of an animation that is no longer playing.
  session.invulnerableUntil?.clear();
  clearBombCasts(session);
  clearPlacementPermits(session);
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The hero carries four weapon slots on the wire, and they are *not* the same
 * thing as the account inventory: they are what the avatar has equipped, in
 * slot order. An all-zero set means the hero enters with no usable weapon,
 * which the client cannot recover from once an attack lands.
 *
 * Slots are filled from the items equipped on this avatar (ItemInfo.avatar_slot);
 * empty slots stay zeroed.
 */
export const weaponsForAvatar = (account, avatar) => {
  const slots = [{}, {}, {}, {}];
  if (!avatar) return slots;

  for (const item of account.account_items ?? []) {
    if (item.avatar_id !== avatar.id) continue;
    const slot = item.avatar_slot ?? 0;
    if (slot < 0 || slot >= slots.length) continue;

    slots[slot] = {
      type: item.item_id,
      power: item.power ?? 0,
      /**
       * Doubles as the weapon's level: GMWeaponItem.getWeaponAesthetic looks
       * the model up by this value against each aesthetic's MinLvl..MaxLvl.
       * Ranges start at 1, so a zero here matches nothing and the client logs
       * "Unable to find Weapon Aesthetic".
       *
       * Spelled the way the account row spells it. `requiredlevel` and
       * `legendarymodifier` are single lowercase words in the captured payload
       * and everywhere else in this server — see the schema note in README.md —
       * and translating them here is what made every weapon enter a dungeon at
       * level 1 with no legendary bonus at all.
       */
      requiredlevel: Math.max(1, item.requiredlevel ?? 1),
      rarity: item.rarity ?? 1,
      modifier1: item.modifier1 ?? 0,
      modifier2: item.modifier2 ?? 0,
      legendarymodifier: item.legendarymodifier ?? 0,
    };
  }
  return slots;
};

/**
 * The two consumable slots — what the game calls powerups.
 *
 * Every one of the twenty-seven Stackables rows a slot can hold reports
 * `ItemCategory: POWERUP`: health and mana potions, the demolition bomb, the
 * party speed-up. They ride in the hero's own generate as `ConsumableDetails`,
 * a fixed pair of `{ u32 type, u16 count }`, and leaving them at their default
 * sends two empty slots — the player walks into the dungeon with the potions
 * they equipped in town simply absent.
 *
 * A slot holding a type with no count, or a count with no type, is not half a
 * powerup; it is an empty slot.
 */
export const consumablesForAvatar = (avatar) =>
  [1, 2].map((slot) => {
    const type = Number(avatar?.[`consumable${slot}_id`] ?? 0);
    const count = Number(avatar?.[`consumable${slot}_count`] ?? 0);
    return type > 0 && count > 0 ? { type, count } : {};
  });

/**
 * The owner hero's distributed-object id is its account avatar instance id.
 *
 * Infinite revive/exit UI looks the hero up with `activeAvatarInfo.id` and then
 * dereferences its dungeon floor without a null guard. Giving the hero a fresh
 * object-server id therefore works until that UI opens, then segfaults. The
 * official capture keeps the two identities equal on every floor.
 */
export const heroDoidForAvatar = (avatar) => {
  const doid = Number(avatar?.id);
  if (
    !Number.isSafeInteger(doid) ||
    doid <= 0 ||
    doid > CLIENT_PERSISTENT_OBJECT_ID_MAX ||
    isClientLocalObjectId(doid)
  ) {
    throw new RangeError(
      `avatar ${avatar?.id ?? "(missing)"} has no client-safe instance id`
    );
  }
  return doid;
};

/**
 * Honours DR_NPC_FILTER. The class of an actor is only known once its
 * GameMaster row is resolved, so the check lives here rather than at the
 * placement level. A quiet floor needs none of it: it is built with none of
 * its own NPCs to begin with (floors.js, quietFloor).
 */
export const passesFilter = (npc, filter = config.npcFilter) => {
  switch (filter) {
    case "props":
      return npc.CharType === "PROP";
    case "enemies":
      return npc.CharType !== "PROP";
    case "none":
      return false;
    default:
      return true;
  }
};

/**
 * Spawns one NPC and returns 1 if it worked.
 *
 * The constant is resolved first because role placeholders (FODDER, BRUISER,
 * MINIBOSS) appear on plain LENPC placements too, not just on generators.
 */
/**
 * Which way a placement faces.
 *
 * The answer is already settled one layer up: `facingOf` in floors.js reads the
 * tile's `rotation` and mirrors it to `180 - rotation` when the object is
 * flipped, and hands the result over as the placement's `heading`. Applying the
 * mirror a second time here turned every flipped wall trap in the game back to
 * facing zero — a temple emitter drawn pointing left and shooting right, which
 * is exactly the report that followed.
 *
 * So this reads the placement and nothing else. It exists as a function rather
 * than an expression because three call sites need the same answer: the actor's
 * generate, the shape its attack sweeps, and the direction its projectile
 * flies. The last of those used to read a field nothing ever set and fired due
 * east whatever the tile said.
 */
export const headingFor = (npc, at) => at.heading ?? npc?.DefaultHeading ?? 0;


export const dungeonMembers = (session) =>
  [...membersOf(session)].filter(
    (member) => isLiveMember(member) && member?.heroSpawn && member?.heroDoid
  );

export const contextForMember = (member) =>
  member.world && !member.world.destroyed
    ? member.world.contextFor(member)
    : member;

/** Everything whose lifetime is one floor, registered once on its owner scope. */
export const clearFloorRuntime = (session) => {
  session.stopAi?.();
  session.stopAi = null;
  for (const stop of session.generatorStops?.values?.() ?? []) stop?.();
  session.generatorStops?.clear?.();
  for (const member of dungeonMembers(session)) {
    cancelPetRespawn(member);
    member.petDoid = null;
    member.stopManaRegen?.();
    member.stopManaRegen = null;
    member.stopAfkWatch?.();
    member.stopAfkWatch = null;
    clearSecurityState(contextForMember(member));
  }
  session.stopTriggers?.();
  session.stopTriggers = null;
  session.stopTrapProjectiles?.();
  session.stopTrapProjectiles = null;
  clearInfiniteModifierTimers(session);
  clearFloorFailing(session);
  clearHazardBeats(session);
  forgetVoices(session);
  clearDungeonBuffs(session);
  clearDungeonPowerups(session);
  clearDungeonPlaceables(session);
};

export const ownFloorRuntime = (session) => {
  const scope = beginFloorScope(session);
  scope?.defer(() => clearFloorRuntime(session));
  return scope;
};

const heroFrameForFloor = (member, floorDoid, position, owner) => {
  const spawn = member.heroSpawn;
  const details = {
    ...spawn,
    doid: member.heroDoid,
    parent: floorDoid,
    zone: member.dungeonZone ?? 10,
    position,
    dungeonBusterPoints: member.dungeonBusterPoints ?? 0,
    healthBombsUsed: member.healthBombsUsed ?? 0,
    partyBombsUsed: member.partyBombsUsed ?? 0,
  };
  return owner ? heroOwnerGenerate(details) : heroGenerate(details);
};

/** Installs every live member on a new floor and emits recipient-correct heroes. */
export const buildPartyHeroes = async (session, floor, floorDoid) => {
  const members = dungeonMembers(session);
  const gm = await loadGameMaster();
  const buffsById = new Map((gm.raw.Buff ?? []).map((row) => [Number(row.Id), row.Constant]));
  session.playerActors = new Set();

  for (const member of members) {
    const context = contextForMember(member);
    const spawn = member.heroSpawn;
    const at = { x: floor.spawn.x, y: floor.spawn.y };
    session.actors.set(member.heroDoid, {
      // The generate sends this same current value. Stamina raises the ceiling
      // on the client; it does not silently heal the current bar on the wire.
      hitPoints: spawn.hitPoints,
      maxHitPoints: spawn.effectiveHitPoints,
      collisionRadius: spawn.collisionRadius,
      constant: spawn.constant,
      // On the actor, so the floor prices a hit on any hero the same way it
      // prices one on a monster: from the actor, not from a connection.
      stats: member.heroStats,
      position: { ...at },
      team: TEAM.PLAYERS,
      healthBombsUsed: member.healthBombsUsed ?? 0,
      partyBombsUsed: member.partyBombsUsed ?? 0,
    });
    session.objects.set(member.heroDoid, CLID.HeroGameObject);
    member.objects?.set(member.heroDoid, CLID.HeroGameObject);
    session.playerActors.add(member.heroDoid);
    context.heroPosition = { ...at };
    // The generate says heading 0, and the client reports one only once it
    // turns, so the last floor's facing is not this hero's.
    context.heroHeading = 0;
    context.reportedHeroPosition = { ...at };
    context.heroPositionAt = Date.now();
    context.reportedHeroPositionAt = context.heroPositionAt;
    context.movementCredit = 1000;
    context.movementCreditAt = context.heroPositionAt;
    // A hero seated by the server is where the server says, with nothing owed.
    context.movementStallCredit = 0;
    context.movementBehind = false;
    context.heroManaPoints = spawn.manaPoints;
    context.maxHeroManaPoints = spawn.manaPoints;
  }

  for (const recipient of members) {
    const ordered = [recipient, ...members.filter((member) => member !== recipient)];
    for (const owner of ordered) {
      recipient.send(
        heroFrameForFloor(owner, floorDoid, contextForMember(owner).heroPosition, owner === recipient)
      );
    }
  }

  for (const member of members) {
    const context = contextForMember(member);
    await grantBuff(context, "SPAWN_INVULNERBILITY", { affectedActor: member.heroDoid });
    for (const modifier of session.infiniteActiveModifiers ?? []) {
      const constant = buffsById.get(Number(modifier.PlayerBuffId));
      if (constant) {
        const granted = await grantBuffInstance(context, constant, {
          affectedActor: member.heroDoid,
        });
        // The Poison Gas is the one that hurts by itself — see startHealthDrain.
        if (granted.created) {
          startHealthDrain(context, {
            buffDoid: granted.doid,
            victimDoid: member.heroDoid,
            buff: granted.buff,
          });
        }
      }
    }
    for (const constant of (envSetting("HERO_BUFFS") ?? "").split(",").filter(Boolean)) {
      const granted = await grantBuff(context, constant.trim(), {
        affectedActor: member.heroDoid,
      });
      info(
        granted
          ? `[${context.id}] test buff ${constant.trim()} granted to the hero`
          : `[${context.id}] test buff ${constant.trim()} does not name a buff`
      );
    }
    info(`[${context.id}] generated HeroGameObject${members.length > 1 ? " party view" : "Owner"} doid=${member.heroDoid}`);
  }
  return members;
};

/**
 * The held account's active hero must exist and pass `verifyAccount` — the
 * entry check asked again of the object the run will play, since the hero may
 * have been switched after admission. Either failing lets the account go.
 */
const heldAvatarOrRelease = async (session, account, verifyAccount) => {
  try {
    const avatar = account.account_avatars?.find((row) => row.id === account.active_avatar);
    if (!avatar) {
      throw new Error(
        `account ${account.id} active avatar ${account.active_avatar} does not name an owned avatar`
      );
    }
    await verifyAccount(account);
  } catch (problem) {
    matchHost().releaseAccount(account.id);
    delete session.dungeonAccount;
    throw problem;
  }
};

/**
 * Builds the per-member half of a dungeon without laying out a second world.
 *
 * Solo entry uses it and immediately builds the floor. Multiplayer late entry
 * uses the same preparation, then generates this member's owner objects into
 * the already existing `DungeonMatch.world`.
 */
export const prepareDungeonMember = async (
  session,
  {
    isActive = () => true,
    sendPlayerOwner = true,
    acquireAccountById = (id) => matchHost().acquireAccount(id),
    verifyAccount = async () => {},
  } = {}
) => {
  const account = await acquireAccountById(session.accountId);
  session.dungeonAccount = account;
  if (!isActive()) {
    matchHost().releaseAccount(account.id);
    delete session.dungeonAccount;
    return false;
  }
  await heldAvatarOrRelease(session, account, verifyAccount);
  const avatar = account.account_avatars.find((row) => row.id === account.active_avatar);

  session.dungeonAvatar = avatar;
  session.dungeonStart = {
    basicCurrency: account.basic_currency ?? 0,
    experience: avatar.experience ?? 0,
    // When the run began, which is the only thing a speedrun board needs that
    // the summary does not already carry.
    at: Date.now(),
  };
  session.dungeonRewards = { gold: 0, gems: 0, xp: 0 };
  session.xpCarry = 0;
  session.dungeonContribution = { kills: 0, damage: 0 };
  session.dungeonTreasures = [];
  session.healthBombsUsed = 0;
  session.partyBombsUsed = 0;
  session.completionAwarded = false;
  session.receivedTrophy = 0;
  session.completionXpBase = undefined;
  session.completionXpBonus = 0;
  session.completionTeamXpBonus = 0;
  session.playerDoid = session.accountId;
  session.objects.set(session.playerDoid, CLID.PlayerGameObject);
  if (sendPlayerOwner) {
    session.send(
      playerOwnerGenerate({
        doid: session.playerDoid,
        zone: session.dungeonZone,
        screenName: account.name,
        basicCurrency: account.basic_currency,
      })
    );
    info(`[${session.id}] generated PlayerGameObjectOwner doid=${session.playerDoid}`);
  }

  const hero = await heroById(avatar.avatar_id ?? 101);
  if (!isActive()) return false;
  const dungeonBusterAttack = hero?.DBuster1
    ? await attackForConstant(hero.DBuster1)
    : null;
  if (!isActive()) return false;
  const heroDoid = heroDoidForAvatar(avatar);
  if (session.objects.has(heroDoid)) {
    throw new Error(`avatar doid ${heroDoid} is already in use in session ${session.id}`);
  }
  session.heroDoid = heroDoid;
  session.dungeonBusterAttack = dungeonBusterAttack?.Constant ?? null;
  session.dungeonBusterPoints = 0;
  session.maxDungeonBusterPoints = Math.max(
    1,
    dungeonBusterAttack?.CrowdCost ?? 0xffffffff
  );

  const gm = await loadGameMaster();
  const weapons = weaponsForAvatar(account, avatar);
  const consumables = consumablesForAvatar(avatar);
  session.heroWeapons = weapons;
  session.heroConsumables = consumables;
  session.petSpawn = equippedPetSpawn(gm, account, avatar, hero);
  const hitPoints = hero ? maxHitPoints(gm, hero, avatar) : 100;
  const manaPoints = hero ? maxManaPoints(gm, hero, avatar) : 100;
  const effectiveHitPoints = hero
    ? effectiveMaxHitPoints(gm, hero, avatar, weapons)
    : hitPoints;
  const effectiveManaPoints = hero
    ? effectiveMaxManaPoints(gm, hero, avatar, weapons)
    : manaPoints;
  const slotPoints = hero ? wireSlotPoints(gm, hero, avatar) : [0, 0, 0, 0];
  session.heroManaPoints = manaPoints;
  session.maxHeroManaPoints = effectiveManaPoints;
  session.heroSpawn = {
    doid: heroDoid,
    heroType: avatar.avatar_id ?? 101,
    skinType: avatar.skin_type ?? 151,
    playerId: session.accountId,
    screenName: account.name ?? "Player",
    experiencePoints: avatar.experience ?? 0,
    slotPoints,
    weapons,
    consumables,
    hitPoints,
    manaPoints,
    effectiveHitPoints,
    collisionRadius: Math.max(12, (hero?.CollisionSize ?? 30) * (hero?.Scale ?? 1)),
    scale: Number(hero?.Scale ?? 1),
    constant: hero?.Constant ?? "HERO",
  };
  session.npcLevel = Math.max(1, Number(session.floorPlan?.npcLevel ?? 1));
  session.heroStats = hero ? statTotals(gm, hero, avatar) : undefined;
  const infiniteDefinition = session.infiniteDefinition ?? session.world?.infiniteDefinition;
  if (infiniteDefinition) {
    const nodeId = session.mapNodeId ?? session.world?.mapNodeId ?? session.world?.match?.mapNodeId;
    const epoch = session.infiniteEpoch ?? session.world?.infiniteEpoch ?? infiniteEpoch();
    const progress = infiniteProgressFor(account, {
      nodeId,
      avatarDoid: avatar.id,
      epoch,
      create: true,
    });
    session.infiniteStartScore = progress.score;
    session.infiniteClaimedBeforeRun = new Set(progress.claimed);
    session.infiniteClaimedThisRun = new Set();
  }
  return true;
};

/**
 * Full entry sequence. The order is forced by the client:
 *
 *   area  — its postGenerate makes the client fetch the tile library
 *   (wait) — that fetch is async and nothing tells us when it lands
 *   floor  — DungeonFloorFactory reads the library straight from cache
 *   hero   — weapons are only built once a floor exists
 *   world  — NPCs, pickups and the rest hang off the floor
 */
export const enterDungeon = async (
  session,
  mapNodeId,
  {
    acquireAccountById = (id) => matchHost().acquireAccount(id),
    onPlayerReady = () => {},
    waitForHandshake = waitForEntryHandshake,
    verifyAccount = async () => {},
  } = {}
) => {
  // A same-session transition may still be persisting the run it just left.
  // Reacquiring before that save lands would read the old disk snapshot and
  // create exactly the divergent object this entry path is meant to prevent.
  await leaveDungeon(session, { notifyClient: true });
  // Take the hold before floor/cache loading. Besides closing the stale-read
  // race, this makes all RPCs during the loading screen share the run's object.
  const account = await acquireAccountById(session.accountId);
  session.dungeonAccount = account;
  await heldAvatarOrRelease(session, account, verifyAccount);
  const avatar = account.account_avatars.find((row) => row.id === account.active_avatar);
  session.dungeonAvatar = avatar;
  session.dungeonStart = {
    basicCurrency: account.basic_currency ?? 0,
    experience: avatar.experience ?? 0,
    at: Date.now(),
  };
  const dungeonEpoch = session.dungeonEpoch;
  const isActive = () => session.dungeonActive && session.dungeonEpoch === dungeonEpoch;
  session.dungeonActive = true;
  session.floorCleared = false;
  session.enemiesSeen = 0;
  beginRunXp(session);
  startRunCheckpoints(session);
  // Production creates DistributedDungeonSummary in the dungeon interest zone.
  session.dungeonZone = 10;
  session.mapNodeId = mapNodeId;
  // Which is what a friend's panel means by "in a dungeon" — see presence.js.
  matchHost().setPresenceLocation(session, mapNodeId);
  session.dungeonRewards = { gold: 0, gems: 0, xp: 0 };
  session.xpCarry = 0;
  session.dungeonContribution = { kills: 0, damage: 0 };
  session.dungeonTreasures = [];
  session.healthBombsUsed = 0;
  session.partyBombsUsed = 0;
  session.completionAwarded = false;
  session.receivedTrophy = 0;
  session.completionXpBase = undefined;
  session.completionXpBonus = 0;
  session.completionTeamXpBonus = 0;
  /**
   * Whether this node is a file or a layout is the node's own business — twelve
   * of them name a CustomTileset and the rest do not. Everything past here
   * treats the two the same.
   */
  // A ranked lobby brings its own plan; its race floors are added when it starts.
  session.floorPlan =
    (await modeHooks.planFor(session, mapNodeId)) ?? (await floorPlanForMapNode(mapNodeId));
  session.floorCount = floorCountOf(session.floorPlan);
  /**
   * DR_START_FLOOR drops the run straight onto a floor. Clamped here rather
   * than in config because only the run knows how long it is, and a request
   * for floor nine of a two-floor node should still enter something.
   */
  session.floorIndex = Math.min(
    Math.max(0, config.startFloor - 1),
    Math.max(0, (session.floorCount ?? 1) - 1)
  );
  if (session.floorIndex > 0) {
    info(`[${session.id}] starting on floor ${session.floorIndex + 1}/${session.floorCount}`);
  }
  const floor = await loadFloorAt(session.floorPlan, session.floorIndex);
  if (!isActive()) return false;

  const gm = await loadGameMaster();
  const node = await mapNode(mapNodeId);
  session.tierConstant = node?.TierRank ?? "";
  session.mapPage = node;
  session.infiniteEpoch ??= infiniteEpoch();
  session.infiniteDefinition = infiniteDefinitionForNode(gm, node);
  session.infiniteModifierIds = session.infiniteDefinition
    ? infiniteModifierIdsForNode(gm, node, session.infiniteEpoch)
    : [];
  session.infiniteActiveModifiers = activeInfiniteModifiers(
    gm,
    session.infiniteDefinition,
    session.infiniteModifierIds,
    session.floorIndex + 1
  );
  if (session.infiniteDefinition) {
    const progress = infiniteProgressFor(account, {
      nodeId: node.Id,
      avatarDoid: avatar.id,
      epoch: session.infiniteEpoch,
      create: true,
    });
    session.infiniteStartScore = progress.score;
    session.infiniteClaimedBeforeRun = new Set(progress.claimed);
    session.infiniteClaimedThisRun = new Set();
  }

  const areaDoid = session.allocateDoid(CLID.DistributedDungionArea);
  // The area preloads once, for the whole run — see tileLibrariesFor.
  const tileLibraries = [
    ...new Set([...(await tileLibrariesFor(session.floorPlan)), ...(session.floorPlan.preloadTileLibraries ?? [])]),
  ];
  /**
   * And the art that goes with them. Left empty, the client reaches a movie
   * clip whose SWF was never loaded and draws nothing without failing — which
   * is what made the fire and mine placeables invisible. See precache.js.
   */
  const selectedModifierRows = (gm.raw.DungeonModifier ?? []).filter((row) =>
    session.infiniteModifierIds.includes(Number(row.Id))
  );
  // A plan may preload the art of its first floors only (`preloadArtFloors`):
  // a ranked lobby's, since the race is drawn after the lobby is built
  // (docs/ranked.md, "What a change of dungeon between floors costs").
  const artLibraries = session.floorPlan.preloadArtFloors
    ? await tileLibrariesFor({ floors: session.floorPlan.floors.slice(0, session.floorPlan.preloadArtFloors) })
    : tileLibraries;
  const { cacheNpcs, cacheSwfs } = await preloadFor(artLibraries, {
    gm,
    tierConstant: session.tierConstant,
    extraNpcIds: selectedModifierRows.flatMap((row) =>
      [row.NPCSpawnId, row.NPCDeathSpawnId, row.NPCHitSpawnId].filter(Boolean)
    ),
    extraBuffIds: selectedModifierRows.flatMap((row) =>
      [row.PlayerBuffId, row.EnemyBuffId].filter(Boolean)
    ),
  });
  if (!isActive()) return false;

  // The owner player is the loading-screen handshake endpoint. Production
  // creates it before accepting entry, then creates the area; sending it after
  // the floor loses requestentry because there was no object listening yet.
  const playerDoid = session.accountId;
  session.playerDoid = playerDoid;
  session.objects.set(playerDoid, CLID.PlayerGameObject);
  session.send(
    playerOwnerGenerate({
      doid: playerDoid,
      zone: session.dungeonZone,
      screenName: account.name,
      basicCurrency: account.basic_currency,
    })
  );
  info(`[${session.id}] generated PlayerGameObjectOwner doid=${playerDoid}`);
  await onPlayerReady();
  if (!isActive()) return false;

  session.send(dungeonAreaGenerate({ doid: areaDoid, tileLibraries, cacheNpcs, cacheSwfs }));
  info(
    `[${session.id}] generated DungionArea doid=${areaDoid} — ` +
      `${tileLibraries.length} tile librar${tileLibraries.length === 1 ? "y" : "ies"}, ` +
      `${cacheNpcs.length} npcs and ${cacheSwfs.length} swfs to preload`
  );

  const entryReady = await waitForHandshake(
    session,
    PLAYER_REQUEST_ENTRY,
    config.entryHandshakeMs
  );
  if (!entryReady) warn(`[${session.id}] requestentry timed out; using compatibility fallback`);
  if (!isActive()) return false;

  const floorDoid = session.allocateDoid(CLID.DistributedDungeonFloor);
  // The floor has to be generated as a child of the area: DcSocket calls
  // InformParentOfNewObject, which is what sets Area.mActiveFloor. Without that
  // link every floor-ending message the area receives is silently dropped.
  session.send(
    dungeonFloorGenerate({
      doid: floorDoid,
      parent: areaDoid,
      mapNodeId,
      floor,
      // Carries both the run length and the floor actually entered. The client
      // splits 55003 into "room 4" and "55 rooms".
      floorNumber: dungeonFloorNumber(session.floorCount, session.floorIndex),
      tierConstant: session.tierConstant,
      activeDungeonModifiers: session.infiniteActiveModifiers.map((row) => ({
        id: row.Id,
        newThisFloor: row.newThisFloor,
      })),
    })
  );
  session.areaDoid = areaDoid;
  session.floorDoid = floorDoid;
  info(`[${session.id}] generated DungeonFloor doid=${floorDoid} (${floor.tiles.length} tiles)`);

  const heroReady = await waitForHandshake(
    session,
    PLAYER_REQUEST_HERO,
    config.entryHandshakeMs
  );
  if (!heroReady) warn(`[${session.id}] requesthero timed out; using compatibility fallback`);
  if (!isActive()) return false;

  /**
   * Which hero enters is not the client's call. `requesthero` and `requestentry`
   * are argument-less signals — eight bytes, opcode and field and nothing else —
   * so the server picks, and it picks the avatar the account has active. A
   * capture settles it: the account's active_avatar was 1100334245 and the hero
   * object generated back carried that same doid, hero 106, skin 156 and the
   * avatar's own experience and stat points.
   *
   * Falling back to a different avatar is unsafe: the account payload has
   * already told the client which instance is active, and Infinite revive/exit
   * UI resolves the owner hero by that exact id.
   */
  const hero = await heroById(avatar?.avatar_id ?? 101);
  if (!isActive()) return false;
  const dungeonBusterAttack = hero?.DBuster1
    ? await attackForConstant(hero.DBuster1)
    : null;
  if (!isActive()) return false;
  const heroDoid = heroDoidForAvatar(avatar);
  if (session.objects.has(heroDoid)) {
    throw new Error(`avatar doid ${heroDoid} is already in use in session ${session.id}`);
  }
  session.heroDoid = heroDoid;
  /**
   * The one attack the hero brings that no weapon grants; see hasPowerupWeapon.
   */
  session.dungeonBusterAttack = dungeonBusterAttack?.Constant ?? null;
  session.dungeonBusterPoints = 0;
  session.maxDungeonBusterPoints = Math.max(
    1,
    dungeonBusterAttack?.CrowdCost ?? 0xffffffff
  );
  // Health and mana are earned, not flat: the hero's base plus its LV_ growth
  // across levels plus whatever training put into a health slot — if it has one.
  const weapons = weaponsForAvatar(account, avatar);
  session.heroWeapons = weapons;
  session.petSpawn = equippedPetSpawn(gm, account, avatar, hero);
  /**
   * The two powerup slots, held on the session as well as sent, because using
   * one has to be counted somewhere the client cannot reach.
   */
  const consumables = consumablesForAvatar(avatar);
  session.heroConsumables = consumables;
  // Sent as-is; the client adds its own legendary bonuses on top of these.
  const hitPoints = hero ? maxHitPoints(gm, hero, avatar) : 100;
  const manaPoints = hero ? maxManaPoints(gm, hero, avatar) : 100;
  // What the health bar really tops out at, and so what damage is taken from.
  const effectiveHitPoints = hero ? effectiveMaxHitPoints(gm, hero, avatar, weapons) : hitPoints;
  const effectiveManaPoints = hero ? effectiveMaxManaPoints(gm, hero, avatar, weapons) : manaPoints;
  const slotPoints = hero ? wireSlotPoints(gm, hero, avatar) : [0, 0, 0, 0];
  session.heroManaPoints = manaPoints;
  session.maxHeroManaPoints = effectiveManaPoints;

  /**
   * Everything about the hero that survives a floor change. Only its position
   * and its parent floor differ from one floor to the next, so the rest is
   * settled once here and replayed by buildFloorWorld.
   */
  session.heroSpawn = {
    doid: heroDoid,
    heroType: avatar?.avatar_id ?? 101,
    skinType: avatar?.skin_type ?? 151,
    playerId: session.accountId,
    screenName: account.name ?? "Player",
    experiencePoints: avatar?.experience ?? 0,
    slotPoints,
    weapons,
    consumables,
    hitPoints,
    manaPoints,
    effectiveHitPoints,
    /**
     * The size on the floor, not the size in the table — the same product the
     * NPC path has always used. A hero row is `CollisionSize` 22 and `Scale`
     * 1.176, so the body is 25.9 and not 22.
     */
    collisionRadius: Math.max(12, (hero?.CollisionSize ?? 30) * (hero?.Scale ?? 1)),
    scale: Number(hero?.Scale ?? 1),
    constant: hero?.Constant ?? "HERO",
  };
  /**
   * The level every NPC on this floor is generated at, from the node's tier.
   *
   * Constant per floor in the official's recordings — 222 NPCs on one floor all
   * read 59 — and every one of the 21 distinct values across the corpus is some
   * tier's `MinLevel`; see buildFloorPlan. The client scales an enemy's whole
   * stat vector by this to the power of one and a half, so the 1 this used to
   * send made every enemy a fraction of its intended strength.
   * See src/npc-stats.js.
   */
  session.npcLevel = Math.max(1, Number(session.floorPlan?.npcLevel ?? 1));
  /**
   * A `session.weaponPower` stood here — the strongest of the four equipped —
   * and combat priced every hero hit with it, so carrying one strong weapon
   * raised what the weak ones did. The slot that swung is named in the result
   * and in the choreography, and `handleProposeCombatResults` reads it now.
   * Removed rather than left, because a maximum sitting on the session is an
   * invitation to reach for it again.
   */
  // Damage reads the attacker's offence stat, so the hero's vector is worked
  // out once here rather than per swing.
  session.heroStats = hero ? statTotals(gm, hero, avatar) : undefined;

  return buildFloorWorld(session, { floor, floorDoid, isActive });
};
