import {
  attackColliders,
  attackForConstant,
  projectileForConstant,
  projectileLaunches, autoMoveFrame } from "../gamemaster.js";

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
  weaponPower = nativeWeapon?.Power ?? 1,
  { weapons = [nativeWeapon] } = {}
) => {
  const attackSet = [];
  /**
   * Which of the NPC's weapons an attack is swung with: the index, in
   * `Weapon1..4` order, of the first weapon whose own `Attack1..8` names it.
   * The official sends that index as the choreography's weapon slot — a rival
   * sorcerer's LIGHTNING_SHOT on 0 (the staff), CHAIN_LIGHTNING on 1, BALL
   * on 2, THUNDERBOLT on 3 (its three books), 41 of 41 in the Cretaceous
   * Park recording — and the client draws the weapon of that slot. Anything
   * no weapon names is slot 0, which is every single-weapon monster.
   */
  const slotOf = (constant) => {
    const index = weapons.findIndex(
      (weapon) => weapon && NPC_ATTACK_SLOTS.some((key) => weapon[key] === constant)
    );
    return index > 0 ? index : 0;
  };
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
    const moveFrame = await autoMoveFrame(attack.AttackTimeline);
    const actionFrames = [
      ...shape.map((collider) => Number(collider.frame ?? 0)),
      ...launches.map((launch) => Number(launch.frame ?? 0)),
      // A move not yet started is still the attack's: the chase waits for it.
      ...(moveFrame === null ? [] : [moveFrame]),
    ];
    attackSet.push({
      attackType: attack.Id,
      weaponSlot: slotOf(named),
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
      // The attack's own move (ai.js, `lunge`): how far, which way off the
      // facing, how long, and the timeline frame it starts on. Only a timeline
      // that authors the action moves — null is "this attack stands still".
      moveAmount: moveFrame === null ? 0 : Math.max(0, Number(attack.MoveAmount ?? 0)),
      moveAngle: Number(attack.MoveAngle ?? 0),
      moveDurationMs: Math.max(0, Number(attack.MoveDuration ?? 0) * 1000),
      moveFrame,
    });
  }
  return attackSet;
};

/** The most a floor may speed its monsters up: three times authored, past which timelines stop reading. */
const ATTACK_SPEED_BONUS_MOST = 2;

/**
 * How much faster this floor's monsters attack than authored: 1 + the floor's
 * `npcAttackSpeedBonus` (set from a mode's floor plan, floor-world.js), the
 * same factor on the server's timing and on the play speed the client is sent.
 */
export const floorAttackSpeedScale = (session) =>
  1 + Math.min(ATTACK_SPEED_BONUS_MOST, Math.max(0, Number(session?.npcAttackSpeedBonus) || 0));
