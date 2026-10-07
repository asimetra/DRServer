/**
 * A floor's monsters drinking what they deal: a mode's floor plan says how much
 * (`lifeSteal`, a share, modes/README.md "The floor plan"), and the toughest of
 * them — a boss — heals that share of every hit it lands on a hero.
 *
 * "Toughest" is read off the floor rather than a row's flag: `IsBoss` is set on
 * nine rows, few of them the bosses (Papa Yeti and the Frost Troll say 0). An
 * enemy with at least half the most health of any enemy that has stood on this
 * floor is one; on a boss's map that is the boss, whatever else it summons.
 */
import { CLID } from "./opcodes.js";
import { hitPointsUpdate } from "./combat-wire.js";

/** The share of the floor's toughest health that still counts as tough. */
const TOUGH_SHARE = 0.5;
/** The most a floor may heal: as much as it deals, and no more. */
const STEAL_MOST = 1;

/** An enemy has stood on this floor with `hitPoints` most: the bar a boss is measured against. */
export const noteFloorEnemy = (session, hitPoints) => {
  if (Number.isFinite(hitPoints) && hitPoints > (session.floorToughestHitPoints ?? 0)) {
    session.floorToughestHitPoints = hitPoints;
  }
};

/**
 * An NPC's hit landed `dealt` health on a hero: heals the NPC its share, if the
 * floor steals and it is one of the floor's toughest. Answers what it healed.
 */
export const stealLife = (session, attackerDoid, dealt) => {
  const share = Math.min(STEAL_MOST, Math.max(0, Number(session.npcLifeSteal) || 0));
  if (!(share > 0) || !(dealt > 0)) return 0;
  if (session.objects?.get(attackerDoid) !== CLID.DistributedNPCGameObject) return 0;
  const attacker = session.actors?.get(attackerDoid);
  if (!attacker || attacker.dead || !attacker.isEnemy) return 0;
  if (attacker.maxHitPoints < (session.floorToughestHitPoints ?? 0) * TOUGH_SHARE) return 0;
  const healed = Math.min(attacker.maxHitPoints - attacker.hitPoints, Math.max(1, Math.round(dealt * share)));
  if (!(healed > 0)) return 0;
  attacker.hitPoints += healed;
  session.send(hitPointsUpdate(attackerDoid, CLID.DistributedNPCGameObject, attacker.hitPoints));
  return healed;
};
