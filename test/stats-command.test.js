import assert from "node:assert/strict";
import test from "node:test";

import { COMMAND_PREFIX, resetCommands, runCommand } from "../src/socket/commands.js";
import { registerBuiltinCommands } from "../src/socket/command-set.js";

/**
 * `/stats` reports what a hero's numbers are at the moment it is asked.
 *
 * Worth pinning are the things it exists to say and no screen in the game
 * does: the share of an incoming hit that is turned aside, that a live buff is
 * folded into what is shown, and that a slot whose points never reach the
 * totals says where they went instead.
 *
 * The Berserker is the hero to ask. `MASTER_DEFENSE` in its fourth slot is the
 * only trained defence any hero has — 0.0033 a point, so a full 75 measures
 * almost exactly a quarter — and `BERSERK_DB` is the one buff that turns aside
 * all of it. One hero covers both ends of the range.
 */

const BERSERKER = 101; // MELEE_ATK | FURY | HP_BOOST | MASTER_DEFENSE

const onFloor = (overrides = {}) => ({
  id: 7,
  accountId: 500,
  dungeonAccount: { id: 500, name: "Simetra" },
  heroDoid: 500,
  floorDoid: 400,
  dungeonAvatar: {
    avatar_id: BERSERKER,
    experience: 876615,
    statupgrade1: 75,
    statupgrade2: 0,
    statupgrade3: 50,
    statupgrade4: 75,
  },
  actors: new Map([[500, { hitPoints: 640, maxHitPoints: 880 }]]),
  heroManaPoints: 143,
  maxHeroManaPoints: 200,
  ...overrides,
});

/** The whole readout, and how many chat entries it cost to send. */
let said = [];
const run = async (session) => {
  said = [];
  const reply = (message) => said.push(message);
  reply.warn = (message) => said.push(message);
  await runCommand(session, `${COMMAND_PREFIX}stats`, reply);
  return said.join("\n");
};

const line = (pattern) => said.join("\n").split("\n").find((text) => pattern.test(text));

test.beforeEach(() => {
  resetCommands();
  registerBuiltinCommands();
});

test("stats refuses outside a floor rather than reporting nothing", async () => {
  await run(onFloor({ dungeonAvatar: undefined, heroDoid: undefined }));
  assert.equal(said.length, 1);
  assert.match(said[0], /not on a floor/);
});

/**
 * The client keeps fifty chat lines and concatenates them into one text field,
 * so a reply per line would cost a tenth of the player's history each time this
 * is run. Newlines inside one message cost a single entry.
 */
test("stats answers in one message, however many lines it has", async () => {
  const report = await run(onFloor());
  assert.equal(said.length, 1, "one chat entry");
  assert.ok(report.split("\n").length > 5, "and it is still a multi-line report");
});

test("stats names the hero and its level, and stops there", async () => {
  await run(onFloor());
  assert.match(said[0].split("\n")[0], /^BERSERKER lv \d+$/);
});

test("stats reports the live bars and what mana is coming back at", async () => {
  await run(onFloor());
  assert.ok(
    line(/^health 640\/880 · mana 143\/200 \+3\/5s$/),
    "the Berserker regenerates three, and the period is the one the game uses"
  );
});

/**
 * The number no screen in the game shows. A full `MASTER_DEFENSE` is 75 points
 * at 0.0033 each, which is 24.75% and rounds to a quarter — and it is listed
 * against every damage type, because that slot feeds all three.
 */
test("stats reports defence as the share of a hit it turns aside", async () => {
  await run(onFloor());
  assert.ok(line(/^melee {4}deal \+[\d.]+ · take −25%$/), "melee");
  assert.ok(line(/^shooting deal \+[\d.]+ · take −25%$/), "shooting");
  assert.ok(line(/^magic {4}deal \+[\d.]+ · take −25%$/), "magic");
});

test("an untrained defence turns nothing aside", async () => {
  const RANGER = 102; // no MASTER_DEFENSE anywhere in its four slots
  await run(
    onFloor({
      dungeonAvatar: {
        avatar_id: RANGER,
        experience: 500000,
        statupgrade1: 75,
        statupgrade2: 75,
        statupgrade3: 0,
        statupgrade4: 0,
      },
    })
  );
  assert.ok(line(/^melee {4}deal \+[\d.]+ · take −0%$/), "a Ranger tanks nothing, however trained");
});

/**
 * A buff is a multiplier combat applies at the moment of a hit rather than a
 * change to the stored vector, so the base is kept beside the product: seeing
 * only `379.5` would leave no way to tell training from a potion.
 */
test("stats folds a live buff into the numbers and shows both halves", async () => {
  await run(
    onFloor({
      activeBuffs: new Map([
        [
          9,
          {
            affectedActor: 500,
            buff: {
              Constant: "BERSERK_DB",
              MELEE_ATK: 1.5,
              MOVEMENT: 1.3,
              MELEE_DEF: 100,
              SHOOT_DEF: 100,
              MAGIC_DEF: 100,
            },
          },
        ],
        [10, { affectedActor: 501, buff: { Constant: "SOMEBODY_ELSES", MELEE_ATK: 99 } }],
      ]),
    })
  );

  assert.ok(line(/^melee {4}deal \+[\d.]+ ×1\.5 = [\d.]+ · take −100%$/), "attack, and total immunity");

  const buffs = line(/^buffs /);
  assert.match(buffs, /BERSERK_DB/);
  assert.doesNotMatch(buffs, /SOMEBODY_ELSES/, "a buff on another actor is not this hero's");
});



/**
 * The stored vector rather than a fresh calculation. `session.heroStats` is
 * what combat prices hits against, so if it ever went stale that is the fault
 * this command should expose instead of papering over.
 */
test("stats reports the vector combat holds, not one it recomputes", async () => {
  await run(onFloor({ heroStats: new Map([["MELEE_ATK", 999]]) }));
  assert.ok(line(/^melee {4}deal \+999 · take −0%$/), "the held value, and nothing added back");
});


/**
 * Training is what this readout is not. Which slot holds which stat, and how
 * many points are in it, reads the same before a floor as after one and the
 * client's own screen already shows it — carrying it here buried the handful
 * of lines that do change.
 */
test("stats reports no training, only what a run can change", async () => {
  const report = await run(onFloor());

  assert.doesNotMatch(report, /slot \d/, "no slot listing");
  assert.doesNotMatch(report, /points placed/, "no points total");
  assert.doesNotMatch(report, /Ultimate Defense/, "the stat behind the defence line is not named");
});

test("stats reports the buster meter, which only a floor fills", async () => {
  await run(onFloor({ dungeonBusterPoints: 48, maxDungeonBusterPoints: 120 }));
  assert.ok(line(/^buster 48\/120$/));
});

/**
 * `MAGIC_COOLDOWN` is the Sorcerer's third slot and nobody else's, so the line
 * is written only when there is something to say — a `−0%` on five heroes out
 * of six is noise in a readout whose whole point is the four numbers that move.
 */
test("cooldown is reported for the one hero that trains it, and nobody else", async () => {
  const trained = (avatarId) => ({
    avatar_id: avatarId,
    experience: 500000,
    statupgrade1: 25,
    statupgrade2: 25,
    statupgrade3: 75,
    statupgrade4: 25,
  });

  await run(onFloor({ dungeonAvatar: trained(103) })); // SORCERER
  assert.ok(line(/^cooldown −25%$/), "a fully bought Sorcerer takes a quarter off");

  await run(onFloor({ dungeonAvatar: trained(101) })); // BERSERKER
  assert.equal(line(/^cooldown /), undefined, "and a Berserker is not told about zero");
});

/**
 * Movement is the client's. This server audits a claimed position rather than
 * authoring one, so a movement number here would be what it believes the
 * client ought to be doing — which agrees with the client right up until
 * something is wrong, which is when somebody reads it.
 *
 * Health and mana are not in that company and must stay: nothing but this
 * server writes either, and the client never sends them.
 */
test("stats reports nothing this server does not own", async () => {
  const report = await run(
    onFloor({
      activeBuffs: new Map([
        [9, { affectedActor: 500, buff: { Constant: "SPEED_BOOSTER_L3", MOVEMENT: 1.3 } }],
      ]),
    })
  );

  assert.doesNotMatch(report, /move/, "no movement, buffed or otherwise");
  assert.doesNotMatch(report, /client-side/, "and nothing hedged as somebody else's");
  assert.ok(line(/^health 640\/880 · mana 143\/200/), "health and mana are this server's");
});
