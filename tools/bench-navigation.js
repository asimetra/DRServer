#!/usr/bin/env node
/**
 * What a navigation query costs, in players per core.
 *
 *   node tools/bench-navigation.js
 *   node tools/bench-navigation.js --library nordic/temple --seed 5
 *
 * The cheat-mitigation audit proposes validating every claimed position against
 * our colliders, and its performance section says not to run full-floor A* at 5
 * Hz without saying what anything costs. Guessing at that is how a check that
 * catches cheating becomes a way to stop the server: unbounded work on
 * attacker-controlled input is a denial of service whatever else it is.
 *
 * So the answer is measured rather than reasoned about, and it is reported in
 * the unit the decision actually needs — not nanoseconds, but how many players
 * one core carries if this runs for each of them at the client's 5 Hz sampling.
 *
 * Companion to `tools/wall-audit.js`, which scores the same queries for
 * correctness. A rule has to pass both: right often enough to enforce, cheap
 * enough to run.
 */
import { buildFloor } from "../test/helpers/floor.js";
import { findPath, hasLineOfSight, isPositionBlocked } from "../src/socket/navigation.js";

const argument = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1] ?? fallback;
};

/** The hero's body as the client draws it: CollisionSize times Scale. */
const HERO_RADIUS = 26;

/** The client samples its own position five times a second. */
const CLAIM_HZ = 5;

/** A 0.2-second step at the hero's top speed is about a hundred units. */
const STEP = 100;

const main = async () => {
  const library = argument("library", "castle/catacombs");
  const seed = Number(argument("seed", 3));

  const world = await buildFloor(`${library}/tiles.json`, { seed, tileCount: 26 });
  const navigation = world.session.navigation;
  if (!navigation) throw new Error(`${library} seed ${seed} built no navigation`);
  const { bounds } = navigation;

  /**
   * Sampled from where a hero can actually stand, not from anywhere in the
   * rectangle. A position inside a wall leaves `isPositionBlocked` at its first
   * early return and would time the one case that never happens.
   */
  const points = [];
  for (let tries = 0; points.length < 500 && tries < 200000; tries++) {
    const at = {
      x: bounds.minX + Math.random() * (bounds.maxX - bounds.minX),
      y: bounds.minY + Math.random() * (bounds.maxY - bounds.minY),
    };
    if (!isPositionBlocked(navigation, at, HERO_RADIUS)) points.push(at);
  }
  if (!points.length) throw new Error("no standable position found on this floor");

  console.log(
    `${library} seed ${seed}: ${navigation.colliders.length} active colliders ` +
      `(${navigation.staticColliders.length} static), ${navigation.tileKeys.size} tiles, ` +
      `${points.length} sampled positions\n`
  );

  const time = (label, run, iterations) => {
    run(0);
    const started = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) run(i);
    const ns = Number(process.hrtime.bigint() - started) / iterations;
    const perCore = Math.round(1e9 / (ns * CLAIM_HZ));
    const cost = ns >= 1e6 ? `${(ns / 1e6).toFixed(1)} ms` : `${(ns / 1e3).toFixed(1)} µs`;
    console.log(
      `  ${label.padEnd(32)} ${cost.padStart(9)}   ~${perCore.toLocaleString()} players/core`
    );
  };

  const at = (i) => points[i % points.length];
  time("isPositionBlocked r=0", (i) => isPositionBlocked(navigation, at(i), 0), 200000);
  time("isPositionBlocked r=hero", (i) => isPositionBlocked(navigation, at(i), HERO_RADIUS), 200000);
  time(
    `hasLineOfSight ${STEP}u sweep`,
    (i) => {
      const from = at(i);
      hasLineOfSight(navigation, from, { x: from.x + STEP, y: from.y }, HERO_RADIUS);
    },
    50000
  );
  time(
    "findPath (full-floor A*)",
    (i) => findPath(navigation, at(i), at(i * 7 + 3), HERO_RADIUS),
    300
  );

  console.log(
    `\nAt ${CLAIM_HZ} Hz per player. Anything an attacker can trigger on demand ` +
      `must be\nbounded — see the performance section of the cheat-mitigation audit.`
  );
};

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});
