import assert from "node:assert/strict";
import test from "node:test";

import { dungeonSummaryGenerate } from "../src/socket/objects.js";
import {
  buildDungeonReport,
  projectDungeonReports,
  sendDungeonSummary,
} from "../src/socket/summary.js";
import { createMatchWorld } from "../src/socket/match-world.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketReader } from "../src/socket/packet.js";

const readReport = (reader) => {
  const report = {
    name: reader.utf(),
    trophyCount: reader.u32(),
    id: reader.u32(),
    type: reader.u32(),
    skinType: reader.u32(),
    kills: reader.u32(),
    xp: reader.u32(),
    xpEarned: reader.u32(),
    xpBonus: reader.u32(),
    teamXpBonus: reader.u32(),
    goldEarned: reader.u32(),
    gemsEarned: reader.u32(),
    boostXp: reader.f32(),
    boostGold: reader.f32(),
    receivedTrophy: reader.u8(),
  };

  // Modifiers(4), loot(4), weapon levels(3), weapon types(3), weapon
  // modifiers(9), powers(3), rarities(3), chests(4).
  report.trailingValues = Array.from({ length: 33 }, () => reader.u32());
  report.valid = reader.u8();
  report.accountFlags = reader.u32();
  report.totalAvatarsOwned = reader.u32();
  report.consumables = [
    { id: reader.u32(), count: reader.u32() },
    { id: reader.u32(), count: reader.u32() },
  ];
  return report;
};

test("dungeon summary generate follows the four-slot production contract", () => {
  const frame = dungeonSummaryGenerate({
    doid: 5001,
    parent: 4001,
    zone: 10,
    mapNodeId: 50002,
    success: true,
    reports: [
      {
        name: "Player1",
        trophyCount: 12,
        id: 12345,
        type: 101,
        skinType: 151,
        kills: 9,
        xp: 100,
        xpEarned: 25,
        xpBonus: 5,
        teamXpBonus: 2,
        goldEarned: 50,
        gemsEarned: 1,
        boostXp: 1,
        boostGold: 1,
        receivedTrophy: 1,
        valid: 1,
        accountFlags: 7,
        totalAvatarsOwned: 1,
        consumable1Id: 70001,
        consumable1Count: 2,
      },
    ],
  });
  const reader = new PacketReader(frame.subarray(2));

  assert.equal(reader.u16(), OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP);
  assert.equal(reader.u32(), 4001);
  assert.equal(reader.u32(), 10);
  assert.equal(reader.u16(), CLID.DistributedDungeonSummary);
  assert.equal(reader.u32(), 5001);
  assert.equal(reader.u32(), 50002);

  // Four empty reports occupy 4 * 212 bytes. The first slot's seven-byte name
  // is the only variable-sized content in this fixture, matching production.
  assert.equal(reader.u16(), 855);
  const report = readReport(reader);
  assert.deepEqual(
    {
      name: report.name,
      trophyCount: report.trophyCount,
      id: report.id,
      type: report.type,
      skinType: report.skinType,
      kills: report.kills,
      xp: report.xp,
      xpEarned: report.xpEarned,
      xpBonus: report.xpBonus,
      teamXpBonus: report.teamXpBonus,
      goldEarned: report.goldEarned,
      gemsEarned: report.gemsEarned,
      boostXp: report.boostXp,
      boostGold: report.boostGold,
      receivedTrophy: report.receivedTrophy,
      valid: report.valid,
      accountFlags: report.accountFlags,
      totalAvatarsOwned: report.totalAvatarsOwned,
      consumables: report.consumables,
    },
    {
      name: "Player1",
      trophyCount: 12,
      id: 12345,
      type: 101,
      skinType: 151,
      kills: 9,
      xp: 100,
      xpEarned: 25,
      xpBonus: 5,
      teamXpBonus: 2,
      goldEarned: 50,
      gemsEarned: 1,
      boostXp: 1,
      boostGold: 1,
      receivedTrophy: 1,
      valid: 1,
      accountFlags: 7,
      totalAvatarsOwned: 1,
      consumables: [
        { id: 70001, count: 2 },
        { id: 0, count: 0 },
      ],
    }
  );

  for (let index = 1; index < 4; index++) {
    const empty = readReport(reader);
    assert.equal(empty.name, "");
    assert.equal(empty.valid, 0);
  }
  assert.equal(reader.utf(), "");
  assert.equal(reader.u8(), 1);
  assert.deepEqual([reader.u32(), reader.u32(), reader.u32(), reader.u32()], [0, 0, 0, 0]);
  assert.equal(reader.eof(), true);
});

test("summary report is built from authoritative dungeon state", () => {
  const report = buildDungeonReport({
    accountId: 12345,
    playerDoid: 54321,
    dungeonAccount: {
      id: 12345,
      name: "Player1",
      trophies: 12,
      account_flags: 7,
      account_avatars: [{}, {}],
    },
    dungeonAvatar: {
      avatar_id: 102,
      skin_type: 152,
      experience: 124,
      consumable1_id: 70001,
      consumable1_count: 2,
    },
    dungeonRewards: { xp: 25, gold: 50, gems: 1 },
    dungeonStart: { experience: 99 },
    actors: new Map([
      [1, { isEnemy: true, dead: true }],
      [2, { isEnemy: true, dead: false }],
      [3, { isEnemy: false, dead: true }],
    ]),
    heroWeapons: [
      { type: 11001, power: 5, requiredlevel: 1, rarity: 2, modifier1: 8 },
    ],
  });

  assert.deepEqual(
    {
      name: report.name,
      id: report.id,
      type: report.type,
      skinType: report.skinType,
      kills: report.kills,
      xp: report.xp,
      xpEarned: report.xpEarned,
      goldEarned: report.goldEarned,
      gemsEarned: report.gemsEarned,
      totalAvatarsOwned: report.totalAvatarsOwned,
      consumable1Id: report.consumable1Id,
      weaponType1: report.weaponType1,
      weaponPower1: report.weaponPower1,
      weaponRarity1: report.weaponRarity1,
      modifierType1a: report.modifierType1a,
    },
    {
      name: "Player1",
      id: 54321,
      type: 102,
      skinType: 152,
      kills: 1,
      // Where the bar starts: what the avatar holds now, which already contains
      // the 25 the run earned — the captured defeat reported 366773 against an
      // account that went 366408 -> 366773.
      xp: 124,
      xpEarned: 25,
      goldEarned: 50,
      gemsEarned: 1,
      totalAvatarsOwned: 2,
      consumable1Id: 70001,
      weaponType1: 11001,
      weaponPower1: 5,
      weaponRarity1: 2,
      modifierType1a: 8,
    }
  );
});

test("five-member summaries put each recipient first and expose at most four reports", () => {
  const members = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1,
    accountId: 100 + index,
    playerDoid: 100 + index,
    heroDoid: 200 + index,
    dungeonAccount: {
      id: 100 + index,
      name: `P${index + 1}`,
      account_avatars: [{}],
    },
    dungeonAvatar: { avatar_id: 101, skin_type: 151, experience: 0 },
    dungeonRewards: { xp: index, gold: index, gems: 0 },
    dungeonContribution: { kills: index, damage: index * 10 },
    heroWeapons: [],
    objects: new Map(),
    actors: new Map(),
    doobers: new Map(),
    socket: { destroyed: false },
    send: () => {},
    allocateDoid(clid) {
      const doid = 9000 + this.objects.size;
      this.objects.set(doid, clid);
      return doid;
    },
  }));
  const world = createMatchWorld({ id: 1, members: new Set(members) }, members[0]);
  for (const member of members.slice(1)) world.contextFor(member);

  for (const recipient of members) {
    const reports = projectDungeonReports(world.contextFor(recipient), recipient, true);
    assert.equal(reports.length, 4);
    assert.equal(reports[0].id, recipient.playerDoid);
    assert.equal(reports[0].kills, recipient.dungeonContribution.kills);
    assert.equal(new Set(reports.map((report) => report.id)).size, 4);
  }
});

test("summary object is emitted at most once per dungeon", () => {
  const sent = [];
  const objects = new Map();
  const session = {
    id: 9,
    dungeonActive: true,
    areaDoid: 4001,
    dungeonZone: 10,
    mapNodeId: 50002,
    actors: new Map(),
    allocateDoid: (clid) => {
      objects.set(5001, clid);
      return 5001;
    },
    send: (frame) => sent.push(frame),
  };

  assert.equal(sendDungeonSummary(session, true), true);
  assert.equal(sendDungeonSummary(session, true), false);
  assert.equal(sent.length, 1);
  assert.equal(session.summaryDoid, 5001);
  assert.equal(objects.get(5001), CLID.DistributedDungeonSummary);
});

/**
 * A captured report from the official server puts real numbers in these:
 * weaponLevel 73/63/73, power 381/387/2350, rarity 3/4/4. Everything here read
 * level 1 instead, because the mapping invented `required_level` for a column
 * the account payload spells `requiredlevel` — and a level-1 weapon also picks
 * the wrong model, since GMWeaponItem.getWeaponAesthetic keys off it.
 */
test("an equipped weapon keeps the level and legendary its account row carries", async () => {
  const { weaponsForAvatar } = await import("../src/socket/dungeon.js");

  const account = {
    account_items: [
      {
        item_id: 11001,
        avatar_id: 4,
        avatar_slot: 0,
        power: 381,
        requiredlevel: 73,
        rarity: 3,
        modifier1: 70114,
        modifier2: 70154,
        legendarymodifier: 12,
      },
    ],
  };

  const [first] = weaponsForAvatar(account, { id: 4 });
  assert.equal(first.requiredlevel, 73, "not 1, which is what a missed column gives");
  assert.equal(first.legendarymodifier, 12);
  assert.equal(first.power, 381);
  assert.equal(first.rarity, 3);
});

test("the report carries the weapon level the hero went in with", () => {
  const report = buildDungeonReport({
    dungeonAccount: {},
    dungeonAvatar: {},
    heroWeapons: [{ type: 11001, power: 381, requiredlevel: 73, rarity: 3, legendarymodifier: 12 }],
  });

  assert.equal(report.weaponLevel1, 73);
  assert.equal(report.weaponPower1, 381);
  assert.equal(report.legendaryModifierType1, 12);
});

/**
 * The teardown, from the captured defeat in `socket-20260816-210034.jsonl`:
 * five seconds after dungeonEnding the report is generated and 341 objects go
 * with it — 203 NPCs, 137 doobers and the floor. The area survives, because the
 * report is its child, and so does the player object.
 */
test("the report takes the floor down with it", () => {
  const sent = [];
  const session = {
    id: 5,
    areaDoid: 100,
    floorDoid: 101,
    heroDoid: 102,
    playerDoid: 103,
    dungeonActive: true,
    allocateDoid: () => 999,
    objects: new Map([
      [100, CLID.DistributedDungionArea],
      [101, CLID.DistributedDungeonFloor],
      [102, CLID.HeroGameObject],
      [103, CLID.PlayerGameObject],
      [200, CLID.DistributedNPCGameObject],
      [201, CLID.DistributedNPCGameObject],
      [300, CLID.DistributedDooberGameObject],
      [400, CLID.DistributedBuffGameObject],
    ]),
    actors: new Map([[200, { isEnemy: true, dead: true }]]),
    doobers: new Map([[300, {}]]),
    send: (frame) => sent.push(frame),
  };

  assert.equal(sendDungeonSummary(session, false), true);

  const ops = sent.map((frame) => new PacketReader(frame.subarray(2)).u16());
  const disabled = sent
    .filter((frame) => {
      const op = new PacketReader(frame.subarray(2)).u16();
      return op === OP.CLIENT_OBJECT_DISABLE_RESP;
    })
    .map((frame) => {
      const reader = new PacketReader(frame.subarray(2));
      reader.u16();
      return reader.u32();
    });

  assert.equal(ops[0], OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP, "the report goes up first");
  assert.deepEqual(disabled, [200, 201, 300, 400, 101], "children first, the floor last");
  assert.ok(
    ops.includes(OP.CLIENT_OBJECT_DISABLE_OWNER_RESP),
    "and the hero leaves as an owner disable"
  );
  assert.deepEqual(
    [...session.objects.keys()],
    [100, 103],
    "the area and the player stay; the hero left as an owner disable"
  );
});

test("the run stops simulating once the report is up", () => {
  const stopped = [];
  const session = {
    id: 6,
    areaDoid: 100,
    dungeonActive: true,
    allocateDoid: () => 998,
    objects: new Map([[200, CLID.DistributedNPCGameObject]]),
    send: () => {},
    stopAi: () => stopped.push("ai"),
    stopTriggers: () => stopped.push("triggers"),
    stopTrapProjectiles: () => stopped.push("projectiles"),
  };

  sendDungeonSummary(session, true);

  assert.deepEqual(stopped.sort(), ["ai", "projectiles", "triggers"]);
  assert.equal(session.stopAi, null, "and does not stop them twice");
});

/**
 * Completing a node is what pays its bonus. The captured defeat reported
 * xp_bonus and team_xp_bonus as zero on a node that authors a CompletionXPBonus,
 * while still reporting the 365 experience the run itself collected.
 */
test("the completion bonus is only paid for completing it", () => {
  const session = () => ({
    dungeonAccount: { account_avatars: [{}, {}, {}, {}, {}, {}] },
    dungeonAvatar: { experience: 500 },
    dungeonRewards: { xp: 365 },
    mapPage: { CompletionXPBonus: 4665 },
  });

  const won = buildDungeonReport(session(), true);
  assert.equal(won.xpBonus, 4665);
  assert.ok(won.teamXpBonus > 0, "six heroes earn a crew share");

  const lost = buildDungeonReport(session(), false);
  assert.equal(lost.xpBonus, 0);
  assert.equal(lost.teamXpBonus, 0);
  assert.equal(lost.xpEarned, 365, "but the floor's own experience is kept");
  assert.equal(lost.xp, 500);
});

/**
 * The crash of 2026-08-16 21:43, from the core: UIOffScreenPlayerManager.update
 * calling iterator() on a null map, one frame after the floor was disabled.
 *
 * A flag guarded the hero's owner-disable against being sent twice, and
 * leaveDungeon was not clearing it — so on a session's second run the report
 * disabled the floor while the hero was still up, and destroying the floor
 * nulls the map that HUD reads every frame. Only HeroGameObjectOwner.destroy
 * takes that HUD down. The guard is now the object table, which cannot outlive
 * its dungeon; this pins the ordering the crash turned on.
 */
test("the hero always leaves before the floor does", () => {
  const sent = [];
  const session = {
    id: 11,
    areaDoid: 100,
    heroDoid: 102,
    dungeonActive: true,
    allocateDoid: () => 997,
    objects: new Map([
      [100, CLID.DistributedDungionArea],
      [101, CLID.DistributedDungeonFloor],
      [102, CLID.HeroGameObject],
      [200, CLID.DistributedNPCGameObject],
    ]),
    send: (frame) => sent.push(frame),
  };

  sendDungeonSummary(session, false);

  const order = sent.map((frame) => {
    const reader = new PacketReader(frame.subarray(2));
    return { op: reader.u16(), doid: reader.u32() };
  });
  const heroAt = order.findIndex(
    (entry) => entry.op === OP.CLIENT_OBJECT_DISABLE_OWNER_RESP && entry.doid === 102
  );
  const floorAt = order.findIndex(
    (entry) => entry.op === OP.CLIENT_OBJECT_DISABLE_RESP && entry.doid === 101
  );

  assert.ok(heroAt !== -1, "a stale flag must not swallow the hero's disable");
  assert.ok(floorAt !== -1);
  assert.ok(heroAt < floorAt, "or the client dereferences a floor it has emptied");
});

test("a fresh dungeon's object table is what decides, not last run's", async () => {
  const { leaveDungeon } = await import("../src/socket/dungeon.js");
  const { removeHeroFromFloor } = await import("../src/socket/summary.js");

  const sent = [];
  const session = {
    id: 12,
    heroDoid: 7,
    objects: new Map([[7, CLID.HeroGameObject]]),
    send: (frame) => sent.push(frame),
  };

  assert.equal(removeHeroFromFloor(session), true, "run one takes its hero off");
  leaveDungeon(session);

  // Run two: a new dungeon, a new object table, and a hero that must still go.
  session.heroDoid = 8;
  session.objects = new Map([[8, CLID.HeroGameObject]]);
  assert.equal(removeHeroFromFloor(session), true, "and run two takes its own");
  assert.equal(sent.length, 2);
});
