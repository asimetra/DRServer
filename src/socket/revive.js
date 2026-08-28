import { info, warn } from "../log.js";
import { CLID, OP } from "./opcodes.js";
import { PacketWriter } from "./packet.js";
import {
  heroStateAndChoreography,
  hitPointsUpdate,
  noteBombCast,
  stateUpdate,
} from "./combat.js";
import { attackForConstant } from "../gamemaster.js";
import { grantBuff } from "./buffs.js";
import { cancelFloorFailing } from "./floorstate.js";
import { heroManaPointsUpdate, queueAccountSave } from "./rewards.js";
import { loadAccount } from "../accounts.js";
import { heroMembersOf, memberForHero } from "./match-world.js";
import { RULE, noteViolation } from "./security-events.js";

export const FLID_PROPOSE_REVIVE = 173;
export const FLID_PROPOSE_SELF_REVIVE = 174;

const ALLY_REVIVE_ATTACK_IDS = new Set([910900, 910901]);
const ALLY_REVIVE_WINDOW_MS = 5000;
// HeroReviveSensor is authored at 100. The extra 25 covers the normal gap
// between the two clients' last accepted position samples without allowing a
// rescue from another part of the room.
const ALLY_REVIVE_RANGE = 125;

export const isAllyReviveAttack = (attack) =>
  ALLY_REVIVE_ATTACK_IDS.has(Number(attack?.Id));

/** Records the targeted revive choreography that must precede field 173. */
export const noteAllyReviveAttempt = (
  session,
  attack,
  targetDoid,
  now = Date.now()
) => {
  if (!isAllyReviveAttack(attack) || targetDoid === session.heroDoid) return false;
  const targetMember = memberForHero(session, targetDoid);
  const target = session.actors?.get(targetDoid);
  const reviver = session.actors?.get(session.heroDoid);
  if (!targetMember || !target?.dead || !reviver || reviver.dead) return false;
  session.allyReviveAttempt = {
    targetDoid,
    attackId: Number(attack.Id),
    at: now,
  };
  return true;
};

const FLID = {
  healthBombsUsed: 154,
  partyBombsUsed: 155,
  response: 175,
  partyBomb: 176,
  setStateAndAttackChoreography: 178,
};

/**
 * The bomb going off.
 *
 * Neither bomb is only a revive: both are authored attacks — `HEALTH_BOMB_ATTACK`
 * and `PARTY_BOMB_ATTACK` — with a `Range` of 400, knockback of 140 and 250, and
 * a `SelfBuff` of INVULNERBILITY. Nothing here played them, so the hero simply
 * stood back up in silence.
 *
 * Both captured revives carry it on hero field 178, which is state and
 * choreography in one message: an empty state, the attack, and no combat
 * results at all. The damage is not in this packet and is not meant to be — a
 * hero's hits are proposed by the client and priced here like any other, which
 * is the same split every other hero attack uses.
 */
const BOMB_ATTACK = { health: "HEALTH_BOMB_ATTACK", party: "PARTY_BOMB_ATTACK" };
const HEALTH_BOMB_REVIVE_SHARE = 0.4;

/**
 * `HeroGameObject::PartyBomb(u32)` — who set it off.
 *
 * Sent only for the party bomb, and only carrying a hero doid: the client looks
 * that hero up and puts "<name> BOMB_DROPPER" on the floor for everyone. Solo it
 * names the player themselves, which is what the capture shows.
 */
const partyBombNotice = (heroDoid) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(heroDoid)
    .u16(FLID.partyBomb)
    .u32(heroDoid)
    .frame();

const selfReviveResponse = (heroDoid, success, reviveAll) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(heroDoid)
    .u16(FLID.response)
    .u8(success ? 1 : 0)
    .u8(reviveAll ? 1 : 0)
    .frame();

const bombUsageUpdate = (heroDoid, fieldId, uses) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(heroDoid)
    .u16(fieldId)
    .u8(uses)
    .frame();

/** Stackables, the two the revive screen offers. */
const BOMB_STACK_ID = { health: 60001, party: 60018 };

/**
 * Resolves HeroGameObjectOwner.ProposeRevive (field 173).
 *
 * The client sends this only at the end of ATTEMPT_REVIVE_LONG/INSTANT. The
 * choreography names the same target at its start, so the proposal is accepted
 * only when that exact attempt is still live, both heroes are still in the same
 * world, and they are still standing inside the revive sensor's range.
 */
export const handleProposeRevive = (session, reader, now = Date.now()) => {
  const targetDoid = reader.u32();
  const attempt = session.allyReviveAttempt;
  session.allyReviveAttempt = null;

  if (
    !attempt ||
    attempt.targetDoid !== targetDoid ||
    now - attempt.at < 0 ||
    now - attempt.at > ALLY_REVIVE_WINDOW_MS
  ) {
    noteViolation(
      session,
      RULE.reviveWithoutAttempt,
      `field 173 target ${targetDoid} has no live matching choreography`
    );
    return true;
  }

  const targetMember = memberForHero(session, targetDoid);
  const target = session.actors?.get(targetDoid);
  const reviver = session.actors?.get(session.heroDoid);
  if (
    !targetMember ||
    session.objects?.get(targetDoid) !== CLID.HeroGameObject ||
    !target?.dead ||
    !target.maxHitPoints ||
    !reviver ||
    reviver.dead
  ) {
    noteViolation(session, RULE.reviveWithoutAttempt, `invalid revive target ${targetDoid}`);
    return true;
  }

  const from = reviver.position ?? session.heroPosition;
  const at = target.position ?? targetMember.heroPosition;
  const distance = from && at ? Math.hypot(at.x - from.x, at.y - from.y) : Infinity;
  if (distance > ALLY_REVIVE_RANGE) {
    noteViolation(
      session,
      RULE.reviveOutOfReach,
      `target ${targetDoid} is ${Math.round(distance)} units away`
    );
    return true;
  }

  target.hitPoints = target.maxHitPoints;
  target.dead = false;
  session.send(hitPointsUpdate(targetDoid, CLID.HeroGameObject, target.hitPoints));
  session.send(stateUpdate(targetDoid, CLID.HeroGameObject, ""));
  (session.cancelFloorFailing ?? cancelFloorFailing)(session);
  info(
    `[${session.id}] hero ${session.heroDoid} rescued ${targetDoid} ` +
      `(${target.hitPoints}/${target.maxHitPoints}hp)`
  );
  return true;
};

/**
 * Charges the account for the bomb the revive just used.
 *
 * A capture settles that the stock really is spent, and that nothing on the
 * wire says so: across a run with two revives the account went HEALTH_BOMB
 * 37 → 36 and PARTY_BOMB 3 → 2, while the only thing sent was the per-run
 * *used* counter and not one RPC was made between entering and returning to
 * town. So the client is told how many it has spent this run and finds out what
 * it still owns when the town reloads the account.
 *
 * That is also why running out has to be refused here. The client asks and
 * keeps its own count, so nothing else can say no, and a hero with an empty
 * stock could otherwise get back up for free as often as it liked. What the
 * official server answers in that case is not in any capture — the recorded
 * account had thirty-seven — so refusing is this server's own reading of who
 * owns the inventory.
 */
const stackRow = (account, stackId) =>
  account?.account_stackables?.find((row) => Number(row.stack_id) === stackId);

/**
 * Picks up a bomb bought while the hero was lying there.
 *
 * `dungeonAccount` is a snapshot taken at entry, and a purchase goes through
 * the RPC layer against its own freshly loaded copy — so buying from the revive
 * screen is invisible here, and the player pays for a button that then does
 * nothing. Re-read only when about to refuse: the ordinary revive still costs
 * no I/O, and only the stackables are taken across, because the rest of the
 * snapshot holds this run's own unsaved rewards.
 */
const refreshStackables = async (session) => {
  const id = session.dungeonAccount?.id ?? session.accountId;
  if (!id || !session.dungeonAccount) return;
  const fresh = await loadAccount(id);
  if (fresh?.account_stackables) {
    session.dungeonAccount.account_stackables = fresh.account_stackables;
  }
};

const spendBomb = async (session, reviveAll) => {
  const stackId = reviveAll ? BOMB_STACK_ID.party : BOMB_STACK_ID.health;
  let stock = stackRow(session.dungeonAccount, stackId);
  if (!stock || (stock.count ?? 0) <= 0) {
    await refreshStackables(session);
    stock = stackRow(session.dungeonAccount, stackId);
  }
  if (!stock || (stock.count ?? 0) <= 0) return false;

  stock.count -= 1;
  session.queueAccountSave?.(session) ?? queueAccountSave(session);
  return true;
};

/**
 * Plays the bomb and leaves what it authors.
 *
 * The order is the captured one: the choreography, then the buff it names. The
 * `SelfBuff` is not invented here — both attacks author INVULNERBILITY, five
 * seconds of INVULNERABLE_ALL, and the capture generates exactly that buff (id
 * 35081) against the reviving hero straight after the choreography.
 */
const detonate = async (session, reviveAll) => {
  const attack = await attackForConstant(reviveAll ? BOMB_ATTACK.party : BOMB_ATTACK.health);
  if (!attack) return;

  // Party Bomb is drawn on every party hero, not only on the character that
  // spent it. Field 178 belongs to the shared Hero class, so publishing one
  // choreography per hero makes every client play every character's blast.
  const animatedHeroes = reviveAll
    ? [...heroMembersOf(session).keys()].filter((doid) => session.objects?.has(doid))
    : [session.heroDoid];
  for (const doid of animatedHeroes) {
    session.send(heroStateAndChoreography({ doid, attackType: attack.Id }));
  }
  if (attack.SelfBuff) {
    await grantBuff(session, attack.SelfBuff, { affectedActor: session.heroDoid });
  }
};

/**
 * Resolves HeroGameObjectOwner.ProposeSelfRevive.
 *
 * A bomb is spendable while the hero is down and, per the player who owns these,
 * while it is already up — in which case it tops the health bar back up instead
 * of raising anyone, and still goes off. That second case is not in any capture,
 * where both uses were from the revive screen; it is reported behaviour, and it
 * costs a bomb either way, which is what keeps it from being a free heal.
 *
 * What the account holds decides the rest: no bomb, no revive.
 */
export const handleProposeSelfRevive = async (session, reader) => {
  const reviveAll = reader.u8() !== 0;
  const hero = session.actors?.get(session.heroDoid);
  const usable = Boolean(hero && hero.maxHitPoints > 0);
  const success = usable && (await spendBomb(session, reviveAll));
  if (usable && !success) {
    warn(`[${session.id}] revive refused: no ${reviveAll ? "party" : "health"} bomb left`);
  }

  // Whoever set it off is named to the whole floor before anything else.
  if (success && reviveAll) session.send(partyBombNotice(session.heroDoid));
  const sendOwner = session.sendDirect ?? session.send.bind(session);
  sendOwner(selfReviveResponse(session.heroDoid, success, reviveAll));
  if (!success) return true;

  const usageKey = reviveAll ? "partyBombsUsed" : "healthBombsUsed";
  const usageField = reviveAll ? FLID.partyBombsUsed : FLID.healthBombsUsed;
  hero[usageKey] = Math.min(255, (hero[usageKey] ?? 0) + 1);

  session.send(bombUsageUpdate(session.heroDoid, usageField, hero[usageKey]));
  /**
   * This is the bomb's cast. It sends no choreography of its own, which is why
   * its attack is exempt from the cast rule — but the exemption was
   * unconditional, so its damage was accepted whatever had happened. The bomb
   * itself was already paid for a few lines above; what this adds is that the
   * damage now belongs to a revive that really took place.
   */
  noteBombCast(session, reviveAll);
  await detonate(session, reviveAll);
  const targets = reviveAll
    ? [...heroMembersOf(session)]
    : [[session.heroDoid, session.member ?? session]];
  let revived = 0;
  for (const [doid, member] of targets) {
    const actor = session.actors?.get(doid);
    if (!actor?.maxHitPoints) continue;
    const wasDead = Boolean(actor.dead);
    if (wasDead) revived++;
    const healthBombRevive = !reviveAll && doid === session.heroDoid && wasDead;
    actor.hitPoints = healthBombRevive
      ? Math.max(1, Math.round(actor.maxHitPoints * HEALTH_BOMB_REVIVE_SHARE))
      : actor.maxHitPoints;
    actor.dead = false;
    const target = member.world?.contextFor(member) ?? member;
    target.send(hitPointsUpdate(doid, CLID.HeroGameObject, actor.hitPoints));
    if (healthBombRevive && target.maxHeroManaPoints > 0) {
      target.heroManaPoints = Math.max(
        0,
        Math.round(target.maxHeroManaPoints * HEALTH_BOMB_REVIVE_SHARE)
      );
      target.send(heroManaPointsUpdate(doid, target.heroManaPoints));
    }
    target.send(stateUpdate(doid, CLID.HeroGameObject, ""));
  }
  // Back on his feet inside the window, so the floor stops failing.
  (session.cancelFloorFailing ?? cancelFloorFailing)(session);
  info(
    `[${session.id}] ${reviveAll ? `${revived} hero(es)` : "hero"} revived with ` +
      `${reviveAll ? "party" : "health"} bomb (${hero.hitPoints}/${hero.maxHitPoints}hp)`
  );
  return true;
};
