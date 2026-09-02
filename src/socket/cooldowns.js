/**
 * How soon an attack may be used again.
 *
 * `CooldownLength` is authored in seconds on seventy-eight Attack rows — twenty
 * for the Ranger's speed scroll, ten for its snare blast, twenty for the Battle
 * Chef's food pot — and it is a rule about the player, not about the animation.
 *
 * The client enforces it locally, which is why nothing looks wrong in normal
 * play: the button greys out. That is exactly why the server has to enforce it
 * too. Mana is already checked here on the principle that the client asks and
 * the server decides; a cooldown is the same kind of claim and was the only one
 * of the pair going unchecked, so a modified client could repeat a twenty
 * second scroll as fast as it could send packets.
 *
 * Kept per attack rather than per hero. A Battle Chef can carry more than one
 * pot, and one shared timer meant cooking soup blocked cooking food.
 *
 * And per *slot* rather than per attack, because two slots may hold the same
 * pot and the official runs them on their own clocks. Its own recording is
 * direct — `THROW_FIREBOMB` carries a five second cooldown:
 *
 *   13:30:01.187  propose slot 1
 *   13:30:01.919    FIREBOMB_PLACEABLE_L3 spawned
 *   13:30:02.309  propose slot 2
 *   13:30:03.051    FIREBOMB_PLACEABLE_L3 spawned
 *
 * A second bomb one and a half seconds into a five second wait, from the other
 * slot, and it landed. Keyed by the attack alone, this server refused it and
 * the pot did not go down — "I have two of the same potion and the second one
 * does nothing".
 */

import { heroById, loadGameMaster } from "../gamemaster.js";
import { buffMultiplierFor } from "./buffs.js";

const keyFor = (attack, slot) => `${attack?.Constant}|${slot ?? 0}`;

export const isOffCooldown = (session, attack, slot, now = Date.now()) =>
  now >= (session.attackCooldownUntil?.get(keyFor(attack, slot)) ?? 0);

/**
 * The authored wait is not the wait. `WeaponController.startCooldown` is:
 *
 *   L = CooldownLength || AIRechargeT
 *   mCoolDownTime = L*1000 * weapon.cooldownReduction()
 *                 - L*1000 * hero.attackCooldownMultiplier
 *
 * Enforcing the authored seconds instead makes this server stricter than the
 * game for anybody who bought the reduction, and a rule that is stricter than
 * the game refuses attacks the player is entitled to. That matters more than it
 * sounds: with DR_REQUIRE_CAST on, a refused cast also drops the hits that
 * follow it, so getting this formula wrong deletes damage rather than merely
 * annoying somebody.
 */
const MAGIC_COOLDOWN = "MAGIC_COOLDOWN";

/**
 * The weapon's own share: the product of `COOLDOWN_REDUC` over its modifiers.
 *
 * Five of the game's 120 modifier rows carry one — 0.9 down to 0.4 — and a row
 * without the field contributes nothing, exactly as `attackManaCost` reads
 * `MP_COST` from the same two slots.
 */
const weaponCooldownReduction = async (session, slot) => {
  const weapon = session.heroWeapons?.[slot];
  if (!weapon) return 1;

  const { modifiersById } = await loadGameMaster();
  let reduction = 1;
  for (const modifierId of [weapon.modifier1, weapon.modifier2]) {
    if (!modifierId) continue;
    reduction *= Math.max(0, Number(modifiersById.get(modifierId)?.COOLDOWN_REDUC ?? 1));
  }
  return reduction;
};

/**
 * The hero's own share, and the client's branch is copied rather than tidied.
 *
 * `HeroGameObject.get_attackCooldownMultiplier` asks whether *slot three* is
 * `MAGIC_COOLDOWN`, and if it is, buffs are not consulted at all. The data says
 * that is one hero: only the Sorcerer authors it, and only there, with
 * `AmtStat3` 1 against the super stat's `CooldownReduction` of 0.33 — so a
 * fully bought Sorcerer takes a third off and everyone else takes nothing.
 *
 * The buff branch is live but inert today: all 157 buff rows author
 * `AttackCooldownMultiplier` 1, so the product is 1 and this returns 0. It is
 * written out anyway because the day a row says otherwise, this reads it.
 *
 * Exported so `/stats` can report the share a hero is currently taking off its
 * own attacks, which is a live number a player feels and no screen shows.
 */
export const heroCooldownMultiplier = async (session) => {
  const gm = await loadGameMaster();
  const hero = await heroById(session.dungeonAvatar?.avatar_id);

  if (hero?.StatUpgrade3 === MAGIC_COOLDOWN) {
    const superStat = gm.raw?.SuperStats?.find((row) => row.Constant === MAGIC_COOLDOWN);
    const points = Number(session.dungeonAvatar?.statupgrade3 ?? 0);
    return 0.01 * points * Number(hero.AmtStat3 ?? 0) * Number(superStat?.CooldownReduction ?? 0);
  }

  return buffMultiplierFor(session, session.heroDoid, "AttackCooldownMultiplier") - 1;
};

/** What this attack's wait actually is, for this hero and this weapon. */
export const effectiveCooldownMs = async (session, attack, slot) => {
  const seconds = Number(attack?.CooldownLength) || Number(attack?.AIRechargeT) || 0;
  if (!seconds) return 0;

  const base = seconds * 1000;
  const [weapon, hero] = await Promise.all([
    weaponCooldownReduction(session, slot),
    heroCooldownMultiplier(session),
  ]);
  // Never negative: a reduction that outran the authored length would hand out
  // a wait in the past, which is no wait at all rather than a bonus.
  return Math.max(0, base * weapon - base * hero);
};

/** Records the wait an accepted attack has just started, for the slot it came from. */
export const noteCooldown = async (session, attack, slot, now = Date.now()) => {
  if (!attack?.Constant) return false;
  const waitMs = await effectiveCooldownMs(session, attack, slot);
  if (!waitMs) return false;

  session.attackCooldownUntil ??= new Map();
  session.attackCooldownUntil.set(keyFor(attack, slot), now + waitMs);
  return true;
};

/** Nothing carries a cooldown across a dungeon. */
export const clearCooldowns = (session) => {
  session.attackCooldownUntil?.clear();
};
