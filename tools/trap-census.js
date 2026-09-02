/**
 * Every trap in the game, against what the official was seen doing.
 *
 *   node tools/trap-census.js <logdir>/socket-*.jsonl
 *   node tools/trap-census.js --all <logdir>/socket-*.jsonl   # unmeasured too
 *
 * A trap is not something this server places. It is authored inside a tile,
 * with its wiring, and the server reads the tile and instantiates it — so no
 * trap is ever handled one at a time. What is handled is the *kind*: whether
 * its artwork toggles with its trigger, whether it is live without one,
 * whether it burns whatever stands in it. Get a kind wrong and every trap of
 * that kind is wrong at once, which is what happened when arrow launchers were
 * recognised by the name `TRAP_ARROWS` and twenty-one sibling props across five
 * themes were blinked on and off.
 *
 * So the useful question is not "is this trap broken" but "does the rule we
 * apply to its kind match what the official did". This asks it of all 133 of
 * them at once.
 *
 * The prediction under test is `togglesRenderer`: it says the trap receives
 * field 141, and a launcher does not. The captures say who actually got one.
 *
 * Three rules about reading the output:
 *
 * The verdict is per *attack*, not per prop. `togglesRenderer` says a kind's
 * artwork follows its trigger — not that every instance of it is ever switched.
 * A third of the catacombs' spike beds are wired to nothing, in the data as
 * much as here, so a single unwired prop sits at zero states while its family
 * has thousands. Judging props one at a time called two of those a bug.
 *
 * Absence is not agreement. A kind no capture ever saw is `unmeasured` and is
 * never counted as passing — it is printed apart, because a column of quiet
 * traps looks exactly like a column of correct ones.
 *
 * And the classification is imported rather than restated. `classifyHazard` is
 * the same function the floor builder calls; an oracle that reimplements the
 * rule it checks cannot catch the rule being wrong, only a typo in its copy.
 */
// Must be first: it fills the environment config.js reads as it is evaluated.
import "../src/load-env.js";
import fs from "node:fs";
import readline from "node:readline";
import {
  attackForConstant,
  loadGameMaster,
  projectileForConstant,
} from "../src/gamemaster.js";
import { classifyHazard } from "../src/socket/hazards.js";
import { config } from "../src/config.js";
import fsp from "node:fs/promises";
import nodePath from "node:path";

/**
 * Which props the triggerable path ever sees.
 *
 * `classifyHazard` runs inside buildTriggerables, so it only ever judges a
 * placement authored as `LETriggerable`. A prop placed as `LENPC` is an actor
 * and is built somewhere else entirely — REWARD_CHEST_A is one, and censusing
 * it against the triggerable rule reported a disagreement about code that never
 * runs on it.
 */
const triggerableConstants = async () => {
  const file = nodePath.join(config.resourcesDir, "Levels", "library_server.json");
  const library = JSON.parse(await fsp.readFile(file, "utf8"));
  const found = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const constant = node.constant ?? node.Constant;
    const type = node.type ?? node.Type;
    if (typeof constant === "string" && type === "LETriggerable") found.add(constant);
    for (const value of Object.values(node)) walk(value);
  };
  walk(library);
  return found;
};

const FIELD = { state: 141, choreography: 143, result: 144 };

/** Counts field traffic per NPC type, resolving doids through their generate. */
const tally = async (files) => {
  const counts = new Map();
  const bump = (type, key) => {
    const row = counts.get(type) ?? { state: 0, choreography: 0, result: 0 };
    row[key] += 1;
    counts.set(type, row);
  };

  for (const file of files) {
    const doidType = new Map();
    const stream = readline.createInterface({
      input: fs.createReadStream(file),
      crlfDelay: Infinity,
    });
    for await (const line of stream) {
      if (!line.includes('"field"') && !line.includes('"clidName"')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const hex = String(record.hex ?? "").replace(/[^0-9a-fA-F]/g, "");
      const bytes = Buffer.from(hex, "hex");

      if (record.clidName === "DistributedNPCGameObject" && bytes.length >= 20) {
        doidType.set(record.doid, bytes.readUInt32LE(16));
        continue;
      }
      const type = doidType.get(record.doid);
      if (type === undefined) continue;
      if (record.field === FIELD.state) bump(type, "state");
      else if (record.field === FIELD.choreography) bump(type, "choreography");
      else if (record.field === FIELD.result) bump(type, "result");
    }
  }
  return counts;
};

const main = async () => {
  const files = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (!files.length) {
    console.error("usage: node tools/trap-census.js <logdir>/socket-*.jsonl [--all]");
    process.exit(2);
  }

  const gm = await loadGameMaster();
  const seen = await tally(files);
  const triggerable = await triggerableConstants();

  const rows = [];
  const family = new Map();
  for (const npc of gm.raw.Npc) {
    if (npc.CharType !== "PROP" || !npc.Attack1) continue;
    // Judged only where the rule is actually applied.
    if (!triggerable.has(npc.Constant)) continue;
    const attack = await attackForConstant(npc.Attack1);
    const projectile = attack?.Projectile
      ? await projectileForConstant(attack.Projectile)
      : null;
    const kind = classifyHazard({ npc, attack, projectile });
    const counts = seen.get(npc.Id);

    rows.push({ constant: npc.Constant, attack: npc.Attack1, launcher: Boolean(projectile), kind, counts });

    // The family carries the verdict, because the kind is what is being judged.
    const totals = family.get(npc.Attack1) ?? { state: 0, choreography: 0, kind };
    totals.state += counts?.state ?? 0;
    totals.choreography += counts?.choreography ?? 0;
    family.set(npc.Attack1, totals);
  }

  for (const [attack, totals] of family) {
    totals.verdict =
      totals.state + totals.choreography === 0
        ? "unmeasured"
        : totals.kind.togglesRenderer === totals.state > 0
          ? "agrees"
          : "DISAGREES";
    for (const row of rows.filter((r) => r.attack === attack)) row.verdict = totals.verdict;
  }

  const measured = [...family.values()].filter((f) => f.verdict !== "unmeasured");
  const disagree = measured.filter((f) => f.verdict === "DISAGREES");

  console.log(
    `${rows.length} trap props in ${family.size} kinds, ${measured.length} kinds seen in ${files.length} capture(s)\n`
  );
  console.log(
    `  ${"trap".padEnd(38)}${"attack".padEnd(26)}${"kind".padEnd(10)}` +
      `${"state".padStart(7)}${"chor".padStart(7)}${"taken".padStart(7)}   verdict`
  );

  const show = (row) => {
    const kindName = row.kind.alwaysLive
      ? "terrain"
      : row.kind.togglingLauncher
        ? "toggling"
        : row.launcher
          ? "launcher"
          : row.kind.togglesRenderer
            ? "stateful"
            : "other";
    const c = row.counts ?? { state: "-", choreography: "-", result: "-" };
    console.log(
      `  ${row.constant.padEnd(38)}${row.attack.padEnd(26)}${kindName.padEnd(10)}` +
        `${String(c.state).padStart(7)}${String(c.choreography).padStart(7)}` +
        `${String(c.result).padStart(7)}   ${row.verdict === "agrees" ? "" : row.verdict}`
    );
  };

  const seenRows = rows.filter((row) => row.counts);
  for (const row of seenRows.sort(
    (a, b) => b.counts.state + b.counts.choreography - (a.counts.state + a.counts.choreography)
  )) {
    show(row);
  }

  if (process.argv.includes("--all")) {
    console.log(`\n  never seen in these captures (${rows.length - seenRows.length}):`);
    for (const row of rows.filter((r) => !r.counts)) show(row);
  }

  console.log(
    `\n${disagree.length ? `${disagree.length} kind(s) disagree` : "no disagreements"}` +
      `, ${family.size - measured.length} kind(s) unmeasured`
  );
  process.exitCode = disagree.length ? 1 : 0;
};

main();
