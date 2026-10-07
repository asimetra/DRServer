import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The seam, held both ways (src/modes/README.md, "What a mode may rely on").
 *
 * A mode — each folder under src/modes/ — imports the seam (the files at the
 * top of src/modes/), its own files, the log and the server's settings, and
 * nothing else of src/: a mode that reaches into src/socket/ directly is
 * reaching past the seam. And the core imports no mode: what a mode adds —
 * its routes, its profile field, its settings, its records — it adds through
 * the seam, so the core never names it. Only the registry (modes/index.js)
 * knows which modes ship.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const modesDir = path.join(src, "modes");

const filesUnder = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });

/** Every module a file names: static imports and re-exports, and dynamic imports of a string. */
const importsOf = (file) => {
  const text = fs.readFileSync(file, "utf8");
  const found = [];
  for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/g)) found.push(match[1]);
  for (const match of text.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) found.push(match[1]);
  for (const match of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]);
  return found;
};

const modeFolders = fs
  .readdirSync(modesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(modesDir, entry.name));

const relative = (file) => path.relative(root, file);

/** Where a mode may reach: the seam's own files, and these of the core's. */
const CORE_A_MODE_MAY_USE = new Set([path.join(src, "log.js"), path.join(src, "config.js")]);

test("there are modes to hold to it: ranked, delve and one life, each in its own folder", () => {
  const names = modeFolders.map((dir) => path.basename(dir)).sort();
  for (const name of ["delve", "one-life", "ranked"]) assert.ok(names.includes(name), `src/modes/${name}/`);
});

test("a mode imports the seam, its own files, the log and the settings — nothing else of the core", () => {
  const reaching = [];
  for (const folder of modeFolders) {
    for (const file of filesUnder(folder)) {
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith("node:")) continue;
        if (!specifier.startsWith(".")) {
          reaching.push(`${relative(file)} imports the package ${specifier}`);
          continue;
        }
        const target = path.resolve(path.dirname(file), specifier);
        const ownFolder = target.startsWith(folder + path.sep);
        const seam = path.dirname(target) === modesDir;
        if (ownFolder || seam || CORE_A_MODE_MAY_USE.has(target)) continue;
        reaching.push(`${relative(file)} imports ${relative(target)}`);
      }
    }
  }
  assert.deepEqual(reaching, [], "past the seam: what it needs belongs on the seam (src/modes/*.js)");
});

test("the core imports no mode; only the registry names the ones that ship", () => {
  const registry = path.join(modesDir, "index.js");
  const inMode = (target) => modeFolders.some((folder) => target.startsWith(folder + path.sep));
  const reaching = [];
  for (const file of filesUnder(src)) {
    if (inMode(file) || file === registry) continue;
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), specifier);
      if (inMode(target)) reaching.push(`${relative(file)} imports ${relative(target)}`);
    }
  }
  assert.deepEqual(reaching, []);
});

test("nor does the core name a mode in its code: no setting, route, table or default of any mode's", () => {
  const names = modeFolders.map((dir) => path.basename(dir).replace("-", ""));
  const literal = new RegExp(`["'\`](${names.join("|")})["'\`.]`);
  const comment = /^\s*(\*|\/\/|\/\*)/;
  const naming = [];
  for (const file of filesUnder(src)) {
    if (modeFolders.some((folder) => file.startsWith(folder + path.sep))) continue;
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (!comment.test(line) && literal.test(line)) naming.push(`${relative(file)}:${index + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(naming, []);
});
