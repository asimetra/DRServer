import test from "node:test";
import assert from "node:assert/strict";

/**
 * A healing wave, as the official server actually delivers one.
 *
 * Two things had to be measured to get this right, and the first attempt got
 * the second one wrong.
 *
 * `DamageMod` is signed, and its sign is the whole rule. The client reads
 * nothing else — `ActorGameObject.ReceiveCombatResult` picks `receiveHeal` over
 * `receiveDamage` on `DamageMod > 0` — and the table agrees: all 452 HOSTILE
 * rows carrying one are negative, 280 of them exactly -1, and the eleven
 * positive rows are FRIENDLY and all heal.
 *
 * And a heal is *not proposed*. Of 7214 attack choreographies in the
 * recordings exactly two name a healing attack, and neither is followed by a
 * ProposeCombatResults — yet 25 healing results come back. The client asks to
 * cast; the server decides who is healed and for how much. One cast, from
 * `socket-20260816-145437`:
 *
 *     14:55:56.874  out  choreography   HEALING_PULSE_COOLDOWN, slot 2
 *     14:55:57.048  in   hit points     304 -> 420
 *     14:55:57.049  in   combat result  +282, when 255
 */

const HEALING_PULSE_COOLDOWN = 900082; // the Heal Scroll's cast
const RESULT_BYTES = 37;

/**
 * A party of two on one floor, the caster carrying a Heal Scroll in slot 2.
 *
 * A real `MatchWorld`, because who a wave reaches is read through
 * `heroMembersOf` — and a hand-built session without one falls back to the
 * caster alone, which is the shape of the bug rather than a test of it.
 */
const woundedParty = async () => {
  const { CLID } = await import("../src/socket/opcodes.js");
  const { createMatchWorld } = await import("../src/socket/match-world.js");
  const sent = [];

  const memberFor = (heroDoid) => ({
    id: heroDoid,
    accountId: heroDoid,
    heroDoid,
    dungeonZone: 10,
    heroManaPoints: 200,
    maxHeroManaPoints: 200,
    allocateDoid: () => 900 + heroDoid,
    send: (bytes) => sent.push(bytes),
  });
  const host = memberFor(500);
  const peer = memberFor(501);
  const world = createMatchWorld({ id: 9, members: new Set([host, peer]) }, host);
  world.contextFor(peer); // a member is not live on the floor until it has one

  world.objects = new Map([
    [500, CLID.HeroGameObject],
    [501, CLID.HeroGameObject],
    [700, CLID.DistributedNPCGameObject],
  ]);
  world.actors = new Map([
    [500, { hitPoints: 100, maxHitPoints: 1000, team: 1 }],
    [501, { hitPoints: 100, maxHitPoints: 1000, team: 1 }],
    [700, { hitPoints: 900, maxHitPoints: 900, constant: "KNIGHT_TUTORIAL", isEnemy: true, team: 2 }],
  ]);

  const session = {
    id: 94,
    member: host,
    world,
    heroDoid: 500,
    floorDoid: 400,
    heroManaPoints: 200,
    maxHeroManaPoints: 200,
    heroWeapons: [null, null, { power: 120, constant: "HERO_SCROLL_HEAL" }],
    objects: world.objects,
    actors: world.actors,
    send: (bytes) => sent.push(bytes),
  };
  return { sent, session };
};

const cast = async (session, attackType = HEALING_PULSE_COOLDOWN) => {
  const { healFriendlyTargets } = await import("../src/socket/combat.js");
  const { attackById } = await import("../src/gamemaster.js");
  return healFriendlyTargets(session, await attackById(attackType), 2);
};

/**
 * The number the client draws, dug out of the frame that carried it. A
 * CombatResult opens with `u32 attacker, u32 attackee, i32 damage`, so the pair
 * locates the record and the sign sits eight bytes in.
 */
const resultFor = (sent, attacker, attackee) => {
  const wanted = Buffer.alloc(8);
  wanted.writeUInt32LE(attacker, 0);
  wanted.writeUInt32LE(attackee, 4);
  for (const frame of sent) {
    const buf = Buffer.from(frame);
    const at = buf.indexOf(wanted);
    if (at >= 0 && buf.length >= at + RESULT_BYTES) {
      return { damage: buf.readInt32LE(at + 8), when: buf.readUInt8(at + 22) };
    }
  }
  return null;
};

test("a heal scroll cast on yourself gives hit points back", async () => {
  const { session } = await woundedParty();

  await cast(session);

  const hero = session.actors.get(500);
  assert.ok(hero.hitPoints > 100, `AffectsSelf is 1, so the caster heals — got ${hero.hitPoints}`);
  assert.ok(hero.hitPoints <= hero.maxHitPoints, "and never past the top of the bar");
});

test("a heal scroll heals the ally standing in it, not only the caster", async () => {
  const { session } = await woundedParty();

  await cast(session);

  assert.ok(session.actors.get(501).hitPoints > 100, "AffectsOthers is 1 as well");
});

test("healing never carries a hero past maximum", async () => {
  const { session } = await woundedParty();
  session.actors.get(500).hitPoints = 999;

  await cast(session);

  assert.equal(session.actors.get(500).hitPoints, 1000, "clamped to the bar, not over it");
});

test("a downed hero is not healed back up by a passing wave", async () => {
  const { session } = await woundedParty();
  Object.assign(session.actors.get(500), { hitPoints: 0, dead: true });

  await cast(session);

  assert.equal(session.actors.get(500).hitPoints, 0, "getting up is a revive's job, not a heal's");
});

/**
 * The sign is the client's only way to read the magnitude: `spawnHealFloater`
 * prints this field straight out, so a heal sent negative is drawn as a heal of
 * minus two hundred and eighty-two.
 */
test("a heal goes down the wire positive, marked as the server's own", async () => {
  const { session, sent } = await woundedParty();

  await cast(session);

  const own = resultFor(sent, 500, 500);
  assert.ok(own, "the caster gets a combat result");
  assert.ok(own.damage > 0, `positive on the wire — got ${own.damage}`);
  assert.equal(own.when, 255, "255 is what the official writes when nothing proposed it");
});

/**
 * 304 + 282 against a 420 bar is 586, and the recording still reports 282. The
 * result carries what was computed, not the part that fit.
 */
test("the reported heal is the whole amount, not the part that fit", async () => {
  const { session, sent } = await woundedParty();
  session.actors.get(500).hitPoints = 990; // ten points of room, on a 1000 bar

  await cast(session);

  const own = resultFor(sent, 500, 500);
  assert.ok(own.damage > 10, `reports the computed heal, not the 10 applied — got ${own.damage}`);
  assert.equal(session.actors.get(500).hitPoints, 1000);
});

test("a hostile attack is not routed into the healing path", async () => {
  const { session } = await woundedParty();

  const fanned = await cast(session, 901104); // a fireball: DamageMod negative

  assert.equal(fanned, null, "nothing friendly happens for an attack that hurts");
  assert.equal(session.actors.get(500).hitPoints, 100, "and the caster is not healed by it");
});

/**
 * The whole way through, from the packet the client actually sends.
 *
 * The tests above call the fan-out directly, which would still pass if every
 * guard in the choreography handler refused the cast — and a heal refused for
 * want of Mana or a cooldown is exactly as broken as one never computed. This
 * drives the same field-172 message the recording shows.
 */
test("casting the scroll heals through the choreography handler, paying its Mana", async () => {
  const { session } = await woundedParty();
  const { handleProposeAttackChoreography } = await import("../src/socket/buster.js");
  const { PacketWriter, PacketReader } = await import("../src/socket/packet.js");

  // HERO_SCROLL_HEAL in slot 2, which is the slot both recorded casts name.
  session.heroWeapons = [null, null, { type: 24003, power: 120 }];

  const proposal = new PacketWriter()
    .u8(2) // weaponSlot
    .u8(0) // isConsumableWeapon
    .u32(HEALING_PULSE_COOLDOWN)
    .u32(0) // targetActorDoid
    .u8(0) // loop
    .f32(1) // playSpeed
    .f32(1) // scalingMaxProjectiles
    .body();

  await handleProposeAttackChoreography(session, new PacketReader(proposal));

  assert.equal(session.heroManaPoints, 160, "the authored 40 Mana is spent");
  assert.ok(session.actors.get(500).hitPoints > 100, "and the caster is healed");
  assert.ok(session.actors.get(501).hitPoints > 100, "along with the ally");
});

/**
 * A drink is paid out by `useConsumable` as a share of the bar before this
 * runs, so pricing it here too would heal the drinker twice.
 */
test("a health potion is not healed a second time by the combat path", async () => {
  const { session } = await woundedParty();

  // CONSUMABLE_HEALTH_SHOT_ATTACK: DamageMod +1, but DoPercentHealthDamage 0.25
  const fanned = await cast(session, 910515);

  assert.equal(fanned, null, "the percent heal belongs to the consumable path");
  assert.equal(session.actors.get(500).hitPoints, 100);
});
