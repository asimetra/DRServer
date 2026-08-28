/**
 * Every weapon's attacks, and which of them need this server to do something.
 *
 * A hero's swing is drawn by the client from its own timeline, so most of what
 * an attack looks like needs nothing from here. Some actions in that timeline
 * are not drawing, though — placing something on the floor, putting a
 * projectile in the air, granting a buff — and those only happen if this server
 * makes them happen. An attack whose visible half is client-side and whose
 * server half is missing looks exactly like "the animation is broken".
 *
 *   node tools/weapon-audit.js            # everything that needs the server
 *   node tools/weapon-audit.js --all      # including the purely client-side
 */
import { loadGameMaster } from "../src/gamemaster.js";

/** Timeline actions this server has to answer for, and what answers them. */
const SERVER_ACTIONS = new Map([
  ["spawnnpc", "placeables.js"],
  ["spawnNpcForAttack", "placeables.js"],
  ["projectile", "combat.js projectiles"],
]);

const actionsOf = (gm, attack) => {
  const timeline = gm.timelines.get(attack?.AttackTimeline);
  const seen = new Map();
  for (const frame of timeline?.frames ?? []) {
    for (const action of frame.actions ?? []) {
      // A `#` prefix is the data disabling itself.
      const type = String(action.type ?? "");
      if (type.startsWith("#")) continue;
      seen.set(type, [...(seen.get(type) ?? []), { ...action, frame: frame.frame }]);
    }
  }
  return seen;
};

const main = async () => {
  const all = process.argv.includes("--all");
  const gm = await loadGameMaster();
  const rows = [];

  for (const item of gm.raw.WeaponItem ?? []) {
    for (const [slot, constant] of [
      ["attack", item.Attack1],
      ["charge", item.ChargeAttack],
    ]) {
      if (!constant) continue;
      const attack = gm.attacksByConstant.get(constant);
      if (!attack) {
        rows.push({ weapon: item.Constant, slot, constant, note: "names no Attack row" });
        continue;
      }
      const actions = actionsOf(gm, attack);
      const needs = [...actions.keys()].filter((type) => SERVER_ACTIONS.has(type));
      if (!needs.length && !all) continue;

      const spawns = [
        ...(actions.get("spawnnpc") ?? []),
        ...(actions.get("spawnNpcForAttack") ?? []),
      ].map((action) => action.spawnname);
      const missing = spawns.filter((name) => name && !gm.npcByConstant.has(name));

      rows.push({
        weapon: item.Constant,
        slot,
        constant,
        needs,
        spawns,
        missing,
        buff: attack.SelfBuff || attack.TargetBuff1 || "",
      });
    }
  }

  console.log(`${rows.length} weapon attack(s) need something from this server\n`);
  console.log(
    "  " + "weapon".padEnd(30) + "slot".padEnd(8) + "attack".padEnd(26) + "needs"
  );
  for (const row of rows.sort((a, b) => a.weapon.localeCompare(b.weapon))) {
    console.log(
      "  " + row.weapon.padEnd(30) + row.slot.padEnd(8) + row.constant.padEnd(26) +
        (row.note ?? row.needs.join(",")) +
        (row.spawns?.length ? `  places ${row.spawns.join(",")}` : "") +
        (row.missing?.length ? `   <-- ${row.missing.join(",")} is in no Npc row` : "")
    );
  }
};

await main();
