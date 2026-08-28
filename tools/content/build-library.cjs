#!/usr/bin/env node
/**
 * The bodies for the rows this server adds.
 *
 * `library_server.json` is keyed by constant and holds the shape of everything
 * that can be hit or walked into — `combatCollisions` for the first,
 * `navCollisions` for the second. It is a *separate* file from the rules table,
 * and that separation is easy to miss: an invented NPC row gets its artwork
 * from its own `SwfFilepath` and appears on screen looking finished, while
 * having no entry here at all.
 *
 * A thing with no entry is a thing you can see and cannot touch. That is
 * precisely how STANDING_STONE arrived: right artwork, right hit points, right
 * IsAttackable, and no body for a sword to find.
 *
 * So every constant added to the rules table is added here too, borrowing the
 * shape of whatever it was copied from.
 */
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const source = path.join(root, "local-data", "Resources", "Levels", "library_server.json");
const target = path.join(root, "content", "Resources", "Levels", "library_server.json");

const library = JSON.parse(fs.readFileSync(source, "utf8"));
const entries = Array.isArray(library) ? library : library.entries ?? library.Library;
if (!Array.isArray(entries)) throw new Error("library_server.json is not the shape this expects");

const byConstant = new Map(entries.map((entry) => [entry.constant, entry]));

/** Borrows a body, under a new name. */
const copyBody = (fromConstant, constant) => {
  const shape = byConstant.get(fromConstant);
  if (!shape) throw new Error(`no collision entry for ${fromConstant}`);
  if (byConstant.has(constant)) return null;
  return { ...structuredClone(shape), constant };
};

const added = [
  copyBody("AZTECH_STATUE", "STANDING_STONE"),
  copyBody("KNIGHT", "TAVERN_KEEPER"),
].filter(Boolean);

for (const entry of added) entries.push(entry);

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(library));
console.error(
  `${added.length} body(ies) added: ` +
    added
      .map((e) => `${e.constant}(nav=${(e.navCollisions ?? []).length} combat=${(e.combatCollisions ?? []).length})`)
      .join(", ")
);
