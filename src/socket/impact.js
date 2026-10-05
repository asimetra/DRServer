import { PacketWriter } from "./packet.js";
import { CLID, OP } from "./opcodes.js";
import { hasAbility } from "./buffs.js";
import { moveWithNavigation } from "./navigation.js";

/**
 * What a blow does to where its victim stands: knockback (`pushVictim` — the
 * contact clamp, the first-frame share, the timed shove the AI tick carries)
 * and stagger, for heroes, NPCs and trap victims alike. Read by every
 * attacker: npc-swings.js, trap-attacks.js, placeable-attacks.js and the
 * hero's own proposals in combat.js.
 */

/**
 * The stagger a trap hit carries.
 *
 * The client reads these two as either/or and knockback wins
 * (`ActorGameObject.receiveDamage`): knockback plays
 * `GENERIC_SUFFER_KNOCKBACK`, suffer alone plays `GENERIC_STUN`. Its own
 * resolver writes them the same way it reads them (`CombatGameObject`) — roll
 * the stagger, and only consider a knockback if that roll won:
 *
 *     suffer = Math.random() <= StunChance ? 1 : 0;
 *     if (suffer == 1 && Knockback != 0) knockback = 1;
 *
 * Which is what the wire shows, once it is read at the right offset. Every
 * damaging trap result carries both, near enough always: 123 of 123 cave mace
 * results against monsters, 67 of 67 crusher, 50 of 50 blade, 261 of 273
 * arrows. The hero shrugs some of them off, and what decides that turned out
 * to be timing: a hero staggered a moment ago is not staggered again — see
 * `heroStaggerFor`, which is where the rule itself now lives.
 *
 * Two things do decide it here, and both are measured:
 *
 * A result that does no damage carries neither flag. All 44 zero-damage spike
 * results have both clear, against 119 of 153 damaging ones.
 *
 * A trap authored without them sends neither. `TRAP_TARPIT` is the only one:
 * `SufferChance` 0 and `Knockback` 0, and all 34 of its damaging hits are
 * unstaggered, where the spikes carry 30 knockback and the mace 90.
 */
const npcPositionUpdate = (doid, position) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(132) // DistributedNPCGameObject.position
    .f32(position.x)
    .f32(position.y)
    .frame();

/**
 * Moving what a hit knocked back, which the server does and this one did not.
 *
 * The flag was published and nothing followed it. Measured on official NPC
 * victims, holding the attack constant and comparing hits that carry the flag
 * against hits that do not: `TRAP_ARROWS`, whose row authors 30, moves its
 * victim a median 27 with the flag and 0 without it across 437 and 61 samples;
 * `TRAP_FLAME_JET`, authoring 60, moves it 57 against 5. So the push is a real
 * displacement, it is the server's, and it is the authored distance.
 *
 * Along the line from the attacker, so a negative distance pulls instead — which
 * is exactly how `PULL` is authored, at -100 through -300, and the only reading
 * under which those negatives mean anything.
 *
 * A pull stops where the bodies meet. `Trapper` names -300 and a monster is
 * seldom that far away when a hit lands; carried the whole distance it would
 * pass through the attacker and land behind him, which is not a pull.
 *
 * Over the time the throw is given, when it is given one: a monster the AI
 * walks is handed the push as a shove in flight (`slideShoved` in ai.js) and
 * covers it across the next ticks, the way the official's position frames do —
 * a `Blastback` victim reads 149 at +158ms and 230 at +408ms. One frame at
 * the far end is a teleport, and it looked like one. What the AI does not
 * walk, or a push with no duration, moves at once.
 *
 * The first frame goes out with the hit. Left to the tick alone the body stood
 * still for up to 250ms and then set off, which read as lag — the client
 * tweens toward each frame it is sent, so a frame it has not been sent is a
 * body that has not moved. Half the distance now, as the official's first
 * frame carries about that much; the tick carries the rest.
 *
 * Through navigation, so a monster is not shoved into a wall or out of the
 * floor. A push that ends where it started is still a push as far as the client
 * is concerned; it plays its own animation off the flag.
 */
export const NO_KNOCKBACK = Object.freeze({ distance: 0, durationMs: 0 });
/** The share of a timed throw sent with the hit itself. */
const FIRST_FRAME_SHARE = 0.5;

export const pushVictim = (session, victimDoid, attackerDoid, distance, durationMs = 0) => {
  if (!distance) return false;
  const victim = session.actors?.get(victimDoid);
  const attacker = session.actors?.get(attackerDoid);
  const from = attacker?.position ?? session.heroPosition;
  if (!victim?.position || !from) return false;
  const immunity = distance < 0 ? "PULL_IMMUNE" : "KNOCKBACK_IMMUNE";
  if (hasAbility(session, victimDoid, immunity)) return false;

  const dx = victim.position.x - from.x;
  const dy = victim.position.y - from.y;
  const span = Math.hypot(dx, dy);
  if (!(span > 0)) return false;

  const contact =
    Math.max(0, Number(victim.collisionRadius) || 0) +
    Math.max(0, Number(attacker?.collisionRadius) || 0);
  const carried = distance < 0 ? -Math.max(0, Math.min(-distance, span - contact)) : distance;
  if (!carried) return false;

  const wanted = {
    x: (dx / span) * carried,
    y: (dy / span) * carried,
  };
  const timed = Boolean(victim.ai) && durationMs > 0;
  const step = timed ? { x: wanted.x * FIRST_FRAME_SHARE, y: wanted.y * FIRST_FRAME_SHARE } : wanted;
  if (timed) {
    victim.ai.shove = { ...wanted, startedAt: Date.now(), durationMs, covered: FIRST_FRAME_SHARE };
  }
  const landed = moveWithNavigation(
    session.navigation,
    victim.position,
    step,
    Math.max(1, Number(victim.collisionRadius) || 1)
  );
  if (Math.hypot(landed.x - victim.position.x, landed.y - victim.position.y) < 0.5) {
    // Stopped at once, by a wall: nothing for the tick to carry either.
    if (timed) victim.ai.shove = null;
    return false;
  }

  victim.position.x = landed.x;
  victim.position.y = landed.y;
  session.send(npcPositionUpdate(victimDoid, victim.position));
  return true;
};

export const NO_STAGGER = Object.freeze({ suffer: 0, knockback: 0 });

/**
 * Whether a hit that landed makes its victim flinch, and whether it throws it.
 *
 * Two bytes the client proposes as zero and reads back as orders: it plays the
 * stagger or the knockback only when the result says so. The official decides
 * them the same way for a hero's hit and a monster's:
 *
 *   an attack that authors a `Knockback`   both, every time
 *   one that does not                      suffer alone, by its `SufferChance`
 *
 * KATANA_SOUL_BANG (chance 1, knockback 50) is 6583 of 6583 staggered;
 * KATANA_COMBO_2 (chance 0.1, knockback 15) is 170 of 170, so the chance is
 * not consulted where there is a knockback. LONG_BOW_SHOT (0.1, none) is 8%
 * of 109 and THROW_FAR_AXE_KN (0.15, none) 11% of 287.
 *
 * This set both whenever the row authored anything, which staggered a hero on
 * every thrown axe instead of one in nine.
 */
export const staggerFor = (attack, damage, random = Math.random) => {
  if (!(damage > 0)) return NO_STAGGER;
  if (Number(attack?.Knockback ?? 0) !== 0) return { suffer: 1, knockback: 1 };
  const chance = Number(attack?.SufferChance ?? attack?.StunChance ?? 0);
  return { suffer: chance > 0 && random() < chance ? 1 : 0, knockback: 0 };
};

/** The least a stagger shelters a hero from the next one. */
const MIN_STAGGER_GRACE_MS = 300;

/**
 * The same, for a hit on a hero — who is not staggered twice in a row.
 *
 * Sorted by the time since the hero last staggered, the official's 684
 * knockback hits by monsters carry the flags 1% of the time within 0.3s, 31%
 * up to 0.7s, 83% up to 2s and on every one of the 345 after that. That is a
 * pack swinging together — the first blow throws the hero and the rest land on
 * a hero already thrown.
 *
 * The shelter is taken to last as long as the blow that gave it says the hero
 * reels: its `HitStunDur` and `KnockbackDur`, up to 1.2s for a tackle, which
 * fits that curve. A buff that makes its bearer `SUFFER_IMMUNE` — the
 * Berserker's rage is the one — shelters outright.
 *
 * For a monster's own attack. The floor's traps keep the rule that was
 * measured on them — see `trapStaggerFor`. Heroes only; on a monster the
 * official staggers near enough every hit.
 */
export const heroStaggerFor = (session, attack, damage, victimDoid, random = Math.random) => {
  const stagger = staggerFor(attack, damage, random);
  if (!stagger.suffer) return stagger;
  if (session.objects?.get(victimDoid) !== CLID.HeroGameObject) return stagger;
  if (hasAbility(session, victimDoid, "SUFFER_IMMUNE")) return NO_STAGGER;

  session.heroStaggeredUntil ??= new Map();
  const now = Date.now();
  if (now < (session.heroStaggeredUntil.get(victimDoid) ?? 0)) return NO_STAGGER;
  const reels = (Number(attack?.HitStunDur ?? 0) + Number(attack?.KnockbackDur ?? 0)) * 1000;
  session.heroStaggeredUntil.set(victimDoid, now + Math.max(MIN_STAGGER_GRACE_MS, reels));
  return stagger;
};

/**
 * How soon after one trap hit the hero shrugs off the next one's stagger.
 *
 * The official's 332 damaging `TRAP_SPIKES` hits on heroes, sorted by the time
 * since that hero's previous trap hit: within 0.3s only 15% of 95 carry suffer
 * and knockback; 0.3 to 0.7s, 81%; after that 81 to 88%. It is the beds of a
 * row biting together — the first throws the hero, the rest land on a hero
 * already thrown.
 *
 * The same holds for every floor trap the corpus has — mace 0% against 94%,
 * blade 25% against 89%, arrows 0% against 97% — so it is the rule for the
 * floor's traps, not for spikes. Heroes only, because that is what was
 * measured; on monsters the official staggers near enough every hit.
 *
 * And the floor's named traps only, on their own clock. This was folded into
 * `heroStaggerFor` once, which measures from the hero's last stagger and for as
 * long as that blow says he reels: the slicers, whose attack is not a `TRAP_`
 * and whose every recorded hit throws the hero, dropped to 29% and the trap
 * conformance report said so. What was measured for traps stays as measured.
 */
const TRAP_STAGGER_GRACE_MS = 300;

export const trapStaggerFor = (session, attack, damage, victimDoid) => {
  const stagger = staggerFor(attack, damage, session.random ?? Math.random);
  if (session.objects?.get(victimDoid) !== CLID.HeroGameObject || damage <= 0) return stagger;
  if (!/^TRAP_/.test(String(attack?.Constant ?? ""))) return stagger;
  session.lastTrapHitAt ??= new Map();
  const now = Date.now();
  const previous = session.lastTrapHitAt.get(victimDoid);
  session.lastTrapHitAt.set(victimDoid, now);
  return previous !== undefined && now - previous < TRAP_STAGGER_GRACE_MS
    ? NO_STAGGER
    : stagger;
};
