import test from "node:test";
import assert from "node:assert/strict";
import { checkFloorCleared } from "../src/socket/floorstate.js";
import { CLID, OP } from "../src/socket/opcodes.js";

/**
 * A dead monster leaves the floor.
 *
 * Every actor this server ever spawned stayed in `session.actors` for the rest
 * of the run, so a catacombs floor finished holding 141 enemies of which only a
 * handful were alive. Everything that sweeps the floor — trap victims, hazard
 * victims, the AI's target search — walked all of them on every tick.
 *
 * The official does not keep them. Across the recordings 9015 of 9051 dead
 * monsters are disabled, and not one of them takes longer than 43ms: the median
 * is a single millisecond, so the corpse goes in the same breath as the death.
 * The 36 without a disable are the ones still on screen when the log stops.
 */

const disablesIn = (sent) =>
  sent
    .filter((frame) => frame.readUInt16LE(2) === OP.CLIENT_OBJECT_DISABLE_RESP)
    .map((frame) => frame.readUInt32LE(4));

const build = () => {
  const sent = [];
  return {
    sent,
    session: {
      id: 1,
      objects: new Map([
        [700, CLID.DistributedNPCGameObject],
        [701, CLID.DistributedNPCGameObject],
        [702, CLID.HeroGameObject],
      ]),
      actors: new Map([
        [700, { hitPoints: 10, maxHitPoints: 10, isEnemy: true, position: { x: 5, y: 6 } }],
        // CASTLE_ARENA_GATE_B: Species DOOR, PermCorpse, twenty-five hit points.
        [701, { hitPoints: 25, maxHitPoints: 25, permCorpse: true }],
        [702, { hitPoints: 30, maxHitPoints: 30, position: { x: 1, y: 2 } }],
      ]),
      heroDoid: 702,
      send: (frame) => sent.push(frame),
      beginFloorFailing: () => {},
    },
  };
};

test("a dead monster is disabled and leaves both maps", async () => {
  const { applyDamage } = await import("../src/socket/combat.js");
  const { sent, session } = build();

  applyDamage(session, 700, 10);

  assert.ok(disablesIn(sent).includes(700), "the client is told to destroy it");
  assert.ok(!session.actors.has(700), "and it stops being swept");
  assert.ok(!session.objects.has(700), "and stops being addressable");
});

test("a gate breaks in place and a fallen hero stays where it fell", async () => {
  const { applyDamage } = await import("../src/socket/combat.js");
  const { sent, session } = build();

  applyDamage(session, 701, 25);
  assert.ok(!disablesIn(sent).includes(701), "a gate leaves its broken half standing");
  assert.ok(session.actors.has(701), "so it is still there to collide with");

  applyDamage(session, 702, 30);
  assert.ok(!disablesIn(sent).includes(702), "a fallen hero can still be revived");
  assert.ok(session.actors.has(702), "so it keeps its place on the floor");
});

/**
 * Removal happens after the death hook, never before it.
 *
 * `spawnNpcRewards`, `playDeathAttack` and the boss chest all read
 * `session.actors.get(doid).position` to place themselves, each falling back to
 * the generator's own coordinates when the actor is missing. Clearing the actor
 * one step early is therefore silent: the loot still drops, just back at the
 * spawn point instead of where the monster fell.
 */
test("the death hook still finds the body it is about to bury", async () => {
  const { applyDamage } = await import("../src/socket/combat.js");
  const { session } = build();
  let seen;
  session.actors.get(700).onDeath = (doid) => {
    seen = session.actors.get(doid)?.position;
  };

  applyDamage(session, 700, 10);

  assert.deepEqual(seen, { x: 5, y: 6 }, "loot lands where it died, not where it spawned");
});

/**
 * Clearing used to be read off the floor: count the enemies, count the living
 * ones, and a floor with no enemies at all could not be cleared — otherwise
 * smashing the last barrel would end the dungeon. Once corpses go, that count
 * falls to zero the moment the last monster dies, which is exactly when the
 * floor should clear. So the floor remembers how many it had.
 */
/**
 * A barrel is not gone until it has finished going off.
 *
 * Taking the object away at the moment of death is a mistake this server has
 * already made once and recorded: "the bomb vanished without exploding". The
 * official does not make it. Of 9047 recorded deaths 96% are told they died
 * within 120ms of losing their last hit point — the granularity of its own
 * loop — but a distinct 3.5% wait between 1.5 and 4 seconds, which is where
 * the authored death attacks land: a barrel's blast runs 1208ms, a thrown
 * bomb's 1583ms, and the party bomb's 2792ms.
 */
test("a barrel keeps its body until its blast has finished", async (t) => {
  const { applyDamage } = await import("../src/socket/combat.js");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sent, session } = build();
  session.actors.get(700).deathEffectMs = 1208;

  applyDamage(session, 700, 10);
  assert.ok(session.actors.has(700), "it is still there while the blast plays");
  assert.ok(!disablesIn(sent).includes(700), "and the client still has it to draw");

  t.mock.timers.tick(1208);
  assert.ok(!session.actors.has(700), "and only then does it go");
  assert.ok(disablesIn(sent).includes(700), "along with the object itself");
});

test("a floor still clears once its last enemy is gone rather than merely dead", () => {
  const session = {
    id: 1,
    areaDoid: 1000,
    enemiesSeen: 3,
    actors: new Map([[9, { isEnemy: false }]]),
    floorExits: [{ x: 0, y: 0, radius: 10 }],
    send: () => {},
  };

  assert.equal(checkFloorCleared(session), true);
});

test("and a floor that never had an enemy is not cleared by its scenery", () => {
  const session = {
    id: 1,
    areaDoid: 1000,
    actors: new Map([[9, { isEnemy: false }]]),
    floorExits: [{ x: 0, y: 0, radius: 10 }],
    send: () => {},
  };

  assert.equal(checkFloorCleared(session), false);
});

/**
 * A body stays as long as its death timeline is still doing something —
 * which is not the same as as long as it is still hitting anybody.
 *
 * `deathEffectMs` was read off the colliders, on the reasoning that a barrel's
 * blast is what keeps it on screen. That holds for a barrel and fails for the
 * one death the game ends on: `REWARD_CHEST_A` dies into `LOOT_SPAWN_A1`,
 * which has no colliders at all — its DamageMod is zero — and forty-seven
 * `spawndoober` actions running to frame 145. Measured at zero, the chest was
 * destroyed on the client the instant it broke, and then six seconds of coins
 * flew out of nothing.
 */
test("a chest outlives its own shower of coins", async () => {
  const { loadGameMaster, npcForConstant, attackForConstant } = await import(
    "../src/gamemaster.js"
  );
  const { deathEffectMsFor } = await import("../src/socket/dungeon.js");

  const gm = await loadGameMaster();
  const chest = await npcForConstant("REWARD_CHEST_A");
  const attack = await attackForConstant(chest.DeathAttack);

  const held = deathEffectMsFor(gm, attack);
  assert.ok(held > 5500, `the chest is taken away after ${held}ms of a 6042ms drop`);
  assert.ok(held < 7000, "and not held open past what the timeline actually does");
});

test("and a barrel is still measured by the blast that is its last act", async () => {
  const { loadGameMaster, attackForConstant } = await import("../src/gamemaster.js");
  const gm = await loadGameMaster();
  const blast = await attackForConstant("EN_EXPLODING_BARREL_DEATH_ARENA");
  const { deathEffectMsFor } = await import("../src/socket/dungeon.js");

  // Frame 29 at 24fps: the collider is the last thing this timeline does, so
  // reading actions rather than colliders must not move it.
  assert.equal(Math.round(deathEffectMsFor(gm, blast)), 1208);
});

test("a death that does nothing holds nothing open", async () => {
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const { deathEffectMsFor } = await import("../src/socket/dungeon.js");
  assert.equal(deathEffectMsFor(await loadGameMaster(), null), 0);
});
