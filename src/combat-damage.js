import { statVector, STAT_NAMES } from "./hero-stats.js";

/**
 * Attack damage, ported from the client's own calculation.
 *
 * The client still carries the whole formula in
 * DistributedDungionArea.calculateNetAttackDamage — but nothing calls it. That
 * is the shape of the cancellation: the arithmetic was left in place and the
 * call sites removed, so the client proposes who hit whom and leaves the number
 * at zero for the server to fill in. Reading it back out is therefore not
 * guesswork; it is the original function.
 *
 *   offence = (power × Bonus[offenceStat] + attacker[offenceStat]) × attackerBuff
 *   offence = offence × DamageMod
 *   defence = defender[defenceStat] × defenderBuff
 *   damage  = offence + defence
 *
 * Two things about that last line look wrong and are not:
 *
 *   - Defence is *added*, not subtracted, because DamageMod is negative for
 *     anything that hurts (VENOM_STRIKE is -2). Damage travels down the wire as
 *     a negative number and healing as a positive one, so adding a positive
 *     defence pulls the result toward zero.
 *   - An attack with no StatOffsets — SUPPORT and ANIMATION types — skips stats
 *     entirely and is just `power × DamageMod`.
 */

/**
 * Which stats an attack type reads, by index into the canonical stat order
 * (GMAttack.g_melee / g_range / g_magic).
 *
 * Note the cross-wiring, which is faithful to the shipped game: a MELEE attack
 * is resisted by SHOOT_DEF and a SHOOTING attack by MELEE_DEF. The stat name
 * list has those two swapped relative to the attack list, and the offsets are
 * literal indices into it. It reads like an original bug; either way the client
 * shipped with it and a server that "corrects" it would disagree with every
 * damage number the game ever produced.
 */
const OFFSETS_BY_ATTACK_TYPE = {
  MELEE: { speed: 8, offence: 2, defence: 5, type: 0 },
  SHOOTING: { speed: 9, offence: 3, defence: 6, type: 1 },
  MAGIC: { speed: 10, offence: 4, defence: 7, type: 2 },
};

export const statOffsetsFor = (attack) => OFFSETS_BY_ATTACK_TYPE[attack?.AttackType] ?? null;

const statAt = (vector, index) => vector?.get(STAT_NAMES[index]) ?? 0;

/**
 * The signed damage a single hit does: negative harms, positive heals, exactly
 * as the wire and the client's floaters read it.
 *
 * `attacker` and `defender` are stat maps as produced by hero-stats; either may
 * be omitted, which simply contributes nothing rather than failing — a prop has
 * no stats and still takes hits.
 */
export const netAttackDamage = ({
  gm,
  attack,
  weaponPower = 0,
  attacker,
  defender,
  attackerBuff = 1,
  defenderBuff = 1,
}) => {
  const damageMod = Number(attack?.DamageMod ?? 0);
  const offsets = statOffsetsFor(attack);

  if (!offsets) return weaponPower * damageMod;

  const bonus = Number(
    gm.raw.Stats.find((row) => row.Constant === STAT_NAMES[offsets.offence])?.Bonus ?? 0
  );

  const offence =
    (weaponPower * bonus + statAt(attacker, offsets.offence)) * attackerBuff * damageMod;
  const defence = statAt(defender, offsets.defence) * defenderBuff;

  return offence + defence;
};

/**
 * The stat map for an NPC row.
 *
 * NPCs carry the same stat columns as heroes and simply have no training slots,
 * so the shared vector does the work. Their `Level` column, where present, feeds
 * the same LV_ growth.
 */
export const npcStats = (gm, npc) =>
  statVector(gm, npc ?? {}, { level: Number(npc?.Level ?? 0) });
