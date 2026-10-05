import { objectDisable } from "./objects.js";
import { npcForConstant, heroById, weaponForConstant, attackForConstant, attackColliders, attackTimelineFrames, loadGameMaster, FRAMES_PER_SECOND } from "../gamemaster.js";
import { legendaryPetBonuses } from "../hero-stats.js";
import { petSpawnPosition, scaledNpcWeaponPower } from "../pets.js";
import { isStockedRoleMarker } from "./population.js";
import { CLID } from "./opcodes.js";
import { playDeathAttack } from "./triggers.js";
import { worldColliders } from "./heading.js";
import { giveVoice } from "./speech.js";
import { nearestClearPosition } from "./navigation.js";
import { warn } from "../log.js";
import { cancelScopedTimer } from "./lifecycle-scope.js";
import { hitPointsUpdate } from "./combat.js";
import { spawnNpc, npcTimelineAction } from "./npc-spawn.js";

/**
 * What a floor is peopled with: the NPCs its file places (`buildNpcs`, with
 * the party's scaling), the equipped pet, and the Infinite modifiers' timed
 * spawns.
 */

const rememberInfiniteTimer = (session, timer, scope = session.floorScope) => {
  session.infiniteModifierTimers ??= new Set();
  session.infiniteModifierTimers.add(timer);
  if (!scope) timer.unref?.();
  return timer;
};

const scheduleInfiniteTimeout = (session, callback, delay) => {
  const scope = session.floorScope;
  let timer;
  const run = () => {
    session.infiniteModifierTimers?.delete(timer);
    Promise.resolve(callback()).catch((error) =>
      warn(`Infinite timer failed: ${error.message}`)
    );
  };
  timer = scope ? scope.timeout(run, delay) : setTimeout(run, delay);
  return rememberInfiniteTimer(session, timer, scope);
};

export const clearInfiniteModifierTimers = (session) => {
  for (const timer of session.infiniteModifierTimers ?? []) {
    cancelScopedTimer(session.floorScope, timer, clearTimeout);
  }
  session.infiniteModifierTimers?.clear();
};

/** Spawns the NPC authored by an Infinite hit/death/periodic modifier. */
async function spawnInfiniteModifierNpc(context, modifier, origin, generation = 1) {
  const { session } = context;
  const npcId = Number(
    modifier.NPCSpawnId ?? modifier.NPCDeathSpawnId ?? modifier.NPCHitSpawnId ?? 0
  );
  const spawnedNpc = (context.gm.raw.Npc ?? []).find((row) => Number(row.Id) === npcId);
  if (!spawnedNpc || !context.isActive()) return null;
  const random = session.random ?? Math.random;
  const angle = random() * Math.PI * 2;
  const desired = {
    x: Number(origin?.x ?? 0) + Math.cos(angle) * 45,
    y: Number(origin?.y ?? 0) + Math.sin(angle) * 45,
  };
  const position = nearestClearPosition(session.navigation, desired, 20, {
    reach: 140,
    towards: origin,
  }) ?? desired;
  const doid = await spawnNpc(context, spawnedNpc.Constant, position, spawnedNpc.Scale, {
    returnDoid: true,
    engaged: true,
    suppressRewards: true,
    suppressTriggerReporting: true,
    modifierGeneration: generation,
    countsForFloor: false,
  });
  if (!doid || spawnedNpc.IsMover || !spawnedNpc.Attack1) return doid;

  // Infinite bombs are stationary one-shot actors. Arm for the row's own
  // AttackTimer, play its authored attack, then retire after the timeline.
  scheduleInfiniteTimeout(session, async () => {
    if (!context.isActive() || !session.actors?.has(doid)) return;
    const attack = await attackForConstant(spawnedNpc.Attack1);
    const colliders = attack ? await attackColliders(attack.AttackTimeline) : [];
    const weaponPower =
      (spawnedNpc.Weapon1 && (await weaponForConstant(spawnedNpc.Weapon1))?.Power) || 1;
    await playDeathAttack(
      session,
      doid,
      attack,
      position,
      worldColliders(position, 0, colliders),
      { npc: spawnedNpc, weaponPower }
    );
    const frames = attack ? await attackTimelineFrames(attack.AttackTimeline) : 0;
    scheduleInfiniteTimeout(session, () => {
      session.send(objectDisable(doid));
      session.objects?.delete(doid);
      session.actors?.delete(doid);
    }, Math.max(1, frames) * (1000 / FRAMES_PER_SECOND));
  }, Math.max(0, Number(spawnedNpc.AttackTimer ?? 1) * 1000));
  return doid;
}

export function spawnInfiniteModifierActors(context, { event, npc, origin, generation }) {
  const random = context.session.random ?? Math.random;
  for (const modifier of context.session.infiniteActiveModifiers ?? []) {
    const prefix = event === "death" ? "NPCDeathSpawn" : "NPCHitSpawn";
    if (!modifier[`${prefix}Id`]) continue;
    if (modifier[`${prefix}CharType`] && modifier[`${prefix}CharType`] !== npc.CharType) continue;
    if (generation >= Math.max(0, Number(modifier[`${prefix}MaxGeneration`] ?? 0))) continue;
    if (random() >= Math.max(0, Number(modifier[`${prefix}Chance`] ?? 0))) continue;
    const min = Math.max(0, Math.trunc(Number(modifier[`${prefix}MinCount`] ?? 0)));
    const max = Math.max(min, Math.trunc(Number(modifier[`${prefix}MaxCount`] ?? min)));
    const count = min + Math.floor(random() * (max - min + 1));
    for (let index = 0; index < count; index++) {
      spawnInfiniteModifierNpc(context, modifier, origin, generation + 1).catch((error) =>
        warn(`Infinite ${event} spawn failed: ${error.message}`)
      );
    }
  }
}

export const startInfiniteModifierSpawns = (context) => {
  const { session } = context;
  clearInfiniteModifierTimers(session);
  for (const modifier of session.infiniteActiveModifiers ?? []) {
    const everyMs = Math.max(0, Number(modifier.NPCSpawnTime ?? 0) * 1000);
    if (!modifier.NPCSpawnId || !everyMs) continue;
    const scope = session.floorScope;
    const tick = () => {
      const hero = session.actors?.get(session.heroDoid);
      if (!context.isActive() || !hero?.position) return;
      spawnInfiniteModifierNpc(context, modifier, hero.position).catch((error) =>
        warn(`Infinite periodic spawn failed: ${error.message}`)
      );
    };
    const timer = scope ? scope.interval(tick, everyMs) : setInterval(tick, everyMs);
    rememberInfiniteTimer(session, timer, scope);
  }
};

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
  if (respawn && npc.Aggro_AI_Type !== "TELEPORT_AI") {
    context.session.send(npcTimelineAction(doid, npc.TeleportInTimeline || "TELEPORT_IN"));
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
    if (!(maximum > 0)) continue;
    actor.partySize = partySize;
    if (maximum === actor.maxHitPoints) continue;
    const share = actor.maxHitPoints > 0 ? actor.hitPoints / actor.maxHitPoints : 1;
    actor.maxHitPoints = maximum;
    actor.hitPoints = actor.dead
      ? 0
      : Math.max(1, Math.min(maximum, Math.round(maximum * share)));
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

export const buildNpcs = async (context, placements) => {
  const { session, gm } = context;
  let built = 0;
  for (const placement of placements) {
    if (!context.isActive()) break;

    /**
     * A role placement is the centre of a stocked pack, not another member of
     * that pack. `stockFloor` fills it from the tier quota below; resolving it
     * here as well produced exactly marker + quota — tutorial became 53-67
     * knights and 11 brutes instead of the authored 35-49 and 6.
     *
     * This flag is set only for the initial floor build. A role marker hidden
     * inside a secret room was not available to the opening stock pass and is
     * therefore still resolved when that room is revealed.
     */
    if (
      context.skipStockedRoleMarkers &&
      isStockedRoleMarker(gm, context.tierConstant, placement.constant)
    ) continue;

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
      session.npcPlacementIds ??= new Map();
      session.npcPlacementIds.set(doid, placement.id);
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
