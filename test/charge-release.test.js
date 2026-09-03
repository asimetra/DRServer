import test from "node:test";
import assert from "node:assert/strict";
import { handleProposeAttackChoreography } from "../src/socket/buster.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";
import { CLID } from "../src/socket/opcodes.js";

/**
 * A charge release lands its hits from inside its own choreography.
 *
 * Muramasa — `HERO_REGULAR_KATANA`, a `CHARGE_UP` weapon whose `ChargeAttack` is
 * `KATANA_SOUL_BANG` — played its animation, spent its 25 Mana, had its cast
 * recorded, and left every enemy on full health. The hits were in the packet the
 * whole time: the collider resolves on the first frame, so the client writes its
 * victims into the tail of the choreography rather than proposing them a moment
 * later, and the handler read the header and stopped.
 *
 * Measured on the wire: field 172 carries a non-empty result list on 1521 casts
 * across the recordings, 7620 of those hits belonging to `KATANA_SOUL_BANG` and
 * as many as 22 to a single swing.
 */

const SOUL_BANG = 902509; // KATANA_SOUL_BANG, the katana's ChargeAttack
const KATANA = 12502; // HERO_REGULAR_KATANA
const HERO = 500;

const sessionWith = (overrides = {}) => {
  let nextDoid = 900;
  const sent = [];
  return {
    id: 42,
    heroDoid: HERO,
    floorDoid: 400,
    dungeonActive: true,
    heroPosition: { x: 1000, y: 1000 },
    heroHeading: 0,
    heroManaPoints: 100,
    maxHeroManaPoints: 100,
    dungeonBusterPoints: 0,
    dungeonAvatar: { avatar_id: 104, experience: 0 },
    heroWeapons: [{ type: KATANA, power: 9 }],
    objects: new Map(),
    actors: new Map(),
    allocateDoid: () => ++nextDoid,
    sent,
    send: (packet) => sent.push(packet),
    ...overrides,
  };
};

/** One CombatResult, in the fixed 37-byte shape readProposals expects. */
const result = ({ attacker = HERO, attackee, attackType = SOUL_BANG, weaponSlot = 0 }) =>
  new PacketWriter()
    .u32(attacker)
    .u32(attackee)
    .u32(0) // damage — the server fills this in
    .u8(weaponSlot)
    .u8(0) // isConsumableWeapon
    .u32(attackType)
    .u32(attackee) // attack.targetActorDoid
    .u8(0) // when
    .u8(0) // suffer
    .u8(0) // knockback
    .u8(0) // blocked
    .u8(0) // criticalHit
    .u8(0) // effectiveness
    .u32(0) // selfDamage
    .u32(0) // scalingMaxPowerMultiplier
    .u8(0) // generation
    .body();

/** A Soul Bang cast with its victims written into the tail, as the client sends it. */
const soulBang = (victims, { attackType = SOUL_BANG, weaponSlot = 0 } = {}) => {
  const results = Buffer.concat(
    victims.map((attackee) => result({ attackee, attackType, weaponSlot }))
  );
  return new PacketWriter()
    .u8(0) // weaponSlot
    .u8(0) // isConsumableWeapon
    .u32(SOUL_BANG)
    .u32(victims[0] ?? 0) // targetActorDoid
    .u8(0) // choreography.loop
    .f32(1) // playSpeed
    .f32(1) // scalingMaxProjectiles
    .u16(results.length)
    .raw(results)
    .body();
};

const withEnemies = (session, count, hitPoints = 5000) => {
  const doids = [];
  for (let index = 0; index < count; index += 1) {
    const doid = 9900 + index;
    doids.push(doid);
    session.objects.set(doid, CLID.DistributedNPCGameObject);
    session.actors.set(doid, {
      hitPoints,
      maxHitPoints: hitPoints,
      collisionRadius: 25,
      constant: "BRUTE",
      isEnemy: true,
      position: { x: 1050, y: 1000 },
    });
  }
  return doids;
};

test("a charge release damages what its choreography says it hit", async () => {
  const session = sessionWith();
  const [enemy] = withEnemies(session, 1);

  await handleProposeAttackChoreography(session, new PacketReader(soulBang([enemy])));

  assert.equal(session.heroManaPoints, 75, "the authored 25 Mana is spent");
  const actor = session.actors.get(enemy);
  assert.ok(
    actor.hitPoints < 5000,
    `the enemy is still on ${actor.hitPoints}/5000 — the embedded hit was dropped`
  );
});

test("every victim in the list is hit, not only the first", async () => {
  const session = sessionWith();
  const enemies = withEnemies(session, 5);

  await handleProposeAttackChoreography(session, new PacketReader(soulBang(enemies)));

  for (const doid of enemies) {
    assert.ok(
      session.actors.get(doid).hitPoints < 5000,
      `enemy ${doid} took nothing`
    );
  }
});

test("a swing that catches twenty-two is not refused for its size", async () => {
  /**
   * The most a recorded Soul Bang has ever caught, and eight times what the
   * separate-packet limit allows. A crowd is what the weapon is for.
   */
  const session = sessionWith();
  const enemies = withEnemies(session, 22);

  await handleProposeAttackChoreography(session, new PacketReader(soulBang(enemies)));

  const hurt = enemies.filter((doid) => session.actors.get(doid).hitPoints < 5000);
  assert.equal(hurt.length, 22, `only ${hurt.length} of 22 were hit`);
});

test("a choreography carrying no hits still works as before", async () => {
  const session = sessionWith();
  const [enemy] = withEnemies(session, 1);

  await handleProposeAttackChoreography(session, new PacketReader(soulBang([])));

  assert.equal(session.heroManaPoints, 75, "the cast was still paid for");
  assert.equal(session.actors.get(enemy).hitPoints, 5000, "and nothing was hurt");
});

test("an embedded result naming another attack is refused", async () => {
  /**
   * All 7264 recorded records repeat the outer attack and slot exactly. One that
   * does not is a hit this choreography cannot vouch for — the cast that was
   * paid for is not the cast being claimed.
   */
  const session = sessionWith();
  const [enemy] = withEnemies(session, 1);

  const forged = soulBang([enemy], { attackType: 902508 }); // KATANA_SHADOW_SLASH
  await handleProposeAttackChoreography(session, new PacketReader(forged));

  assert.equal(
    session.actors.get(enemy).hitPoints,
    5000,
    "a result for a different attack was applied anyway"
  );
});

test("an embedded result naming another attacker is refused", async () => {
  const session = sessionWith();
  const [enemy] = withEnemies(session, 1);

  const results = result({ attacker: 601, attackee: enemy });
  const forged = new PacketWriter()
    .u8(0).u8(0).u32(SOUL_BANG).u32(enemy).u8(0).f32(1).f32(1)
    .u16(results.length).raw(results)
    .body();
  await handleProposeAttackChoreography(session, new PacketReader(forged));

  assert.equal(
    session.actors.get(enemy).hitPoints,
    5000,
    "a result attributed to someone else was applied anyway"
  );
});
