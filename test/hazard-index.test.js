import assert from "node:assert/strict";
import test from "node:test";

import { hazardCandidateDoids, hazardVictims } from "../src/socket/combat.js";
import { CLID } from "../src/socket/opcodes.js";

test("hazards exact-test only actors in nearby spatial cells and reuse one floor-tick index", () => {
  const actors = new Map();
  const objects = new Map();
  for (let index = 0; index < 1000; index++) {
    const doid = 10_000 + index;
    actors.set(doid, {
      hitPoints: 100,
      maxHitPoints: 100,
      collisionRadius: 20,
      position: { x: index * 500, y: 0 },
      team: 6,
      isEnemy: true,
    });
    objects.set(doid, CLID.DistributedNPCGameObject);
  }
  const session = { actors, objects };
  const collider = { type: "circle", x: 0, y: 0, radius: 50 };
  const now = 1234;

  const candidates = hazardCandidateDoids(session, [collider], now);
  const index = session.hazardVictimIndex;
  assert.ok(candidates.has(10_000));
  assert.ok(candidates.size < 10, `nearby query retained ${candidates.size}/1000 actors`);

  const victims = hazardVictims(session, [collider], null, now);
  assert.deepEqual(victims.map(({ doid }) => doid), [10_000]);

  hazardCandidateDoids(
    session,
    [{ type: "circle", x: 500, y: 0, radius: 50 }],
    now
  );
  assert.equal(session.hazardVictimIndex, index, "each hazard rebuilt the actor grid");
});
