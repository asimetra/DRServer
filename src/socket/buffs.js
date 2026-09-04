import { buffColorTypeNamed, buffForConstant, heroById, loadGameMaster } from "../gamemaster.js";
import { superStatValue } from "../hero-stats.js";
import { warn } from "../log.js";
import { CLID, OP } from "./opcodes.js";
import { buffGenerate, objectDisable } from "./objects.js";
import { PacketWriter } from "./packet.js";

const FLID_HERO_REPORT_BUFF_EFFECT = 168;

const multiplier = (value) =>
  Number.isFinite(Number(value)) ? Number(value) : 1;

const expireBuff = (session, doid) => {
  const timer = session.buffTimers?.get(doid);
  if (timer) clearTimeout(timer);
  session.buffTimers?.delete(doid);
  session.activeBuffs?.delete(doid);
  if (!session.objects?.has(doid)) return;
  session.send(objectDisable(doid));
  session.objects.delete(doid);
};


/**
 * Everything a body was carrying, taken off with it.
 *
 * A buff outlived its host: `removeActor` deleted the actor and disabled its
 * object and left the buffs alone, so poison went on being drawn on a monster
 * that was no longer there, and `buffMultiplierFor` went on walking entries for
 * a doid nothing could look up.
 *
 * The official takes them together. Of 3048 poison and fire buffs whose victim
 * was disabled in the recordings, 2176 are disabled within 250ms of it and only
 * 8 outlive their host at all.
 */
export const clearBuffsOn = (session, actorDoid) => {
  let cleared = 0;
  for (const [doid, active] of [...(session.activeBuffs?.entries() ?? [])]) {
    if (active.affectedActor !== actorDoid) continue;
    const damageTimer = session.damageOverTimeByBuff?.get(doid);
    if (damageTimer) {
      clearInterval(damageTimer);
      session.damageOverTimeTimers?.delete(damageTimer);
      session.damageOverTimeByBuff.delete(doid);
    }
    expireBuff(session, doid);
    cleared += 1;
  }
  return cleared;
};

/**
 * Creates one client-visible buff and retains the same GameMaster row for the
 * server's combat calculation. The client owns the HUD/VFX; the server owns
 * both the lifetime and the numbers the buff changes.
 */
/**
 * The seconds a Battle Chef's training adds to what he cooks.
 *
 * `COOKING` is his second slot and already decides how often food appears at
 * all — `HitSpawnBase` and `DeathSpawnBase` with their per-point increases. It
 * says nothing about how long the buff in that food lasts, so a chef who has
 * put everything into cooking serves the same ten-second speed soup as one who
 * has put nothing there.
 *
 * The authored amount is 0.1 a point, and two seconds are given for each of
 * those, so the seventy-five cap adds 15: the speed soup goes from 10 seconds
 * to 25, the defence from 15 to 30 and the beefy from 20 to 35.
 *
 * A point is worth a fifth of a second rather than a whole one. A whole one
 * would put the beefy soup at ninety-five seconds, which is most of a floor and
 * stops being a buff.
 *
 * Only what he cooked. A potion picked up off the ground is not his cooking,
 * and a buff granted by an attack is the attack's.
 */
const COOKING_BUFFS = new Set(["CHEF_BEEFY_BUFF", "CHEF_SPEEDY_BUFF", "CHEF_DEFENSE_BUFF"]);

const COOKING_SECONDS_PER_POINT = 2;

const cookingBonus = async (session, buff) => {
  if (!COOKING_BUFFS.has(buff?.Constant)) return 0;
  const gm = await loadGameMaster();
  const hero = await heroById(session.dungeonAvatar?.avatar_id);
  if (!hero) return 0;
  const trained = Math.max(0, superStatValue(gm, hero, session.dungeonAvatar, "COOKING"));
  return trained * COOKING_SECONDS_PER_POINT;
};

export const grantBuff = async (session, constant, { affectedActor, attackerActor } = {}) => {
  const buff = await buffForConstant(constant);
  if (!buff) {
    warn(`buffs: no buff named "${constant}"`);
    return null;
  }

  const affected = affectedActor ?? session.heroDoid;
  const attacker = attackerActor ?? affected;
  if (!session.floorDoid || !affected) return null;
  session.activeBuffs ??= new Map();

  /**
   * How many of this one an actor may carry at once, which the data says and
   * nothing here read.
   *
   * 139 of the game's 157 buffs author `MaxStacks` 1 and this stacked all of
   * them without limit, so re-applying one compounded it: `buffMultiplierFor`
   * multiplies over every live copy, so three of a 1.3x movement buff make
   * 2.2x, and three of a half-damage buff would turn aside seven eighths of a
   * hit rather than half. A player watching it read "3x" on his own bar.
   *
   * Past the limit the oldest is refreshed instead of another being added,
   * which is what re-applying a buff means: the effect does not grow, the clock
   * starts again.
   */
  const limit = Math.max(1, Number(buff.MaxStacks ?? 1));
  const held = [...session.activeBuffs.entries()].filter(
    ([, active]) => active.affectedActor === affected && active.buff?.Constant === buff.Constant
  );
  if (held.length >= limit) {
    const [oldest] = held;
    refreshBuff(session, oldest[0], durationOf(buff, await cookingBonus(session, buff)));
    return oldest[0];
  }

  const doid = session.allocateDoid(CLID.DistributedBuffGameObject);
  session.objects?.set(doid, CLID.DistributedBuffGameObject);
  session.activeBuffs.set(doid, { affectedActor: affected, buff });
  session.send(
    buffGenerate({
      doid,
      parent: session.floorDoid,
      zone: session.dungeonZone ?? 0,
      buffType: buff.Id,
      affectedActor: affected,
      attackerActor: attacker,
    })
  );

  refreshBuff(session, doid, durationOf(buff, await cookingBonus(session, buff)));
  return doid;
};

/** The authored seconds plus whatever the caster's training adds, in ms. */
const durationOf = (buff, bonusSeconds) =>
  Math.max(0, (Number(buff.Duration ?? 0) + bonusSeconds) * 1000);

/** Starts, or restarts, the clock on one live buff. */
const refreshBuff = (session, doid, durationMs) => {
  const existing = session.buffTimers?.get(doid);
  if (existing) clearTimeout(existing);
  if (!durationMs) return;
  const timer = setTimeout(() => expireBuff(session, doid), durationMs);
  timer.unref?.();
  session.buffTimers ??= new Map();
  session.buffTimers.set(doid, timer);
};

/**
 * The number that floats off whoever a buff just burned or poisoned.
 *
 * A damage-over-time tick is the one kind of damage that carries no
 * CombatResult — the captures show hit points changing and nothing else on the
 * victim — so without this the mob silently melts and the player is told
 * nothing. `ReportBuffEffect` is what the official server sends instead, and it
 * goes on the *hero owner* rather than the victim: the arithmetic is the
 * server's, but only the player whose buff is doing the damage is shown it.
 *
 * `HeroGameObjectOwner.ReportBuffEffect` looks the victim up with
 * `DistributedDungeonFloor.getActor`, which resolves the owner's own avatar
 * before the remote actors, so one message covers a burning monster and a
 * poisoned hero alike. That is why the sibling `ReceivedBuffEffect` (169) is
 * not sent here and never appears in a capture.
 *
 * Sign follows the same rule as every other damage on this wire: negative is
 * damage, positive is a heal, and the client picks the floater from that alone.
 */
export const buffEffectReport = ({ heroDoid, actorDoid, amount, colorType = 0, effectiveness = 0 }) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(heroDoid)
    .u16(FLID_HERO_REPORT_BUFF_EFFECT)
    .u32(actorDoid)
    .i32(amount)
    .u32(colorType)
    // Effectiveness is -2..+2 and drives DamageFloater.showEffectivenessFX;
    // u8 masks it into two's complement, which is what the client reads back.
    .u8(effectiveness)
    .frame();

/**
 * Which colour the floater is drawn in.
 *
 * `DamageFloater` only consults the table when the type is above ten, and the
 * six `BuffColorType` rows start at eleven — Poison 11, Fire 12, then Cold,
 * Blood, Bacon and Ethereal. Nothing joins that table to a buff except the
 * name: `Buff.Ability1` reads POISON or FIRE, and the rows are described as
 * Poison and Fire.
 *
 * Two captured ticks confirm the join rather than merely allowing it: a poison
 * cloud reported colour 11 and a firebomb's burn colour 12.
 *
 * Eleven damaging buffs author no `Ability1` at all — bleeding, the wounds, the
 * salmonella line — and they get zero, which leaves the client on its default
 * colour. Their real colours are guessable from `VFX` but no capture shows one,
 * so they are left alone.
 */
export const buffColorTypeFor = async (buff) => {
  const row = await buffColorTypeNamed(buff?.Ability1);
  return row?.Id ?? 0;
};

/** The product the client applies to one actor's authored stat. */
export const buffMultiplierFor = (session, actorDoid, stat) => {
  let result = 1;
  for (const active of session.activeBuffs?.values() ?? []) {
    if (active.affectedActor === actorDoid) result *= multiplier(active.buff?.[stat]);
  }
  return result;
};

/**
 * How much of an incoming hit a buff takes off, by damage type.
 *
 * The three `*_DEF` columns were read as multipliers on the defender's defence
 * stat, and that made the whole family inert. A fully trained Berserker's
 * `MELEE_DEF` stat is 0.2 — defence is subtracted flat, so it does not scale
 * with the hit — and multiplying 0.2 by anything is still nothing. Measured
 * against a 400 damage swing: no buff 400, `DEFENDER_L1` 400, `DEFENDER_L2`
 * 400, and the Berserker's own Dungeon Buster 375. Six per cent, for the
 * ultimate that is supposed to make him a tank.
 *
 * The authored values say what they are meant to be. `CONSUMABLE_DEFENSE_BUFF`
 * is 0.1, `DEFENDER_L1` 0.25, `FRENZY` 0.3, `DEFENDER_L2` 0.5 — a family of
 * fractions, read plainly as "take this much off". `BERSERK_DB` is 100, which
 * is the same sentence meaning all of it, and the enemy version of the same
 * buff says so outright with `INVULNERABLE_ALL`.
 *
 * Stacked multiplicatively, so two sources leave a remainder rather than adding
 * to a total: 0.5 and 0.3 together take 65%, not 80%. Nothing reaches all of it
 * by accumulation — only a source that is itself all of it.
 *
 * Which no item can be. None of the game's 162 modifier rows across
 * `Modifiers`, `LegendaryModifiers` and `DungeonModifier` carries a defence
 * field at all; they are attack, crit, chain, pierce, speed, mana and cooldown.
 * So reduction comes from buffs alone, and the only buff that is total is the
 * Berserker's own — which is his ultimate, on himself, for twelve seconds. The
 * party gets `BERSERK`, which carries attack and movement and no defence.
 */
export const damageReductionFor = (session, actorDoid, stat) => {
  let remaining = 1;
  for (const active of session?.activeBuffs?.values() ?? []) {
    if (active.affectedActor !== actorDoid) continue;
    const authored = Number(active.buff?.[stat]);
    if (!Number.isFinite(authored) || authored <= 0) continue;
    // A value at or above 1 is the whole of it; the rest are fractions.
    remaining *= 1 - Math.min(1, authored);
  }
  return 1 - remaining;
};

/** Whether this actor is already under a named buff. */
export const hasBuff = (session, actorDoid, constant) => {
  for (const active of session?.activeBuffs?.values() ?? []) {
    if (active.affectedActor === actorDoid && active.buff?.Constant === constant) return true;
  }
  return false;
};

/**
 * Whether any buff on this actor carries a given `Ability1`.
 *
 * The kind is named there rather than implied by the numbers: STUN and ROOT
 * both zero `MOVEMENT`, and the difference between them is only that a rooted
 * monster can still swing.
 */
export const hasAbility = (session, actorDoid, ability) => {
  for (const active of session.activeBuffs?.values() ?? []) {
    if (active.affectedActor !== actorDoid) continue;
    if (active.buff?.Ability1 === ability || active.buff?.Ability2 === ability) return true;
  }
  return false;
};

/** Stops timers before a floor/object teardown; dungeon.js emits the disables. */
export const clearDungeonBuffs = (session) => {
  for (const timer of session.buffTimers?.values() ?? []) clearTimeout(timer);
  session.buffTimers?.clear();
  // Damage-over-time runs on its own interval per victim — see combat.js.
  for (const timer of session.damageOverTimeTimers ?? []) clearInterval(timer);
  session.damageOverTimeTimers?.clear();
  session.damageOverTimeByBuff?.clear();
  session.activeBuffs?.clear();
};
