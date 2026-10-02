import assert from "node:assert/strict";
import test from "node:test";

import { applyTargetBuff } from "../src/socket/combat.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { startManaRegen } from "../src/socket/regen.js";
import { awardDungeonCompletion } from "../src/socket/rewards.js";
import { removeHeroFromFloor } from "../src/socket/summary.js";

/**
 * Nothing is addressed to a hero the client no longer holds.
 *
 * Walking out of an ordinary dungeon takes the hero off the floor at once,
 * five seconds before the report, and the floor goes on running underneath.
 * The official server sends that hero nothing more: 80439 objects disabled
 * across its recordings and not one field update for any of them afterwards.
 * This server sent three kinds — the next Mana tick, a burning monster's
 * floater and the completion experience — and the client logged each as an
 * update for an object it did not have.
 */

const HERO = 500;
const MONSTER = 20;
const FLID_HERO_MANA_POINTS = 163;
const FLID_HERO_EXPERIENCE_POINTS = 164;
const FLID_HERO_REPORT_BUFF_EFFECT = 168;

/** Field updates addressed to `doid`, as the field ids they carry. */
const fieldsSentTo = (frames, doid) =>
  frames
    .filter(
      (frame) =>
        frame.readUInt16LE(2) === OP.CLIENT_OBJECT_UPDATE_FIELD && frame.readUInt32LE(4) === doid
    )
    .map((frame) => frame.readUInt16LE(8));

test("mana stops arriving once the hero is off the floor", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });

  const sent = [];
  const session = {
    id: 90,
    heroDoid: HERO,
    dungeonActive: true,
    heroManaPoints: 0,
    maxHeroManaPoints: 200,
    dungeonAvatar: { avatar_id: 101 },
    objects: new Map([[HERO, CLID.HeroGameObject]]),
    actors: new Map([[HERO, { hitPoints: 400, maxHitPoints: 400 }]]),
    send: (frame) => sent.push(frame),
  };
  session.stopManaRegen = await startManaRegen(session);

  t.mock.timers.tick(5000);
  assert.deepEqual(fieldsSentTo(sent, HERO), [FLID_HERO_MANA_POINTS], "while it is there, it regenerates");

  removeHeroFromFloor(session);
  sent.length = 0;
  t.mock.timers.tick(15_000);

  assert.deepEqual(fieldsSentTo(sent, HERO), [], "and a hero that has left is sent no more of it");
  assert.equal(session.stopManaRegen, null, "the trickle is stopped, not merely muted");
});

test("a monster still burns after the hero leaves, but nobody is told the number", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });

  const sent = [];
  const session = {
    id: 91,
    heroDoid: HERO,
    dungeonActive: true,
    floorDoid: 55,
    allocateDoid: () => 900,
    objects: new Map([
      [HERO, CLID.HeroGameObject],
      [MONSTER, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [MONSTER, { hitPoints: 100_000, maxHitPoints: 100_000, constant: "SHAMAN_IMP", isEnemy: true }],
    ]),
    send: (frame) => sent.push(frame),
  };
  await applyTargetBuff(session, {
    attack: { TargetBuff1: "FIRE_L1" },
    victimDoid: MONSTER,
    attackerDoid: HERO,
    damage: 1000,
  });

  t.mock.timers.tick(1000);
  assert.ok(
    fieldsSentTo(sent, HERO).includes(FLID_HERO_REPORT_BUFF_EFFECT),
    "while the hero is there, its burn is reported to it"
  );
  const afterFirstTick = session.actors.get(MONSTER).hitPoints;

  removeHeroFromFloor(session);
  sent.length = 0;
  t.mock.timers.tick(1000);

  assert.ok(session.actors.get(MONSTER).hitPoints < afterFirstTick, "the burn goes on");
  assert.deepEqual(fieldsSentTo(sent, HERO), [], "but its floater has no hero to go to");
});

/**
 * The same burn, when it is what finishes the monster and the weapon pays
 * Buster for a kill: the points went to the hero that had already left.
 */
test("a kill the hero is not there for pays it no Buster and no Mana", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });

  const sent = [];
  const session = {
    id: 93,
    heroDoid: HERO,
    dungeonActive: true,
    floorDoid: 55,
    allocateDoid: () => 900,
    dungeonBusterPoints: 0,
    maxDungeonBusterPoints: 1000,
    // The Ranger's "Buster on kill" legendary.
    heroWeapons: [{ legendarymodifier: 7 }],
    objects: new Map([
      [HERO, CLID.HeroGameObject],
      [MONSTER, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [MONSTER, { hitPoints: 150, maxHitPoints: 100_000, constant: "SHAMAN_IMP", isEnemy: true }],
    ]),
    send: (frame) => sent.push(frame),
  };
  await applyTargetBuff(session, {
    attack: { TargetBuff1: "FIRE_L1" },
    victimDoid: MONSTER,
    attackerDoid: HERO,
    damage: 1000,
  });

  removeHeroFromFloor(session);
  sent.length = 0;
  t.mock.timers.tick(3000);

  assert.equal(session.actors.get(MONSTER)?.dead ?? true, true, "the burn finished it");
  assert.deepEqual(fieldsSentTo(sent, HERO), [], "and the hero that left is told nothing of it");
});

/**
 * The completion bonus is the report's to show. Across 47 recorded endings the
 * official sends no experience update after `dungeonEnding` on either kind of
 * node — the report carries the bonus as its own line and the client counts the
 * bar up from the total before it.
 */
for (const [title, onFloor] of [
  ["a hero that already walked out", false],
  ["a hero still standing on a boss floor", true],
]) {
  test(`finishing a node banks the bonus without announcing it to ${title}`, async () => {
    const sent = [];
    const session = {
      id: 92,
      heroDoid: HERO,
      objects: new Map(onFloor ? [[HERO, CLID.HeroGameObject]] : []),
      dungeonAccount: { basic_currency: 0, basic_keys: 0, completed_dungeons: 0 },
      dungeonAvatar: { id: 1, experience: 1_000 },
      mapPage: { Name: "Knight Fortress 1-1", NodeType: "DUNGEON", BitIndex: 4, CompletionXPBonus: 110 },
      persistDungeonAccount: async () => {},
      send: (frame) => sent.push(frame),
    };

    await awardDungeonCompletion(session);

    assert.equal(session.dungeonAvatar.experience, 1_110, "the bonus is paid");
    assert.equal(session.completionXpBase, 1_000, "and the report still starts from before it");
    assert.equal(
      fieldsSentTo(sent, HERO).includes(FLID_HERO_EXPERIENCE_POINTS),
      false,
      "the report shows it; the hero is not sent it"
    );
  });
}
