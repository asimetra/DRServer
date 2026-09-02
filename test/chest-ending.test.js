import test from "node:test";
import assert from "node:assert/strict";

/**
 * A run ends when the chest is broken, and the floor decides how long after.
 *
 * The tutorial's boss floor authors the whole chain and nothing about it is
 * this server's to invent:
 *
 *   NPC_LIFE_TRIGGER (the minotaur) -> NOT_GATE -> GEN REWARD_CHEST_A
 *   GEN REWARD_CHEST_A clears -> COLLECT_TREASURE_GO
 *                             -> RESET_TIMER_GATE startDelay=3 -> 3_SECONDS_LEFT
 *                             -> RESET_TIMER_GATE startDelay=7 -> FLOOR_COMPLETION_IMMEDIATE
 *
 * The recorded run agrees to a hundredth: chest broken, then COLLECT at 6.35s,
 * 3_SECONDS_LEFT 3.00s after that, and the run over 6.99s after COLLECT. The
 * 6.35 is the drop — the generator clears when the chest is *gone*, not when
 * it dies, and LOOT_SPAWN_A1 runs 6.04s.
 */

const FLOOR = "castle/arena/db_floor_TUTORIAL_LEVEL_final.json";
const MINOTAUR = "1:5.1336431165310";

const watch = (session) => {
  const seen = [];
  const send = session.send;
  const started = Date.now();
  session.send = (frame) => {
    if (frame.readUInt16LE(2) === 124) {
      const field = frame.readUInt16LE(8);
      if (field === 201) {
        seen.push({
          at: Date.now() - started,
          what: frame.subarray(12).toString("utf8").replace(/[^\x20-\x7e]/g, ""),
        });
      } else if (field === 216) seen.push({ at: Date.now() - started, what: "dungeonEnding" });
    }
    return send(frame);
  };
  return seen;
};

test("the run does not end until the chest is broken", async () => {
  const { buildFloor } = await import("./helpers/floor.js");
  const { applyDamage } = await import("../src/socket/combat.js");

  const session = (await buildFloor(FLOOR, { tileCount: 24 })).session;
  session.areaDoid ??= 999;
  session.floorSettled = true;
  const seen = watch(session);

  applyDamage(session, session.npcDoids.get(MINOTAUR), 9999);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.ok(
    [...session.actors.values()].some((actor) => /CHEST/i.test(actor.constant ?? "")),
    "killing the boss puts the chest on the floor"
  );
  assert.deepEqual(seen, [], "and says nothing about treasure until somebody breaks it");
  assert.ok(!session.floorCleared, "the floor is not finished by the boss");
});

test("and each line arrives once, on the floor's own clock", async (t) => {
  const { buildFloor } = await import("./helpers/floor.js");
  const { applyDamage } = await import("../src/socket/combat.js");

  const session = (await buildFloor(FLOOR, { tileCount: 24 })).session;
  session.areaDoid ??= 999;
  session.floorSettled = true;

  applyDamage(session, session.npcDoids.get(MINOTAUR), 9999);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const seen = watch(session);
  const [doid, chest] = [...session.actors].find(([, a]) => /CHEST/i.test(a.constant ?? ""));
  applyDamage(session, doid, chest.hitPoints);
  await new Promise((resolve) => setTimeout(resolve, 15000));

  const said = seen.map(({ what }) => what);
  assert.deepEqual(
    said,
    ["COLLECT_TREASURE_GO", "3_SECONDS_LEFT", "dungeonEnding"],
    "the floor wires these three; a second copy from a timer here is one too many"
  );

  const at = (what) => seen.find((e) => e.what === what).at;
  // 6.04s of drop, then the floor's own gates. Loose enough for a scheduler.
  assert.ok(at("COLLECT_TREASURE_GO") > 5500, "COLLECT waits for the coins to finish");
  assert.ok(at("3_SECONDS_LEFT") - at("COLLECT_TREASURE_GO") > 2700, "then three seconds");
  assert.ok(at("dungeonEnding") - at("COLLECT_TREASURE_GO") > 6500, "and seven to the end");
  assert.ok(at("dungeonEnding") < 15000, "and no more than the floor asked for");
});
