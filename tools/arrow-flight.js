/**
 * How far every launcher on a floor actually shoots.
 *
 *   node tools/arrow-flight.js trap-test/db_floor_TRAPS_NORDIC_CAVES.json
 *
 * An arrow trap is the hardest thing here to judge by eye: the shot is small,
 * it is fast, and when it dies at the muzzle what a player sees is a trap that
 * does nothing. "The arrow is born and dies" was the report, and it took a
 * number to become a bug — the ice caves\' Y-firing gargoyle flew 12 of its
 * authored 800.
 *
 * So the floor is built for real, every launcher is fired, and each flight is
 * run to its end against the same navigation the game uses. A shot that stops
 * short is not automatically wrong: a trap aimed across a corridor should stop
 * at the far wall. What the column is for is telling those two apart.
 */
import fs from "node:fs/promises";
import path from "node:path";

const { loadFloor } = await import("../src/socket/floors.js");
const { createNavigationState, loadNavigationLibrary } = await import(
  "../src/socket/navigation.js"
);
const { attackForConstant, npcForConstant, projectileForConstant, weaponForConstant } =
  await import("../src/gamemaster.js");
const { tickTrapProjectiles } = await import("../src/socket/combat.js");
const { raiseHazard } = await import("../src/socket/hazards.js");
const { CLID } = await import("../src/socket/opcodes.js");

await loadNavigationLibrary();

const file = process.argv[2];
const floor = await loadFloor(file);
const navigation = createNavigationState(floor.navigation);

const launchers = [];
for (const placement of floor.placements?.triggerable ?? []) {

  const npc = await npcForConstant(placement.constant);
  const attack = npc?.Attack1 && (await attackForConstant(npc.Attack1));
  const projectile = attack?.Projectile && (await projectileForConstant(attack.Projectile));
  if (projectile) launchers.push({ placement, npc, attack, projectile });
}

console.log(`${path.basename(file)}: ${launchers.length} launcher placement(s)`);
const byConstant = new Map();

for (const { placement, npc, attack, projectile } of launchers) {
  const session = {
    id: 1,
    dungeonActive: true,
    heroDoid: 7001,
    heroPosition: { x: -99999, y: -99999 },
    navigation,
    objects: new Map([[9101, CLID.DistributedNPCGameObject]]),
    actors: new Map(),
    triggerableDoids: new Map([["t", 9101]]),
    triggerableAttacks: new Map([["t", attack.Id]]),
    triggerableHazards: new Map([
      ["t", {
        attack,
        npc,
        projectile,
        position: placement,
        heading: placement.heading ?? npc.DefaultHeading ?? 0,
        combatColliders: [],
        weaponPower: (npc.Weapon1 && (await weaponForConstant(npc.Weapon1))?.Power) || 1,
      }],
    ]),
    send: () => {},
  };

  raiseHazard(session, "t");
  const shot = session.activeTrapProjectiles?.[0];
  const range = shot?.range ?? 0;
  let travelled = 0;
  for (let i = 0; i < 400 && session.activeTrapProjectiles?.length; i += 1) {
    travelled = session.activeTrapProjectiles[0]?.traveled ?? travelled;
    await tickTrapProjectiles(session, 0.02);
  }

  const row = byConstant.get(placement.constant) ?? { shots: [], range, heading: new Set() };
  row.shots.push(Math.round(travelled));
  row.heading.add(Math.round(placement.heading ?? npc.DefaultHeading ?? 0));
  byConstant.set(placement.constant, row);
}

console.log(`  ${"launcher".padEnd(38)} ${"range".padStart(6)} ${"travelled".padStart(24)}  headings`);
for (const [constant, row] of byConstant) {
  const short = row.shots.filter((d) => d < row.range * 0.5).length;
  const mark = short ? `  <-- ${short}/${row.shots.length} die in the first half` : "";
  console.log(
    `  ${constant.padEnd(38)} ${String(row.range).padStart(6)} ${row.shots.join(",").padStart(24)}  ` +
      `${[...row.heading].join(",")}${mark}`
  );
}
