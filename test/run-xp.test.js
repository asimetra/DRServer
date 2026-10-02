import assert from "node:assert/strict";
import test from "node:test";

import { rollNpcRewardDoobers, spawnNpcRewards } from "../src/socket/drops.js";
import { applyDooberReward, applyProgressReward } from "../src/socket/rewards.js";
import { claimXpStar, beginRunXp, countFloorXp, settleFloorXp, xpWeightOf, xpWorthOf } from "../src/socket/run-xp.js";
import { generatorXpWeight } from "../src/socket/population.js";

/**
 * What a kill is worth, against the official's recordings.
 *
 * Two things were wrong and both were visible on the wire. Which star drops was
 * rolled by rarity, where the official names it on the monster's own row: 5530
 * of 5530 kills of an `XP` 1 monster dropped EXP_SMALL, 1255 of 1255 at `XP` 3
 * dropped EXP_MEDIUM and 366 of 366 at `XP` 10 dropped EXP_LARGE. And the star
 * paid its `Exp` column — 1, 5 or 10 on every node in the game — where the
 * official pays the node: a small star was worth 1 in the tutorial and 19 in
 * Icewater Caverns 2-2, a medium three times a small and a large ten times.
 */

const doober = (Id, Constant, DooberType, extra = {}) => ({ Id, Constant, DooberType, Rarity: "COMMON", ...extra });
const EXP_SMALL = doober(30004, "EXP_SMALL", "EXP", { Exp: 1 });
const EXP_MEDIUM = doober(30005, "EXP_MEDIUM", "EXP", { Exp: 5, Rarity: "UNCOMMON" });
const EXP_LARGE = doober(30006, "EXP_LARGE", "EXP", { Exp: 10, Rarity: "RARE" });
const GOLD_SMALL = doober(30001, "GOLD_SMALL", "COIN", { Gold: 1 });

const rewardData = {
  allDoobers: [EXP_SMALL, EXP_MEDIUM, EXP_LARGE, GOLD_SMALL],
  candidates: [GOLD_SMALL],
  categoryProb: {},
  rarityProb: { COMMON: 0.75, UNCOMMON: 0.2, RARE: 0.05 },
};

const monster = (XP, XP_DOOBER_VISUAL, extra = {}) => ({
  Constant: "TEST_MONSTER",
  CharType: "ENEMY",
  Exp: 20,
  DooberProb: 0,
  XP,
  XP_DOOBER_VISUAL,
  ...extra,
});

const starsOf = (npc, random) =>
  rollNpcRewardDoobers(npc, rewardData, random)
    .filter((reward) => reward.DooberType === "EXP")
    .map((reward) => reward.Constant);

test("a monster drops the star its own row names, whatever the dice say", () => {
  // Every roll that used to pick the rarity: common, uncommon and rare.
  for (const roll of [0, 0.8, 0.99]) {
    const random = () => roll;
    assert.deepEqual(starsOf(monster(1, "EXP_SMALL"), random), ["EXP_SMALL"]);
    assert.deepEqual(starsOf(monster(3, "EXP_MEDIUM"), random), ["EXP_MEDIUM"]);
    assert.deepEqual(starsOf(monster(10, "EXP_LARGE"), random), ["EXP_LARGE"]);
  }
});

test("a row worth no experience drops no star", () => {
  assert.deepEqual(starsOf(monster(0, "EXP_SMALL"), () => 0), [], "a visual with nothing behind it");
  assert.deepEqual(starsOf(monster(undefined, undefined), () => 0), [], "and a row that authors neither");
  assert.deepEqual(
    starsOf(monster(3, "EXP_MEDIUM", { CharType: "BEAST" }), () => 0),
    ["EXP_MEDIUM"],
    "while a beast worth something pays like any monster"
  );
});

/**
 * One weight unit is the node's `TotalEnemyXP`, spread over its floors and over
 * what stands on the first of them. The official's best-explored runs give it
 * back to within a percent: 4665 on one floor carrying 243 came to 19.04 a
 * unit against 19.20; the Infinite nodes' 50000 over 55 floors of about 106
 * came to 8.57 on five floors running.
 */
const runOn = (mapPage, floorCount, rows) => {
  const session = { mapPage, floorCount, floorSettled: false };
  beginRunXp(session);
  for (const row of rows) countFloorXp(session, row);
  settleFloorXp(session);
  return session;
};

const floorOf = (small, medium, large) => [
  ...Array.from({ length: small }, () => monster(1, "EXP_SMALL")),
  ...Array.from({ length: medium }, () => monster(3, "EXP_MEDIUM")),
  ...Array.from({ length: large }, () => monster(10, "EXP_LARGE")),
];

test("a unit of experience is the node's budget over what its floors hold", () => {
  // 100 + 3 × 31 + 10 × 5 = 243, the floor the 19.04 was measured on.
  const caverns = runOn({ TotalEnemyXP: 4665 }, 1, floorOf(100, 31, 5));
  assert.ok(Math.abs(xpWorthOf(caverns, monster(1, "EXP_SMALL")) - 19.2) < 0.01);
  assert.ok(Math.abs(xpWorthOf(caverns, monster(3, "EXP_MEDIUM")) - 57.6) < 0.01, "three times a small");
  assert.ok(Math.abs(xpWorthOf(caverns, monster(10, "EXP_LARGE")) - 192) < 0.1, "and ten");

  const twoFloors = runOn({ TotalEnemyXP: 4820 }, 2, floorOf(200, 22, 5));
  assert.ok(
    Math.abs(xpWorthOf(twoFloors, monster(1, "EXP_SMALL")) - 4820 / 2 / 316) < 1e-9,
    "a node of two floors gives each half"
  );
});

/**
 * A boss floor is not a second approach. The tutorial is 55 over a first floor
 * of about 48 and a boss room of about 12, and the official's stars there paid
 * 1; counting the boss room as another 48 would have paid a half.
 */
test("the other floors count for what their plan says, when it says", () => {
  const session = { mapPage: { TotalEnemyXP: 55 }, floorCount: 2, floorSettled: false };
  beginRunXp(session);
  for (const row of floorOf(48, 0, 0)) countFloorXp(session, row);
  settleFloorXp(session, 12);
  assert.ok(Math.abs(xpWorthOf(session, monster(1, "EXP_SMALL")) - 55 / 60) < 1e-9);
});

test("the unit is settled on the first floor and kept for the run", () => {
  const session = runOn({ TotalEnemyXP: 4820 }, 2, floorOf(200, 22, 5));
  const first = xpWorthOf(session, monster(1, "EXP_SMALL"));

  // The second floor builds: more monsters arrive, and then it settles too.
  session.floorSettled = false;
  for (const row of floorOf(50, 0, 0)) countFloorXp(session, row);
  settleFloorXp(session);

  assert.equal(xpWorthOf(session, monster(1, "EXP_SMALL")), first, "both floors of a recorded run paid alike");
});

test("a run with nothing to divide pays the star's face value", () => {
  const unbudgeted = runOn({}, 1, floorOf(10, 0, 0));
  assert.equal(xpWorthOf(unbudgeted, monster(3, "EXP_MEDIUM")), undefined);

  const empty = runOn({ TotalEnemyXP: 500 }, 1, []);
  assert.equal(xpWorthOf(empty, monster(3, "EXP_MEDIUM")), undefined, "nor one whose first floor is bare");
});

const dropSession = (overrides = {}) => {
  let next = 100;
  return {
    id: 5,
    dungeonZone: 10,
    objects: new Map(),
    doobers: new Map(),
    allocateDoid: () => next++,
    send: () => {},
    ...overrides,
  };
};

test("the star a kill drops carries the run's price, not its own column", () => {
  const session = dropSession();
  spawnNpcRewards(session, {
    floorDoid: 50,
    npc: monster(3, "EXP_MEDIUM"),
    rewardData,
    origin: { x: 0, y: 0 },
    random: () => 0,
    xpWorth: 57.6,
  });
  const [star, coin] = [...session.doobers.values()];
  assert.equal(star.constant, "EXP_MEDIUM");
  assert.equal(star.xp, 57.6);
  assert.equal(coin.xp, 0, "and only the star");

  const unpriced = dropSession();
  spawnNpcRewards(unpriced, {
    floorDoid: 50,
    npc: monster(3, "EXP_MEDIUM"),
    rewardData,
    origin: { x: 0, y: 0 },
    random: () => 0,
  });
  assert.equal([...unpriced.doobers.values()][0].xp, 5, "with no price it is the column again");
});

/**
 * What a monster calls up is not part of the node's budget. The official's
 * summoned lightning orbs dropped nothing on 37 of 37 kills.
 */
test("a summoned monster drops no star", () => {
  const session = dropSession();
  spawnNpcRewards(session, {
    floorDoid: 50,
    npc: monster(1, "EXP_SMALL"),
    rewardData,
    origin: { x: 0, y: 0 },
    random: () => 0,
    xp: false,
  });
  assert.deepEqual([...session.doobers.values()].map((entry) => entry.constant), ["GOLD_SMALL"]);
});

/**
 * A star arrives whole, but a legendary that adds a share to it makes it
 * fractional again, and the hero's total is whole. What does not make a point
 * is kept for the next star rather than thrown away each time.
 */
test("a fraction a bonus leaves is carried to the next star, not dropped", () => {
  const sent = [];
  const session = {
    id: 6,
    heroDoid: 500,
    dungeonAvatar: { experience: 1000 },
    dungeonAccount: {},
    persistDungeonAccount: async () => {},
    send: (frame) => sent.push(frame),
  };

  const paid = [];
  for (let star = 0; star < 5; star++) {
    const before = session.dungeonAvatar.experience;
    applyDooberReward(session, { xp: 9.2 });
    paid.push(session.dungeonAvatar.experience - before);
  }

  assert.deepEqual(paid, [9, 9, 9, 9, 10]);
  assert.equal(session.dungeonAvatar.experience, 1046, "five stars at 9.2 are 46");
  assert.equal(session.dungeonRewards.xp, 46, "and the report counts the same");
});

test("a star worth less than one still adds up", () => {
  const session = {
    id: 7,
    dungeonAvatar: { experience: 0 },
    dungeonAccount: {},
    persistDungeonAccount: async () => {},
    send: () => {},
  };
  for (let star = 0; star < 10; star++) applyProgressReward(session, { xp: 0.9 });
  assert.equal(session.dungeonAvatar.experience, 9);
});

/**
 * A row can name a star and weigh one and still be worth nothing: the princess,
 * her barricades and her orbs are CharType HERO at `XP` 1 with `Exp` 0 — the
 * things a party defends. Counting them priced a whole defence map by its own
 * furniture, and breaking a barricade paid like a kill.
 */
test("what the party defends weighs nothing and leaves no star", () => {
  const barricade = monster(1, "EXP_SMALL", { CharType: "HERO", Exp: 0 });
  assert.equal(xpWeightOf(barricade), 0);
  assert.deepEqual(starsOf(barricade, () => 0), []);
  assert.equal(xpWeightOf(monster(1, "EXP_SMALL")), 1, "a monster worth experience still does");
});

/**
 * The tutorial is worth 55 and holds about ninety monsters' weight, so a share
 * is 0.6 — and the official does not pay six tenths of a point. It rounds each
 * monster's share to a whole number by chance: 242 recorded kills there dropped
 * a star that paid exactly 1, 168 dropped none, mixed together from the first
 * kill to the last, and the minotaur's star paid 6.
 */
const pricedAt = (unit) => {
  const session = { mapPage: { TotalEnemyXP: unit * 100 }, floorCount: 1, floorSettled: false };
  beginRunXp(session);
  for (const row of floorOf(100, 0, 0)) countFloorXp(session, row);
  settleFloorXp(session);
  return session;
};

test("a share below one point is a whole point for some monsters and nothing for the rest", () => {
  const tutorial = pricedAt(0.6);
  const knight = monster(1, "EXP_SMALL");

  assert.equal(claimXpStar(tutorial, knight, () => 0.59), 1, "six times in ten it is worth 1");
  assert.equal(claimXpStar(tutorial, knight, () => 0.61), null, "and the other four it drops no star");
  assert.equal(claimXpStar(tutorial, monster(10, "EXP_LARGE"), () => 0.5), 6, "the minotaur's ten weigh 6");
});

test("the monsters with nothing are spread through the run, not left for last", () => {
  const tutorial = pricedAt(0.6);
  const knight = monster(1, "EXP_SMALL");
  // A fixed sequence standing in for chance, the same on every run of the test.
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const kills = Array.from({ length: 400 }, () => claimXpStar(tutorial, knight, random));
  const paid = kills.filter((points) => points === 1).length;
  assert.ok(kills.every((points) => points === 1 || points === null), "a star pays 1 or is not there");
  assert.ok(paid > 210 && paid < 270, `about six in ten carry a star — saw ${paid} of 400`);

  const lastHundred = kills.slice(300).filter((points) => points === 1).length;
  assert.ok(lastHundred > 45, `and the late kills are no poorer than the early — saw ${lastHundred} of 100`);
});

/**
 * The same rounding everywhere else: at 9.16 a unit the official's small stars
 * paid 9 thirty-nine times and 10 seven, never 9.16 and never a 9 every time.
 */
test("above one point every monster carries a star, of one of two neighbouring values", () => {
  const fortress = pricedAt(9.16);
  const knight = monster(1, "EXP_SMALL");

  assert.equal(claimXpStar(fortress, knight, () => 0.15), 10);
  assert.equal(claimXpStar(fortress, knight, () => 0.17), 9);
  assert.equal(claimXpStar(fortress, monster(3, "EXP_MEDIUM"), () => 0.9), 27, "a medium is 27.48: 27 or 28");
  assert.equal(claimXpStar(fortress, monster(3, "EXP_MEDIUM"), () => 0.1), 28);
});

test("an unpriced run has no shares to round, and falls back to the star's column", () => {
  const session = runOn({}, 1, floorOf(3, 0, 0));
  assert.equal(claimXpStar(session, monster(1, "EXP_SMALL")), undefined);
});

/**
 * What a floor's generators will make is part of what the node is shared over.
 * The tutorial says so: its 0.6 only comes out with the thirty-four spawns its
 * generators author in the sum. And a defence map is nothing else — every one
 * of its 279 monsters comes out of a generator after the floor is built.
 */
test("a floor is weighed with what its generators will make", () => {
  const gm = { npcByConstant: new Map([["RAIDER", monster(1, "EXP_SMALL")], ["CHIEF", monster(10, "EXP_LARGE")]]) };
  const floor = {
    placements: {
      generator: [
        { spawnConstant: "RAIDER", maxSpawns: 20 },
        { spawnConstant: "CHIEF", maxSpawns: 1 },
        { spawnConstant: "REWARD_CHEST_A", maxSpawns: 1 },
      ],
    },
  };
  assert.equal(generatorXpWeight(gm, floor), 30);

  // Nothing standing at all: the generators are the whole floor.
  const defence = { mapPage: { TotalEnemyXP: 300 }, floorCount: 1, floorSettled: false };
  beginRunXp(defence);
  settleFloorXp(defence, 0, generatorXpWeight(gm, floor));
  assert.equal(xpWorthOf(defence, monster(1, "EXP_SMALL")), 10);

  // Twenty standing and thirty to come: fifty share the node.
  const mixed = { mapPage: { TotalEnemyXP: 300 }, floorCount: 1, floorSettled: false };
  beginRunXp(mixed);
  for (const row of floorOf(20, 0, 0)) countFloorXp(mixed, row);
  settleFloorXp(mixed, 0, generatorXpWeight(gm, floor));
  assert.equal(xpWorthOf(mixed, monster(1, "EXP_SMALL")), 6);
});
