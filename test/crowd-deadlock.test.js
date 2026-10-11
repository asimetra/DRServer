import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { tickNpcAi } from "../src/socket/ai.js";
import { applyDamage } from "../src/socket/combat.js";
import { levelsFile } from "../src/socket/floors.js";
import { loadGameMaster } from "../src/gamemaster.js";
import { spawnNpc } from "../src/socket/npc-spawn.js";
import { buildFloor, FLOOR_DOID, HERO_DOID } from "./helpers/floor.js";

/**
 * Two monsters touching never hold each other both ways.
 *
 * Played on 838788c (ice caves, socket-20261011-213513): groups 400-600 from
 * the hero stood 40-180 s with a full route to him. The pair below is the
 * whole of it: their bodies 70.04 apart, a hair past touching, each walk
 * leaning a little into the other. The sweep met each one beside the other
 * at once and stopped it there instead of sliding past; alone, either walks
 * to the hero and swings within 3 s. The floor is the capture's, rebuilt by
 * tools/replay-floor.js; without it the test has nothing to stand on.
 */
const FLOOR = "replay/replay_socket-20261011-213513_1.json";
const HERO = { x: 1887, y: 1997 };
const PAIR = [["ICE_IMP", 2394, 2099], ["FREEZE_IMP", 2406, 2168]];
const GROUP = [...PAIR, ["SHAMAN_IMP", 2473, 2134], ["SUICIDE_BABY_YETI", 2535, 2176]];

const stage = async (cast) => {
  const world = await buildFloor(FLOOR);
  const { session } = world;
  session.stopAi?.();
  session.random = () => 0.5;
  session.heroPosition = { ...HERO };
  session.actors.get(HERO_DOID).position = session.heroPosition;
  for (const [doid, actor] of session.actors) {
    if (doid !== HERO_DOID && actor.ai && actor.ai.moveSpeed > 0) applyDamage(session, doid, 1e9);
  }
  const context = { session, floorDoid: FLOOR_DOID, heroDoid: HERO_DOID, mapNodeId: session.mapNodeId, gm: await loadGameMaster(), isActive: () => true };
  const members = [];
  for (const [constant, x, y] of cast) {
    const doid = await spawnNpc(context, constant, { x, y }, undefined, { returnDoid: true });
    const actor = session.actors.get(doid);
    actor.position.x = x;
    actor.position.y = y;
    actor.ai.engaged = true;
    actor.ai.targetDoid = HERO_DOID;
    members.push(actor);
  }
  return { world, session, members };
};

const run = async (session, ticks) => {
  for (let tick = 0; tick < ticks; tick++) {
    session.heroPosition.x = HERO.x;
    session.heroPosition.y = HERO.y;
    await tickNpcAi(session, 1_000_000 + tick * 250, 0.25);
  }
};

for (const [name, cast] of [["the touching pair", PAIR], ["the four that stood with it", GROUP]]) {
  test(`${name} walk to the hero instead of holding each other`, { skip: !existsSync(levelsFile(FLOOR)) && "no replay floor" }, async (t) => {
    const { world, session, members } = await stage(cast);
    t.after(() => world.session.runScope?.dispose?.());
    const from = members.map((actor) => ({ ...actor.position }));
    await run(session, 40);
    for (const [index, actor] of members.entries()) {
      const moved = Math.hypot(actor.position.x - from[index].x, actor.position.y - from[index].y);
      const left = Math.hypot(actor.position.x - HERO.x, actor.position.y - HERO.y);
      assert.ok(moved > 150, `${actor.constant} stood where it was: moved ${Math.round(moved)}`);
      assert.ok(left < 300, `${actor.constant} is still ${Math.round(left)} from the hero after 10 s`);
    }
  });
}
