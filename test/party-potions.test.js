import test from "node:test";
import assert from "node:assert/strict";

/**
 * The two consumables that give a resource back to the whole party.
 *
 * Of the 29 usage attacks behind the game's stackables, 17 carry
 * `AffectsOthers`. Fifteen of those hand out a buff and already reach the
 * party through `buffFriendlyTarget`, or are bombs that reach it as ordinary
 * hostile attacks. Exactly two restore something instead, and both were
 * restoring it to the drinker alone:
 *
 *   910501  CONSUMABLE_HEALTH_POTION_PARTY_ATTACK   DoPercentHealthDamage, 1
 *   910503  CONSUMABLE_MANA_POTION_PARTY_ATTACK     ManaCost -999
 *
 * The two halves travel differently, and that is the whole reason this needed
 * care. `actors` is a shared field on a MatchWorld, so an ally's hit points are
 * the caster's session to change and the update broadcasts. `heroManaPoints` is
 * not shared — it lives on each member — so mana has to be handed to the member
 * itself or it silently tops up the drinker again.
 */

const HEALTH_PARTY = 70001; // -> CONSUMABLE_HEALTH_POTION_PARTY_ATTACK
const MANA_PARTY = 70003; // -> CONSUMABLE_MANA_POTION_PARTY_ATTACK
const HEALTH_SELF = 70000; // -> CONSUMABLE_HEALTH_POTION_ATTACK, AffectsOthers 0

/** A party of two on one floor, both hurt and both out of Mana. */
const thirstyParty = async () => {
  const { CLID } = await import("../src/socket/opcodes.js");
  const { createMatchWorld } = await import("../src/socket/match-world.js");
  const sent = [];

  const memberFor = (heroDoid) => ({
    id: heroDoid,
    accountId: heroDoid,
    heroDoid,
    dungeonZone: 10,
    heroManaPoints: 10,
    maxHeroManaPoints: 200,
    allocateDoid: () => 900 + heroDoid,
    send: (bytes) => sent.push(bytes),
  });
  const host = memberFor(500);
  const peer = memberFor(501);
  const world = createMatchWorld({ id: 9, members: new Set([host, peer]) }, host);
  world.contextFor(peer); // not live on the floor until it has a context

  world.objects = new Map([
    [500, CLID.HeroGameObject],
    [501, CLID.HeroGameObject],
  ]);
  world.actors = new Map([
    [500, { hitPoints: 100, maxHitPoints: 1000, team: 1 }],
    [501, { hitPoints: 100, maxHitPoints: 1000, team: 1 }],
  ]);

  const session = {
    id: 95,
    member: host,
    world,
    heroDoid: 500,
    floorDoid: 400,
    heroManaPoints: 10,
    maxHeroManaPoints: 200,
    objects: world.objects,
    actors: world.actors,
    send: (bytes) => sent.push(bytes),
  };
  return { sent, session, host, peer };
};

/**
 * Drinks whatever is in powerup slot 0, through the real field-172 handler.
 *
 * The usage attack is looked up from the stackable rather than hard-coded,
 * because that pairing is exactly what `useConsumable` checks before it will
 * spend anything.
 */
const drink = async (session, stackableId) => {
  const { handleProposeAttackChoreography } = await import("../src/socket/buster.js");
  const { PacketWriter, PacketReader } = await import("../src/socket/packet.js");
  const { stackableById, loadGameMaster } = await import("../src/gamemaster.js");

  session.heroConsumables = [{ type: stackableId, count: 3 }, null];
  const stackable = await stackableById(stackableId);
  const gm = await loadGameMaster();
  const usage = Object.values(gm.raw.Attack).find(
    (row) => row.Constant === stackable.UsageAttack
  );

  const proposal = new PacketWriter()
    .u8(0) // powerup slot 0
    .u8(1) // isConsumableWeapon
    .u32(usage.Id)
    .u32(0) // targetActorDoid
    .u8(0) // loop
    .f32(1) // playSpeed
    .f32(1) // scalingMaxProjectiles
    .body();
  await handleProposeAttackChoreography(session, new PacketReader(proposal));
};

test("a party health potion heals the ally as well as the drinker", async () => {
  const { session } = await thirstyParty();

  await drink(session, HEALTH_PARTY);

  assert.ok(session.actors.get(500).hitPoints > 100, "the drinker is healed");
  assert.ok(
    session.actors.get(501).hitPoints > 100,
    "AffectsOthers is 1, so the ally is healed too"
  );
});

test("a party mana potion fills the ally's bar, not the drinker's twice", async () => {
  const { session, host, peer } = await thirstyParty();

  await drink(session, MANA_PARTY);

  assert.ok(host.heroManaPoints > 10, "the drinker gets Mana back");
  assert.ok(
    peer.heroManaPoints > 10,
    "and so does the ally — heroManaPoints is per-member, not shared"
  );
});

test("a single-target health potion still heals only the drinker", async () => {
  const { session } = await thirstyParty();

  await drink(session, HEALTH_SELF);

  assert.ok(session.actors.get(500).hitPoints > 100, "the drinker is healed");
  assert.equal(
    session.actors.get(501).hitPoints,
    100,
    "AffectsOthers is 0 on the plain potion, so nobody else is"
  );
});

test("a downed ally is not brought back up by a party potion", async () => {
  const { session } = await thirstyParty();
  Object.assign(session.actors.get(501), { hitPoints: 0, dead: true });

  await drink(session, HEALTH_PARTY);

  assert.equal(
    session.actors.get(501).hitPoints,
    0,
    "getting up is a revive's job, as it is for a healing wave"
  );
});
