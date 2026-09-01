import test from "node:test";
import assert from "node:assert/strict";

/**
 * A friendly attack heals, and the whole rule is the sign of `DamageMod`.
 *
 * The client picks the floater from the attack row and nothing else:
 *
 *     if(_loc2_.DamageMod > 0) actorView.receiveHeal(...)
 *     else if(blocked == 0)    actorView.receiveDamage(...)
 *
 * — ActorGameObject.ReceiveCombatResult. The table agrees, unanimously: of the
 * 452 HOSTILE attacks that carry a `DamageMod` every one is negative, 280 of
 * them exactly -1, and not one is positive. The eleven positive rows are all
 * FRIENDLY and all of them heal.
 *
 * So `netAttackDamage` is signed on purpose and always has been; combat.js was
 * throwing the positive half away with `if (signed >= 0) return 0`.
 */

const HEALING_PULSE_COOLDOWN = 900082; // the Heal Scroll's cast, DamageMod +1
const FIREBALL = 901104; // HOSTILE, DamageMod negative

/** Builds a party of two on one floor, both wounded. */
const woundedParty = async () => {
  const { CLID } = await import("../src/socket/opcodes.js");
  const sent = [];
  return {
    sent,
    session: {
      id: 94,
      heroDoid: 500,
      floorDoid: 400,
      heroWeapons: [{ power: 16 }], // HERO_SCROLL_HEAL
      objects: new Map([
        [500, CLID.HeroGameObject],
        [501, CLID.HeroGameObject],
        [700, CLID.DistributedNPCGameObject],
      ]),
      actors: new Map([
        [500, { hitPoints: 100, maxHitPoints: 1000, team: 1 }],
        [501, { hitPoints: 100, maxHitPoints: 1000, team: 1 }],
        [700, { hitPoints: 900, maxHitPoints: 900, constant: "KNIGHT_TUTORIAL", isEnemy: true, team: 2 }],
      ]),
      partyHeroDoids: new Set([500, 501]),
      allocateDoid: () => 900,
      send: (bytes) => sent.push(bytes),
    },
  };
};

const propose = async (session, { attackee, attackType }) => {
  const { handleProposeCombatResults } = await import("../src/socket/combat.js");
  const { PacketWriter, PacketReader } = await import("../src/socket/packet.js");
  const result = new PacketWriter()
    .u32(500).u32(attackee).i32(0).u8(0).u8(0).u32(attackType).u32(0)
    .u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).i32(0).f32(1).u8(0)
    .body();
  const packet = new PacketWriter().u16(result.length).raw(result).body();
  return handleProposeCombatResults(session, new PacketReader(packet));
};

test("a heal scroll cast on yourself gives hit points back", async () => {
  const { session } = await woundedParty();

  await propose(session, { attackee: 500, attackType: HEALING_PULSE_COOLDOWN });

  const hero = session.actors.get(500);
  assert.ok(
    hero.hitPoints > 100,
    `AffectsSelf is 1 on HEALING_PULSE_COOLDOWN, so the caster is healed — got ${hero.hitPoints}`
  );
  assert.ok(hero.hitPoints <= hero.maxHitPoints, "and never past the top of the bar");
});

test("a heal scroll heals the ally standing in it, not only the caster", async () => {
  const { session } = await woundedParty();

  await propose(session, { attackee: 501, attackType: HEALING_PULSE_COOLDOWN });

  assert.ok(session.actors.get(501).hitPoints > 100, "AffectsOthers is 1 as well");
});

test("healing never carries a hero past maximum", async () => {
  const { session } = await woundedParty();
  session.actors.get(500).hitPoints = 999;

  await propose(session, { attackee: 500, attackType: HEALING_PULSE_COOLDOWN });

  assert.equal(session.actors.get(500).hitPoints, 1000, "clamped to the bar, not over it");
});

test("a downed hero is not healed back up by a passing wave", async () => {
  const { session } = await woundedParty();
  session.actors.get(500).hitPoints = 0;
  session.actors.get(500).dead = true;

  await propose(session, { attackee: 500, attackType: HEALING_PULSE_COOLDOWN });

  assert.equal(session.actors.get(500).hitPoints, 0, "getting up is a revive's job, not a heal's");
});

/**
 * The number the client draws, dug out of the frame that carried it.
 *
 * A CombatResult is fixed width and opens with `u32 attacker, u32 attackee,
 * i32 damage`, so the pair locates the record and the sign sits eight bytes in.
 */
const wireDamage = (sent, attacker, attackee) => {
  const wanted = Buffer.alloc(8);
  wanted.writeUInt32LE(attacker, 0);
  wanted.writeUInt32LE(attackee, 4);
  for (const frame of sent) {
    const at = Buffer.from(frame).indexOf(wanted);
    if (at >= 0) return Buffer.from(frame).readInt32LE(at + 8);
  }
  return null;
};

/**
 * The sign on the wire is the client's only way to read the magnitude:
 * `spawnHealFloater` prints `combatResult.damage` straight out, so a heal sent
 * as a negative would be drawn as a heal of minus forty-two.
 */
test("a heal reports a positive number where damage reports a negative one", async () => {
  const healed = await woundedParty();
  await propose(healed.session, { attackee: 500, attackType: HEALING_PULSE_COOLDOWN });
  const heal = wireDamage(healed.sent, 500, 500);

  const hurt = await woundedParty();
  await propose(hurt.session, { attackee: 700, attackType: FIREBALL });
  const damage = wireDamage(hurt.sent, 500, 700);

  assert.ok(heal > 0, `a heal goes down the wire positive — got ${heal}`);
  assert.ok(damage < 0, `and damage negative — got ${damage}`);
});

/**
 * A drink is paid out by `useConsumable` as a share of the bar before any
 * result is proposed, so pricing it again here would heal the drinker twice.
 */
test("a health potion is not healed a second time by the combat path", async () => {
  const { session } = await woundedParty();

  // CONSUMABLE_HEALTH_SHOT_ATTACK: DamageMod +1, but DoPercentHealthDamage 0.25
  await propose(session, { attackee: 500, attackType: 910515 });

  assert.equal(
    session.actors.get(500).hitPoints,
    100,
    "the percent heal is the consumable path's to give, and it already gave it"
  );
});

test("a hostile attack still damages, with the healing path in place", async () => {
  const { session } = await woundedParty();

  await propose(session, { attackee: 700, attackType: FIREBALL });

  assert.ok(
    session.actors.get(700).hitPoints < 900,
    "DamageMod is negative on a fireball, so it still hurts"
  );
});
