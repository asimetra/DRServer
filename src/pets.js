import { heroLevel } from "./progression.js";

/** The offset used by every initial equipped-pet generate in the capture corpus. */
export const PET_SPAWN_OFFSET = Object.freeze({ x: 0, y: -111 });

/**
 * Monster weapons are levelled by the original server even though their
 * GameMaster rows carry only the level-one base power.
 */
export const scaledNpcWeaponPower = (weapon, level) => {
  const base = Math.max(0, Number(weapon?.Power ?? 0));
  const exponent = Math.max(0, Number(weapon?.ScalingFactor ?? 0));
  const at = Math.max(1, Number(level ?? 1));
  return Math.max(1, Math.floor(base * (1 + Math.pow(at, exponent) / 20)));
};

/**
 * Pet health is linear on the player team, but the authoritative server prices
 * pet offence with the same level^1.5 curve used by hostile NPC attacks.
 */
export const petCombatLevel = (level) => Math.pow(Math.max(1, Number(level ?? 1)), 1.5);

/**
 * Resolves the one inventory pet equipped to an avatar into run-local data.
 * Invalid/corrupt inventory rows are ignored rather than becoming arbitrary
 * NPC spawns in a dungeon.
 */
export const equippedPetSpawn = (gm, account, avatar, hero) => {
  if (!gm || !account || !avatar || !hero) return null;
  const owned = (account.account_pets ?? []).find(
    (pet) => Number(pet.equipped_hero) === Number(avatar.id)
  );
  if (!owned) return null;

  const npc = gm.raw.Npc.find((row) => Number(row.Id) === Number(owned.npc_id));
  // UsePetUI separates inventory pets from summons and temporary PET actors.
  if (npc?.CharType !== "PET" || !npc.UsePetUI) return null;

  return {
    instanceId: Number(owned.id),
    npcId: Number(npc.Id),
    constant: npc.Constant,
    level: Math.max(1, heroLevel(gm, hero, Number(avatar.experience ?? 0))),
    ownerHeroDoid: Number(avatar.id),
  };
};

export const petSpawnPosition = (ownerPosition) => ({
  x: Number(ownerPosition?.x ?? 0) + PET_SPAWN_OFFSET.x,
  y: Number(ownerPosition?.y ?? 0) + PET_SPAWN_OFFSET.y,
});
