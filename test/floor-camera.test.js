import assert from "node:assert/strict";
import test from "node:test";

import { buildCameraShake, buildCameraZoom, shakeFloorCamera, zoomFloorCamera } from "../src/socket/floorstate.js";
import { floorPlanForMapNode, loadFloorAt } from "../src/socket/floors.js";
import { emitSignal, trackTriggers } from "../src/socket/triggers.js";

/**
 * The camera a floor directs.
 *
 * Three maps place camera objects among their triggerables — the Lava Golem's
 * nineteen, the Ice Dragon's three, the princess's two — and wire them like any
 * other: a proximity trigger for the corridor's stomps, the golem's own
 * timeline events for the arena pulling back and closing in. The client builds
 * none of them (TileFactory lists the type among those it skips) and has no
 * handler of its own, so the effect only ever happens when the server says so
 * on the floor: `trigger_camera_shake` and `trigger_camera_zoom`.
 *
 * This server read the objects as nothing and sent neither. A recorded Lava
 * Golem run carries 48 of them, each one accounted for by the map's wiring.
 */

const FLOOR = 42;

const body = (frame) => frame.subarray(2).toString("hex");

test("the two camera messages are byte for byte what was recorded", () => {
  // Floor 50076848: shake for 8 frames, strength 12, five times.
  assert.equal(
    body(buildCameraShake(50076848, { shakeDuration: 8, shakeStrength: 12, shakeCount: 5 })),
    "7c00b01cfc02cc00000000410000404105"
  );
  // Floor 50078388: pull back to 0.86.
  assert.equal(body(buildCameraZoom(50078388, 0.86)), "7c00b422fc02cb00f6285c3f");
});

test("the golem's map keeps its camera objects, with what they author", async () => {
  const plan = await floorPlanForMapNode(50020, { seed: 1 });
  const cameras = [];
  for (let index = 0; index < plan.floors.length; index++) {
    const floor = await loadFloorAt(plan, index);
    cameras.push(...floor.placements.triggerable.filter((entry) => /^CAMERA_/.test(entry.constant)));
  }

  const shakes = cameras.filter((entry) => entry.constant === "CAMERA_SHAKE_TRIGGERABLE");
  const zooms = cameras.filter((entry) => entry.constant === "CAMERA_ZOOM_TRIGGERABLE");
  assert.ok(shakes.length > 0, "the corridor stomps");
  assert.ok(zooms.length > 0, "and the arena's zoom");
  for (const shake of shakes) {
    assert.ok(shake.shakeDuration > 0 && shake.shakeStrength > 0 && shake.shakeCount > 0);
  }
  assert.ok(zooms.some((zoom) => zoom.zoom < 1), "one pulls back");
  assert.ok(zooms.some((zoom) => zoom.zoom === 1), "and one returns");
});

const wired = (camera) => {
  const sent = [];
  const session = {
    id: 3,
    floorDoid: FLOOR,
    send: (frame) => sent.push(frame),
    shakeFloorCamera,
    zoomFloorCamera,
  };
  trackTriggers(session, {
    placements: {
      heroSpawn: [],
      npc: [],
      collectable: [],
      generator: [],
      trigger: [],
      logicGate: [],
      triggerable: [{ id: "camera", ...camera }],
    },
    wiring: new Map([["source", ["camera"]]]),
  });
  return { session, sent };
};

test("a camera object fires when its wiring switches it on, and only then", () => {
  const { session, sent } = wired({
    constant: "CAMERA_SHAKE_TRIGGERABLE",
    shakeDuration: 60,
    shakeStrength: 12,
    shakeCount: 32,
    zoom: 1,
  });

  emitSignal(session, "source", true);
  assert.deepEqual(sent.map(body), ["7c002a000000cc0000007042000040412" + "0"]);

  emitSignal(session, "source", false);
  assert.equal(sent.length, 1, "switching it off undoes nothing");

  emitSignal(session, "source", true);
  assert.equal(sent.length, 2, "and each new rise is another shake");
});

/**
 * Which message is the constant's to say, not the numbers'. Every shake object
 * authors `zoom: 1` and none of them ever sent a zoom, while a zoom object
 * authoring 1 sent it seventeen times — that is the arena closing back in.
 */
test("a zoom object zooms, even back to one, and never shakes", () => {
  const { session, sent } = wired({
    constant: "CAMERA_ZOOM_TRIGGERABLE",
    shakeDuration: 8,
    shakeStrength: 12,
    shakeCount: 0,
    zoom: 1,
  });

  emitSignal(session, "source", true);
  assert.deepEqual(sent.map(body), ["7c002a000000cb000000803f"]);
});
