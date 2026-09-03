import {
  attackColliders,
  attackForConstant,
  projectileForConstant,
  projectileLaunches,
} from "../gamemaster.js";

const NPC_ATTACK_SLOTS = ["Attack1", "Attack2", "Attack3", "Attack4", "Attack5", "Attack6"];

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
    attackSet.push({
      attackType: attack.Id,
      range: Math.max(20, attack.Range ?? 80),
      minRange: Math.max(0, Number(attack.MinRange ?? 0)),
      rechargeMs: Math.max(0, Number(attack.AI_RechargeT ?? 0) * 1000),
      readyAt: 0,
      weaponPower,
      damage: Math.max(1, Math.round(weaponPower * Math.abs(attack.DamageMod ?? -1))),
      attackColliders: shape,
      projectile: projectile || null,
      projectileLaunches: await projectileLaunches(attack.AttackTimeline),
      impactFrame: shape.length
        ? Math.min(...shape.map((collider) => Number(collider.frame ?? 0)))
        : 0,
      moveAmount: Math.max(0, Number(attack.MoveAmount ?? 0)),
      moveAngle: Number(attack.MoveAngle ?? 0),
      moveDurationMs: Math.max(0, Number(attack.MoveDuration ?? 0) * 1000),
    });
  }
  return attackSet;
};
