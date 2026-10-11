import assert from "node:assert/strict";
import test from "node:test";
import { attackClassOf, createCrowdMetrics, crowdProfile, mergeCrowd } from "../tools/crowd-metrics.js";

/**
 * The crowd counts the official corpus and the AI harness are both measured
 * with (tools/crowd-metrics.js): a number for one means what it means for
 * the other only while the definitions hold, so they are pinned here.
 */

const hero = { x: 0, y: 0, bx: 0, by: -26, r: 26 };
const knight = (id, x, y, extra = {}) => ({
  id,
  kind: "chase",
  mover: true,
  x,
  y,
  bx: x,
  by: y - 26,
  r: 40,
  reach: 150,
  standoffGap: 0,
  cadenceMs: 1500,
  ...extra,
});

test("a body more than ten inside another's is an overlap; touching is not", () => {
  const metrics = createCrowdMetrics();
  metrics.sample(0, hero, [knight(1, 100, 0), knight(2, 175, 0)]);
  metrics.sample(250, hero, [knight(1, 100, 0), knight(2, 165, 0)]);
  const { engaged, overlap, overlapAny } = metrics.result();
  assert.equal(engaged, 4);
  assert.equal(overlapAny, 4, "five in and fifteen in both touch");
  assert.equal(overlap, 2, "only fifteen in is past ten");
});

test("a chaser held behind another, the hero still, waits; one that walks round it slides", () => {
  const still = createCrowdMetrics();
  // The front one touches the hero; the one behind stands 80 behind it.
  for (let t = 0; t <= 1000; t += 250) still.sample(t, hero, [knight(1, 66, 0), knight(2, 146, 0)]);
  assert.equal(still.result().blocked.n, 1);
  assert.equal(still.result().blockedHeroStill.waits, 1);

  const round = createCrowdMetrics();
  for (let t = 0; t <= 1000; t += 250) round.sample(t, hero, [knight(1, 66, 0), knight(2, 146, t / 10)]);
  assert.equal(round.result().blocked.slides, 1);
});

test("a swing is at its walk's end, on the way in, or held short of both", () => {
  const metrics = createCrowdMetrics();
  // Monster 1 walks in 30 a tick and swings at 100; monster 2 stands at 140 and swings.
  for (let t = 0; t <= 500; t += 250) {
    const swung = t === 500 ? [{ id: 1, what: "contact" }, { id: 2, what: "contact" }] : [];
    metrics.sample(t, hero, [knight(1, 160 - (t / 250) * 30, 30), knight(2, 0, 140)], swung);
  }
  const { swings, due } = metrics.result();
  assert.equal(swings["chase contact"].swings, 2);
  assert.equal(swings["chase contact"].advancing, 1);
  assert.equal(swings["chase contact"].allowed, 1);
  assert.equal(due.heldSwung, 1);
  assert.equal(due.allowedSwung, 1);
});

test("a kiter's walk ends at its standoff, and two results add up", () => {
  const profile = crowdProfile(
    { behavior: "KITE_AI", moveSpeed: 200, radius: 35, attacks: [{ range: 600, projectile: {} }], keepDistance: 300, attackRange: 600 },
    26
  );
  assert.equal(profile.kind, "kite");
  assert.equal(profile.reach, 600);
  assert.equal(profile.standoffGap, 300 - 61);
  const one = createCrowdMetrics();
  one.sample(0, hero, [knight(1, 100, 0)]);
  assert.equal(mergeCrowd([one.result(), one.result()]).engaged, 2);
});

test("a swing is a shot, a contact swing, or something else", () => {
  assert.equal(attackClassOf({ Projectile: "ARROW", Range: 600 }), "shot");
  assert.equal(attackClassOf({ Range: 80 }), "contact");
  assert.equal(attackClassOf({ Range: 140 }), "contact");
  assert.equal(attackClassOf({ Range: 250 }), "other");
  assert.equal(attackClassOf({ Range: 100, MoveAmount: 40 }), "other");
});
