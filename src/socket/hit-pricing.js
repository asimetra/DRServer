import { CLID, TEAM } from "./opcodes.js";
import { npcForConstant, loadGameMaster, projectileForConstant } from "../gamemaster.js";
import { netAttackDamage, npcStats, statOffsetsFor } from "../combat-damage.js";
import { partyStatMultiplier } from "../npc-stats.js";
import { STAT_NAMES, legendaryShieldFor } from "../hero-stats.js";
import { buffMultiplierFor, buffRatingFor, damageReductionFor } from "./buffs.js";
import { heroMembersOf, memberForHero } from "./match-world.js";
import { attackMultiplierFor } from "./modifiers.js";
import { isPartyHero } from "./combat-wire.js";
import { computeHealing } from "./hero-healing.js";

/**
 * The number a hit is worth: the hero's stats and weapons, generation
 * falloff, defence and resistance, a pet's damage, and the bytes a result
 * carries back — crit, knockback, suffer, effectiveness, power multiplier.
 * The reach a claimed hit may have (`claimedReachOf`) is here too, for
 * cast-audit.js.
 */

/**
 * Damage is the server's to compute. The client fills in who hit whom, with
 * which attack, and whether it was blocked — but never the number: look at
 * CombatGameObject, which reads the weapon's power and then leaves
 * `damage` at zero. So a relayed proposal with its zero intact produces a hit
 * that does nothing.
 *
 * The arithmetic itself is not ours: the client still carries it whole in
 * DistributedDungionArea.calculateNetAttackDamage, with every call site removed.
 * See combat-damage.js — attacker offence stat and weapon power against the
 * victim's defence, scaled by the attack's DamageMod.
 *
 * Returned as a positive magnitude; the caller negates it for the wire.
 */
/**
 * Asked of the floor rather than of a connection.
 *
 * A monster's numbers come from its `constant`, which anything holding the
 * floor can look up. A hero's lived on its own session, so this had to ask "is
 * this doid the session's own hero?" to find them — and any other member of the
 * party fell through to an NPC lookup that cannot succeed, because no hero
 * constant is in the Npc table. Their defence silently counted as zero, and the
 * lookup warned about a missing NPC on every hit.
 *
 * That question was also the only reason floor code had a notion of *whose*
 * hero at all. A server has no self: a hazard firing, a bomb going off and a
 * monster swinging happen to actors on a floor, and which connection is holding
 * the timer is not part of the arithmetic. Heroes now carry their numbers on
 * the actor, like everything else on the floor does.
 */
export const statsFor = async (session, doid) => {
  const actor = session.actors?.get(doid);
  if (actor?.stats) return actor.stats;
  // Floor traps with zero HP are intentionally absent from actors, but their
  // attacks are still priced from the NPC row's levelled offence stat.
  const trapStats = session.trapNames?.get(doid)?.stats;
  if (trapStats) return trapStats;
  // For a hero installed before its stats were known, and for hand-built
  // sessions in tests that predate the actor carrying them.
  if (doid === session.heroDoid) return session.heroStats;
  if (!actor?.constant) return undefined;
  const gm = await loadGameMaster();
  const npc = await npcForConstant(actor.constant);
  return npcStats(gm, npc, actor.level ?? npc?.Level ?? 0);
};

/**
 * How much a repeated hit is worth.
 *
 * The client counts each collision of a projectile in `generation`, and the
 * captures show the damage halving with it. One victim caught by two different
 * storms settles it: at generation 0 it took 2877, and at generation 2 it took
 * 720 — half of half, 1439 and then 720. So a cloud mauls the first thing it
 * reaches and is nearly spent by the fifth.
 *
 * Harmless for everything else — an ordinary swing is generation zero and
 * divides by one.
 */
export const generationFalloff = (hit, generation) => {
  /**
   * Each collision half of the one before, rounded — not the first over a
   * power of two. A Sonic Slash in the official's recording (2026-10-03) went
   * 5623, 2812, 1406, 703, 352, 176, 88, 44, 22, 11, 6, 3, 2, 1: halves rounded
   * up, 2811.5 to 2812 and 351.5 to 352, where 5623 over sixteen is 351. The
   * storm's 2877 and 720 above are the same rule.
   */
  let landed = hit;
  for (let step = 0; step < Math.max(0, Number(generation ?? 0)) && landed > 1; step++) {
    landed = Math.max(1, Math.round(landed / 2));
  }
  return landed;
};

/** The equipment belonging to a hero doid, including a remote party member. */
export const weaponsForHero = (session, doid) => {
  // Most damage targets an NPC. Avoid rebuilding the at-most-four-member hero
  // lookup on that hot path when the shared actor set already answers no.
  if (!isPartyHero(session, doid)) return [];
  if (doid === session?.heroDoid) return session.heroWeapons ?? [];
  const member = memberForHero(session, doid);
  return member?.heroWeapons ?? [];
};

/**
 * The most a hero may turn aside through training alone.
 *
 * Everything earned rather than granted is bounded, so no amount of levelling
 * arrives at untouchable — that is reserved for a buff that says it outright,
 * and there is exactly one. It is not reached today: a Berserker with every
 * point in the slot sits at 24.75%, which is half the ceiling.
 */
const MAX_TRAINED_REDUCTION = 0.5;

/**
 * What a defender turns aside from one type of hit, as a share of it.
 *
 * The trained half is the `*_DEF` stat, which only one hero has any of:
 * `MASTER_DEFENSE` is the Berserker's fourth slot and gives 0.0033 a point
 * across all three types, so every point in it reaches 24.75% and nobody else
 * reaches anything — a Ranger with all seventy-five there still measures zero.
 * That is the tankiness he trains for, and it is his.
 *
 * Combined with the buffs multiplicatively rather than added, so the two leave
 * a remainder: a quarter off from training and half off from `DEFENDER_L2` is
 * 62%, not 75%. Only a source that is itself all of it gets to all of it, and
 * the trained half is capped well below that in any case.
 *
 * A function rather than four lines inside `priceHit` because `/stats`
 * reports this number to the player, and a second copy of the formula written
 * to read it out is a copy that drifts from the one that charges for it.
 */
export const damageTurnedAside = (session, doid, stats, offsets) => {
  if (!offsets) return 0;
  const stat = STAT_NAMES[offsets.defence];
  const trained = Math.min(
    MAX_TRAINED_REDUCTION,
    Math.max(0, Number(stats?.get(stat)) || 0)
  );
  /**
   * And whether the hero resists this type outright — see `heroResists`. A
   * monster's resistance is its rating and is `categoryFor`'s to apply, so this
   * is nothing for everybody else.
   */
  const attackType = ["MELEE", "SHOOTING", "MAGIC"][offsets.type];
  const resisted = heroResists(session, doid, attackType) ? RESISTED_SHARE : 0;

  return (
    1 -
    (1 - trained) *
      (1 - damageReductionFor(session, doid, stat)) *
      (1 - resisted)
  );
};

/** What resisting a type of damage takes off it: half, as it does for a monster. */
const RESISTED_SHARE = 0.5;

/**
 * Whether a hero resists a type of damage, which is half of it and is said on
 * the hit.
 *
 * Two things make one. A legendary shield for the type — `Barrier`, `Cover`,
 * `Comprehend` — and a buff that rates the hero +1 against it (`buffRatingFor`).
 * They are the same resistance and not two: the official's samurai carried
 * `Cover` and took 5, 7 and 9 from an archer on three floors, then 11 on the
 * fourth under the Poison Gas — the next step of the same halved series, where
 * a second half would have made it 6.
 */
const heroResists = (session, doid, attackType) => {
  if (!attackType || !isPartyHero(session, doid)) return false;
  return (
    legendaryShieldFor(weaponsForHero(session, doid), attackType) > 0 ||
    buffRatingFor(session, doid, DEFENCE_FIELD[attackType]) > 0
  );
};

/**
 * One hit, priced: what lands, what would have landed against a neutral target,
 * and the `effectiveness` the result carries — see `categoryFor`.
 *
 * `neutral` is what a damage-over-time the hit applies is priced from. The
 * official's fire ticks are one number for every monster a hero burns, 194
 * against knights, lions, yetis and imps rated every which way; only
 * `WEAK_FIRE` changes them (see startDamageOverTime). A tick priced from the
 * categorised hit would carry the category into it.
 */
export const priceHit = async (session, proposal, attack, weaponPower, weapon = null) => {
  const offsets = statOffsetsFor(attack);
  const gm = await loadGameMaster();
  const attacker = session.actors?.get(proposal.attacker);
  // Zero-HP launchers are protocol NPCs but not damageable actors, so they have
  // no actor.partySize. The live floor membership is their fallback.
  const partySize = attacker?.partySize ?? Math.max(1, heroMembersOf(session).size);
  const npcStatScale =
    offsets &&
    session.objects?.get(proposal.attacker) === CLID.DistributedNPCGameObject &&
    attacker?.team !== TEAM.PLAYERS
      ? partyStatMultiplier(gm, partySize, STAT_NAMES[offsets.offence]) *
        (1 + Math.max(0, Number(session.npcDamageDepthBonus) || 0))
      : 1;
  /**
   * A monster's defence is its category, not a number. Its three ratings are
   * ±1 and nothing more (no level growth), and the official reads them as a
   * half or a double — see `categoryFor` — and not also as a point of flat
   * defence and a trained reduction, which is what reading them as a hero's
   * stats did: a Knight Fortress knight rated +1 against melee stood behind
   * both. Only a hero's defence stats are a hero's defence.
   */
  const category = await categoryFor(session, proposal.attacker, proposal.attackee, attack);
  const defender = category.rated ? undefined : await statsFor(session, proposal.attackee);
  const signed = netAttackDamage({
    gm,
    attack,
    // The slot that swung, which the result names. NPCs and placeables pass
    // their own weapon explicitly and never reach the fallback.
    weaponPower: weaponPower ?? 1,
    attacker: await statsFor(session, proposal.attacker),
    defender,
    // PlayerScale multiplies the NPC's stat, not the weapon beside it. The
    // four-player BRUTE_CAVE capture distinguishes 31 from the 32 produced by
    // multiplying both.
    attackerStatMultiplier: npcStatScale,
    /**
     * The buffs on the attacker and, alongside them, the `DAMAGE` modifiers on
     * the weapon that swung — see `attackMultiplierFor`. Both are multipliers on
     * the same stat, so they belong in the same place; the weapon's is null for
     * every NPC and placeable, which have no modifiers to carry.
     */
    attackerBuff: offsets
      ? buffMultiplierFor(session, proposal.attacker, STAT_NAMES[offsets.offence]) *
        attackMultiplierFor(gm, weapon, STAT_NAMES[offsets.offence])
      : 1,
    /**
     * The defence *stat* is still a flat subtraction and still tiny; what a
     * buff does is take a share off the hit, which is handled below.
     */
    defenderBuff: 1,
  });

  /**
   * Nothing landed, so nothing is said about how well. The official's hits
   * that do no damage — a thrown garlic or firebomb striking before its cloud
   * does the work, a buff pulse — carry zero whatever the rating: THROW_GARLIC
   * on a KNIGHT_BOXERS weak to magic, eleven such hits on rated monsters, all
   * zero. The client would otherwise play StrongHit for a hit that did nothing.
   */
  const none = { damage: 0, neutral: 0, effectiveness: 0 };
  if (signed >= 0) return none; // a heal is `computeHealing`'s to price
  const raw = -signed;

  /**
   * And then what the defender's buffs take off it, by the type of the hit.
   *
   * Separately from the stat, because the two are different things wearing the
   * same column name: `MELEE_DEF` on a hero is a small flat number, and
   * `MELEE_DEF` on a buff is a share of the incoming hit. Reading the second as
   * a multiplier on the first is what left the whole family doing nothing.
   *
   * Type by type, which is what makes a Berserker a tank against the pack he
   * has waded into without making him one against the archers behind it — the
   * data separates melee, shooting and magic and this keeps them separate.
   *
   * Traps are not here. Twenty-four of the game's forty trap attacks take a
   * share of maximum health and never reach this path at all, so no amount of
   * reduction saves a player from walking into spikes. That is the floor's job
   * and it stays the floor's job.
   */
  const reduction = damageTurnedAside(session, proposal.attackee, defender, offsets);
  // All of it is all of it. The floor of one exists so a hit that lands is felt,
  // and a hit that is entirely turned aside did not land.
  if (reduction >= 1) return none;
  /**
   * NPC-authored damage rounds upward when it crosses the integer wire.
   * Captured results pin the distinction repeatedly: BABY_YETI L59 computes
   * to 4.36 and lands as 5 in 44/44 hits; KNIGHT_MARKSMAN L53 computes to 7.24
   * and lands as 8 in 33/33. Hero proposals retain nearest-integer rounding,
   * and persistent pets keep their separately measured rule below.
   */
  const round = session.objects?.get(proposal.attacker) === CLID.DistributedNPCGameObject
    ? Math.ceil
    : Math.round;
  // Multiplied before it is rounded: KATANA_SHADOW_SLASH lands 1133 on a
  // neutral target and 2265 on a weak one, not 2266.
  /**
   * And a resistance says what it did. `Barrier`, `Cover` and `Comprehend`
   * each take half of one type, and the official marks the hit they halved as
   * resisted: 408 of 408 arrows on a hero carrying `Cover` arrive at -1, every
   * melee hit and every arrow on one carrying both. A buff that rates the hero
   * does the same — all nine sword blows on a hero under the Poison Gas. It is
   * the resistance and nothing else: a Berserker with every point in his
   * defence slot and no shield takes 339 melee hits at zero.
   */
  const shielded =
    offsets &&
    heroResists(session, proposal.attackee, ["MELEE", "SHOOTING", "MAGIC"][offsets.type]);
  return {
    damage: generationFalloff(Math.max(1, round(raw * category.multiplier * (1 - reduction))), proposal.generation),
    neutral: generationFalloff(Math.max(1, round(raw * (1 - reduction))), proposal.generation),
    effectiveness: shielded ? -1 : category.effectiveness,
  };
};

/**
 * How well a hit lands on a monster, by the monster's rating for its type.
 *
 * Every NPC row rates itself against the three attack types — `MELEE_DEF`,
 * `SHOOT_DEF`, `MAGIC_DEF` — at +1 (resists), 0 or -1 (weak), and the
 * official halves or doubles the hit by it and says so: the result's
 * `effectiveness` is the inverse of the rating, which is what the client
 * draws as the pale or the orange number, the weak or the super flash, and
 * the WeakAttack or StrongHit sound. Across 15721 hero hits on monsters
 * 15717 carry exactly that; the same hero's `AXE_COMBO_1` lands 944, 1887
 * and 3774 on resistant, neutral and weak targets, and `KATANA_SOUL_BANG`
 * 5237 and 10474. The columns are read straight — melee against `MELEE_DEF`
 * — which the cross-wired stat offsets do not, and fit none of it.
 *
 * Everything that hits a monster is judged so — heroes, pets, a hero's
 * placeables, a floor's mines, and monsters hitting pets and beasts — except
 * the floor's own PROP traps and barrels, whose 3000 recorded hits all carry
 * zero. A hero is not rated and is never judged.
 *
 * `IgnoreResistances` on the attacker's buffs — the two mushroom potions —
 * takes the category away and the client is told it landed well: 135 of 135
 * hits under the star mushroom carry +1, and land at 1.5 times the neutral
 * hit whatever the rating, which is the buff's own attack multiplier.
 */
const DEFENCE_FIELD = {
  MELEE: "MELEE_DEF",
  SHOOTING: "SHOOT_DEF",
  MAGIC: "MAGIC_DEF",
};

const NOT_RATED = Object.freeze({ rated: false, multiplier: 1, effectiveness: 0 });

/**
 * The level from which a monster's ratings count.
 *
 * The first dungeons have none. Every rated hit in the official's recordings on
 * a monster of level 1 to 4 (map nodes 50002-50005) is neutral — 63 of 63,
 * knights and juggernauts rated +1 against melee among them — and from level 7
 * (50008, Icewater Caverns) they count, 41 of 41. It is also where the client
 * first explains them: its RESISTANCES tutorial opens once seven dungeons are
 * done. Levels 5 and 6 are not in the recordings; the line is drawn at the
 * tutorial. Rating the knights of the first floors made nearly every early hit
 * a weak one.
 */
const RATED_FROM_LEVEL = 7;
const NEUTRAL_MONSTER = Object.freeze({ rated: true, multiplier: 1, effectiveness: 0 });

const rowOf = async (session, doid) => {
  const constant = session.actors?.get(doid)?.constant ?? session.trapNames?.get(doid)?.constant;
  return constant ? npcForConstant(constant) : null;
};

const ignoresResistances = (session, doid) => {
  for (const active of session.activeBuffs?.values() ?? []) {
    if (active.affectedActor === doid && active.buff?.IgnoreResistances) return true;
  }
  return false;
};

const categoryFor = async (session, attackerDoid, victimDoid, attack) => {
  const field = DEFENCE_FIELD[attack?.AttackType];
  if (!field) return NOT_RATED;
  if (session.objects?.get(victimDoid) !== CLID.DistributedNPCGameObject) return NOT_RATED;
  const victim = await rowOf(session, victimDoid);
  if (!victim) return NOT_RATED;
  if (session.objects?.get(attackerDoid) === CLID.DistributedNPCGameObject) {
    const attacker = await rowOf(session, attackerDoid);
    if (attacker?.CharType === "PROP") return NOT_RATED;
  }
  if (ignoresResistances(session, attackerDoid)) {
    return { rated: true, multiplier: 1, effectiveness: 1 };
  }
  // Still a monster, whose defence is its category — only the category is
  // neutral. A level that is not known is not a reason to drop the rating.
  const level = Number(session.actors?.get(victimDoid)?.level);
  if (Number.isFinite(level) && level < RATED_FROM_LEVEL) return NEUTRAL_MONSTER;
  // Its own rating, and whatever a buff on it adds — the Infinite modifiers
  // that make enemies resist a type are exactly that. See `buffRatingFor`.
  const rating = Math.round(Number(victim[field] ?? 0)) + buffRatingFor(session, victimDoid, field);
  const effectiveness = Math.max(-2, Math.min(2, -rating));
  return { rated: true, multiplier: 2 ** effectiveness, effectiveness };
};

/** Prices one persistent pet hit exactly as the official pet corpus does. */
export const computePetDamage = async (session, attackerDoid, victimDoid, attack, weaponPower) => {
  const offsets = statOffsetsFor(attack);
  const { effectiveness, multiplier } = await categoryFor(session, attackerDoid, victimDoid, attack);
  const signed = netAttackDamage({
    gm: await loadGameMaster(),
    attack,
    weaponPower: weaponPower ?? 1,
    attacker: await statsFor(session, attackerDoid),
    // The categorical multiplier below is the target's defence for pet hits.
    defender: undefined,
    attackerBuff: offsets
      ? buffMultiplierFor(session, attackerDoid, STAT_NAMES[offsets.offence])
      : 1,
    defenderBuff: 1,
  });
  if (signed >= 0) return { damage: 0, neutral: 0, effectiveness: 0 };

  const buffed = offsets
    ? damageReductionFor(session, victimDoid, STAT_NAMES[offsets.defence])
    : 0;
  if (buffed >= 1) return { damage: 0, neutral: 0, effectiveness: 0 };
  // The official rounds the neutral pet hit first, then applies the categorical
  // half/double. L75 Wolf bite is 287.56 -> 288 -> 144/288/576.
  const neutral = Math.round(-signed);
  const damage = Math.max(1, Math.round(neutral * multiplier * (1 - buffed)));
  return { damage, neutral: Math.max(1, Math.round(neutral * (1 - buffed))), effectiveness };
};

/** Rewrites the signed wire damage field of a CombatResult on a copy. */
export const withDamage = (bytes, wireDamage) => {
  const copy = Buffer.from(bytes);
  copy.writeInt32LE(wireDamage, 8); // attacker(4) + attackee(4)
  return copy;
};

/**
 * Says so on the copy that goes back out, so the client draws the number the
 * way it draws a crit. The client proposes this byte as 0 every time — see
 * `critRollFor` — so setting it here is the whole of how it is ever set.
 */
const CRITICAL_HIT_BYTE = 26; // attacker, attackee, damage, Attack(10), when, suffer, knockback, blocked
const KNOCKBACK_BYTE = 24; // attacker, attackee, damage, Attack(10), when, suffer
const SUFFER_BYTE = 23; // attacker, attackee, damage, Attack(10), when
export const withSuffer = (bytes, enabled = true) => {
  const copy = Buffer.from(bytes);
  copy.writeUInt8(enabled ? 1 : 0, SUFFER_BYTE);
  return copy;
};

/**
 * Keeps a monster that was just staggered from acting, for as long as the
 * attack says it reels.
 *
 * The flag alone is a picture: the client plays the flinch and the monster
 * would go on swinging through it. The official's do not — after a hit that
 * staggered it a monster's next attack comes 1.0s later at the quartile and
 * 1.4s at the median, against 0.16s and 0.56s after one that did not (809 and
 * 135 hits). `HitStunDur` is a second on the attacks that make up most of
 * those, which is what the quartile shows.
 *
 * Read by the AI tick, which leaves a held monster where it is. Never
 * shortened: a second blow inside the first one's stun does not release it.
 */
export const holdStaggered = (session, victimDoid, attack) => {
  const ai = session.actors?.get(victimDoid)?.ai;
  const reels = Number(attack?.HitStunDur ?? 0) * 1000;
  if (!ai || !(reels > 0)) return;
  ai.staggeredUntil = Math.max(ai.staggeredUntil ?? 0, Date.now() + reels);
};

export const withKnockback = (bytes, enabled = true) => {
  const copy = Buffer.from(bytes);
  copy.writeUInt8(enabled ? 1 : 0, KNOCKBACK_BYTE);
  return copy;
};

export const withCrit = (bytes, enabled = true) => {
  const copy = Buffer.from(bytes);
  copy.writeUInt8(enabled ? 1 : 0, CRITICAL_HIT_BYTE);
  return copy;
};

/**
 * How well it landed, which the client proposes as zero and the server
 * decides — see `categoryFor`. The last byte before `selfDamage`.
 */
const EFFECTIVENESS_BYTE = 27;
export const withEffectiveness = (bytes, effectiveness) => {
  const copy = Buffer.from(bytes);
  copy.writeInt8(effectiveness, EFFECTIVENESS_BYTE);
  return copy;
};

/** Writes the server-bounded charge multiplier into the authoritative echo. */
export const withPowerMultiplier = (bytes, multiplier) => {
  const copy = Buffer.from(bytes);
  copy.writeFloatLE(multiplier, 32);
  return copy;
};

/**
 * Applies each proposed result: computes the damage, tells the victim, and
 * publishes its new hit points. Returns true when handled so the caller does
 * not log it as unimplemented.
 */
/**
 * How far a claimed hit may reasonably have reached.
 *
 * The client says *that* a hit happened and the server prices it; it is the one
 * claim on the hot path with nothing checking it, so a modified client can
 * report hitting every monster on the floor from where it stands. The damage
 * would still be ours, but the hits would be theirs.
 *
 * The bound comes from the official's own play rather than from a guess. Over
 * 5445 of its hit claims, measured as the distance to the victim minus the
 * attack's authored reach:
 *
 *   median -227   p90 -37   p99 +35   p999 +190   worst +253
 *
 * Only 221 of the 5445 exceed the authored reach at all, and the ones that do
 * are explicable: `IMPALE_DASH_FORWARD` and `KATANA_SHADOW_SLASH` carry the
 * hero along with the swing, `THROW_GARLIC` is thrown, and every sample is read
 * against a hero position up to 208ms old — a fifth of a second at 250 a second
 * is another 52 units.
 *
 * So the slack is set well past the worst honest case. Nothing in those 5445
 * would have been questioned, and a claim on something across the floor still
 * would be.
 *
 * A teleport does not trip this. It compares the hit to where the hero *is*,
 * not to where it was, so being dropped beside a party member on joining — or
 * anywhere else the server puts you — reads as an ordinary hit from wherever
 * you landed. Only a speed check would have that problem, which is why this is
 * the one that goes first.
 */
const REACH_SLACK = 400;

/**
 * How far past its authored reach an honest claim lands.
 *
 * There was a staleness term here: the bound grew with the age of the hero's
 * position, up to a cap, past which this server declined to judge at all. Both
 * halves were wrong, and in opposite directions. The client chooses whether to
 * send field 147, so the growing allowance was bought on demand — and declining
 * past the cap turned withholding into a way to switch the rule off entirely.
 *
 * Neither is needed, because age is not error. The client sends a position when
 * it changes, so a hero standing still legitimately has an old one — the oldest
 * used by an honest claim in the recordings is 64.9 seconds — and it is still
 * exactly where he is. Measured against those same last-known positions, over
 * 14479 claims with a locatable victim, the distance beyond the attack's
 * authored reach is -39 at the median, 69 at the p99 and **253 at the worst**.
 *
 * So the allowance is fixed and the answer is always given. `REACH_SLACK` is
 * 400, which is a little over half again the widest honest excess.
 */
export const claimedReachOf = async (attack) => {
  let reach = Math.max(0, Number(attack?.Range ?? 0));
  if (attack?.Projectile) {
    const projectile = await projectileForConstant(attack.Projectile);
    reach = Math.max(reach, Number(projectile?.Range ?? 0));
  }
  return reach + REACH_SLACK;
};
