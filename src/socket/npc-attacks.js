import {
  attackColliders,
  attackForConstant,
  projectileForConstant,
  projectileLaunches,
} from "../gamemaster.js";

const NPC_ATTACK_SLOTS = ["Attack1", "Attack2", "Attack3", "Attack4", "Attack5", "Attack6"];

const SPEED_STAT_BY_ATTACK_TYPE = {
  MELEE: "MELEE_SPD",
  SHOOTING: "SHOOT_SPD",
  MAGIC: "MAGIC_SPD",
};

/** A non-positive animation multiplier cannot advance a client timeline. */
export const npcAttackSpeed = (value) => {
  const speed = Number(value);
  return Number.isFinite(speed) && speed > 0 ? speed : 1;
};

/** The buff column paired with GMAttack's authored attack type. */
export const npcAttackSpeedStat = (attackType) =>
  SPEED_STAT_BY_ATTACK_TYPE[attackType] ?? "MELEE_SPD";

/** Resolves every authored NPC attack into the runtime data used by AI. */
export const npcAttackChoices = async (
  npc,
  nativeWeapon,
  weaponPower = nativeWeapon?.Power ?? 1
) => {
  const attackSet = [];
  for (const slot of NPC_ATTACK_SLOTS) {
    const named = npc?.[slot];
    if (!named) continue;
    const attack = await attackForConstant(named);
    if (!attack) continue;
    const shape = await attackColliders(attack.AttackTimeline);
    const projectile = attack.Projectile
      ? await projectileForConstant(attack.Projectile)
      : null;
    const launches = await projectileLaunches(attack.AttackTimeline);
    const actionFrames = [
      ...shape.map((collider) => Number(collider.frame ?? 0)),
      ...launches.map((launch) => Number(launch.frame ?? 0)),
    ];
    attackSet.push({
      attackType: attack.Id,
      attackSpeed: npcAttackSpeed(attack.AttackSpd),
      speedStat: npcAttackSpeedStat(attack.AttackType),
      range: Math.max(20, attack.Range ?? 80),
      minRange: Math.max(0, Number(attack.MinRange ?? 0)),
      rechargeMs: Math.max(0, Number(attack.AI_RechargeT ?? 0) * 1000),
      readyAt: 0,
      weaponPower,
      damage: Math.max(0, Math.round(weaponPower * Math.abs(attack.DamageMod ?? 0))),
      attackColliders: shape,
      projectile: projectile || null,
      projectileLaunches: launches,
      impactFrame: shape.length
        ? Math.min(...shape.map((collider) => Number(collider.frame ?? 0)))
        : 0,
      // Ordinary chase and target tracking pause through the last authored
      // damaging action. Attack-specific MoveAmount remains active.
      attackLockFrame: Math.max(0, ...actionFrames),
      moveAmount: Math.max(0, Number(attack.MoveAmount ?? 0)),
      moveAngle: Number(attack.MoveAngle ?? 0),
      moveDurationMs: Math.max(0, Number(attack.MoveDuration ?? 0) * 1000),
    });
  }
  return attackSet;
};
