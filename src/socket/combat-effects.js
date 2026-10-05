import { loadGameMaster } from "../gamemaster.js";
import { countsAsKill } from "./actor-roles.js";
import { buffColorTypeFor, buffEffectAbilityFor, buffEffectReport, grantBuffInstance, hasAbility, isBuffEffectSuppressed } from "./buffs.js";
import { heroOnFloor } from "./match-world.js";
import { cancelScopedTimer } from "./lifecycle-scope.js";
import { onHitBuffEffectsFor } from "./modifiers.js";
import { isPartyHero } from "./combat-wire.js";
import { isInvulnerable, applyDamage, payBusterForKill } from "./combat.js";

/**
 * What a hit leaves behind: a health drain, damage over time, and the buffs a
 * weapon's modifiers or an attack's target buff grant on landing.
 */

/**
 * A buff that takes a share of its bearer's full health every second, for as
 * long as it is on him — the Infinite dungeons' Poison Gas.
 *
 * Not the damage-over-time below, which is priced from the hit that applied it
 * and which a hero never takes. Nothing applies the gas: the floor grants it,
 * and its `PercentDamage` is of the hero rather than of a blow. On the official
 * it is one percent a second, rounded up — 9 off a hero of 880, forty-two times
 * running, a median 973ms apart — and here it was a picture on the health bar.
 *
 * It stops with the buff, and it does not take the last point. Whether the
 * official's can finish a hero is not something its one recording settles: that
 * hero was killed by a skeleton with the gas still on him. Wearing him down and
 * leaving the killing to the monsters is the reading that cannot be unfair.
 */
export const startHealthDrain = (session, { buffDoid, victimDoid, buff }) => {
  const share = Number(buff?.PercentDamage);
  if (buff?.BuffType !== "DAMAGE_OVER_TIME" || !(share > 0)) return null;

  const scope = session.floorScope;
  let timer = null;
  const stop = () => {
    if (timer === null) return;
    if (scope) cancelScopedTimer(scope, timer, clearInterval);
    else clearInterval(timer);
    session.damageOverTimeTimers?.delete(timer);
    timer = null;
  };
  const tick = () => {
    if (!session.activeBuffs?.has(buffDoid)) return stop();
    const victim = session.actors?.get(victimDoid);
    if (!victim || victim.dead) return;
    const lost = Math.min(
      Math.ceil(Number(victim.maxHitPoints ?? 0) * share),
      Math.max(0, Number(victim.hitPoints ?? 0) - 1)
    );
    if (lost > 0) applyDamage(session, victimDoid, lost);
  };
  timer = scope ? scope.interval(tick, 1000) : setInterval(tick, 1000);
  if (!scope) timer.unref?.();
  session.damageOverTimeTimers ??= new Set();
  session.damageOverTimeTimers.add(timer);
  return stop;
};

const startDamageOverTime = (session, { buffDoid, victimDoid, buff, damage, colorType }) => {
  /**
   * The hero does not burn.
   *
   * Every damage-over-time tick in the recordings — 625 of them, fire and
   * poison, across 47 sessions — lands on a monster. Not one names a hero, and
   * that is not for want of the chance: the same corpus has flame jets hitting
   * the hero 152 times, and `TRAP_FLAME_JET` authors `FIRE_L1` as its
   * `TargetBuff1`. If the official burned the player it would be here.
   *
   * Ours did, and priced each tick as the applying attack's damage — which for
   * a trap is twelve percent of the bar. A single touch cost the hero twelve
   * percent and then sixty more, and that is what the flame traps felt like.
   *
   * An argument from absence, and flagged as one in docs/evidence.md. The buff
   * is still granted: traps are seen to leave things on the hero — fifteen
   * TAR_SLOW off the tarpit — and it is only the damage that never arrives.
   *
   * Asked of the party, not of one hero. Written against `session.heroDoid`
   * this was true for whoever's context applied the buff and false for
   * everybody else, so in a party the host did not burn and the other players
   * did — the same shape as the ground trap that hurt only one of two people
   * standing in it.
   */
  if (isPartyHero(session, victimDoid)) return;

  if (buff?.BuffType !== "DAMAGE_OVER_TIME" || !(damage > 0)) return;
  const ticks = Math.max(0, Math.round(Number(buff.Duration ?? 0)));
  if (!ticks) return;

  /**
   * A share of the hit, not the whole of it.
   *
   * `PercentDamage` is authored per level and was never read: poison runs 2.5%,
   * 5%, 10%, 15%, 20% from one star to five, and fire 10% to 50%. Ticking the
   * full hit instead meant an eight-second poison dealt nine times the swing
   * that applied it — which is the report, in the words of the item card that
   * promises 15% at four stars.
   *
   * Floored at one so a tick that happens is felt, the same floor the hit
   * itself is priced with.
   */
  const share = Number(buff.PercentDamage);
  const portion = Number.isFinite(share) && share > 0 ? damage * share : damage;

  /**
   * And twice that on a monster weak to its element, which is the only thing
   * that moves a tick.
   *
   * The official's fire ticks are one number per burning hero — 194 on
   * knights, lions, yetis, a shaman imp rated exactly like an ice imp — and
   * 387 on the rows authoring `WEAK_FIRE`: the ice and freeze imps, the imp
   * miniboss, the frost troll miniboss. 98 of 98, each carrying effectiveness
   * +2, the client's "sweet" flash. Doubled before rounding: 2 × 193.5.
   *
   * `WEAK_<element>` rather than naming fire, because that is how the rows
   * say it; fire is the only damaging element any row is weak to today. The
   * `RESIST_` rows are immune rather than halved — see isEffectImmune — and
   * none of their ticks is on the wire.
   */
  const element = buffEffectAbilityFor(buff);
  const weak = Boolean(element) && hasAbility(session, victimDoid, `WEAK_${element}`);
  const perTick = Math.max(1, Math.round(portion * (weak ? 2 : 1)));
  const effectiveness = weak ? 2 : 0;

  /**
   * One clock per distributed buff object. New stacks get new clocks; a grant
   * refused at `MaxStacks` starts nothing. This keeps DoT lifetime identical to
   * the object lifetime the client sees.
   */
  const clocks = (session.damageOverTimeByBuff ??= new Map());
  const existing = clocks.get(buffDoid);
  const scope = session.floorScope;
  if (existing) {
    cancelScopedTimer(scope, existing, clearInterval);
    session.damageOverTimeTimers?.delete(existing);
  }

  let remaining = ticks;
  const tick = () => {
    const actor = session.actors?.get(victimDoid);
    const done = !actor || actor.dead || !session.dungeonActive || remaining <= 0;
    if (done) {
      cancelScopedTimer(scope, timer, clearInterval);
      session.damageOverTimeTimers?.delete(timer);
      clocks.delete(buffDoid);
      return;
    }
    remaining -= 1;
    // The official still creates the debuff object on an immune enemy; only
    // its gameplay effect is suppressed. Keep its lifetime/tick clock intact
    // so expiring resistance can expose the remaining authored ticks.
    if (isBuffEffectSuppressed(session, buffDoid)) return;
    const hitPointsBefore = actor.hitPoints ?? 0;
    // Hit points first, then the floater — the order every captured tick shows.
    if (!applyDamage(session, victimDoid, perTick)) return;
    if (countsAsKill(actor)) {
      session.dungeonContribution ??= { kills: 0, damage: 0 };
      session.dungeonContribution.damage += Math.min(perTick, hitPointsBefore);
      if (actor.dead) {
        session.dungeonContribution.kills += 1;
        // The kill counts on the report either way; the Buster it pays is
        // an update on the hero, which has to still be there to take it.
        if (heroOnFloor(session)) payBusterForKill(session);
      }
    }
    // The floater is drawn by the hero owner; a hero that has walked out has
    // nobody to draw it, though what it set alight goes on burning.
    if (!heroOnFloor(session)) return;
    session.send(
      buffEffectReport({
        heroDoid: session.heroDoid,
        actorDoid: victimDoid,
        amount: -perTick,
        colorType,
        effectiveness,
      })
    );
  };
  const timer = scope ? scope.interval(tick, 1000) : setInterval(tick, 1000);
  if (!scope) timer.unref?.();
  session.damageOverTimeTimers ??= new Set();
  session.damageOverTimeTimers.add(timer);
  clocks.set(buffDoid, timer);
};

/**
 * What a hit leaves on whoever it caught.
 *
 * `TargetBuff1`/`TargetBuff2` are the debuffs an attack applies, and they are
 * most of what separates these from one another: garlic stuns, the fire patch
 * burns, the poison cloud poisons. `grantBuff` owns stacking: poison reaches
 * six copies and fire two; a one-stack slow ignores more until it expires.
 */
/**
 * The debuffs the weapon's own modifiers leave on what it hit.
 *
 * Kept separate because a weapon may contribute two modifier buffs in addition
 * to the attack's own pair. Stacking remains `grantBuff`'s decision in both
 * paths; its authored `MaxStacks` is the single source of truth.
 *
 * `damage` here and in `applyTargetBuff` is what a tick is priced from, and it
 * is the *neutral* hit — `priceHit`'s `neutral`, times the crit — never the
 * categorised one. The official's burn is one number on every monster a hero
 * sets alight, whatever they are rated; only `WEAK_<element>` moves it (see
 * startDamageOverTime). A Burning weapon's FIRE_L1 is exactly that burn.
 */
export const applyModifierBuffs = async (session, { weapon, victimDoid, attackerDoid, damage }) => {
  const effects = onHitBuffEffectsFor(await loadGameMaster(), weapon);
  for (const { constant, effectAbility } of effects) {
    const { doid: buffDoid, buff, created } = await grantBuffInstance(session, constant, {
      affectedActor: victimDoid,
      attackerActor: attackerDoid,
      effectAbility,
    });
    if (!created) continue;
    startDamageOverTime(session, {
      buffDoid,
      victimDoid,
      buff,
      damage,
      colorType: await buffColorTypeFor(buff),
    });
  }
};

export const applyTargetBuff = async (session, { attack, victimDoid, attackerDoid, damage }) => {
  const constants = [...new Set([attack?.TargetBuff1, attack?.TargetBuff2].filter(Boolean))];
  if (!constants.length) return;
  if (attack?.Team !== "FRIENDLY" && isInvulnerable(session, victimDoid)) return;
  // A friendly attack with a distinct SelfBuff has already covered its caster.
  // DBUSTER_BERSERK gives BERSERK_DB to the Berserker and BERSERK to allies;
  // the caster's impact result must not turn that into two simultaneous buffs.
  if (
    attack.Team === "FRIENDLY" &&
    attack.SelfBuff &&
    Number(victimDoid) === Number(attackerDoid)
  ) {
    return;
  }
  for (const constant of constants) {
    const { doid: buffDoid, buff, created } = await grantBuffInstance(session, constant, {
      affectedActor: victimDoid,
      attackerActor: attackerDoid,
    });
    if (!created) continue;
    startDamageOverTime(session, {
      buffDoid,
      victimDoid,
      buff,
      damage,
      colorType: await buffColorTypeFor(buff),
    });
  }
};
