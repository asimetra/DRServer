#!/usr/bin/env node

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
  const failures = [];
  let localManifest;
  try {
    localManifest = JSON.parse(await fs.readFile(localManifestFile, "utf8"));
  } catch (error) {
    console.error(`FAIL ${localManifestFile}: ${error.message}`);
    console.error("Run npm run sync:data -- --source /path/to/your/client first.");
    process.exitCode = 1;
  }

  const expected = new Map(
    (localManifest?.files ?? []).map((entry) => [entry.source, entry.sha256])
  );
  for (const entry of manifest.files) {
    const target = localPathFor(entry);
    try {
      const actual = sha256(await fs.readFile(target));
      if (actual !== expected.get(entry.source)) {
        failures.push(`${entry.source}: checksum mismatch`);
      }
    } catch (error) {
      failures.push(`${entry.source}: ${error.message}`);
    }
  }

  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`Verified ${manifest.files.length} local compatibility-data files.`);
  }
} else {
  const sourceArgument = argumentValue("--source");
  if (!sourceArgument) {
    console.error("Usage: node tools/sync-game-data.js --source /path/to/client-repository");
    process.exitCode = 2;
  } else {
    const sourceRoot = path.resolve(sourceArgument);
    const copies = [];

    // Read and hash every source before changing the snapshot, preventing a
    // missing source from leaving a partially refreshed game-data directory.
    for (const entry of manifest.files) {
      const source = pathInside(sourceRoot, entry.source);
      const data = await fs.readFile(source);
      copies.push({ entry, data, digest: sha256(data) });
    }

    for (const { entry, data, digest } of copies) {
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
  }
}
