#!/usr/bin/env node
/**
 * Exhaustive GameMaster-driven combat conformance matrix.
 *
 *   node tools/combat-matrix.js
 *   node tools/combat-matrix.js --json
 *   node tools/combat-matrix.js --static --json
 *
 * The human report is for a developer. The JSON form is the stable surface for
 * an agent or a future MCP wrapper: every failure names the owner, slot,
 * attack, failed check and evidence rather than asking a model to scrape logs.
 */
import { buildCombatMatrix } from "./combat-matrix-lib.js";

const json = process.argv.includes("--json");
const runtime = !process.argv.includes("--static");
const argument = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] ?? null;
};

const write = process.stdout.write.bind(process.stdout);
const matrix = await buildCombatMatrix({
  runtime,
  owner: argument("owner"),
  attack: argument("attack"),
  // Combat paths deliberately log every hit. The report itself is the stable
  // output, especially in JSON mode where a single INFO line breaks parsing.
  muteLogs: true,
});

if (json) {
  write(`${JSON.stringify(matrix, null, 2)}\n`);
} else {
  const { summary } = matrix;
  write(
    `combat matrix: ${summary.npcRows} NPCs / ${summary.npcAttackReferences} references / ` +
      `${summary.npcUniqueAttacks} unique attacks\n`
  );
  write(
    `               ${summary.weaponRows} weapons / ${summary.weaponAttackReferences} references / ` +
      `${summary.weaponUniqueAttacks} unique attacks\n`
  );
  write(
    `runtime cases: ${summary.runtimeNpcCases} NPC, ${summary.runtimeWeaponCases} weapon; ` +
      `failures: ${summary.failures}\n`
  );
  for (const failure of matrix.failures) {
    write(
      `  ${failure.owner}.${failure.slot} -> ${failure.attack} [${failure.check}] ` +
        `${failure.detail}\n`
    );
  }
}

process.exitCode = matrix.failures.length ? 1 : 0;
