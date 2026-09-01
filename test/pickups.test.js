import assert from "node:assert/strict";
import test from "node:test";

import { collectNearby, collectNearbyForPet } from "../src/socket/pickups.js";
import { dooberForConstant } from "../src/gamemaster.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketReader } from "../src/socket/packet.js";
import { createMatchWorld } from "../src/socket/match-world.js";
import { dooberGenerate } from "../src/socket/objects.js";

const FLID_DOOBER_COLLECTED_BY = 291;
const FLID_PLAYER_BASIC_CURRENCY = 181;
const FLID_HERO_EXPERIENCE_POINTS = 164;
const FLID_HERO_DUNGEON_BUSTER_POINTS = 166;
const FLID_HERO_HIT_POINTS = 151;
const FLID_HERO_MANA_POINTS = 163;

test("the authored FOOD placeholder resolves to a concrete healing doober", async () => {
  const doober = await dooberForConstant("FOOD", () => 0);
  assert.equal(doober.DooberType, "FOOD");
  assert.ok(doober.HP_PERCENTAGE > 0);
});

test("a nearby doober is collected and announced exactly once", () => {
  const sent = [];
  const session = {
    id: 7,
    heroDoid: 500,
    doobers: new Map([
      [100, { x: 20, y: 20, constant: "GOLD_SMALL" }],
      [101, { x: 500, y: 500, constant: "GOLD_SMALL" }],
    ]),
    objects: new Map([
      [100, 40],
      [101, 40],
    ]),
    send: (frame) => sent.push(frame),
  };

  assert.equal(collectNearby(session, { x: 0, y: 0 }), 1);
  assert.equal(collectNearby(session, { x: 0, y: 0 }), 0);
  assert.equal(session.doobers.has(100), false);
  assert.equal(session.doobers.has(101), true);
  assert.equal(session.objects.has(100), false);
  assert.equal(sent.length, 1);

  const reader = new PacketReader(sent[0].subarray(2));
  assert.equal(reader.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(reader.u32(), 100);
  assert.equal(reader.u16(), FLID_DOOBER_COLLECTED_BY);
  assert.equal(reader.u32(), session.heroDoid);
  assert.equal(reader.eof(), true);
});

test("a collecting pet takes progression stars for its owner but leaves food alone", async () => {
  const sent = [];
  const account = { id: 42, basic_currency: 100, account_avatars: [] };
  const session = {
    id: 70,
    playerDoid: 42,
    heroDoid: 500,
    dungeonAccount: account,
    dungeonRewards: { gold: 0, gems: 0, xp: 0 },
    doobers: new Map([
      [100, { x: 5, y: 5, constant: "GOLD_SMALL", gold: 10 }],
      [101, { x: 5, y: 5, constant: "FOOD", hpPercentage: 0.2 }],
    ]),
    objects: new Map([
      [100, CLID.DistributedDooberGameObject],
      [101, CLID.DistributedDooberGameObject],
    ]),
    persistDungeonAccount: async () => {},
    send: (frame) => sent.push(frame),
  };

  assert.equal(
    collectNearbyForPet(session, { x: 0, y: 0 }, { gold: true }),
    1
  );
  await session.rewardSavePromise;
  assert.equal(session.doobers.has(100), false);
  assert.equal(session.doobers.has(101), true);
  assert.equal(account.basic_currency, 110);
  assert.equal(session.dungeonRewards.gold, 10);

  const collected = new PacketReader(sent[0].subarray(2));
  assert.equal(collected.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(collected.u32(), 100);
  assert.equal(collected.u16(), FLID_DOOBER_COLLECTED_BY);
  assert.equal(collected.u32(), session.heroDoid, "the owner remains the wire collector");
});

test("GameMaster pickup rewards update live state and persist exactly once", async () => {
  const sent = [];
  const saved = [];
  const avatar = { experience: 90 };
  const account = { id: 42, basic_currency: 1000, account_avatars: [avatar] };
  const session = {
    id: 8,
    playerDoid: 42,
    heroDoid: 500,
    dungeonAccount: account,
    dungeonAvatar: avatar,
    dungeonBusterPoints: 2,
    maxDungeonBusterPoints: 110,
    heroManaPoints: 20,
    maxHeroManaPoints: 100,
    dungeonRewards: { gold: 0, gems: 0, xp: 0 },
    doobers: new Map([
      [
        100,
        {
          x: 20,
          y: 20,
          constant: "TEST_REWARD",
          gold: 10,
          xp: 5,
          crowd: 6,
          hpPercentage: 0.2,
          mpPercentage: 0.25,
        },
      ],
    ]),
    objects: new Map([[100, 40]]),
    actors: new Map([
      [500, { hitPoints: 100, maxHitPoints: 200, constant: "BERSERKER" }],
    ]),
    persistDungeonAccount: async (value) => {
      saved.push(structuredClone(value));
    },
    send: (frame) => sent.push(frame),
  };

  assert.equal(collectNearby(session, { x: 0, y: 0 }), 1);
  await session.rewardSavePromise;
  assert.equal(collectNearby(session, { x: 0, y: 0 }), 0);

  assert.deepEqual(session.dungeonRewards, { gold: 10, gems: 0, xp: 5 });
  assert.equal(session.dungeonBusterPoints, 8);
  assert.equal(session.actors.get(session.heroDoid).hitPoints, 140);
  assert.equal(session.heroManaPoints, 45);
  assert.equal(account.basic_currency, 1010);
  assert.equal(avatar.experience, 95);
  assert.deepEqual(saved, [
    { id: 42, basic_currency: 1010, account_avatars: [{ experience: 95 }] },
  ]);
  assert.equal(sent.length, 6);

  const currency = new PacketReader(sent[1].subarray(2));
  assert.equal(currency.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(currency.u32(), session.playerDoid);
  assert.equal(currency.u16(), FLID_PLAYER_BASIC_CURRENCY);
  assert.equal(currency.u32(), 1010);
  assert.equal(currency.eof(), true);

  const experience = new PacketReader(sent[2].subarray(2));
  assert.equal(experience.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(experience.u32(), session.heroDoid);
  assert.equal(experience.u16(), FLID_HERO_EXPERIENCE_POINTS);
  assert.equal(experience.u32(), 95);
  assert.equal(experience.eof(), true);

  const buster = new PacketReader(sent[3].subarray(2));
  assert.equal(buster.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(buster.u32(), session.heroDoid);
  assert.equal(buster.u16(), FLID_HERO_DUNGEON_BUSTER_POINTS);
  assert.equal(buster.u32(), 8);
  assert.equal(buster.eof(), true);

  const health = new PacketReader(sent[4].subarray(2));
  assert.equal(health.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(health.u32(), session.heroDoid);
  assert.equal(health.u16(), FLID_HERO_HIT_POINTS);
  assert.equal(health.u16(), 140);
  assert.equal(health.eof(), true);

  const mana = new PacketReader(sent[5].subarray(2));
  assert.equal(mana.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(mana.u32(), session.heroDoid);
  assert.equal(mana.u16(), FLID_HERO_MANA_POINTS);
  assert.equal(mana.u16(), 45);
  assert.equal(mana.eof(), true);

  const collected = new PacketReader(sent[0].subarray(2));
  assert.equal(collected.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(collected.u32(), 100);
  assert.equal(collected.u16(), FLID_DOOBER_COLLECTED_BY);
  assert.equal(collected.u32(), session.heroDoid);
  assert.equal(collected.eof(), true);
});

test("one shared pickup disappears and pays Gold/XP/Crowd to the party", async () => {
  const makeMember = (id, heroDoid, hitPoints) => {
    const sent = [];
    const avatar = { experience: 100 };
    const account = { id, basic_currency: 1000, account_avatars: [avatar] };
    return {
      id,
      accountId: id,
      playerDoid: id,
      heroDoid,
      dungeonAccount: account,
      dungeonAvatar: avatar,
      dungeonRewards: { gold: 0, gems: 0, xp: 0 },
      dungeonBusterPoints: 0,
      maxDungeonBusterPoints: 110,
      heroManaPoints: 20,
      maxHeroManaPoints: 100,
      objects: new Map([
        [id, CLID.PlayerGameObject],
        [heroDoid, CLID.HeroGameObject],
      ]),
      actors: new Map([[heroDoid, { hitPoints, maxHitPoints: 200 }]]),
      doobers: new Map(),
      socket: { destroyed: false },
      sent,
      send: (frame) => sent.push(frame),
      persistDungeonAccount: async () => {},
      allocateDoid: () => 100,
    };
  };
  const host = makeMember(41, 501, 200);
  const collector = makeMember(42, 502, 100);
  const world = createMatchWorld({ id: 1, members: new Set([host, collector]) }, host);
  world.contextFor(collector);
  world.objects.set(collector.playerDoid, CLID.PlayerGameObject);
  world.objects.set(collector.heroDoid, CLID.HeroGameObject);
  world.actors.set(collector.heroDoid, collector.actors.get(collector.heroDoid));
  world.floorDoid = 50;
  world.dungeonZone = 10;
  const doober = {
    x: 20,
    y: 20,
    constant: "PARTY_REWARD",
    gold: 10,
    xp: 5,
    crowd: 6,
    hpPercentage: 0.2,
  };
  world.doobers.set(100, doober);
  world.objects.set(100, CLID.DistributedDooberGameObject);
  world.contextFor(host).send(
    dooberGenerate({ doid: 100, parent: 50, zone: 10, dooberType: 30001, position: doober })
  );
  assert.equal(world.snapshotCreates.has(100), true);

  assert.equal(collectNearby(world.contextFor(collector), { x: 0, y: 0 }), 1);
  await Promise.all([host.rewardSavePromise, collector.rewardSavePromise]);

  for (const member of [host, collector]) {
    assert.equal(member.dungeonAccount.basic_currency, 1010);
    assert.equal(member.dungeonAvatar.experience, 105);
    assert.equal(member.dungeonBusterPoints, 6);
    assert.deepEqual(member.dungeonRewards, { gold: 10, gems: 0, xp: 5 });
    const collected = member.sent.find(
      (frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD &&
        frame.readUInt32LE(4) === 100 && frame.readUInt16LE(8) === FLID_DOOBER_COLLECTED_BY
    );
    assert.ok(collected, `member ${member.id} saw the shared pickup disappear`);
    assert.equal(collected.readUInt32LE(10), collector.heroDoid);
    for (const owner of [host, collector]) {
      assert.ok(
        member.sent.some(
          (frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD &&
            frame.readUInt32LE(4) === owner.heroDoid &&
            frame.readUInt16LE(8) === FLID_HERO_DUNGEON_BUSTER_POINTS
        ),
        `member ${member.id} saw hero ${owner.heroDoid}'s shared Buster progress`
      );
    }
  }
  assert.equal(world.actors.get(host.heroDoid).hitPoints, 200, "host did not eat collector's food");
  assert.equal(world.actors.get(collector.heroDoid).hitPoints, 140);
  assert.equal(world.doobers.has(100), false);
  assert.equal(world.objects.has(100), false);
  assert.equal(world.snapshotCreates.has(100), false, "late join cannot replay collected loot");
  world.destroy();
});

test("a healthy hero leaves the big food for whoever needs it", async () => {
  const { collectNearby } = await import("../src/socket/pickups.js");
  const { CLID } = await import("../src/socket/opcodes.js");

  const floorFood = (session, doid, hp, mp = 0) => {
    session.objects.set(doid, CLID.DistributedDooberGameObject);
    session.doobers.set(doid, {
      x: 1000,
      y: 1000,
      constant: "TEST_FOOD",
      hpPercentage: hp,
      mpPercentage: mp,
    });
  };

  const atHealth = (share) => {
    const session = {
      id: 70,
      heroDoid: 500,
      heroManaPoints: 100,
      maxHeroManaPoints: 100,
      objects: new Map(),
      doobers: new Map(),
      actors: new Map([[500, { hitPoints: Math.round(1000 * share), maxHitPoints: 1000 }]]),
      send: () => {},
    };
    return session;
  };

  /**
   * The rule is a share of what the food offers, not a fixed health line, so it
   * scales: a steak is for a bad wound and a scrap is for a scratch.
   */
  const full = atHealth(1);
  floorFood(full, 900, 0.75);
  assert.equal(collectNearby(full, { x: 1000, y: 1000 }), 0, "a steak is left at full health");

  /**
   * A scrap — a quarter of the bar or less — asks only for somewhere to go.
   * Refusing a sausage at 97% is what a full-health rule feels like from the
   * player's side, so only being genuinely full turns one down.
   */
  const brimming = atHealth(1);
  floorFood(brimming, 901, 0.2);
  assert.equal(collectNearby(brimming, { x: 1000, y: 1000 }), 0, "a sausage at full health is waste");

  const scratched = atHealth(0.97);
  floorFood(scratched, 902, 0.2);
  assert.equal(collectNearby(scratched, { x: 1000, y: 1000 }), 1, "but a scratch is reason enough");

  // Anything larger still has to be worth it, at half of what it offers.
  const dented = atHealth(0.8);
  floorFood(dented, 903, 0.75);
  assert.equal(collectNearby(dented, { x: 1000, y: 1000 }), 0, "a steak at eighty is still waste");

  const wounded = atHealth(0.6);
  floorFood(wounded, 904, 0.75);
  assert.equal(collectNearby(wounded, { x: 1000, y: 1000 }), 1, "and goes once it is worth it");
});

test("a pickup that restores nothing is never refused", async () => {
  const { collectNearby } = await import("../src/socket/pickups.js");
  const { CLID } = await import("../src/socket/opcodes.js");

  const session = {
    id: 71,
    heroDoid: 500,
    heroManaPoints: 100,
    maxHeroManaPoints: 100,
    objects: new Map(),
    doobers: new Map(),
    actors: new Map([[500, { hitPoints: 1000, maxHitPoints: 1000 }]]),
    send: () => {},
  };
  // The chef's buff soups heal nothing and carry a buff, and gold and XP heal
  // nothing either. There is nothing to waste, so nothing to weigh.
  session.objects.set(910, CLID.DistributedDooberGameObject);
  session.doobers.set(910, { x: 1000, y: 1000, constant: "FOOD_BUFF_BEEFY", gold: 0, xp: 0 });

  assert.equal(collectNearby(session, { x: 1000, y: 1000 }), 1);
});

test("a sandwich is still worth taking for the Mana alone", async () => {
  const { collectNearby } = await import("../src/socket/pickups.js");
  const { CLID } = await import("../src/socket/opcodes.js");

  const session = {
    id: 72,
    heroDoid: 500,
    heroManaPoints: 10,
    maxHeroManaPoints: 100,
    objects: new Map(),
    doobers: new Map(),
    actors: new Map([[500, { hitPoints: 1000, maxHitPoints: 1000 }]]),
    send: () => {},
  };
  session.objects.set(920, CLID.DistributedDooberGameObject);
  session.doobers.set(920, {
    x: 1000,
    y: 1000,
    constant: "COMBO_SANDWICH",
    hpPercentage: 0.25,
    mpPercentage: 0.25,
  });

  // Full health, so the healing is waste — but nine tenths of the Mana is gone.
  assert.equal(collectNearby(session, { x: 1000, y: 1000 }), 1);
});

/**
 * All three of the chef's soups carry `MaxStacks` 1, so a second one does
 * nothing for him — but nothing stopped him walking over it, and in a party
 * that is the buff taken out of somebody else's reach. He cooks for the table.
 */
test("a chef leaves a soup he is already under", async () => {
  const { collectNearby } = await import("../src/socket/pickups.js");
  const { grantBuff, clearDungeonBuffs } = await import("../src/socket/buffs.js");
  const { CLID } = await import("../src/socket/opcodes.js");

  let next = 900;
  const session = {
    id: 72,
    heroDoid: 500,
    floorDoid: 400,
    dungeonZone: 0,
    heroManaPoints: 100,
    maxHeroManaPoints: 100,
    objects: new Map(),
    doobers: new Map(),
    actors: new Map([[500, { hitPoints: 1000, maxHitPoints: 1000 }]]),
    allocateDoid: () => ++next,
    send: () => {},
  };

  const soupOnFloor = (doid) => {
    session.objects.set(doid, CLID.DistributedDooberGameObject);
    session.doobers.set(doid, {
      x: 1000,
      y: 1000,
      constant: "FOOD_BUFF_SPEED",
      buffGranted: "CHEF_SPEEDY_BUFF",
    });
  };

  // Without the buff he takes it: a soup restores nothing, so nothing is wasted.
  soupOnFloor(920);
  assert.equal(collectNearby(session, { x: 1000, y: 1000 }), 1, "the first one is his");

  await grantBuff(session, "CHEF_SPEEDY_BUFF");
  soupOnFloor(921);
  assert.equal(collectNearby(session, { x: 1000, y: 1000 }), 0, "the second is not");
  assert.ok(session.doobers.has(921), "and it stays on the floor for the party");

  clearDungeonBuffs(session);
});

/**
 * `COOKING` already decides how often food appears at all and said nothing
 * about how long the buff inside it lasts, so a chef who put everything into
 * cooking served the same ten-second soup as one who put nothing there.
 *
 * The authored amount is 0.1 a point, taken as seconds: 7.5 at the cap.
 */
test("a trained chef's soups last longer", async () => {
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const { superStatValue } = await import("../src/hero-stats.js");
  const gm = await loadGameMaster();
  const chef = gm.raw.Hero.find((row) => row.Constant === "BATTLE_CHEF");

  const bonus = (points) =>
    superStatValue(gm, chef, { experience: 5_000_000, statupgrade2: points }, "COOKING");

  assert.equal(bonus(0), 0, "untrained adds nothing");
  // 0.1 a point authored, two seconds given for each of those.
  assert.ok(Math.abs(bonus(75) * 2 - 15) < 1e-9, `and the cap adds 15s, got ${bonus(75) * 2}`);

  // Which lands somewhere defensible against the authored durations.
  const durations = { CHEF_SPEEDY_BUFF: 10, CHEF_DEFENSE_BUFF: 15, CHEF_BEEFY_BUFF: 20 };
  for (const [constant, base] of Object.entries(durations)) {
    const buff = gm.raw.Buff.find((row) => row.Constant === constant);
    assert.equal(Number(buff.Duration), base, `${constant} is ${base}s`);
    const trained = base + bonus(75) * 2;
    assert.ok(trained <= base * 2.5, `${constant} at ${trained}s is not a floor-long buff`);
    assert.ok(trained > base * 1.5, `${constant} at ${trained}s is worth training for`);
  }

  // And nobody else's buffs are touched by it.
  const other = gm.raw.Hero.find((row) => row.Constant === "RANGER");
  assert.equal(
    superStatValue(gm, other, { experience: 5_000_000, statupgrade2: 75 }, "COOKING"),
    0,
    "only the chef cooks"
  );
});

/**
 * 139 of the game's 157 buffs author `MaxStacks` 1 and nothing read it, so
 * re-applying one compounded it: `buffMultiplierFor` multiplies over every live
 * copy, so three of a 1.3x movement buff make 2.2x. A player watching it read
 * "3x" on his own bar.
 */
test("a buff does not stack past what it authors", async () => {
  const { grantBuff, buffMultiplierFor, clearDungeonBuffs } = await import("../src/socket/buffs.js");

  let next = 900;
  const session = {
    id: 73,
    heroDoid: 500,
    floorDoid: 400,
    dungeonZone: 0,
    objects: new Map(),
    allocateDoid: () => ++next,
    send: () => {},
  };

  // CHEF_SPEEDY_BUFF authors MaxStacks 1 and MOVEMENT 1.5.
  const first = await grantBuff(session, "CHEF_SPEEDY_BUFF");
  const again = await grantBuff(session, "CHEF_SPEEDY_BUFF");
  const third = await grantBuff(session, "CHEF_SPEEDY_BUFF");

  assert.equal(session.activeBuffs.size, 1, "one copy, however many times it is given");
  assert.equal(again, first, "the same one is handed back");
  assert.equal(third, first, "and again");
  assert.equal(buffMultiplierFor(session, 500, "MOVEMENT"), 1.5, "so the effect does not compound");

  clearDungeonBuffs(session);
});

/** And one that authors more may have more, up to what it says. */
test("a buff that stacks stacks to its limit", async () => {
  const { grantBuff, clearDungeonBuffs } = await import("../src/socket/buffs.js");
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const gm = await loadGameMaster();

  // POISON_L1 authors six.
  const limit = Number(gm.raw.Buff.find((row) => row.Constant === "POISON_L1").MaxStacks);
  assert.equal(limit, 6, "the data says six");

  let next = 900;
  const session = {
    id: 74,
    heroDoid: 500,
    floorDoid: 400,
    dungeonZone: 0,
    objects: new Map(),
    allocateDoid: () => ++next,
    send: () => {},
  };
  for (let i = 0; i < limit + 4; i++) await grantBuff(session, "POISON_L1");
  assert.equal(session.activeBuffs.size, limit, "six, and no more than six");

  clearDungeonBuffs(session);
});
