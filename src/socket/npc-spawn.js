import { npcGenerate, layerFor } from "./objects.js";
import { runRulesOf } from "./run-rules.js";
import { npcForConstant, resolveSpawnConstant, weaponForConstant, attackForConstant, attackColliders, projectileLaunches, projectileForConstant, deathRewardDataForNpc, isArrivalAnimation, FRAMES_PER_SECOND } from "../gamemaster.js";
import { maxHitPoints } from "../hero-stats.js";
import { npcStats } from "../combat-damage.js";
import { npcMaxHitPoints } from "../npc-stats.js";
import { petCombatLevel } from "../pets.js";
import { CLID, OP, TEAM } from "./opcodes.js";
import { PacketWriter } from "./packet.js";
import { playDeathAttack, reportNpcDamage, reportNpcDeath } from "./triggers.js";
import { worldColliders } from "./heading.js";
import { npcAttackChoices } from "./npc-attacks.js";
import { addNavigationObstacle, navigationEntryFor, removeNavigationObstacle } from "./navigation.js";
import { config } from "../config.js";
import { warn } from "../log.js";
import { spawnNpcRewards } from "./drops.js";
import { claimXpStar, countFloorXp } from "./run-xp.js";
import { grantBuff } from "./buffs.js";
import { scheduleTimelineDoobers } from "./powerups.js";
import { npcAttackChoreography } from "./combat.js";
import { membersOf } from "./match-world.js";
import { spawnInfiniteModifierActors } from "./floor-population.js";
import { passesFilter, headingFor } from "./dungeon.js";

/**
 * One NPC onto the floor. `spawnNpc` builds its actor — team, awareness, AI
 * record, death effects, timeline actions — from the game data and generates
 * it to every member. Everything that puts a monster on a floor calls this.
 */

/** Corpus-derived: PROP 1, ENEMY 6, BEAST 7, PET 5, HERO 5. See spawnNpc. */
export const TEAM_BY_CHAR_TYPE = {
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

/** The awareness and leash authored by one NPC row, without a global minimum. */
export const npcAwarenessProfile = (
  npc,
  { fallbackAggroRadius = config.npcAggroRadius, ownedPet = false } = {}
) => {
  const aggroRadius = Math.max(0, Number(npc?.AggroRadius ?? fallbackAggroRadius));
  const keepsAuthoredLeash = ownedPet || npc?.CharType === "BEAST";
  const authoredDisengage = Number(
    npc?.DisengageDist ?? (keepsAuthoredLeash ? aggroRadius : 1600)
  );
  const disengageDistance = keepsAuthoredLeash
    ? Math.max(aggroRadius, authoredDisengage)
    : Math.max(authoredDisengage, aggroRadius + 400);
  return { aggroRadius, disengageDistance };
};

export const spawnNpc = async (context, constant, position, scale, options = {}) => {
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
  /**
   * Every weapon the row carries, in slot order. A rival hero carries four —
   * the official's RIVAL_SORCERER generate lists its staff and three books —
   * and the client draws the one each swing names; sending only the first
   * drew the staff for every spell.
   */
  const nativeWeapons = await Promise.all(
    ["Weapon1", "Weapon2", "Weapon3", "Weapon4"].map((key) =>
      npc[key] ? weaponForConstant(npc[key]) : null
    )
  );
  const nativeWeapon = nativeWeapons[0];
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
  const attackSet = await npcAttackChoices(npc, nativeWeapon, nativeWeaponPower, { weapons: nativeWeapons });
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
  const weapons = nativeWeapons
    .map((weapon, index) =>
      weapon
        ? {
            type: weapon.Id,
            // The first slot is priced as the row's own; the others as authored.
            power: index === 0 ? nativeWeaponPower : Math.max(1, Number(weapon.Power ?? 1)),
            requiredlevel: 1,
            rarity: 1,
          }
        : null
    )
    .filter(Boolean);


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
  const generatedMasterId = npc.CharType === "PET" ? Number(options.masterId ?? heroDoid) : 0;
  const generatedScale = scale ?? npc.Scale ?? 1;
  const generatedFlip = at.flip ?? 0;
  const generatedLayer = layerFor(npc, at.layer);
  const generatedTriggerState = options.triggerState ?? 1;
  const npcCreateFrame = (position, heading, currentHitPoints = hitPoints) =>
    npcGenerate({
      doid: npcDoid,
      parent: floorDoid,
      npcType: npc.Id,
      masterId: generatedMasterId,
      level: npcLevel,
      modifierGeneration: Math.max(0, Number(options.modifierGeneration ?? 0)),
      position,
      heading,
      scale: generatedScale,
      flip: generatedFlip,
      weapons,
      team,
      hitPoints: currentHitPoints,
      layer: generatedLayer,
      triggerState: generatedTriggerState,
    });
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
   * The row's awareness wins; the configured value is only a fallback.
   *
   * Treating `npcAggroRadius` as a minimum replaced 91 of the 98 moving enemy
   * rows: a 600-radius brute became 900 (2.25x the awareness area), a
   * 300-radius enemy became 900 (9x), and the deliberately passive
   * WARTHOG_WHITE_FAT was raised from zero. Every shipped NPC row authors this
   * field, so none of those values needs a server-wide correction.
   */
  const { aggroRadius, disengageDistance } = npcAwarenessProfile(npc, {
    ownedPet: Boolean(options.petOwnerDoid),
  });
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
      abilities: new Set(
        [npc.Ability1, npc.Ability2, npc.Ability3, npc.Ability4, npc.Ability5].filter(Boolean)
      ),
      level: npcLevel,
      // Persistent pets and rare moving BEAST rows need their levelled vector.
      // Pet offence follows the captured level^1.5 curve; a wild beast follows
      // the same linear combat growth as an ordinary enemy. Ordinary NPCs keep
      // the lazy lookup, avoiding a 15-entry Map per prop.
      stats:
        options.petOwnerDoid
          ? npcStats(gm, npc, petCombatLevel(npcLevel))
          : npc.CharType === "BEAST"
            ? npcStats(gm, npc, npcLevel)
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
      teleportRegenerate:
        npc.Aggro_AI_Type === "TELEPORT_AI"
          ? (position, heading) => {
              const current = session.actors.get(npcDoid);
              session.send(npcCreateFrame(position, heading, current?.hitPoints ?? hitPoints));
            }
          : null,
      /**
       * Two questions, and they used to share one answer. Whether this is an
       * enemy is what pets hunt, what the hero's bombs and fissures catch, what
       * FLOOR_KILL_ALL_NPCS takes and what counts on the report. Whether it
       * holds the floor open is only the floor's question — a boss's clones and
       * an Infinite modifier's spawns are enemies it did not stock.
       *
       * Answered together, a summoned clone was nobody's target but the hero's
       * sword. The official counts it: its solo samurai run reports 29 kills,
       * which is the 28 ordinary enemies and the one clone the hero killed,
       * and not the two its pet killed.
       */
      isEnemy: npc.CharType === "ENEMY",
      isProp: npc.CharType === "PROP",
      holdsFloor: npc.CharType === "ENEMY" && options.countsForFloor !== false,
      /**
       * And a third: whether anything may pick it as a target. `IsAttackable`
       * is the client's own answer — `isAttackable = IsAttackable &&
       * triggerState` — so a hero is never offered one to hit. Thirty ENEMY
       * rows say no: every placeable, Infinite's ice bombs and lightning orbs,
       * and the lava golem boss. A pet chasing an orb, or a hero's bomb putting
       * out an ice bomb before it goes off, is this server choosing a target
       * the client never could.
       */
      attackable: Boolean(npc.IsAttackable),
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
        // And whatever it calls up as it goes — the heavy red specter's last
        // flame. See summons.js.
        session.summon?.(doid, deathAttack, 1, { dying: true });
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
        spawnInfiniteModifierActors(context, {
          event: "hit",
          npc,
          origin: session.actors.get(doid)?.position ?? at,
          generation: Math.max(0, Number(options.modifierGeneration ?? 0)),
        });
      },
      onDeath: (doid) => {
        if (context.isActive() && rewardData) {
          const origin = session.actors.get(doid)?.position ?? at;
          // What another monster called up is outside the node's budget and
          // leaves no star. Everything else carries its share of the node,
          // which for some is nothing — see run-xp.js. A run that pays no
          // experience (run-rules.js) drops no star at all.
          const star = options.countsForFloor !== false && runRulesOf(session).pays.experience
            ? claimXpStar(session, npc, session.random ?? Math.random)
            : null;
          spawnNpcRewards(session, {
            floorDoid,
            npc,
            rewardData,
            origin,
            random: session.random ?? Math.random,
            xp: star !== null,
            xpWorth: star ?? undefined,
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
        spawnInfiniteModifierActors(context, {
          event: "death",
          npc,
          origin: session.actors.get(doid)?.position ?? at,
          generation: Math.max(0, Number(options.modifierGeneration ?? 0)),
        });
        options.onDeath?.(doid);
      },
      /** Once the body has actually been taken away — see combat.js. */
      onGone: (doid) => options.onGone?.(doid),
      position: { x: at.x, y: at.y },
      collisionRadius,
      heading: spawnHeading,
      /**
       * `isAlly`: on the players' side without being a player — the chef to be
       * saved, a princess, a barricade, a defence orb. The official's monsters
       * go for these as for anybody: Battleheim's warhogs land 517 hits on
       * barricades and 308 on defence orbs, and the Cretaceous sorcerers put
       * 20 on the chef. Targeted by distance like a hero (ai.js), and the one
       * that walks (the chef) fights back with an AI of its own.
       */
      isAlly: npc.CharType === "HERO" && !options.petOwnerDoid && Boolean(npc.IsAttackable),
      ai:
        (["ENEMY", "BEAST", "HERO"].includes(npc.CharType) || options.petOwnerDoid) &&
        (npc.IsMover || (npc.IsBoss && npc.Aggro_AI_Type === "STATIONARY_AI")) &&
        nativeAttack
          ? {
              kind: options.petOwnerDoid
                ? "pet"
                : npc.CharType === "BEAST"
                  ? "beast"
                  : npc.CharType === "HERO"
                    ? "ally"
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
              attackLockedUntil: 0,
              /**
               * A monster let out of a cage is already coming for you. Waiting
               * for it to notice, when it was released precisely because you
               * are there, reads as a shuffle before it turns round — and
               * costs nothing to skip, since the chase is the same work either
               * way.
               */
              engaged: Boolean(options.engaged),
              // Hostiles, wild beasts and pets all keep their authored
              // awareness radius (see the calculation above).
              aggroRadius,
              // A pursuer must not disengage immediately after it aggroes.
              disengageDistance,
              // A stationary boss participates in targeting and attack cadence
              // without being separated or routed away from its authored spot.
              moveSpeed: npc.IsMover ? (npc.BaseMove ?? 180) : 0,
              collisionRadius,
              behavior: npc.Aggro_AI_Type ?? "CHASE_AI",
              lockRotation: Boolean(npc.LockRotation),
              fleeTimerMs: Math.max(0, Number(npc.FleeTimer ?? 0) * 1000),
              fleeRandMs: Math.max(0, Number(npc.FleeTimerRand ?? 0) * 1000),
              fleeArmed: true,
              teleportRange: Math.max(0, Number(npc.TeleportRange ?? 0)),
              teleportRecurMs: Math.max(0, Number(npc.TeleportRecurT ?? 0) * 1000),
              teleportRecurRandMs: Math.max(0, Number(npc.TeleportRecurRand ?? 0) * 1000),
              preTeleportAttackMs: Math.max(0, Number(npc.PreTeleportAttack ?? 0) * 1000),
              postTeleportAttackMs: Math.max(0, Number(npc.PostTeleportAttack ?? 0) * 1000),
              teleportInTimeline: npc.TeleportInTimeline || "TELEPORT_IN",
              teleportOutTimeline: npc.TeleportOutTimeline || "TELEPORT_OUT",
              // The out animation plays before the object is disabled. Rows
              // author the pre-teleport pace; its reciprocal gives the client
              // roughly one animation beat without naming either specter.
              teleportOutDelayMs:
                1000 / Math.max(1, Number(npc.PreTeleportAttack ?? 1)),
              teleportPhase: "visible",
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
               * The standoff is also the threshold for the authored flee
               * state. `ai.js` backs KITE_AI away when a target crosses it and
               * holds attacks for FleeTimer/FleeTimerRand; rows authoring zero
               * retain this stationary standoff without inventing a pause.
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
              // Its opening TIMELINE_TRIGGERABLE wakes it. Without this hold
              // the first 250ms AI tick can attack before GOLEM_INTRO arrives.
              nextAttackAt:
                npc.Aggro_AI_Type === "STATIONARY_AI"
                  ? Number.POSITIVE_INFINITY
                  : 0,
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
    if (npc.CharType === "ENEMY" && options.countsForFloor !== false) {
      session.enemiesSeen = (session.enemiesSeen ?? 0) + 1;
    }
    // And what it weighs, towards the price of a kill — see run-xp.js. Only
    // what can leave a star. A generator's spawn is left out here because all
    // of them are counted at once, from the generator's own limit, when the
    // floor settles — whichever of them happen to be out by then.
    if (rewardData && options.countsForFloor !== false && !options.fromGenerator) {
      countFloorXp(session, npc);
    }
  }

  addNavigationObstacle(session.navigation, npcDoid, navigationColliders);

  session.send(npcCreateFrame(at, spawnHeading));
  if (npc.CharType === "ENEMY") {
    const buffsById = new Map(
      (context.gm.raw.Buff ?? []).map((row) => [Number(row.Id), row.Constant])
    );
    for (const modifier of session.infiniteActiveModifiers ?? []) {
      const constant = buffsById.get(Number(modifier.EnemyBuffId));
      if (constant) {
        await grantBuff(session, constant, {
          affectedActor: npcDoid,
          attackerActor: npcDoid,
        });
      }
    }
  }
  if (npc.Aggro_AI_Type === "TELEPORT_AI") {
    session.send(npcTimelineAction(npcDoid, npc.TeleportInTimeline || "TELEPORT_IN"));
  }

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

export const npcTimelineAction = (doid, timeline) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(145) // DistributedNPCGameObject.ReceiveTimelineAction
    .utf(timeline)
    .frame();
