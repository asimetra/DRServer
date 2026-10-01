#!/usr/bin/env node

// Must be first: without it a `.env` that moves the data directory is ignored
// here and honoured by the server, and the import lands where nothing reads it.
import "../src/load-env.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestFile = path.join(serverRoot, "game-data", "manifest.json");
const resourcesRoot = path.resolve(
  argumentValue("--target") ??
    process.env.ODS_RESOURCES_DIR ??
    process.env.DR_RESOURCES_DIR ??
    path.join(serverRoot, "local-data", "Resources")
);
const localManifestFile = path.join(path.dirname(resourcesRoot), "manifest.json");

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const pathInside = (root, relative) => {
  const resolved = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) {
    throw new Error(`Manifest path escapes its root: ${relative}`);
  }
  return resolved;
};

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const localPathFor = (entry) => {
  const relative = String(entry.source).replace(/^Resources[\\/]/, "");
  return pathInside(resourcesRoot, relative);
};

const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
if (manifest.version !== 1 || !Array.isArray(manifest.files)) {
  throw new Error(`Unsupported game-data manifest: ${manifestFile}`);
}

if (process.argv.includes("--check")) {
  let localManifest = null;
  try {
    localManifest = JSON.parse(await fs.readFile(localManifestFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (!localManifest) {
    // One line, not one per file: thirty-eight ENOENTs say nothing this does not.
    console.error(`Nothing has been imported into ${resourcesRoot}.`);
    console.error("Run npm run sync:data -- --source /path/to/your/client first.");
    process.exitCode = 1;
  } else {
    const failures = [];
    const expected = new Map(
      (localManifest.files ?? []).map((entry) => [entry.source, entry.sha256])
    );
    for (const entry of manifest.files) {
      const target = localPathFor(entry);
      try {
        const actual = sha256(await fs.readFile(target));
        if (actual !== expected.get(entry.source)) {
          failures.push(`${entry.source}: changed since it was imported`);
        }
      } catch (error) {
        failures.push(`${entry.source}: ${error.code === "ENOENT" ? "missing" : error.message}`);
      }
    }

    if (failures.length) {
      for (const failure of failures) console.error(`FAIL ${failure}`);
      process.exitCode = 1;
    } else {
      console.log(`Verified ${manifest.files.length} local compatibility-data files.`);
    }
  }
} else {
  const sourceArgument = argumentValue("--source");
  if (!sourceArgument) {
    console.error("Usage: node tools/sync-game-data.js --source /path/to/your/client");
    process.exitCode = 2;
  } else {
    const sourceRoot = path.resolve(sourceArgument);
    const copies = [];
    const missing = [];

    // Read and hash every source before changing the snapshot, preventing a
    // missing source from leaving a partially refreshed game-data directory.
    for (const entry of manifest.files) {
      const source = pathInside(sourceRoot, entry.source);
      try {
        const data = await fs.readFile(source);
        copies.push({ entry, data, digest: sha256(data) });
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        missing.push(entry.source);
      }
    }

    if (missing.length) {
      console.error(
        `${missing.length} of ${manifest.files.length} files are missing from ${sourceRoot}:`
      );
      for (const source of missing.slice(0, 10)) console.error(`  ${source}`);
      if (missing.length > 10) console.error(`  ...and ${missing.length - 10} more`);
      console.error(
        "Nothing was imported. --source is the directory that contains the client's Resources folder."
      );
      process.exitCode = 1;
    } else {
      for (const { entry, data } of copies) {
        const target = localPathFor(entry);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, data);
      }

      await fs.mkdir(path.dirname(localManifestFile), { recursive: true });
      await fs.writeFile(
        localManifestFile,
        `${JSON.stringify({
          version: 1,
          source: sourceRoot,
          files: copies.map(({ entry, digest }) => ({ source: entry.source, sha256: digest })),
        }, null, 2)}\n`,
        "utf8"
      );
      console.log(
        `Imported ${copies.length} compatibility-data files into ${resourcesRoot}.`
      );

      /**
       * The manifest records what each file hashed to in the client this
       * server was written against, and nothing ever compared against it. A
       * different version of the client is still importable — it may well
       * work — but it should not be a surprise found out in a dungeon.
       */
      const different = copies.filter(({ entry, digest }) => entry.sha256 && entry.sha256 !== digest);
      if (different.length) {
        console.error(
          `Note: ${different.length} of ${copies.length} files differ from the client version ` +
            "this server was written against; behaviour may differ where they do:"
        );
        for (const { entry } of different.slice(0, 5)) console.error(`  ${entry.source}`);
        if (different.length > 5) console.error(`  ...and ${different.length - 5} more`);
      }
    }
  }
}
