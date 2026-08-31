import {
  attackById,
  buffForConstant,
  invulnerableForMs,
  loadGameMaster,
  stackableById,
} from "../gamemaster.js";
import { info, warn } from "../log.js";
import { grantBuff, hasAbility } from "./buffs.js";
import { heroMembersOf } from "./match-world.js";
import {
  healHero,
  queueAccountSave,
  heroDungeonBusterPointsUpdate,
  heroManaPointsUpdate,
} from "./rewards.js";
import { isPowerupAttack, schedulePowerup } from "./powerups.js";
import { notePlacementPermit } from "./placeables.js";
import { isOffCooldown, noteCooldown } from "./cooldowns.js";
import { RULE, noteViolation } from "./security-events.js";
import { noteCast } from "./combat.js";
import { schedulePlaceables } from "./placeables.js";
import { OP } from "./opcodes.js";
import { PacketWriter } from "./packet.js";
import { isAllyReviveAttack, noteAllyReviveAttempt } from "./revive.js";

export const FLID_PROPOSE_ATTACK_CHOREOGRAPHY = 172;
export const FLID_RECEIVE_ATTACK_CHOREOGRAPHY = 159;
export const FLID_STOP_CHOREOGRAPHY = 179;

export const remoteAttackChoreography = (heroDoid, payload) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(heroDoid)
    .u16(FLID_RECEIVE_ATTACK_CHOREOGRAPHY)
    .raw(payload)
    .frame();

/** Stops a remote hero's current timeline; the field deliberately has no body. */
export const remoteStopChoreography = (heroDoid) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(heroDoid)
    .u16(FLID_STOP_CHOREOGRAPHY)
    .frame();

const STAT_ATTACK_TYPES = new Set(["MELEE", "SHOOTING", "MAGIC"]);

const attackManaCost = async (session, attack, weaponSlot) => {
  const baseCost = Math.max(0, Number(attack.ManaCost ?? 0));
  if (!baseCost || !STAT_ATTACK_TYPES.has(attack.AttackType)) return Math.ceil(baseCost);

  const weapon = session.heroWeapons?.[weaponSlot];
  if (!weapon) return Math.ceil(baseCost);

  const { modifiersById } = await loadGameMaster();
  let multiplier = 1;
  for (const modifierId of [weapon.modifier1, weapon.modifier2]) {
    if (!modifierId) continue;
    multiplier *= Math.max(0, Number(modifiersById.get(modifierId)?.MP_COST ?? 1));
  }
  // Mana is a UInt on the client. A fractional authored cost therefore consumes
  // the next whole point, matching the client's affordability check.
  return Math.ceil(baseCost * multiplier);
};

const spawnSelfBuff = async (session, attack) => {
  if (!attack.SelfBuff || !session.floorDoid || !session.heroDoid) return null;
  return grantBuff(session, attack.SelfBuff);
};

/**
 * The buff a friendly attack puts on whoever it is cast over.
 *
 * `TargetBuff1` is read on the hostile side as the debuff a hit leaves, and
 * twenty-eight attacks carry it with `Team: FRIENDLY` instead — the Ranger's
 * speed scroll and SPEED_BOOSTER_L3 among them. Nothing applied those, so the
 * scroll spent its thirty-five Mana and granted nothing.
 *
 * Where both fields are present the two are for different people — the
 * Berserker's Dungeon Buster gives its caster BERSERK_DB and its targets
 * BERSERK, and the party potions name the same buff in both — so the caster
 * takes the self one and the target one is for everybody else. That used to be
 * skipped outright, on the grounds that a second client on the floor was not
 * modelled. It is now, and twelve of the 33 consumable attacks are party
 * potions carrying `TargetBuff1` with `AffectsOthers`, every one of which was
 * buffing only the person who drank it.
 *
 * The official does it one generate per affected actor. Measured, a party
 * mushroom in a three-player floor:
 *
 *   150ms  DistributedBuffGameObject CONSUMABLE_SMALL_MUSHROOM_BUFF on 50386075
 *   150ms  DistributedBuffGameObject CONSUMABLE_SMALL_MUSHROOM_BUFF on 1100183818  <- the drinker
 *   150ms  DistributedBuffGameObject CONSUMABLE_SMALL_MUSHROOM_BUFF on 1100379173
 *
 * The scrolls have no SelfBuff at all, so their caster *is* the target, which
 * is the case this originally existed for and still covers.
 */
const buffFriendlyTarget = async (session, attack) => {
  if (attack.Team !== "FRIENDLY" || !attack.TargetBuff1) return null;
  if (!session.floorDoid || !session.heroDoid) return null;
  const targetBuff = await buffForConstant(attack.TargetBuff1);
  // Attack.Team describes who owns the cast, not whether TargetBuff1 helps.
  // Garlic Nuke is FRIENDLY because it places player-owned traps, while its
  // ENSNARED target buff is HOSTILE. Treating the attack team as the buff team
  // applied MOVEMENT=0 and poison VFX to the Vampire Hunter for ten seconds.
  if (targetBuff?.Team !== "FRIENDLY") return null;

  const granted = [];

  // No SelfBuff means the caster is one of the targets rather than being
  // covered separately. With one, the self half has already been granted.
  if (!attack.SelfBuff) {
    granted.push(await grantBuff(session, attack.TargetBuff1, { affectedActor: session.heroDoid }));
  }

  /**
   * And everyone else, whenever the attack says it reaches them. This is not
   * only the party potions: of the 19 friendly attacks that name a TargetBuff1
   * and no SelfBuff, 17 carry `AffectsOthers` — both speed pulses, BACON_BOOST,
   * PARTY_BOMB_HEAL_ATTACK, BATTLE_RAGE, SKELETON_DANCE. Every one of them was
   * buffing only the person who cast it.
   */
  if (attack.AffectsOthers) {
    for (const doid of heroMembersOf(session).keys()) {
      if (doid === session.heroDoid) continue;
      granted.push(await grantBuff(session, attack.TargetBuff1, { affectedActor: doid }));
    }
  }

  return granted.length ? granted : null;
};

/**
 * The buster potions, and the only thing that ever fills the meter.
 *
 * A Dungeon Buster costs 120 Crowd, and Crowd arrives two, six and twenty at a
 * time from the pickups enemies leave — so on the way up from zero the meter is
 * a long grind. The two `RefillDungeonBuster` attacks are the shortcut, and
 * without them the buster is effectively unreachable, which is how it looked in
 * play: the meter crept to 2, then 4, and never went anywhere.
 *
 * Read off the official wire rather than guessed. Twice in one recorded fight:
 *
 *   21:57:54.808  CONSUMABLE_STAT_BUSTER_POTION_ATTACK
 *   21:57:54.947  buster points = 120        (full, 139ms later)
 *   21:57:55.959  DBUSTER_IRON_LEGION        (CrowdCost 120)
 *   21:57:56.137  buster points = 0
 *
 * Full rather than topped up: the second of those started from 2 and still
 * landed on exactly 120. Each hero's own maximum, because that is its own
 * buster's CrowdCost.
 *
 * The party bottle reaches the rest of the group the same way the party buffs
 * do — it is the one of the two that carries `AffectsOthers`.
 */
const refillDungeonBuster = (session, attack) => {
  if (!attack.RefillDungeonBuster) return 0;

  const fill = (context) => {
    const full = Math.max(1, Number(context.maxDungeonBusterPoints ?? 0));
    context.dungeonBusterPoints = full;
    context.send?.(heroDungeonBusterPointsUpdate(context.heroDoid, full));
  };

  fill(session);
  let filled = 1;
  if (attack.AffectsOthers) {
    for (const [doid, member] of heroMembersOf(session)) {
      if (doid === session.heroDoid) continue;
      fill(member.world?.contextFor(member) ?? member);
      filled += 1;
    }
  }
  return filled;
};

/**
 * Every attack any weapon or hero can grant, built once.
 *
 * `hasPowerupWeapon` opens with `if (!isPowerupAttack(attack)) return true`, so
 * ownership was only ever asked about the handful of attacks whose timeline
 * spawns something. Everything else went unchecked: a client holding an axe
 * could propose a Sorcerer's Thunderstorm, or a boss's attack, and this server
 * would accept the cast and pay out its damage. 270 of the game's 573 attack
 * rows belong to no player weapon at all.
 *
 * The columns are the authored answer to what a player may swing. Across the
 * recordings every one of 6951 proposed casts is named by one of them; the only
 * four attacks that are not are the `CONSUMABLE_*` potions, and those are
 * exactly the four that carry the consumable flag, so they have already left
 * through `useConsumable` before this is asked. Zero honest casts fall outside.
 *
 * This is the coarse half of the rule — that the attack is a player attack at
 * all. Tying it to the weapon actually in the slot needs the slot's contents
 * checked against the recordings first, and is worth doing separately.
 */
const PLAYER_ATTACK_COLUMNS = /^(Attack\d|ChargeAttack|HoldingAttack|AltAttack\d?|ComboAttack\d?)$/;

let playerAttacks = null;
let attacksByWeapon = null;
let weaponClassById = null;

const buildGrants = async () => {
  if (playerAttacks) return;
  const { raw } = await loadGameMaster();
  playerAttacks = new Set();
  attacksByWeapon = new Map();
  weaponClassById = new Map();
  for (const item of raw.WeaponItem) {
    const granted = new Set();
    for (const [column, value] of Object.entries(item)) {
      if (value && PLAYER_ATTACK_COLUMNS.test(column)) {
        granted.add(value);
        playerAttacks.add(value);
      }
    }
    attacksByWeapon.set(Number(item.Id), granted);
    weaponClassById.set(Number(item.Id), item.ClassType);
  }
  // A Dungeon Buster comes from the hero rather than from anything equipped.
  for (const hero of raw.Hero) if (hero.DBuster1) playerAttacks.add(hero.DBuster1);
  // BERSERK_MODE replaces every melee weapon's authored array with this attack
  // at runtime; it belongs to the player only while that server-known buff is active.
  playerAttacks.add("RAMPAGE");
};

const grantableAttacks = async () => {
  await buildGrants();
  return playerAttacks;
};

/**
 * A hero carries four weapons and two powerups. Nothing else is a slot.
 *
 * `weaponsForAvatar` always returns exactly four entries, filling the empty ones
 * with `{}`, so the range is structural rather than a guess — and the number on
 * the wire is one attacker-controlled byte, so 4 through 255 all named nothing.
 */
const WEAPON_SLOTS = 4;
const POWERUP_SLOTS = 2;

/** Where a Dungeon Buster says it came from, in all 508 recorded uses. */
const BUSTER_SLOT = 0;

const isSlot = (slot, count) => Number.isInteger(slot) && slot >= 0 && slot < count;

/**
 * And out of the weapon that is actually in that slot.
 *
 * The coarse rule above only asks whether a player could ever swing this, so a
 * client with an axe in slot 0 and a staff in slot 1 could still propose the
 * staff's spell from the axe — which matters, because the slot is what pays for
 * it: the Mana modifier, the cooldown key and the placement permit are all read
 * from the weapon there.
 *
 * The recordings are exact. Of 6951 weapon casts, 6783 are granted by the
 * weapon in the slot they claim and 168 are Dungeon Busters, which come from the
 * hero's `DBuster1` and belong to no weapon. Casts arrive from slots 0, 1 and 2
 * and results from the same three; none from an empty slot, none from a weapon
 * that does not grant them, and every one of the 11 weapon types ever equipped
 * has a row in this server's own tables.
 *
 * An earlier version of this returned true for a missing slot, a slot holding
 * nothing, and a weapon with no row — reasoning that refusing on our own
 * ignorance deletes honest attacks. That reasoning is right and this was the
 * wrong place for it: none of those three is ignorance. The slot count is fixed
 * here, an empty slot is a fact this server wrote itself, and an unknown weapon
 * id has never once appeared. Slot 255 was accepted, spent Mana, and opened a
 * cooldown clock of its own — one per byte value, 256 of them.
 */
const slotGrantsAttack = async (session, attack, weaponSlot) => {
  if (!isSlot(weaponSlot, WEAPON_SLOTS)) return false;

  /**
   * The Dungeon Buster is the hero's rather than any weapon's, so no slot
   * grants it — but it still names one, and the recordings are unanimous about
   * which: all 168 buster casts and all 340 buster results arrive on slot zero.
   *
   * Accepting it from any real slot let a modified client pick its strongest,
   * which since the result is priced by the slot that swung is a damage choice
   * rather than a cosmetic one.
   */
  if (attack.Constant && attack.Constant === session.dungeonBusterAttack) {
    return weaponSlot === BUSTER_SLOT;
  }

  const type = Number(session.heroWeapons?.[weaponSlot]?.type ?? 0);
  if (!type) return false;

  await buildGrants();
  /**
   * `WeaponController.berserkModeStart` is a real client-side attack override:
   * while the owner has BERSERK_MODE, every melee controller replaces its
   * Attack1..9 array with RAMPAGE. RAMPAGE is therefore absent from every weapon
   * row by design; requiring only those columns disconnected honest Berserkers
   * after three ordinary swings.
   */
  if (
    attack.Constant === "RAMPAGE" &&
    weaponClassById.get(type) === "MELEE" &&
    hasAbility(session, session.heroDoid, "BERSERK_MODE")
  ) {
    return true;
  }
  return Boolean(attacksByWeapon.get(type)?.has(attack.Constant));
};

/** A client may propose an attack id, but only the equipped buff pot may cook soup. */
const hasPowerupWeapon = async (session, attack, weaponSlot) => {
  if (!(await isPowerupAttack(attack))) return true;
  /**
   * Except the one attack no weapon grants.
   *
   * A Dungeon Buster comes from the hero's own `DBuster1`, and none of the six
   * appears as `Attack1` on any `WeaponItem` — so asking the equipped weapon
   * for permission refuses it every time. It only bit one of them, which is why
   * it went unnoticed: `isPowerupAttack` asks whether the timeline spawns
   * anything, and only the Battle Chef's meteor shower does. The other five
   * passed straight through.
   *
   * Its price is checked in full a few lines below — Crowd points, and Mana —
   * so nothing is being waved past here except the question of which weapon it
   * came out of, which for this attack has no answer.
   */
  if (attack?.Constant && attack.Constant === session.dungeonBusterAttack) return true;
  const weapon = session.heroWeapons?.[weaponSlot];
  if (!weapon) return false;
  const { raw } = await loadGameMaster();
  return raw.WeaponItem.some(
    (item) => Number(item.Id) === Number(weapon.type) && item.Attack1 === attack.Constant
  );
};

/**
 * Charges the account for a powerup that was just used.
 *
 * Two places count them and both are the player's: the avatar's own slot, which
 * is what the hero carries into a dungeon and what the report shows, and the
 * account's stackable stock. Writing only the session's copy would have let a
 * reconnect hand the potion straight back.
 */
/**
 * Takes one off what the hero is carrying, and nothing else.
 *
 * The bag is deliberately untouched. It used to be decremented here as well,
 * which was invisible only because equipping moved the whole stack out of the
 * bag and left nothing there to decrement. Now that the bag holds everything
 * over the carry limit, taking one from both would charge the player twice for
 * every potion.
 *
 * What the bag is for is the next reconcile: leaving the dungeon tops the slot
 * back up out of it, so a potion drunk on floor three is paid for once, from
 * the total.
 */
const spendStackable = (session, stackId, slot, remaining) => {
  const avatar = session.dungeonAvatar;
  if (avatar) avatar[`consumable${slot + 1}_count`] = remaining;

  session.queueAccountSave?.(session) ?? queueAccountSave(session);
};

/**
 * Spends one powerup and does what it does.
 *
 * The client keeps no authority here and never claimed any:
 * ConsumableWeaponGameObject.consume() decrements its own copy and tells the
 * HUD, and that is the whole of it — nothing about the count crosses the wire.
 * So a potion appeared to be used, the number went 1 to 0, and the account was
 * never charged and the effect never happened.
 *
 * What it does is on the stackable, not on the proposal. Every POWERUP row
 * names a `UsageAttack`, and requiring the proposed attack to *be* that attack
 * is what stops a client asking for someone else's effect out of its own slot.
 *
 * Three kinds, taken from the usage attacks themselves:
 *
 *   DoPercentHealthDamage   a share of maximum health   (potions, shots)
 *   SelfBuff                a buff by name             (stat, mushroom)
 *   Team HOSTILE            damage                     (bombs)
 *
 * The health and party bombs need nothing more: they are ordinary hostile
 * attacks and their combat results arrive on the usual path.
 *
 * The other five do. CONSUMABLE_DEMOLITION, ICE, FIRE, VOLT and POISON are all
 * authored at DamageMod zero, so the attack itself is not the weapon — their
 * timelines place a bomb, and the bomb's DeathAttack is the bang. Throwing one
 * did nothing at all while this path returned before the placeable scheduler.
 */
const useConsumable = async (session, attack, slot, { playSpeed = 1 } = {}) => {
  const equipped = session.heroConsumables?.[slot];
  if (!equipped?.type || !(equipped.count > 0)) {
    warn(`[${session.id}] rejected ${attack.Constant}: powerup slot ${slot} is empty`);
    return true;
  }

  const stackable = await stackableById(equipped.type);
  if (!stackable || stackable.UsageAttack !== attack.Constant) {
    warn(
      `[${session.id}] rejected ${attack.Constant}: slot ${slot} holds ` +
        `${stackable?.Constant ?? equipped.type}, whose use is ${stackable?.UsageAttack ?? "nothing"}`
    );
    return true;
  }

  equipped.count -= 1;
  spendStackable(session, equipped.type, slot, equipped.count);

  const healed = healHero(session, attack.DoPercentHealthDamage ? attack.PercentHealthDamageValue : 0);
  const buff = attack.SelfBuff ? await grantBuff(session, attack.SelfBuff) : null;
  // And the party's half of it. Twelve of the 33 consumable attacks are party
  // potions naming the same buff in `SelfBuff` and `TargetBuff1`; only the
  // drinker was ever getting one.
  const shared = await buffFriendlyTarget(session, attack);
  // Here rather than beside the other grants below, because both attacks that
  // refill are bottles: the consumable branch returns before that code runs.
  const refilled = refillDungeonBuster(session, attack);
  // A thrown bomb is a placeable like any other; the slot it came from indexes
  // the powerups, so the weapon slot is not this one's to give.
  await schedulePlaceables(session, attack, 0, { playSpeed });
  info(
    `[${session.id}] used ${stackable.Constant} from slot ${slot}, ${equipped.count} left` +
      (healed ? `; healed ${healed}` : "") +
      (buff ? `; ${attack.SelfBuff}` : "") +
      (refilled ? `; Dungeon Buster refilled for ${refilled}` : "") +
      (Array.isArray(shared) ? `; ${attack.TargetBuff1} to ${shared.length} others` : "")
  );
  return true;
};

/**
 * Reads the AttackChoreography header sent by the owner. The client checks
 * affordability but leaves both Mana and Crowd point mutation to the server.
 */
export const handleProposeAttackChoreography = async (
  session,
  reader,
  { onAccepted } = {}
) => {
  const weaponSlot = reader.u8();
  const isConsumableWeapon = reader.u8();
  const attackType = reader.u32();
  const targetActorDoid = reader.u32();
  reader.u8(); // choreography.loop
  const playSpeed = reader.f32();
  reader.f32(); // choreography.scalingMaxProjectiles
  const attack = await attackById(attackType);
  if (!attack) {
    warn(`buster: unknown proposed attack ${attackType}`);
    return true;
  }

  // Reviving an ally is an owner support timeline, not an attack granted by a
  // weapon. It still has a choreography so remote clients can draw the rescue,
  // and field 173 at the end must match the target recorded here.
  if (isAllyReviveAttack(attack)) {
    if (weaponSlot !== 0 || isConsumableWeapon !== 0) {
      noteViolation(
        session,
        RULE.unownedAttack,
        `${attack.Constant} claimed weapon ${weaponSlot}/consumable ${isConsumableWeapon}`
      );
      return true;
    }
    if (!noteAllyReviveAttempt(session, attack, targetActorDoid)) {
      warn(`[${session.id}] rejected ${attack.Constant}: target ${targetActorDoid} is not down`);
      return true;
    }
    onAccepted?.();
    return true;
  }

  // A consumable is spent, not paid for in Mana and Crowd, so it takes its own
  // path. The slot then indexes the two powerup slots rather than the weapons,
  // and the recordings only ever use those two.
  if (isConsumableWeapon) {
    if (!isSlot(weaponSlot, POWERUP_SLOTS)) {
      noteViolation(session, RULE.unownedAttack, `powerup slot ${weaponSlot} is not one`);
      return true;
    }
    return useConsumable(session, attack, weaponSlot, { playSpeed });
  }

  /**
   * Asked before anything is spent or recorded: an attack no weapon and no hero
   * grants is not a thing this player can swing, whatever slot it claims.
   */
  if (!(await grantableAttacks()).has(attack.Constant)) {
    noteViolation(session, RULE.unownedAttack, `${attack.Constant} is granted by nothing equipped`);
    return true;
  }

  if (!(await slotGrantsAttack(session, attack, weaponSlot))) {
    noteViolation(
      session,
      RULE.unownedAttack,
      `${attack.Constant} from slot ${weaponSlot}, which does not grant it`
    );
    return true;
  }

  if (!isOffCooldown(session, attack, weaponSlot)) {
    warn(`[${session.id}] rejected ${attack.Constant}: still on cooldown`);
    return true;
  }
  if (!(await hasPowerupWeapon(session, attack, weaponSlot))) {
    warn(`[${session.id}] rejected ${attack.Constant}: wrong equipped weapon`);
    return true;
  }

  const manaCost = await attackManaCost(session, attack, weaponSlot);
  const manaPoints = Math.max(0, Math.trunc(session.heroManaPoints ?? 0));
  if (manaPoints < manaCost) {
    warn(
      `[${session.id}] rejected ${attack.Constant}: ` +
        `${manaPoints}/${manaCost} Mana points`
    );
    return true;
  }

  const crowdCost = Math.max(0, Math.trunc(attack.CrowdCost ?? 0));
  if ((session.dungeonBusterPoints ?? 0) < crowdCost) {
    warn(
      `[${session.id}] rejected ${attack.Constant}: ` +
        `${session.dungeonBusterPoints ?? 0}/${crowdCost} Crowd points`
    );
    return true;
  }

  if (manaCost) {
    session.heroManaPoints = manaPoints - manaCost;
    session.send(heroManaPointsUpdate(session.heroDoid, session.heroManaPoints));
  }
  if (crowdCost) {
    session.dungeonBusterPoints -= crowdCost;
    session.send(
      heroDungeonBusterPointsUpdate(
        session.heroDoid,
        session.dungeonBusterPoints
      )
    );
    info(
      `[${session.id}] used ${attack.Constant}; ` +
        `${session.dungeonBusterPoints} Crowd points remain`
      );
  }
  /**
   * The attack is happening, so its wait starts now. Every row that authors a
   * CooldownLength gets one, not only the ones that cook something — and the
   * wait is the one the client computes, not the authored seconds, since a
   * weapon's COOLDOWN_REDUC and a Sorcerer's MAGIC_COOLDOWN both shorten it.
   */
  await noteCooldown(session, attack, weaponSlot);
  /**
   * And the cast itself, because the hits that follow have to point at
   * something. See `castAccepted` in combat.js.
   */
  noteCast(session, attack, weaponSlot);
  /**
   * And whatever untouchable time the attack's own timeline authors. Every
   * hero's Dungeon Buster opens one at frame zero, which is what makes it safe
   * to stand still through — see `invulnerableForMs`.
   */
  const untouchable = await invulnerableForMs(attack.AttackTimeline);
  if (untouchable && session.heroDoid) {
    session.invulnerableUntil ??= new Map();
    session.invulnerableUntil.set(session.heroDoid, Date.now() + untouchable);
  }
  // And, when the throw leaves something behind, the right to land it once.
  await notePlacementPermit(session, attack, weaponSlot);

  /**
   * Outside the Crowd branch. A self buff is a property of the attack, not of
   * its price, and every stat potion costs no Crowd at all — so while this sat
   * inside the branch above, none of them ever granted anything.
   */
  await spawnSelfBuff(session, attack);
  await buffFriendlyTarget(session, attack);
  await schedulePowerup(session, attack);
  /**
   * Alongside the pots rather than inside them: what an attack cooks and what
   * it leaves standing are two different timeline actions, and plenty of
   * attacks — the poison pot, the placed traps, the bombs — have only the
   * second. Reading only `spawndoober` is what left all of those inert.
   */
  await schedulePlaceables(session, attack, weaponSlot, { playSpeed });
  onAccepted?.();
  return true;
};
