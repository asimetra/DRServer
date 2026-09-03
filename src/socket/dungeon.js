import {
  buildFloorEnding,
  FIRST_FLOOR_NUMBER,
  floorTilesUpdate,
  floorBaseLining,
  dungeonAreaGenerate,
  dungeonFloorGenerate,
  heroGenerate,
  heroOwnerGenerate,
  npcGenerate,
  layerFor,
  interestClosure,
  LAYER_SORTED,
  dooberGenerate,
  objectDisable,
  playerOwnerGenerate,
} from "./objects.js";
import {
  loadFloorAt,
  floorCountOf,
  floorPlanForMapNode,
  tileLibrariesFor,
  exitsOf,
  rewardGeneratorIds,
} from "./floors.js";
import {
  npcForConstant,
  propForConstant,
  treasureForTier,
  dooberForConstant,
  resolveSpawnConstant,
  heroById,
  weaponForConstant,
  attackForConstant,
  attackColliders,
  projectileLaunch,
  projectileLaunches,
  attackTimelineFrames,
  projectileForConstant,
  deathRewardDataForNpc,
  isArrivalAnimation,
  loadGameMaster,
  mapNode,
  dooberById,
  FRAMES_PER_SECOND,
} from "../gamemaster.js";
import { legendaryPetBonuses,
  maxHitPoints,
  maxManaPoints,
  effectiveMaxHitPoints,
  wireSlotPoints,
  statTotals,
} from "../hero-stats.js";
import { npcStats } from "../combat-damage.js";
import {
  infiniteDepthBonus,
  npcMaxHitPoints,
} from "../npc-stats.js";
import {
  equippedPetSpawn,
  petCombatLevel,
  petSpawnPosition,
  scaledNpcWeaponPower,
} from "../pets.js";
import { stockFloor } from "./population.js";
import { preloadFor } from "./precache.js";
import { loadAccount } from "../accounts.js";
import {
  CLIENT_PERSISTENT_OBJECT_ID_MAX,
  isClientLocalObjectId,
} from "../account-object-ids.js";
import { CLID, OP, TEAM } from "./opcodes.js";
import { PacketWriter } from "./packet.js";
import { trackDoober } from "./pickups.js";
import {
  clearHazardBeats,
  emitGeneratorRelease,
  emitSignal,
  initialTargetState,
  initialTurretHeading,
  canEverChange,
  isVirtualTriggerable,
  playDeathAttack,
  raiseHazard,
  startTurretAim,
  traced,
  describeInputs,
  reportNpcDamage,
  reportNpcDeath,
  trackTriggers,
  startTimerTriggers,
} from "./triggers.js";
import { worldColliders } from "./heading.js";
import { forgetVoices, giveVoice } from "./speech.js";
import {
  cancelVictory,
  checkFloorCleared,
  clearFloorFailing,
  completeFloor,
  playFloorSound,
  reportFloorFailed,
  showFloorText,
} from "./floorstate.js";
import { classifyHazard } from "./hazards.js";
import { startNpcAi } from "./ai.js";
import { npcAttackChoices } from "./npc-attacks.js";
export { npcAttackChoices } from "./npc-attacks.js";
import { startManaRegen } from "./regen.js";
import {
  addNavigationObstacle,
  collisionPointOf,
  createNavigationState,
  findCageReleasePath,
  hasLineOfSight,
  isPositionBlocked,
  navigationEntryFor,
  removeNavigationObstacle,
  nearestClearPosition,
} from "./navigation.js";
import { config } from "../config.js";
import { envFlag, envSetting } from "../env.js";
import { info, warn } from "../log.js";
import { cancelDungeonSummary, removeHeroFromFloor } from "./summary.js";
import { settleDungeonAccount } from "./settle-account.js";
import { holdAccount, releaseAccount } from "../account-registry.js";
import { spawnNpcRewards, spawnBossReward } from "./drops.js";
import { clearDungeonBuffs, grantBuff } from "./buffs.js";
import { clearDungeonPowerups, scheduleTimelineDoobers } from "./powerups.js";
import { clearDungeonPlaceables, clearPlacementPermits } from "./placeables.js";
import { setPresenceLocation } from "./presence.js";
import { clearCooldowns } from "./cooldowns.js";
import {
  clearAcceptedCasts,
  clearBombCasts,
  hitPointsUpdate,
  startTrapProjectiles,
  killAllEnemies,
  npcAttackChoreography,
} from "./combat.js";
import { isLiveMember, membersOf, worldOf } from "./match-world.js";

/**
 * Everything a client earned the right to do, forgotten together.
 *
 * These were three unrelated keys on the session and only the cooldowns were
 * ever cleared, so an accepted cast authorised its attack across floor changes
 * and into the next dungeon on the same socket, and permits for a floor that no
 * longer exists stayed in the list. Named once and called from both teardown
 * paths, so a fourth kind of permission is added here and not remembered.
 */
const clearSecurityState = (session) => {
  clearCooldowns(session);
  clearAcceptedCasts(session);
  delete session.allyReviveAttempt;
  // Untouchable time is a property of an animation that is no longer playing.
  session.invulnerableUntil?.clear();
  clearBombCasts(session);
  clearPlacementPermits(session);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A generator stop must wake its current wait, not merely set a later flag. */
const generatorSleep = (runtime, ms) => {
  if (runtime.stopped || !(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (runtime.cancelWait === finish) runtime.cancelWait = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    runtime.cancelWait = finish;
  });
};

/**
 * How long a jail stays open to let one out, measured off the real server:
 * 5.41s on the tutorial's first floor and 5.42/5.08/5.07 on its boss floor.
 */
const RELEASE_WINDOW_MS = 5000;

/** Original waves appear as a tight cluster instead of an exact stack. */
const RELEASE_CLUSTER_STEP = 8;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Nearby spawns are one burst; a five-second jail spawn is intentionally not. */
const WAVE_JOIN_WINDOW_MS = 500;

/** A burst keeps its compact separation only through its initial approach. */
const WAVE_COORDINATION_MS = 8000;

/**
 * Builds a dungeon for a player: the objects the client expects the server to
 * own (see docs/private-server.md §4.3).
 *
 * Each placement kind gets one builder below. They all take the same context
 * and report how many objects they produced, so supporting a new kind is a
 * matter of writing a builder and listing it in BUILDERS.
 */

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
 * placement level.
 */
const passesFilter = (npc) => {
  switch (config.npcFilter) {
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


/** Corpus-derived: PROP 1, ENEMY 6, BEAST 7, PET 5, HERO 5. See spawnNpc. */
const TEAM_BY_CHAR_TYPE = {
  PROP: TEAM.ENVIRONMENT,
  ENEMY: TEAM.ENEMIES,
  BEAST: TEAM.THIRD,
  PET: TEAM.PLAYERS,
  HERO: TEAM.PLAYERS,
};

/**
 * How long a death is still worth drawing: the last frame its timeline does
 * anything at all, not the last frame it hits somebody.
 *
 * Read off the colliders once, on the reasoning that what keeps a broken
 * barrel on screen is its blast. That is true of a barrel and false of the one
 * death a run ends on. `REWARD_CHEST_A` dies into `LOOT_SPAWN_A1`, which has
 * no colliders — its `DamageMod` is zero — and forty-seven `spawndoober`
 * actions running to frame 145. Measured by colliders that is nothing, so the
 * chest was taken off the client the instant it broke and six seconds of coins
 * flew out of a space where a chest had been.
 *
 * Every action counts, which leaves a barrel where it was: its collider is
 * also the last thing its timeline does, so 1208ms either way.
 */
export const deathEffectMsFor = (gm, attack) => {
  const timeline = attack ? gm.timelines?.get(attack.AttackTimeline) : null;
  if (!timeline) return 0;

  let last = 0;
  for (const frame of timeline.frames ?? []) {
    if (!(frame.actions ?? []).length) continue;
    last = Math.max(last, Number(frame.frame ?? frame.index) || 0);
  }
  return (last / FRAMES_PER_SECOND) * 1000;
};

const spawnNpc = async (context, constant, position, scale, options = {}) => {
  const { session, floorDoid, heroDoid, mapNodeId, gm } = context;
  const emptyResult = options.returnDoid ? null : 0;
  if (!context.isActive()) return emptyResult;

  const resolved = await resolveSpawnConstant(constant, mapNodeId);
  const npc = resolved && (await npcForConstant(resolved));
  if (!context.isActive() || !npc || !passesFilter(npc)) return emptyResult;
  const spawn = options.resolveSpawn?.(npc);
  if (options.resolveSpawn && !spawn) return emptyResult;
  let at = spawn?.position ?? position;
  const spawnHeading = options.heading ?? headingFor(npc, at);

  // Team drives the Box2D collision mask, so it has to be right or the actor
  // becomes non-solid. Barrels and crates are scenery (CharType PROP) and
  // belong to the environment team; anything else fights the player.
  /**
   * Which side an actor is on, by what kind of thing it is.
   *
   * Read off the corpus, where the five kinds fall out cleanly across thirty
   * thousand generates: PROP 1, ENEMY 6, BEAST 7, PET 5, HERO 5. (Fifty enemies
   * also arrive on 5 — those are a hero's own summons, and they come through
   * placeables.js with their side already chosen.)
   *
   * This used to be "PROP or else an enemy", which put every `BEAST` on team 6.
   * `BEAST` is the placeable family — the mines and fire patches a map authors
   * onto its floor — and a mine on the enemies' side is a mine the hero cannot
   * set off: `determineIfHitBasedOnTeam` is what decides whether a body even
   * registers against another. Nine of them on the temple's second floor did
   * nothing at all.
   */
  const team = TEAM_BY_CHAR_TYPE[npc.CharType] ?? TEAM.ENEMIES;
  const nativeWeapon = npc.Weapon1 && (await weaponForConstant(npc.Weapon1));
  const npcLevel = Math.max(1, Number(options.level ?? session.npcLevel ?? 1));
  const nativeWeaponPower = Math.max(
    1,
    Number(options.weaponPower ?? nativeWeapon?.Power ?? 1)
  );
  const nativeAttack = npc.Attack1 && (await attackForConstant(npc.Attack1));
  // Read once per spawn rather than per swing; a monster's reach does not change.
  const nativeAttackShape = nativeAttack
    ? await attackColliders(nativeAttack.AttackTimeline)
    : [];
  /**
   * A ranged attack authors a projectile instead of a collider, and its flight
   * is the server's to simulate: across 54 official captures the client
   * proposes 4646 combat results and every one is the hero hitting something —
   * it never proposes a monster hitting the hero, and the 4469 that do are all
   * sent by the server, several hundred milliseconds after the animation.
   */
  const nativeProjectileRow =
    nativeAttack?.Projectile && (await projectileForConstant(nativeAttack.Projectile));
  const nativeLaunches = nativeAttack ? await projectileLaunches(nativeAttack.AttackTimeline) : [];

  /**
   * Everything it can swing, not just the first one.
   *
   * This helper now reads Attack1..6, which keeps `FISSURE` on the rival
   * berserkers and the later dragon / boss specials in the rotation.
   */
  const attackSet = await npcAttackChoices(npc, nativeWeapon, nativeWeaponPower);
  const petRangedStandoff = options.petOwnerDoid
    ? Math.max(
        0,
        ...attackSet
          .filter((attack) => attack.projectile && attack.minRange > 0)
          .map((attack) => attack.minRange)
      )
    : 0;
  if (!context.isActive()) return emptyResult;
  const rewardData =
    !options.suppressRewards && (npc.HP ?? 100) > 0
      ? await deathRewardDataForNpc(npc)
      : null;
  if (!context.isActive()) return emptyResult;
  const weapons = nativeWeapon
    ? [
        {
          type: nativeWeapon.Id,
          power: nativeWeaponPower,
          requiredlevel: 1,
          rarity: 1,
        },
      ]
    : [];


  const npcDoid = session.allocateDoid(CLID.DistributedNPCGameObject);
  /**
   * Only a launcher, and only when its own shot cannot leave. Everything else
   * is generated exactly where its tile put it.
   */
  /**
   * Left where its tile put it, even when that is inside the wall it is bolted
   * to.
   *
   * A launcher used to be nudged out until its own shot could clear geometry.
   * That was an attempt at the invisible vertical arrow and it did not fix it —
   * see docs/trap-findings.md — while the real answer to a shot dying in its own
   * mounting turned out to be the `escaping` rule in the projectile engine,
   * which lets a bolt out of the geometry it was born in.
   *
   * So the nudge only bought a difference: three of the four
   * NORDIC_CAVE_GARGOYLE_EMITTER_C on a caves floor were being sent 5 and 10
   * units off their authored square, which is why the replay listed nine of
   * them as placed-only-by-them and nine as placed-only-by-us and never
   * compared a single field. Removed, they sit where the official's sit and the
   * same two shots still land.
   */
  const partySize = Math.max(
    1,
    Math.min(
      5,
      Number(
        options.partySize ??
          [...membersOf(session)].filter((member) => member?.heroDoid != null).length
      )
    )
  );
  // Official party floors scale everything on them — barrels and cages and
  // secret walls along with the monsters. Cached for every supported party size
  // so a late join/leave can rescale the current floor without reloading
  // GameMaster or losing the damage fraction.
  const partyHitPoints = Array.from({ length: 6 }, (_, heroes) =>
    heroes === 0
      ? 0
      : npcMaxHitPoints(gm, npc, npcLevel, heroes, session.npcDepthBonus ?? 0)
  );
  /**
   * A flat addition on top, for every party size at once. `Beast Master` gives a
   * pet health and the table is cached across sizes so a late join can rescale
   * the floor — adding the bonus to the chosen entry alone would lose it the
   * moment somebody else walked in.
   */
  const bonusHitPoints = Math.max(0, Math.round(Number(options.bonusHitPoints ?? 0)));
  if (bonusHitPoints) {
    for (let size = 1; size < partyHitPoints.length; size += 1) {
      partyHitPoints[size] += bonusHitPoints;
    }
  }
  const hitPoints = partyHitPoints[Math.min(5, partySize)];
  /**
   * The body the client actually collides with, which is not the one in the
   * NPC table.
   *
   * `CollisionSize` reads like the answer and is not. It is present on all 563
   * rows and **zero on 454 of them**, so the `?? 35` behind it never fires —
   * the key is there, it is just empty — and everything it covers came out at
   * the floor of twelve. The client agrees it is not the answer:
   * `GMActor.CollisionSize` is read in exactly one place there, and that place
   * is the boomerang's hit radius.
   *
   * The authored body is the nav shape, the same circle `collisionPointOf`
   * takes its offset from and the same one the client builds its Box2D body
   * out of.
   *
   * Almost all of what this corrects is scenery rather than monsters, which is
   * worth saying plainly because the reverse was assumed first. Of the 117
   * attackable monsters only four change at all — Defense Orb 12 to 30, and
   * three Princess rows 35 to 24. Of the 446 props and smashables, 138 change:
   * a barrel was twelve where it is authored at 30, a big loot chest twelve
   * against 61, a smashable tree twelve against 202. Those are the bodies a
   * player walks into, so they were the ones being walked through.
   *
   * Scaled, like everything else. `NavCollider.buildNavColliderFromJson` builds
   * the circle at `radius * param6.x`, and that argument is the scale component
   * of the actor's own transform — so the body the client collides with is the
   * authored circle at the size the actor is drawn. It is the same product the
   * hero path already takes, and the hero's row agrees with it twice over:
   * `CollisionSize` 22 and an authored nav radius of 22, both times 1.176.
   *
   * `CollisionSize * Scale` stays as the second answer for the rows with no
   * shape, and twelve stays under both.
   */
  const authoredBody = navigationEntryFor(resolved)?.navCollisions?.[0]?.radius;
  const collisionRadius = Math.max(
    12,
    (Number(authoredBody) || (npc.CollisionSize ?? 35)) * (npc.Scale ?? 1)
  );
  const navigationColliders =
    npc.CharType === "PROP"
      ? (options.navigationColliders ?? []).map((collider) => ({
          ...collider,
          sourceKind: "LENPC",
          sourceConstant: resolved,
          sourceState: "alive",
        }))
      : [];
  /**
   * The global floor widens hostile NPC awareness, not companion or wild-beast
   * awareness.
   * Applying its default 1800 to a 600-range wolf/dragon and an 800-range
   * rhino made pets run three rooms ahead of their owners. Their own rows are
   * already explicit and match the capture corpus, so those actors keep the
   * authored radius.
   */
  const authoredAwareness = options.petOwnerDoid || npc.CharType === "BEAST";
  const aggroRadius = authoredAwareness
    ? Math.max(0, Number(npc.AggroRadius ?? 600))
    : Math.max(npc.AggroRadius ?? 600, config.npcAggroRadius);
  const disengageDistance = authoredAwareness
    ? Math.max(aggroRadius, Number(npc.DisengageDist ?? aggroRadius))
    : Math.max(npc.DisengageDist ?? 1600, aggroRadius + 400);
  // Twenty-seven rows author DeathAttack — the exploding barrels in every
  // theme among them — and it is what the thing does as it breaks.
  const deathAttack = npc.DeathAttack ? await attackForConstant(npc.DeathAttack) : null;
  const deathColliders = deathAttack ? await attackColliders(deathAttack.AttackTimeline) : [];
  // Its own weapon, or the blast is priced with the hero's — see playDeathAttack.
  const deathWeaponPower = deathAttack
    ? (npc.Weapon1 && (await weaponForConstant(npc.Weapon1))?.Power) || 1
    : 1;

  // Zero-HP rows are indestructible scenery (gates, traps); tracking them as
  // damageable would let a stray hit mark them dead.
  if (hitPoints > 0) {
    session.actors.set(npcDoid, {
      hitPoints,
      maxHitPoints: hitPoints,
      partyHitPoints,
      partySize,
      constant: resolved,
      level: npcLevel,
      // Persistent pets and rare moving BEAST rows need their levelled vector.
      // Ordinary NPCs keep the existing lazy lookup, avoiding a 15-entry Map
      // per prop.
      stats:
        options.petOwnerDoid || npc.CharType === "BEAST"
          ? npcStats(gm, npc, petCombatLevel(npcLevel))
          : undefined,
      /**
       * Which side it is on, kept so a trap can be stopped from hitting it.
       *
       * `CombatGameObject.determineIfHitBasedOnTeam` is the whole rule: a
       * HOSTILE attack connects when the teams differ and a FRIENDLY one when
       * they match. Nothing here knew an actor's team, so trap damage was
       * landing on everything in range — and nine mines standing together, all
       * on team 7, killed each other in three milliseconds every time a floor
       * was laid. That is the reported "there are no mines on the map".
       */
      team: TEAM_BY_CHAR_TYPE[npc.CharType] ?? TEAM.ENEMIES,
      // Only real enemies gate floor completion; smashing every barrel is not
      // what finishes a dungeon.
      isEnemy: npc.CharType === "ENEMY",
      // A moving BEAST is a neutral third-party combatant. Static BEAST rows
      // are traps/placeables and must never enter NPC target selection.
      isBeast: npc.CharType === "BEAST" && Boolean(npc.IsMover),
      isPet: npc.CharType === "PET" && Boolean(options.petOwnerDoid),
      masterId: Number(options.masterId ?? 0),
      /**
       * How long this one is still worth drawing after it dies.
       *
       * Whatever it does as it breaks is choreographed, and the client cannot
       * draw an object it has been told to destroy — see applyDamage, which
       * holds the death announcement open for exactly this long.
       */
      deathEffectMs: deathEffectMsFor(gm, deathAttack),
      /**
       * A gate breaks rather than dying — see applyDamage.
       *
       * `PermCorpse` says so on nineteen rows and misses one, and the miss is
       * the only one anybody can hit: of the 48 rows carrying an authored
       * *off* state without the column, 46 are traps and trigger-driven gates
       * that can never be killed in the first place. The two that can are
       * `JURASSIC_AZTEC_EXIT_GATE_A` — reported as vanishing where the arena's
       * gate leaves its broken half standing — and `HERO_DEFENSE_ORB`.
       *
       * An off state is four authored collision shapes for what the thing
       * becomes once it gives way. Nothing that dies and disappears has any use
       * for them, so carrying one is the same statement `PermCorpse` makes, in
       * a column that was filled in more carefully.
       */
      permCorpse:
        Boolean(npc.PermCorpse) ||
        Boolean(npc.IsAttackable && navigationEntryFor(resolved)?.navCollisions_off?.length),
      /**
       * An exploding barrel is scenery with a `DeathAttack`, and until now
       * nothing fired it — the placeable path honoured the column and the spawn
       * path did not, so bombs went off and barrels did not. It runs ahead of
       * the death state rather than with the rest of onDeath, because the
       * client will not play a choreography aimed at an actor it has been told
       * is dead; see applyDamage.
       */
      onDeathAttack: (doid) => {
        if (!deathAttack || !context.isActive()) return;
        const origin = session.actors.get(doid)?.position ?? at;
        playDeathAttack(
          session,
          doid,
          deathAttack,
          origin,
          worldColliders(origin, spawnHeading, deathColliders),
          { npc, weaponPower: deathWeaponPower }
        ).catch((error) => warn(`death attack ${doid}: ${error.message ?? error}`));
        /**
         * And whatever the same timeline leaves on the floor.
         *
         * `playDeathAttack` is the damage half, and it refuses outright when
         * the attack has no colliders — which `LOOT_SPAWN_A1` has not, its
         * `DamageMod` being zero and everything it authors being `spawndoober`.
         * So the reward chest broke, paid out nothing and showed nothing: the
         * shower of coins the game ends on was simply absent.
         *
         * Read off the NPC's own row rather than named here, so this is every
         * death attack that authors pickups and not a special case for a chest.
         */
        scheduleTimelineDoobers(session, deathAttack, {
          origin,
          heading: spawnHeading,
        }).catch((error) => warn(`death loot ${doid}: ${error.message ?? error}`));
      },
      /**
       * The first real hit on this actor, for `NPC_DAMAGE_TRIGGER`.
       *
       * The catacombs author two of them on one tile: a statue that wakes five
       * FODDER generators and another that wakes four BRUISER ones, both named
       * by placement id rather than by constant. Nothing in this server ever
       * published the event, so the trigger was parsed, stored, and could never
       * change — every generator behind it stayed asleep for the whole run.
       *
       * Attached the way the death hook is, rather than reaching into combat:
       * `triggers.js` already imports `applyDamage`, and importing back would
       * close a cycle.
       *
       * Latched to the first hit. What the official does on the second is not
       * settled by anything measured — the capture shows a statue struck and
       * its generators waking 183 to 666ms later, which a pulse and a latch
       * both explain. A latch is the safe reading of the two: it cannot hold a
       * downstream NOT gate low and then release it on a later swing, and the
       * generators are idempotent anyway.
       */
      onDamage: (doid) => {
        if (!context.isActive()) return;
        if (!options.suppressTriggerReporting) reportNpcDamage(session, position.id);
      },
      onDeath: (doid) => {
        if (context.isActive() && rewardData) {
          const origin = session.actors.get(doid)?.position ?? at;
          spawnNpcRewards(session, {
            floorDoid,
            npc,
            rewardData,
            origin,
            random: session.random ?? Math.random,
          });
        }
        removeNavigationObstacle(session.navigation, doid);
        // An NPC_LIFE_TRIGGER may be watching this exact placement — the boss
        // tile's is, and it is what starts the reward chest and the floor's
        // completion chain.
        if (!options.suppressTriggerReporting) reportNpcDeath(session, position.id);
        // And the room this one was standing in front of, if it was the wall
        // sealing a secret. Outside the trigger guard: a reveal is not a
        // trigger report, and a wall does not stop being a door because the
        // spawn that placed it asked for quiet.
        session.revealSecretRoom?.(position.id);
        options.onDeath?.(doid);
      },
      /** Once the body has actually been taken away — see combat.js. */
      onGone: (doid) => options.onGone?.(doid),
      position: { x: at.x, y: at.y },
      collisionRadius,
      heading: spawnHeading,
      ai:
        (["ENEMY", "BEAST"].includes(npc.CharType) || options.petOwnerDoid) &&
        npc.IsMover &&
        nativeAttack
          ? {
              kind: options.petOwnerDoid
                ? "pet"
                : npc.CharType === "BEAST"
                  ? "beast"
                  : "enemy",
              ownerDoid: Number(options.petOwnerDoid ?? 0),
              tetherDistance: Math.max(0, Number(npc.TetherDist ?? 0)),
              tetherTimerMs: Math.max(0, Number(npc.TetherTimer ?? 0) * 1000),
              returnDistance: Math.max(0, Number(npc.ReturnDist ?? 0)),
              targetTimerMs: Math.max(0, Number(npc.ChangeTargetT ?? 2) * 1000),
              targetRandMs: Math.max(0, Number(npc.ChangeTargetRand ?? 0) * 1000),
              collects: {
                gold: Boolean(npc.CollectsGold),
                xp: Boolean(npc.CollectsXp),
                crowd: Boolean(npc.CollectsCrowd),
              },
              state: "idle",
              /**
               * A monster let out of a cage is already coming for you. Waiting
               * for it to notice, when it was released precisely because you
               * are there, reads as a shuffle before it turns round — and
               * costs nothing to skip, since the chase is the same work either
               * way.
               */
              engaged: Boolean(options.engaged),
              // Hostiles may use the server's wider configured floor; pets
              // retain their authored awareness radius (see the calculation
              // above) so they do not run rooms ahead of their owner.
              aggroRadius,
              // A pursuer must not disengage immediately after it aggroes.
              disengageDistance,
              moveSpeed: npc.BaseMove ?? 180,
              collisionRadius,
              // The furthest any of its attacks reaches. This is the "may it
              // swing from here at all" bar; which attack it then uses is
              // decided per swing against that attack's own band.
              attackRange: Math.max(20, ...attackSet.map((attack) => attack.range)),
              attacks: attackSet,
              /**
               * How far off the player this one wants to stay, for the ones
               * that want to stay off it at all.
               *
               * `Aggro_AI_Type` splits the 98 fighting rows three ways —
               * 78 CHASE_AI, 13 KITE_AI, 7 TELEPORT_AI — and until now nothing
               * here read it. Measured on the official, the difference is
               * plain: a chaser's distance to a player it is fighting peaks at
               * the two bodies touching, while a kiter's has a small bump there
               * and then a broad plateau much further out.
               *
               *   KNIGHT_MARKSMAN  KITE   plateau 240-460, mode 340-360
               *   SKELETON_ARCHER  KITE   plateau 200-460, mode 260-280
               *   ICE_IMP          CHASE  peak at 60-80, its bodies meet at 57
               *
               * `MinFleeDistMult` times the attack's range lands inside that
               * plateau for every kiter the corpus covers: 300 for the two
               * archers above, 350 for KNIGHT_THROWING against a measured p25
               * of 305, 70 for KNIGHT_HALBERD against a measured p05 of 69.
               *
               * This is a standoff and not kiting. A real kiter backs away when
               * you close and `FleeTimer`/`FleeTimerRand` say for how long;
               * none of that is here. It only stops a marksman walking into
               * your face, which is what walking to contact would otherwise
               * make it do.
               */
              keepDistance:
                petRangedStandoff > 0
                  ? petRangedStandoff
                  : npc.Aggro_AI_Type === "CHASE_AI"
                  ? 0
                  : Math.max(0, Number(npc.MinFleeDistMult ?? 0)) *
                    Math.max(0, Number(nativeAttack.Range ?? 0)),
              /**
               * Both halves of the cadence, because the second one is the
               * difference between a fight and a drum roll.
               *
               * `AttackTimer` alone had every enemy swinging on the tick, in
               * step with every other enemy of its kind, and half again as
               * often as the official does. The corpus is unambiguous about the
               * shape — gaps between one NPC's successive attacks, by constant:
               *
               *   BRUTE  (1.5 + 1)     p05 1584   p50 2092   p75 2442
               *   KNIGHT (1.5 + 1)     p05 1604   p50 2259   p75 2841
               *   ICE_IMP (2 + 1)      p05 2077   p50 2667   p75 2992
               *   KNIGHT_MARKSMAN (2 + 1.5)  p05 2151  p50 3176  p75 4258
               *
               * The floor of each sits on its `AttackTimer` and the spread is
               * its `AttackTimeRand` to within a few dozen milliseconds — a
               * fresh uniform roll per swing, which is also why a pack of them
               * does not attack in unison.
               */
              attackTimerMs: Math.max(0, Number(npc.AttackTimer ?? 1.5) * 1000),
              attackRandMs: Math.max(0, Number(npc.AttackTimeRand ?? 0) * 1000),
              nextAttackAt: 0,
              attackType: nativeAttack.Id,
              // The attacker's own weapon, so damage is not read off the hero's.
              weaponPower: nativeWeaponPower,
              damage: Math.max(
                1,
                Math.round(nativeWeaponPower * Math.abs(nativeAttack.DamageMod ?? -1))
              ),
              /**
               * The shape the swing actually covers and the frame it covers it
               * on, both read from the attack's own timeline.
               *
               * `impactFrame` used to be the number 11 for `EN_SWORD_SLASH` and
               * zero for everything else in the game. The timeline has it for
               * all of them, and it is not a detail: a knight's collider is
               * authored on frame 11 of 12, so the damage was arriving 458ms
               * before the sword did.
               */
              attackColliders: nativeAttackShape,
              // What it throws, and the frame of the animation it leaves on.
              projectile: nativeProjectileRow || null,
              projectileLaunches: nativeLaunches,
              impactFrame: nativeAttackShape.length
                ? Math.min(...nativeAttackShape.map((collider) => Number(collider.frame ?? 0)))
                : 0,
              release: spawn?.release ?? null,
              wave: spawn?.wave ?? null,
            }
          : null,
    });
    /**
     * The floor counts the enemies it has seen because it cannot count the
     * ones it still holds: a corpse is disabled and dropped the moment it
     * dies, so by the time the last one falls there is nothing left to count.
     * See checkFloorCleared, which needs to tell "everything is dead" apart
     * from "there was never anything here".
     */
    if (npc.CharType === "ENEMY") session.enemiesSeen = (session.enemiesSeen ?? 0) + 1;
  }

  addNavigationObstacle(session.navigation, npcDoid, navigationColliders);

  session.send(
    npcGenerate({
      doid: npcDoid,
      parent: floorDoid,
      npcType: npc.Id,
      /**
       * Only a pet has a master. The official sends zero for every trap and
       * monster in the corpus; this server sent the hero's doid for all of
       * them, which the client feeds to `checkIfMasterIsUser` and then gates
       * behind `CharType == "PET"` — harmless, but it is not what a monster is.
       */
      masterId: npc.CharType === "PET" ? Number(options.masterId ?? heroDoid) : 0,
      level: npcLevel,
      position: at,
      heading: spawnHeading,
      scale: scale ?? npc.Scale ?? 1,
      flip: at.flip ?? 0,
      weapons,
      team,
      hitPoints,
      // Spikes and pressure plates are authored under the hero, not beside it,
      // and the tile that placed one overrides whatever its row asks for.
      layer: layerFor(npc, at.layer),
      triggerState: options.triggerState ?? 1,
    })
  );

  /**
   * The animation an arrival is, for the one thing whose attack is only that.
   *
   * `REWARD_CHEST_A` authors `Attack1: LOOT_INTRO_A1`, and its timeline is three
   * frames of `visible`, `attackEffect` and `sound` — no collider, no
   * projectile, no spawn of any kind. It is how the chest appears, and the
   * recorded runs play it once at 0.16 and 0.18 seconds after the create and
   * never again, even on a chest left standing for 8.78 seconds with an
   * `AttackTimer` of 1. So it is an entrance, not a cycle.
   *
   * Asked of the timeline rather than named: across all 573 attacks and every
   * NPC that authors an `Attack1`, exactly one carries nothing that acts, and
   * it is this chest. A rule that reads "an attack which does nothing is
   * something to look at" cannot fire a real one by accident.
   */
  if (await isArrivalAnimation(npc)) {
    const intro = await attackForConstant(npc.Attack1);
    session.send(
      npcAttackChoreography({ doid: npcDoid, attackType: intro.Id, targetActorDoid: 0 })
    );
  }
  return options.returnDoid ? npcDoid : 1;
};

const petTimelineAction = (doid, timeline) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(145) // DistributedNPCGameObject.ReceiveTimelineAction
    .utf(timeline)
    .frame();

export const cancelPetRespawn = (member) => {
  if (!member?.petRespawnTimer) return false;
  clearTimeout(member.petRespawnTimer);
  member.petRespawnTimer = null;
  return true;
};

/** Generates one member's equipped inventory pet into the active shared floor. */
export const spawnEquippedPet = async (context, member = context?.session?.member ?? context?.session, {
  respawn = false,
} = {}) => {
  const owner = member?.member ?? member;
  const spawn = owner?.petSpawn;
  if (
    !spawn ||
    Number(spawn.ownerHeroDoid) !== Number(owner?.heroDoid) ||
    !context?.session ||
    !context.isActive?.()
  ) {
    return null;
  }

  cancelPetRespawn(owner);
  const gm = context.gm ?? (await loadGameMaster());
  const npc = await npcForConstant(spawn.constant);
  if (!npc || npc.CharType !== "PET" || !npc.UsePetUI || !context.isActive()) return null;

  const ownerActor = context.session.actors?.get(owner.heroDoid);
  const ownerPosition = owner.heroPosition ?? ownerActor?.position;
  if (!ownerPosition) return null;

  const desired = petSpawnPosition(ownerPosition);
  const radius = Math.max(12, Number(npc.CollisionSize ?? 25) * Number(npc.Scale ?? 1));
  const at = nearestClearPosition(context.session.navigation, desired, radius, {
    reach: 220,
    towards: ownerPosition,
  }) ?? desired;
  const weapon = npc.Weapon1 ? await weaponForConstant(npc.Weapon1) : null;
  const petBonuses = legendaryPetBonuses(context.session.heroWeapons ?? []);
  const floorAtSpawn = context.floorDoid;

  const doid = await spawnNpc(
    { ...context, gm, heroDoid: owner.heroDoid },
    spawn.constant,
    at,
    npc.Scale,
    {
      returnDoid: true,
      level: spawn.level,
      /**
       * Raised by whatever its owner carries — see `legendaryPetBonuses`. The
       * pet's own row decides the rest; these two are the owner's legendaries
       * reaching past him, which is the only thing in the table that does.
       */
      weaponPower: scaledNpcWeaponPower(weapon, spawn.level) + petBonuses.damage,
      bonusHitPoints: petBonuses.health,
      masterId: owner.heroDoid,
      petOwnerDoid: owner.heroDoid,
      partySize: context.partySize,
      suppressRewards: true,
      suppressTriggerReporting: true,
      onDeath: () => {
        if (owner.petDoid === doid) owner.petDoid = null;
        cancelPetRespawn(owner);
        const delay = Math.max(0, Number(npc.RespawnT ?? 0) * 1000);
        if (!delay) return;
        owner.petRespawnTimer = setTimeout(() => {
          owner.petRespawnTimer = null;
          if (
            !context.isActive() ||
            context.session.floorDoid !== floorAtSpawn ||
            context.session.actors?.get(owner.heroDoid)?.dead
          ) return;
          spawnEquippedPet(
            { ...context, floorDoid: context.session.floorDoid, gm },
            owner,
            { respawn: true }
          ).catch((error) => warn(`[${context.session.id}] pet respawn failed: ${error.message}`));
        }, delay);
        owner.petRespawnTimer.unref?.();
      },
    }
  );
  if (!doid) return null;

  owner.petDoid = doid;
  if (respawn) {
    context.session.send(petTimelineAction(doid, npc.TeleportInTimeline || "TELEPORT_IN"));
  }
  return doid;
};

/**
 * Applies GameMaster PlayerScale to actors already alive when party size
 * changes. Full actors stay full and damaged actors keep the same health share.
 */
export const rescaleNpcHealthForParty = (session, heroes) => {
  const partySize = Math.max(1, Math.min(5, Math.trunc(Number(heroes) || 1)));
  let changed = 0;
  for (const [doid, actor] of session.actors ?? []) {
    const maximum = actor?.partyHitPoints?.[partySize];
    if (!(maximum > 0) || maximum === actor.maxHitPoints) continue;
    const share = actor.maxHitPoints > 0 ? actor.hitPoints / actor.maxHitPoints : 1;
    actor.maxHitPoints = maximum;
    actor.hitPoints = actor.dead
      ? 0
      : Math.max(1, Math.min(maximum, Math.round(maximum * share)));
    actor.partySize = partySize;
    session.send(hitPointsUpdate(doid, CLID.DistributedNPCGameObject, actor.hitPoints));
    changed += 1;
  }
  return changed;
};

/** A hero row by constant or id, for a map that names one. */
const heroRowFor = (gm, named) => {
  for (const hero of gm?.heroById?.values() ?? []) {
    if (hero.Constant === named || String(hero.Id) === String(named)) return hero;
  }
  return null;
};

const buildNpcs = async (context, placements) => {
  const { session, gm } = context;
  let built = 0;
  for (const placement of placements) {
    if (!context.isActive()) break;

    /**
     * A speaker wearing a hero is that hero and not also a monster. The
     * placement is one character either way; `voiceHero` only says which body
     * it stands up in.
     */
    if (placement.voice && placement.voiceHero) {
      const hero = heroRowFor(gm, placement.voiceHero);
      if (hero) {
        giveVoice(session, {
          id: placement.id,
          name: placement.voice,
          hero: { heroType: hero.Id, skinType: hero.DefaultSkinType ?? 151 },
          position: { x: placement.x, y: placement.y },
        });
        built += 1;
        continue;
      }
      warn(`[${session.id}] ${placement.voice} names no hero "${placement.voiceHero}"`);
    }
    /**
     * Kept by placement id because an `NPC_SUICIDE_TRIGGER` names its victim
     * that way — see applyTargetState. 169 of them are wired across the game,
     * and they are the room whose trigger sets off every barrel in it.
     */
    const doid = await spawnNpc(context, placement.constant, placement, placement.scale, {
      navigationColliders: placement.navigationColliders,
      returnDoid: true,
    });
    if (doid) {
      session.npcDoids ??= new Map();
      session.npcDoids.set(placement.id, doid);
      /**
       * Anything the map says can talk, can. Registered here without asking
       * what it is, so that a keeper, a statue and a signpost are one case —
       * see socket/speech.js, which is where talking is decided.
       */
      giveVoice(session, { id: placement.id, name: placement.voice });
      built += 1;
    }
  }
  return built;
};

/**
 * Doober ids 30100..30105 are the four chests and the two item boxes — see
 * awardTreasureChest.
 *
 * The boxes were left out, and they are not scenery: SMALL_ITEM_BOX carries no
 * gold, no experience and no health, so `applyDooberReward` returned on its
 * first line and recorded nothing at all. The client still played the pickup,
 * because collecting is a frame the server sends before it decides what the
 * thing was worth — so a box looked collected and vanished.
 *
 * They are chests in the client's own vocabulary: UIHud names 60001..60004 for
 * the four chests and 60005, 60006 for the two boxes, one unbroken run.
 */
const FIRST_TREASURE_DOOBER = 30100;
const LAST_TREASURE_DOOBER = 30105;

const isTreasureDoober = (id) =>
  Number(id) >= FIRST_TREASURE_DOOBER && Number(id) <= LAST_TREASURE_DOOBER;

/**
 * How many reward spots on a floor actually pay a treasure.
 *
 * The tiles mark far more than a run is meant to hand over — an ordinary Arena
 * floor carries three `TREASURE` and sixteen `RANDOM_REWARD` against a node
 * that authorises two. Paying every one of them would multiply the reward
 * economy by ten.
 *
 * `MapPage.MaxTreasure` is the allowance, and it belongs to the run rather than
 * the floor: of 93 official runs on treasure-bearing nodes — 60 of one floor
 * and 33 of two — not one exceeded it, and a second floor bought nothing extra.
 *
 * Chests are placed with the floor rather than dropped by it. `CategoryProb`
 * gives TREASURE a flat 0 for ENEMY, PROP, PET and HERO, and the captures
 * agree: of 95 treasures observed, 90 arrived within two seconds of the floor
 * generate and the rest bore no relation to any death.
 */
const treasuresOwedFor = (node) => Math.max(0, Number(node?.MaxTreasure ?? 0));

/**
 * What a tile writes when it means "a reward goes here" without saying which.
 *
 * Both are the map node's to answer. Neither names a doober row, but only one
 * of them fails to name a DooberType as well — see `buildCollectables`.
 */
const REWARD_PLACEHOLDERS = new Set(["TREASURE", "RANDOM_REWARD"]);

/** Exported so a test can hold the list against what the trap actually is. */
export const isRewardPlaceholder = (constant) => REWARD_PLACEHOLDERS.has(constant);

/**
 * And what each of those spots becomes.
 *
 * `RaritySpawn` carries one row per tier rank spreading `TOTALS` 1 across five
 * chest rarities and the two item boxes, which answers both halves at once:
 * which rarity, and whether a chest arrives instead of a box. Reading only the
 * chest half is what left the boxes — the powerup drops — never spawning at
 * all, while 46 SMALL_ITEM_BOX and 26 ROYAL_ITEM_BOX appear across the official
 * recordings, more than any single chest.
 *
 * It also explains the shape of the run. ARENA_B is COMMON 0.5 / SMALL_ITEM_BOX
 * 0.5 against MaxTreasure 2, so chests per run come out binomial(2, 0.5) —
 * which is what 93 official runs measured:
 *
 *      0 chests   24%        binomial(2, 0.5) says 25%
 *      1 chest    51%                             50%
 *      2 chests   26%                             25%
 *
 * That half used to sit here as a constant. It is not a constant: ICE_CAVES_D
 * spreads 0.1/0.25/0.25 across three rarities and 0.4 across the two boxes.
 *
 * `LEGENDARY_CHEST` is zero on all 55 rows, so a tier roll can never pay one —
 * and no dragon chest appears in 70 official recordings. The only legendary in
 * the game is node 50083's `BossRewardTreasureId`, which is why that is asked
 * first.
 */
const rewardForPlacement = async (session, placement, node) => {
  const random = session.random ?? Math.random;
  session.treasuresOwed ??= treasuresOwedFor(node);

  if (session.treasuresOwed > 0) {
    const rewardId = Number(node?.BossRewardTreasureId ?? 0);
    const treasure =
      (rewardId && (await dooberById(rewardId))) ||
      (await treasureForTier(node?.TierRank, random));
    if (treasure) {
      session.treasuresOwed -= 1;
      return treasure;
    }
  }

  /**
   * Everything the node does not owe a chest for still pays something. A spot
   * that rolled gold, or a treasure spot past the cap, becomes ordinary loot
   * rather than disappearing — the floor keeps its pickup either way.
   */
  return dooberForConstant("GOLD_MEDIUM", random);
};

const buildCollectables = async (context, placements) => {
  const { session, floorDoid } = context;
  let built = 0;

  for (const placement of placements) {
    if (!context.isActive()) break;
    /**
     * The placeholders are asked about first, and that is not tidiness.
     *
     * `dooberForConstant` falls back to reading an unmatched constant as a
     * *DooberType* and picking one of that type at random, which is how FOOD
     * and FOOD_BUFF resolve. `TREASURE` is also a DooberType — the one all six
     * chests and boxes share — so a tile spot named TREASURE never reached the
     * branch below. It resolved to a uniform one-in-six instead, bypassing the
     * map node entirely.
     *
     * Reported from play as a legendary chest on a floor that cannot pay one,
     * and the recording says exactly that: node 50004 spawned a DRAGON_CHEST,
     * and 50003 spawned two ROYAL_ITEM_BOX and a SMALL_ITEM_BOX, while their
     * RANDOM_REWARD spots — which land in the branch below because nothing
     * shares that name — correctly paid the uncommon chest their tier allows.
     * Only node 50083 authorises a legendary anywhere in the game.
     *
     * It also broke the count. Each of these spots paid out unconditionally, so
     * an ordinary floor handed over its three TREASURE placements on top of
     * whatever the node actually owed.
     */
    let doober = REWARD_PLACEHOLDERS.has(placement.constant)
      ? null
      : await dooberForConstant(placement.constant, session.random ?? Math.random);
    if (!context.isActive()) break;
    if (!doober) {
      /**
       * RANDOM_REWARD and TREASURE are placeholders for "whatever this map node
       * pays out", which the tile cannot know. Two places carry it, and only
       * twelve nodes use the first:
       *
       *   MapPage.BossRewardTreasureId  a doober id, on the twelve BOSS nodes
       *   ColiseumTiers.Treasure        a RewardCategory, on everything else
       *
       * The other ninety-four nodes report BossRewardTreasureId 0, so reading
       * only that left every generated dungeon's chests unresolved and the
       * placement skipped — the reward simply never appeared on the floor.
       */
      const node = await mapNode(session.mapNodeId);
      const reward = await rewardForPlacement(session, placement, node);
      if (!reward) {
        warn(`dungeon: unresolved collectable "${placement.constant}"`);
        continue;
      }
      doober = reward;
    }

    const dooberDoid = session.allocateDoid(CLID.DistributedDooberGameObject);
    trackDoober(session, dooberDoid, {
      x: placement.x,
      y: placement.y,
      constant: doober.Constant,
      gold: doober.Gold ?? 0,
      xp: doober.Exp ?? 0,
      crowd: doober.Crowd ?? 0,
      hpPercentage: doober.HP_PERCENTAGE ?? 0,
      mpPercentage: doober.MP_PERCENTAGE ?? 0,
      // Marks this as a chest to be earned, the way spawnBossReward does.
      ...(isTreasureDoober(doober.Id) ? { treasure: doober.Id } : {}),
    });

    session.send(
      dooberGenerate({
        doid: dooberDoid,
        parent: floorDoid,
        zone: session.dungeonZone,
        dooberType: doober.Id,
        position: placement,
        // No Doobers column names a layer, so the tile is the only thing that
        // can lift a chest reward clear of the scenery it sits in.
        layer: layerFor(null, placement.layer),
      })
    );
    built++;
  }
  return built;
};

/** Nearest live party member to a world decision, with a solo fallback. */
export const nearestPartyHeroPosition = (session, origin = { x: 0, y: 0 }) => {
  const candidates = [];
  for (const doid of session.playerActors ?? [session.heroDoid]) {
    const actor = session.actors?.get(doid);
    const position = actor?.position ?? (doid === session.heroDoid ? session.heroPosition : null);
    if (!actor?.dead && position) {
      candidates.push({
        doid,
        position,
        distance: Math.hypot(position.x - origin.x, position.y - origin.y),
      });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || Number(a.doid) - Number(b.doid));
  return candidates[0]?.position ?? null;
};

/**
 * Keeps a burst visually compact while orienting its small variation to the
 * actual door direction. The golden-angle spiral stays inside an 18-unit
 * pocket for the normal six-to-eight member waves without a random source or
 * a map-specific formation.
 */
const releaseClusterPosition = (origin, release, index, collisionRadius = 18) => {
  if (!release || index === 0) return origin;

  const exitX = release.target.x - origin.x;
  const exitY = release.target.y - origin.y;
  const exitLength = Math.hypot(exitX, exitY);
  if (exitLength < 0.001) return origin;

  /**
   * A column marching out of the door, never a ring around the spawn.
   *
   * The ring was the mistake: laid out at the golden angle, half its members
   * land behind the origin — inside the back of the cage — and have to walk
   * backwards out of the wall before they can turn round. That is the odd
   * shuffle before they engage, and on a tight cage it is also how they ended
   * up stuck behind it.
   *
   * So the layout is derived from the exit rather than from a circle: two
   * abreast, each row a body-width further along the way out. Everything is in
   * front of the mouth, nobody overlaps, and the group leaves in the direction
   * it is meant to.
   */
  const spacing = Math.max(RELEASE_CLUSTER_STEP, collisionRadius * 2.5);
  const forwardX = exitX / exitLength;
  const forwardY = exitY / exitLength;
  const row = Math.floor(index / 2);
  const side = index % 2 === 0 ? -1 : 1;
  const forward = (row + 1) * spacing;
  const sideways = side * (spacing / 2);

  return {
    x: origin.x + forwardX * forward - forwardY * sideways,
    y: origin.y + forwardY * forward + forwardX * sideways,
  };
};

/**
 * Reuses one tiny, in-memory group for the enemies emitted by a generator
 * burst. This is deliberately scoped to a single session and never reaches
 * the client; it lets local separation recognize nearby burst members without
 * creating a new global simulation system.
 */
const nextGeneratorWave = (runtime, now) => {
  if (!runtime.wave || now - runtime.wave.lastSpawnAt > WAVE_JOIN_WINDOW_MS) {
    runtime.waveSequence = (runtime.waveSequence ?? 0) + 1;
    runtime.wave = {
      id: `${runtime.placement.id}:${runtime.waveSequence}`,
      lastSpawnAt: now,
      nextMemberIndex: 0,
      expiresAt: now + WAVE_COORDINATION_MS,
    };
  }

  runtime.wave.lastSpawnAt = now;
  return { group: runtime.wave, index: runtime.wave.nextMemberIndex++ };
};

/**
 * Builds the exit animation for a generated enemy from the nearby cage shape.
 *
 * The actor itself remains at the tile's authored position, which preserves
 * the visual of a monster leaving a jail. Only the short release movement
 * ignores the enclosing trigger collider; regular navigation starts after the
 * actor reaches the computed mouth.
 */
const generatorSpawn = (session, runtime, npc) => {
  /**
   * The body the client draws, not the authored number — the same product used
   * where this spawn is announced, and it was missing here alone.
   *
   * Everything that places a released monster reads this: the cluster spacing is
   * `collisionRadius * 2.5`, and the clear-position search asks whether a body
   * of this size fits. Understating it packs a wave tighter than its members
   * actually are. 96 of the 109 NPC rows that author a `CollisionSize` also
   * author a `Scale` other than 1, averaging 1.229, so the spacing came out
   * 18.6% short of what it should be.
   *
   * Which is what a capture of this server shows against the official's: nearest
   * neighbour 51 units at the median here against 61 there, 16.4% tighter, on
   * comparable crowds. A predicted 18.6 and a measured 16.4 are the same number.
   */
  const collisionRadius = Math.max(12, (npc.CollisionSize ?? 35) * (npc.Scale ?? 1));
  const { placement } = runtime;
  const { navigation } = session;
  /**
   * The player's whereabouts belong in the key. The exit is chosen as the way
   * out nearest to them, so a plan worked out for where they stood when the
   * first of a wave came through is the wrong way round for the rest once they
   * have moved — which is how a cage ends up releasing off to one side of
   * whoever opened it.
   *
   * Quantised to a tile so a moving player does not make every spawn redo the
   * search; a step of a whole tile is what it takes to change the answer.
   */
  const hero = nearestPartyHeroPosition(session, placement);
  const heroCell = hero ? `${Math.round(hero.x / 900)},${Math.round(hero.y / 900)}` : "none";
  const cacheKey = `${collisionRadius}:${navigation?.revision ?? 0}:${heroCell}`;
  runtime.releasePlans ??= new Map();
  let release = runtime.releasePlans.get(cacheKey);

  if (!release && navigation) {
    release = findCageReleasePath(navigation, placement, collisionRadius, hero);
    if (release) runtime.releasePlans.set(cacheKey, release);
  }

  /**
   * A generator standing in scenery is normal, not a fault. The boss jails are
   * authored with their spawn point inside the wall at the back of the cage —
   * the brute is meant to step out of it, not to stand there. Refusing produced
   * a cage that swung open ten times and released nobody.
   *
   * The release-path search only knows about cage doors, so when it finds
   * nothing and the point itself is solid, the way out is simply the nearest
   * clear ground.
   */
  if (!release && isPositionBlocked(navigation, placement, collisionRadius)) {
    // Reachable from where the hero is, so nobody is released into a pocket on
    // the wrong side of a wall.
    const hero = nearestPartyHeroPosition(session, placement);
    const clear = nearestClearPosition(navigation, placement, collisionRadius, {
      // Out of the wall towards the room, wherever the room happens to be.
      towards: hero,
      reachableFrom: hero,
    });
    if (!clear) {
      warn(`[${session.id}] generator ${placement.id} has no clear ground to release onto`);
      return null;
    }
    return { position: clear, ignoredColliders: null };
  }

  const wave = nextGeneratorWave(runtime, Date.now());
  let releaseState = null;
  let spawnPosition = placement;
  if (release) {
    spawnPosition = releaseClusterPosition(placement, release, wave.index, collisionRadius);
    /**
     * A doorway is only so wide, and the column is two abreast. Where the
     * sideways half of a slot lands in the frame, that member falls back into
     * single file rather than onto the origin — falling back onto the origin
     * put every blocked member on the same spot, which is exactly the pile that
     * could not fit through the door.
     *
     * Nothing here assumes how wide the gap is: each candidate is tested, and
     * the first that clears is taken.
     */
    const usable = (candidate) =>
      !isPositionBlocked(navigation, candidate, collisionRadius, release) &&
      hasLineOfSight(navigation, candidate, release.target, collisionRadius, release);

    if (!usable(spawnPosition)) {
      const spacing = Math.max(RELEASE_CLUSTER_STEP, collisionRadius * 2.5);
      const exitX = release.target.x - placement.x;
      const exitY = release.target.y - placement.y;
      const length = Math.hypot(exitX, exitY) || 1;
      const forwardX = exitX / length;
      const forwardY = exitY / length;

      spawnPosition = placement;
      for (let step = wave.index; step >= 1; step--) {
        const single = {
          x: placement.x + forwardX * step * spacing,
          y: placement.y + forwardY * step * spacing,
        };
        if (usable(single)) {
          spawnPosition = single;
          break;
        }
      }
    }
    releaseState = { ...release, startsAt: Date.now() };
  }

  /**
   * Whatever was chosen, it has to be somewhere the actor can stand.
   *
   * A spawn placed against geometry is not stuck in the sense of a broken plan —
   * its AI runs, it faces you, it swings when you are close — it simply cannot
   * walk out of the wall it is in. That is the one left behind at the edge of a
   * room fighting from where it was put.
   */
  if (isPositionBlocked(navigation, spawnPosition, collisionRadius)) {
    const clear = nearestClearPosition(navigation, spawnPosition, collisionRadius, {
      towards: hero,
      reachableFrom: hero,
    });
    if (clear) spawnPosition = clear;
  }
  return {
    position: spawnPosition,
    release: releaseState,
    wave,
  };
};

export const completeGenerator = (session, runtime) => {
  /**
   * A generator that has been switched off owes nothing more.
   *
   * Clearing used to require the full quota to have been attempted, which was
   * true until generators learned to stop when their input went low. After
   * that, one switched off part way through could never report itself clear —
   * and a gate waiting on that report never opened, however many of its
   * monsters were killed.
   */
  const owesMore = !runtime.stopped && runtime.attemptedSpawns < runtime.maxSpawns;
  if (runtime.completed || owesMore || runtime.alive > 0) {
    return;
  }

  runtime.completed = true;
  if (runtime.placement.clearsOnAllDead) emitSignal(session, runtime.placement.id, true);
  info(`[${session.id}] generator ${runtime.placement.id} cleared`);
  checkFloorCleared(session);
};

const spawnGeneratorWave = async (context, runtime) => {
  const { session } = context;
  const { placement, maxSpawns } = runtime;
  const intervalMs = Number.isFinite(placement.spawnInterval)
    ? Math.max(0, placement.spawnInterval * 1000)
    : 1000;
  const maxPopulation = Math.max(1, Number(placement.maxPopulation ?? 1));

  for (let index = 0; index < maxSpawns; index++) {
    if (index > 0 && intervalMs > 0) await generatorSleep(runtime, intervalMs);
    if (!context.isActive() || runtime.stopped) break;

    /**
     * maxPopulation is how many of this generator's spawns may stand at once,
     * and it is usually one. Ignoring it turns a jail that should trickle out a
     * single brute at a time into ten of them at once.
     */
    while (runtime.alive >= maxPopulation) {
      if (!context.isActive() || runtime.stopped) return;
      await generatorSleep(runtime, 250);
    }
    if (!context.isActive() || runtime.stopped) break;

    /**
     * The door is held open while this one comes out, not pulsed.
     *
     * The window is a constant, not the generator's spawnInterval. Captures of
     * both floors say so: 5.41 seconds on floor one, 5.42, 5.08 and 5.07 on the
     * boss floor — while their intervals are 0.1 and 5 respectively. Tying it to
     * the interval gave floor one a hundred-millisecond door, which is the
     * "closes instantly" that left its jails full.
     */
    const doid = await spawnNpc(
      context,
      placement.spawnConstant,
      placement,
      placement.scale,
      {
        returnDoid: true,
        engaged: true,
        resolveSpawn: (npc) => generatorSpawn(session, runtime, npc),
        onDeath: (deadDoid) => {
          runtime.alive = Math.max(0, runtime.alive - 1);
          // Breaking the chest is what pays the node out; the chest's own row
          // is blank on purpose.
          if (session.rewardGenerators?.has(placement.id)) {
            spawnBossReward(session, {
              floorDoid: session.floorDoid,
              origin: session.actors.get(deadDoid)?.position ?? placement,
              node: session.mapPage,
              random: session.random ?? Math.random,
            });
          }
        },
        /**
         * Cleared when the spawn is *gone*, not when it dies.
         *
         * A chest spends six seconds throwing its contents across the room
         * after it breaks, and the floor's whole ending hangs off this signal:
         * the recorded run puts COLLECT_TREASURE_GO 6.35s after the break —
         * which is `LOOT_SPAWN_A1` running out — and then the floor's own
         * gates three and seven seconds after that. Clearing on the death
         * started the chain underneath the shower it is meant to follow.
         *
         * Anything with nothing to play is taken away in the same breath as it
         * dies, so this is no slower for the generators that hold monsters.
         */
        onGone: () => completeGenerator(session, runtime),
      }
    );
    runtime.attemptedSpawns++;
    if (doid) {
      runtime.alive++;
      runtime.spawnedDoids.add(doid);

      /**
       * A release event for each one that comes out.
       *
       * Ordinary generators are pulse sources. An all-spawns-dead generator is
       * different: its persistent signal means "the wave is clear", so this
       * release only reaches a directly wired RESET_TIMER cage latch. Its AND
       * and NOT kill-gate branches remain low until completeGenerator publishes
       * the one real completion edge.
       */
      emitGeneratorRelease(session, placement);
    }
  }

  completeGenerator(session, runtime);
  info(
    `[${session.id}] generator ${placement.id} spawned ` +
      `${runtime.spawnedDoids.size}/${maxSpawns} ${placement.spawnConstant}`
  );
};

/** Registers authored waves and starts each one only when its input goes high. */
const buildGenerators = async (context, placements) => {
  const { session } = context;
  session.generators = new Map();
  let built = 0;

  for (const placement of placements) {
    if (!context.isActive()) break;
    const maxSpawns = Math.max(
      1,
      Number.isFinite(placement.maxSpawns) ? placement.maxSpawns : placement.maxPopulation
    );
    const runtime = {
      placement,
      maxSpawns,
      attemptedSpawns: 0,
      alive: 0,
      started: false,
      completed: false,
      spawnedDoids: new Set(),
      spawnPromise: null,
      cancelWait: null,
    };
    session.generators.set(placement.id, runtime);

    const start = () => {
      if (!context.isActive() || runtime.started) return runtime.spawnPromise;
      runtime.started = true;

      /**
       * Announce the first release before the asynchronous wave begins. A cage
       * behind RESET_TIMER opens for it immediately; an all-spawns-dead AND/NOT
       * branch deliberately does not, because spawning is not clearing.
       *
       * Ordinary reward generators remain pulse sources. The chest appearing
       * starts their closing countdown; the special all-dead type waits for its
       * own completion like its name says.
       */
      emitGeneratorRelease(session, placement);
      runtime.spawnPromise = spawnGeneratorWave(context, runtime);
      return runtime.spawnPromise;
    };

    /**
     * A generator runs while its input is high and stops when it drops. The
     * boss jails are fed by the trigger that means "the minotaur is alive", so
     * killing him has to close them — otherwise they keep sending brutes for
     * the rest of the floor.
     */
    session.generatorStops ??= new Map();
    session.generatorStops.set(placement.id, () => {
      if (runtime.stopped) return;
      runtime.stopped = true;
      runtime.cancelWait?.();
      runtime.cancelWait = null;
      info(`[${session.id}] generator ${placement.id} stopped — input went low`);
    });
    session.generatorHandlers.set(placement.id, start);

    // Generators with no authored input are ordinary ambient waves.
    if (!(session.signalIncoming.get(placement.id)?.length)) start();
    /**
     * A generator whose input is already high at build time has to be started
     * here, because nothing will change afterwards to start it. The tutorial's
     * boss jails are exactly that: their brutes hang off an NPC_LIFE_TRIGGER
     * that rests on while the minotaur lives, so waiting for an edge means the
     * cages never open and the two of them never appear.
     */
    else if (initialTargetState(session, placement.id)) start();
    built++;
  }
  return built;
};

/**
 * Gates, jails and traps. They are NPC rows with CharType PROP, so the normal
 * spawn path handles them; they simply were never collected before.
 */
/**
 * Whether a placement should be left in its resting state and never driven.
 *
 * Only on a laid-out floor. An authored one was built with its wiring, so a
 * gate of its own that no trigger reaches is deliberate — the ones behind a
 * starting point are there to stop the player walking off the map.
 *
 * Unwired is included deliberately, and the captures are why. Of 473 cave spike
 * beds the official generates, 218 are never sent a trigger state at all, and
 * **not one of them ever deals damage**. A spike bed with nothing to raise it
 * stays down, so silencing it here is right rather than merely safe.
 *
 * The tar pit is the exception that proves it is the trap and not the wiring:
 * it is never sent a state either and hurts the hero anyway, forty recorded
 * times about a second apart. It is an `AREAOFEFFECT_AI` prop with
 * `InstantAttack`, which is a different mechanism from a triggered hazard —
 * see trap-findings.md. Nothing here reaches it, and nothing here should
 * pretend to.
 */
export const isInert = (session, placementId) =>
  Boolean(session.floorGenerated) && !canEverChange(session, placementId);

/**
 * Whether being stuck on would actually cost the player something.
 *
 * A tenth of the triggerables on a laid-out floor can never be switched by
 * anything standing on it, and not because the layout broke their wiring: the
 * libraries carry 961 links of 8051 whose other end names an object that is on
 * no tile at all. The wiring never crosses tiles — 7090 of the links are
 * within one and none spans two — so the official runs on exactly the same
 * dangling data, and it generates those objects *on*: `CASTLE_ARENA_GATE_D`
 * 84 times of 84, `CASTLE_ARENA_TRAP_JAIL` 162 of 165.
 *
 * Only one kind of stranding is worth being wrong about: a shut exit gate that
 * nothing can open and nobody can break — and most exit gates author
 * `IsAttackable` 0 — ends the run where it stands.
 *
 * Hazards were on this list too, on the reasoning that a spike bed stuck raised
 * is a wall that also hurts. The evidence does not support it. The official
 * generates `NORDIC_TEMPLE_TRAP_SPIKE` raised 730 times against 193 retracted
 * and `NORDIC_CAVE_SPIKETRAP` 441 against 119, on the same dangling data this
 * server has — a floor whose spikes are stranded is a floor whose spikes are
 * *up*, and it is played that way. Forcing them down instead turned a temple
 * room of thirty into flat plates: the trap is drawn, walked over and harmless,
 * which is the reported "they should be on and stay on".
 *
 * Named rather than columned for the exit gates, because the data has no
 * column for "the floor is behind this" — the same compromise, and the same
 * caveat, as `togglingLauncher`.
 */
const strandingCosts = (npc) => /EXIT_?GATE/.test(String(npc?.Constant ?? ""));

/**
 * The state a triggerable is put on the floor in.
 *
 * Four rules in a fixed order, and the order is the whole of it: a fire is
 * unlit whatever its wiring says, a launcher stays mounted whatever its wiring
 * says, a stranded exit gate opens against its wiring, and everything else is
 * generated where its signal graph rests.
 *
 * Exported because it is the one decision this server makes that a packet
 * census cannot see — both servers send field 141 on the same object and only
 * the value differs — so `tools/resting-state.js` compares it against the
 * official's rates per constant. It has to be the same code the builder runs or
 * the comparison measures the copy instead of the server.
 */
export const restingTriggerState = ({ npc, attack, projectile, inert, wired }) => {
  const { togglesRenderer, restsUnlit } = classifyHazard({ npc, attack, projectile });
  if (restsUnlit) return 0;
  if (attack && !togglesRenderer) return 1;
  if (inert && strandingCosts(npc)) return 0;
  return wired ? 1 : 0;
};

const buildTriggerables = async (context, placements) => {
  context.session.armedTraps = 0;
  context.session.inertTraps = new Map();
  context.session.stuckArmed = new Map();
  const { session } = context;
  session.triggerableDoids ??= new Map();
  session.triggerableAttacks ??= new Map();
  session.triggerableStatefulAttacks ??= new Set();
  session.triggerableHazards ??= new Map();
  let built = 0;

  for (const placement of placements) {
    if (!context.isActive()) break;
    // A few triggerables name an action instead of an object — ending the floor,
    // showing its text — and have no NPC row to build. They count as built,
    // because they are wired up and will fire.
    if (isVirtualTriggerable(placement.constant)) {
      built++;
      continue;
    }
    /**
     * Some triggerables name scenery rather than a monster — the cave's own
     * walls are placed this way. Those live in the Prop table, which shares no
     * constant with the NPC table, so the name alone settles who owns it: the
     * client draws it, and its collision is already registered by
     * readPlacements. Looking one up as an NPC only produced a warning per wall
     * per floor.
     */
    if (await propForConstant(placement.constant)) {
      built++;
      continue;
    }
    const npc = await npcForConstant(placement.constant);
    const attack = npc?.Attack1 && (await attackForConstant(npc.Attack1));
    const projectile = attack?.Projectile
      ? await projectileForConstant(attack.Projectile)
      : null;
    if (!context.isActive()) break;
    /**
     * Whether the trap's own artwork switches on and off with its trigger.
     *
     * A spike bed and a flame jet *are* the effect: field 141 drives the
     * renderer as well as the choreography, so they have to receive it. A
     * launcher does not — it stays mounted on the wall while its timeline
     * cycles, and toggling it makes the launcher itself blink in and out.
     *
     * The question is whether the attack fires a projectile, not what it is
     * called. Naming TRAP_ARROWS here covered Arena's arrows and missed every
     * sibling: the Nordic caves shoot TRAP_ICEARROWS from gargoyle emitters,
     * the villages and temples the same, and Loki's statue throws a fireball.
     * All of them were being blinked on and off.
     */
    const {
      alwaysLive,
      burnsOnContact,
      togglingLauncher,
      togglesRenderer,
      contactBomb,
      restsUnlit,
    } = classifyHazard({ npc, attack, projectile });
    // Arrow launchers stay visible; stateful traps and ordinary actuators are
    // generated in the signal graph's resting state.
    /**
     * A door nothing can open is a wall.
     *
     * The wiring comes from the whole tile library, so a laid-out floor inherits
     * triggerables whose openers live in tiles that were never placed. Left in
     * its resting state such a gate stays shut for good, and the player walks up
     * to a doorway they can see through and cannot pass.
     *
     * The test is whether a live source reaches it, not whether any source does.
     * Measured over ten runs each: one exit gate in twenty-two on Icewater
     * Caverns 1-3 and ten in twenty-six on node 50004 were wired to a subtree of
     * pure logic that could never move, so "has a source" called them fine and
     * they stayed shut all run.
     *
     * A trap nobody can trigger goes quiet for the same reason, and the reason
     * is stronger than it looks: a raised trap is a *wall*, because
     * NPCGameObject switches its navigation colliders on with its trigger
     * state. One stuck raised is a permanent block that also does permanent
     * damage, and two of them close together is a pocket the player cannot walk
     * out of — reported, and the only way out was to die.
     *
     * This used to exclude hazards, which left them armed for ever and was the
     * opposite of what the paragraph above says.
     */
    /**
     * Only on a laid-out floor. An authored one was built with its wiring, so a
     * gate of its own that no trigger reaches is deliberate — the ones behind a
     * starting point are there to stop the player walking off the map, and
     * opening them was exactly that.
     *
     * Asked of this floor rather than the run, because a run mixes the two: a
     * boss node lays out its approach and then loads the authored map.
     */
    const inert = isInert(session, placement.id);

    /**
     * Computed once, because being drawn raised and biting have to be the same
     * decision. They were not: the generate asked `restingTriggerState` while
     * the arming below asked `!inert && initialTargetState`, and a stranded
     * spike bed satisfies the first and fails the second. That is a picture of
     * a trap standing in the floor that does nothing at all to whoever walks
     * through it — reported from a catacombs room full of raised spikes the
     * player could stroll across.
     *
     * It is a crack this session opened. Narrowing `strandingCosts` to exit
     * gates was right and is what the corpus says, but it left the two halves
     * disagreeing: before it, a stranded bed was generated flat and unarmed,
     * which at least agreed with itself.
     */
    const resting = restingTriggerState({
      npc,
      attack,
      projectile,
      inert,
      wired: initialTargetState(session, placement.id),
    });

    const launch = attack ? await projectileLaunch(attack.AttackTimeline) : null;
    const aimedHeading = initialTurretHeading({
      attack,
      projectile,
      position: placement,
      launch,
      hero: session.heroPosition,
      heroes: [...(session.playerActors ?? [])]
        .map((doid) => session.actors?.get(doid))
        .filter((actor) => actor && !actor.dead && actor.position)
        .map((actor) => actor.position),
    });

    const doid = await spawnNpc(context, placement.constant, placement, placement.scale, {
      triggerState: resting,
      returnDoid: true,
      heading: aimedHeading ?? undefined,
    });
    if (!doid) continue;

    session.triggerableDoids.set(placement.id, doid);
    /**
     * What to call this doid in a log line. A trap with no hit points is not in
     * `session.actors`, so nothing else knows its name — and "trap 1437 hit
     * hero" is a report nobody can act on. See dealTrapHit.
     */
    session.trapNames ??= new Map();
    session.trapNames.set(doid, { constant: placement.constant, x: placement.x, y: placement.y });
    if (attack) {
      session.triggerableAttacks.set(placement.id, attack.Id);
      session.triggerableHazards.set(placement.id, {
        attack,
        /**
         * The direction it shoots, which is the direction it faces.
         *
         * `launchTrapProjectile` reads `hazard.heading` and fell through to
         * zero, because nothing ever set it and the placement's own field is
         * `rotation` rather than `heading`. Every projectile trap in the game
         * therefore fired due east whatever its tile said — the gargoyles, the
         * arrow traps, the temple emitters — and only Loki's statue escaped it
         * by overwriting the field as it aims. See headingFor.
         */
        heading: aimedHeading ?? headingFor(npc, placement),
        /**
         * Where the client draws the shot leaving from.
         *
         * The timeline's `projectile` action carries it, and Loki's says
         * `yOffset: -180` — out of the statue's raised hands. Both the aim and
         * the flight are taken from there, because the client aims the actor
         * and then launches from the offset point: matching only one of the two
         * leaves the damage on a line parallel to the flame instead of under it.
         */
        launch,
        // Which side the trap is on, so its blast cannot take its neighbours
        // with it — see teamAllowsHit.
        team: TEAM_BY_CHAR_TYPE[npc.CharType] ?? TEAM.ENVIRONMENT,
        /**
         * How long its own animation runs, which is how long a spent bomb has
         * to stay on the floor before it may be taken away. See retireSpentBomb.
         */
        timelineFrames: await attackTimelineFrames(attack.AttackTimeline),
        // Spent by its first bite; see holdZone.
        contactBomb,
        projectile,
        // Carried for AttackTimer: how often a raised trap hits what stands in
        // it, which is authored on the NPC and not on the attack.
        npc,
        position: placement,
        /**
         * The trap's own weapon. Only the six flat-damage traps read it — the
         * five slicers and the burning ground — but every trap row carries one,
         * and without it a disk that should carve you took a single point.
         */
        weaponPower: (npc.Weapon1 && (await weaponForConstant(npc.Weapon1))?.Power) || 1,
        combatColliders: await hazardShape(npc, attack, placement),
        /**
         * A trap that comes out of the floor hurts the player and nobody else.
         * Every one of 25 recorded TRAP_SPIKES results named the hero, while
         * the mace, blade, flame jet, arrows and Thor's hammer all cut through
         * imps, knights and yetis. Monsters cross a spike bed and are only
         * shoved aside — which they are anyway, since a raised trap is a
         * navigation obstacle.
         *
         * Being drawn under the hero and coming out of the ground are the same
         * fact, so the layer is the test: every hero-only trap in the capture
         * is `background`, every one that hurts monsters is `sorted`.
         */
        heroOnly: layerFor(npc, placement.layer) < LAYER_SORTED,
      });
    }
    if (togglesRenderer) session.triggerableStatefulAttacks.add(placement.id);

    if (attack && inert) {
      session.inertTraps?.set(
        placement.constant,
        (session.inertTraps.get(placement.constant) ?? 0) + 1
      );
    }

    if (traced(session, placement.constant)) {
      info(
        `[trace] ${placement.constant} doid=${doid} at ${Math.round(placement.x)},` +
          `${Math.round(placement.y)} starts ${initialTargetState(session, placement.id) ? "on" : "off"}` +
          `${inert ? " (inert — nothing can ever change it)" : ""}` +
          `${attack ? ` attack=${attack.Constant}` : ""}\n` +
          describeInputs(session, placement.id)
      );
    }
    /**
     * A trap that comes up already raised has to start beating on its own.
     *
     * Every hazard beat until now was started by a signal *arriving*, and a
     * trap whose source can never move never receives one — so it stood up at
     * generation and was scenery for the rest of the run. On a laid-out floor
     * that is not the rare case: 181 of the ice caves' 527 spike beds hang off
     * a NOT gate, and a laid-out floor inherits gates whose inputs live in
     * tiles that were never placed.
     */
    /**
     * A statue shoots whether or not anything switched it on.
     *
     * Four of the six Loki statues in the temple capture are sent no trigger
     * packet at all and fire twenty-eight rounds between them anyway; the other
     * two get a single `remoteTriggerState = 1` a fifth of a second before
     * their first shot and never another. Waiting for `initialTargetState` left
     * ours silent on any floor whose wiring did not resolve, which is most of
     * them — the same way spike beds stood still before `burnsOnContact`.
     *
     * Armed on arrival, still switchable: the corpus has 26 switch-ons and 21
     * switch-offs across fourteen statues, so the toggling is real and stays.
     */
    if (
      attack &&
      (alwaysLive ||
        burnsOnContact ||
        contactBomb ||
        (togglingLauncher && !inert) ||
        // Exactly what was drawn: a bed standing up bites, a flat one does not.
        (togglesRenderer && resting))
    ) {
      raiseHazard(session, placement.id);
      // A raised trap is also a wall — NPCGameObject turns its navigation
      // colliders on with its trigger state — so how much of a floor arrives
      // armed is worth being able to see.
      session.armedTraps = (session.armedTraps ?? 0) + 1;
      /**
       * Armed, and nothing on this floor can ever switch it off again.
       *
       * On a laid-out floor `isInert` has already silenced these. An authored
       * one keeps them deliberately, so nothing reported them at all — and a
       * hazard in this state is the shape of "it played once when the map
       * loaded and then the picture went, but walking through it still burns
       * me": the client draws one activation, while a sustained trap goes on
       * testing contact for the rest of the floor.
       *
       * Whether that is right is a question about the trap, so this names them
       * rather than changing anything.
       */
      if (!canEverChange(session, placement.id)) {
        session.stuckArmed?.set(
          placement.constant,
          (session.stuckArmed.get(placement.constant) ?? 0) + 1
        );
      }
    }

    // A turret turns whether or not its fire timer has come round, so this does
    // not hang off the arming above. Loki's statue is never sent a trigger
    // state at all in the captures, and turns for the whole floor.
    if (attack) startTurretAim(session, placement.id);
    built++;
  }
  return built;
};

/**
 * What a trap hits with.
 *
 * Two sources author a shape and most traps have only one. `library_server`
 * carries a `combatCollisions` shape for the traps that *are* their own effect
 * — a spike bed, a flame jet — placed and transformed with the tile. The moving
 * ones carry none at all: a mace and a crusher have navigation collisions and
 * nothing else, so asking only the library gave them an empty shape, and an
 * empty shape catches nobody. That is the whole of "the swinging traps do not
 * damage".
 *
 * Their shape is on the attack's own timeline instead, as the frames of the
 * swing — six for a cave mace, tracking the head from one side to the other.
 * Taking all of them at once makes the damage zone the whole arc for as long as
 * the trap is up, which is coarser than the animation: the real thing is only
 * dangerous where the head is *now*. Following the frames needs the trap's
 * animation clock, which nothing here has yet.
 */
/**
 * Where a trap can hurt you, from whichever of its two shapes is the truth.
 *
 * A triggerable carries an authored shape in `library_server` and its attack
 * carries a timeline, and they are good at different things. For a trap that
 * stands still the library wins: it is the real extent, nine boxes for the nine
 * spikes of `CASTLE_ARENA_TRAP_SPIKES_A` where the timeline has one generic
 * square.
 *
 * For a trap that moves the library cannot say anything at all, because its
 * boxes carry no frame. Preferring it flattened every flame jet — eighteen rows
 * whose timeline is three beats at 0, 500 and 958ms — into one static box, and
 * a flattened trap takes the sustained branch: no choreography is ever sent, so
 * the client never plays the flame, and damage lands on 100ms contact ticks
 * instead of on the authored beats. Which is exactly what our own stream showed
 * next to theirs: two hits 199ms apart and not one animation, against their one
 * animation per activation.
 *
 * So the timeline wins whenever it has something to say about motion, and the
 * library wins otherwise.
 */
const hazardShape = async (npc, attack, placement) => {
  const timeline = await attackColliders(attack.AttackTimeline);
  const moves = new Set(timeline.map((collider) => Number(collider.frame ?? 0))).size > 1;
  if (!moves && placement.combatColliders?.length) return placement.combatColliders;
  /**
   * The same heading the actor was generated at, or a flipped trap fires the
   * way it is not facing — an arrow emitter on the right-hand wall of a temple
   * drew itself pointing left and shot to the right, because the picture came
   * from `rotation` and the shot still came from `DefaultHeading`.
   */
  return worldColliders(placement, headingFor(npc ?? {}, placement), timeline);
};

const BUILDERS = {
  npc: buildNpcs,
  collectable: buildCollectables,
  generator: buildGenerators,
  triggerable: buildTriggerables,
};

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

  for (const [kind, build] of Object.entries(BUILDERS)) {
    if (!isActive()) return;
    const placements = room.placements[kind] ?? [];
    if (placements.length) await build(context, placements);
  }
  info(
    `[${session.id}] secret room revealed at ${room.tile.x},${room.tile.y} ` +
      `by ${placementId}`
  );
};

const dungeonMembers = (session) =>
  [...membersOf(session)].filter(
    (member) => isLiveMember(member) && member?.heroSpawn && member?.heroDoid
  );

const contextForMember = (member) => member.world?.contextFor(member) ?? member;

const heroFrameForFloor = (member, floorDoid, position, owner) => {
  const spawn = member.heroSpawn;
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

/** Installs every live member on a new floor and emits recipient-correct heroes. */
const buildPartyHeroes = async (session, floor, floorDoid) => {
  const members = dungeonMembers(session);
  session.playerActors = new Set();

  for (const member of members) {
    const context = contextForMember(member);
    const spawn = member.heroSpawn;
    const at = { x: floor.spawn.x, y: floor.spawn.y };
    session.actors.set(member.heroDoid, {
      hitPoints: spawn.effectiveHitPoints,
      maxHitPoints: spawn.effectiveHitPoints,
      collisionRadius: spawn.collisionRadius,
      constant: spawn.constant,
      // On the actor, so the floor prices a hit on any hero the same way it
      // prices one on a monster: from the actor, not from a connection.
      stats: member.heroStats,
      position: { ...at },
      team: TEAM.PLAYERS,
    });
    session.objects.set(member.heroDoid, CLID.HeroGameObject);
    member.objects?.set(member.heroDoid, CLID.HeroGameObject);
    session.playerActors.add(member.heroDoid);
    context.heroPosition = { ...at };
    context.reportedHeroPosition = { ...at };
    context.heroPositionAt = Date.now();
    context.reportedHeroPositionAt = context.heroPositionAt;
    context.movementCredit = 1000;
    context.movementCreditAt = context.heroPositionAt;
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
 * Builds the per-member half of a dungeon without laying out a second world.
 *
 * Solo entry uses it and immediately builds the floor. Multiplayer late entry
 * uses the same preparation, then generates this member's owner objects into
 * the already existing `DungeonMatch.world`.
 */
export const prepareDungeonMember = async (
  session,
  { isActive = () => true, sendPlayerOwner = true, account: providedAccount } = {}
) => {
  const account = providedAccount ?? await loadAccount(session.accountId);
  if (!isActive()) return false;
  const avatar = account.account_avatars?.find((row) => row.id === account.active_avatar);
  if (!avatar) {
    throw new Error(
      `account ${account.id} active avatar ${account.active_avatar} does not name an owned avatar`
    );
  }

  session.dungeonAccount = holdAccount(account);
  session.dungeonAvatar = avatar;
  session.dungeonStart = {
    basicCurrency: account.basic_currency ?? 0,
    experience: avatar.experience ?? 0,
    // When the run began, which is the only thing a speedrun board needs that
    // the summary does not already carry.
    at: Date.now(),
  };
  session.dungeonRewards = { gold: 0, gems: 0, xp: 0 };
  session.dungeonContribution = { kills: 0, damage: 0 };
  session.dungeonTreasures = [];
  session.completionAwarded = false;
  session.receivedTrophy = 0;
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
  const slotPoints = hero ? wireSlotPoints(gm, hero, avatar) : [0, 0, 0, 0];
  session.heroManaPoints = manaPoints;
  session.maxHeroManaPoints = manaPoints;
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
  { account: providedAccount } = {}
) => {
  leaveDungeon(session, { notifyClient: true });
  const dungeonEpoch = session.dungeonEpoch;
  const isActive = () => session.dungeonActive && session.dungeonEpoch === dungeonEpoch;
  session.dungeonActive = true;
  session.floorCleared = false;
  session.enemiesSeen = 0;
  // Production creates DistributedDungeonSummary in the dungeon interest zone.
  session.dungeonZone = 10;
  session.mapNodeId = mapNodeId;
  // Which is what a friend's panel means by "in a dungeon" — see presence.js.
  setPresenceLocation(session, mapNodeId);
  session.dungeonRewards = { gold: 0, gems: 0, xp: 0 };
  session.dungeonContribution = { kills: 0, damage: 0 };
  session.dungeonTreasures = [];
  session.completionAwarded = false;
  session.receivedTrophy = 0;
  /**
   * Whether this node is a file or a layout is the node's own business — twelve
   * of them name a CustomTileset and the rest do not. Everything past here
   * treats the two the same.
   */
  session.floorPlan = await floorPlanForMapNode(mapNodeId);
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

  const areaDoid = session.allocateDoid(CLID.DistributedDungionArea);
  // The area preloads once, for the whole run — see tileLibrariesFor.
  const tileLibraries = await tileLibrariesFor(session.floorPlan);
  /**
   * And the art that goes with them. Left empty, the client reaches a movie
   * clip whose SWF was never loaded and draws nothing without failing — which
   * is what made the fire and mine placeables invisible. See precache.js.
   */
  const { cacheNpcs, cacheSwfs } = await preloadFor(tileLibraries, {
    gm: await loadGameMaster(),
    tierConstant: (await mapNode(mapNodeId))?.TierRank ?? "",
  });
  if (!isActive()) return false;
  session.send(dungeonAreaGenerate({ doid: areaDoid, tileLibraries, cacheNpcs, cacheSwfs }));
  info(
    `[${session.id}] generated DungionArea doid=${areaDoid} — ` +
      `${tileLibraries.length} tile librar${tileLibraries.length === 1 ? "y" : "ies"}, ` +
      `${cacheNpcs.length} npcs and ${cacheSwfs.length} swfs to preload`
  );

  await sleep(config.floorDelayMs);
  if (!isActive()) return false;

  const floorDoid = session.allocateDoid(CLID.DistributedDungeonFloor);
  // The floor has to be generated as a child of the area: DcSocket calls
  // InformParentOfNewObject, which is what sets Area.mActiveFloor. Without that
  // link every floor-ending message the area receives is silently dropped.
  const node = await mapNode(mapNodeId);
  session.tierConstant = node?.TierRank ?? "";
  // What finishing this node is worth, and which bit it sets on the world map.
  session.mapPage = node;
  session.send(
    dungeonFloorGenerate({
      doid: floorDoid,
      parent: areaDoid,
      mapNodeId,
      floor,
      // Numbered from the floor actually entered, so DR_START_FLOOR does not
      // put the client on 2000 while it stands on the eighth floor.
      floorNumber: FIRST_FLOOR_NUMBER + session.floorIndex,
      tierConstant: session.tierConstant,
    })
  );
  session.areaDoid = areaDoid;
  session.floorDoid = floorDoid;
  info(`[${session.id}] generated DungeonFloor doid=${floorDoid} (${floor.tiles.length} tiles)`);

  const account = providedAccount ?? await loadAccount(session.accountId);
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
  const avatar = account.account_avatars?.find((row) => row.id === account.active_avatar);
  if (!avatar) {
    throw new Error(
      `account ${account.id} active avatar ${account.active_avatar} does not name an owned avatar`
    );
  }
  session.dungeonAccount = holdAccount(account);
  session.dungeonAvatar = avatar;
  session.dungeonStart = {
    basicCurrency: account.basic_currency ?? 0,
    experience: avatar?.experience ?? 0,
    at: Date.now(),
  };
  // Production uses the account id as the owner player doid. The summary UI
  // resolves DungeonReport.id through GameObjectManager and reads currency
  // from this object, so omitting it leaves a native null reference.
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
  const gm = await loadGameMaster();
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
  const slotPoints = hero ? wireSlotPoints(gm, hero, avatar) : [0, 0, 0, 0];
  session.heroManaPoints = manaPoints;
  session.maxHeroManaPoints = manaPoints;

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

  const party = await buildPartyHeroes(session, floor, floorDoid);

  session.navigation = createNavigationState(floor.navigation);
  // The trigger graph reaches these by name; wiring them here keeps triggers.js
  // free of any knowledge about floors and dungeons.
  session.completeFloor = completeFloor;
  session.showFloorText = showFloorText;
  session.playFloorSound = playFloorSound;
  session.reportFloorFailed = reportFloorFailed;
  session.killAllEnemies = killAllEnemies;
  session.advanceFloor = (target) =>
    advanceFloor(target).catch((err) =>
      warn(`[${target.id}] floor advance failed: ${err.message}`)
    );
  session.floorFinished = false;
  session.floorSettled = false;
  trackTriggers(session, floor);

  const context = {
    session,
    floorDoid,
    heroDoid,
    mapNodeId: session.mapNodeId,
    // Carried rather than reached for per NPC: spawnNpc prices an enemy's health
    // from the Stats table, and the load is cached but the await is not free
    // once per placement on a floor that has thousands.
    gm: await loadGameMaster(),
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

  for (const [kind, build] of Object.entries(BUILDERS)) {
    if (!isActive()) return false;
    const placements = floor.placements[kind] ?? [];
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
  const tier = session.floorPlan?.tier;
  if (tier && isActive()) {
    const stock = stockFloor(context.gm, { floor, navigation: session.navigation, tier });
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
  for (const member of party) {
    const context = contextForMember(member);
    context.stopManaRegen?.();
    context.stopManaRegen = await startManaRegen(context);
  }
  return true;
};

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

  // Per-floor work belongs to the floor that is ending.
  session.stopAi?.();
  session.stopAi = null;
  const party = dungeonMembers(session);
  for (const member of party) {
    cancelPetRespawn(member);
    member.petDoid = null;
    member.stopManaRegen?.();
    member.stopManaRegen = null;
    clearSecurityState(contextForMember(member));
  }
  session.stopTriggers?.();
  session.stopTriggers = null;
  session.stopTrapProjectiles?.();
  session.stopTrapProjectiles = null;
  clearFloorFailing(session);
  clearHazardBeats(session);
  forgetVoices(session);
  clearDungeonBuffs(session);
  clearDungeonPowerups(session);
  clearDungeonPlaceables(session);

  const floor = await loadFloorAt(session.floorPlan, next);
  if (!isActive()) return false;

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
  session.floorCleared = false;
  session.enemiesSeen = 0;

  const floorDoid = session.allocateDoid(CLID.DistributedDungeonFloor);
  session.floorDoid = floorDoid;
  session.send(
    dungeonFloorGenerate({
      doid: floorDoid,
      parent: session.areaDoid,
      mapNodeId: session.mapNodeId,
      floor,
      floorNumber: FIRST_FLOOR_NUMBER + next,
      tierConstant: session.tierConstant ?? "",
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
  const settled = settleDungeonAccount(session);
  cancelPetRespawn(session);

  // Back in town, which the client reads as online and not in a dungeon.
  setPresenceLocation(session, 0);
  session.dungeonEpoch = (session.dungeonEpoch ?? 0) + 1;
  session.dungeonActive = false;
  session.stopTriggers?.();
  session.stopTriggers = null;
  session.stopAi?.();
  session.stopAi = null;
  session.stopManaRegen?.();
  session.stopManaRegen = null;
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
   * Let go of the shared account before the reference to it goes.
   *
   * Released here rather than when the socket closes because this is where the
   * session stops being one of the people playing it: from now on it changes
   * nothing, so the next JSON-RPC should read storage again rather than a copy
   * this run happened to leave behind.
   */
  if (session.dungeonAccount) releaseAccount(session.dungeonAccount.id);

  for (const key of [
    "areaDoid",
    "floorDoid",
    "heroDoid",
    "heroPosition",
    "reportedHeroPosition",
    "heroPositionAt",
    "reportedHeroPositionAt",
    "movementCredit",
    "movementCreditAt",
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
    // The run's remaining chest allowance, rolled once from the node.
    "treasuresOwed",
    "accountSettled",
    "completionAwarded",
    "receivedTrophy",
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
    "dooberTimers",
    "activeTrapProjectiles",
    // Whatever else is added here, note that per-run state kept anywhere *but*
    // this list survives into the next dungeon — see removeHeroFromFloor, where
    // a flag that did exactly that crashed the client on the second run.
  ]) {
    delete session[key];
  }

  return settled;
};
