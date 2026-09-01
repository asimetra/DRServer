#!/usr/bin/env node
/**
 * Exports the weapon icons from a copy of the game you already have.
 *
 *   node tools/export-icons.js --path ~/.steam/steam/steamapps/common/DungeonRampage/Resources
 *   node tools/export-icons.js --path /path/to/Resources --dry
 *
 * This repository ships the tool and never the pictures. That is the whole
 * point of it: the art belongs to the game, so it stays on the machine of
 * whoever owns a copy, and what is shared here is the instructions for getting
 * at it. `content/` is ignored by git and refused by the release check, so the
 * output cannot reach the public tree by accident.
 *
 * Both builds of the game work. The Steam SWF build and the Haxe one ship these
 * files byte for byte identical — checked, not assumed — so `--path` only has to
 * point at either `Resources` directory.
 *
 * The names come from the game's own tables rather than from the SWFs. Each
 * WeaponAesthetics row names an icon and the file it lives in; ffdec exports a
 * sprite as `DefineSprite_<id>_<class>/1.png`, and that class is the icon name.
 * Anything exported that no row asks for is scenery and is left behind.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const argument = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};
const dry = process.argv.includes("--dry");

/**
 * Whichever ffdec is installed.
 *
 * The flatpak is the awkward one and worth naming: it is sandboxed to the home
 * directory, so it cannot write to /tmp. Everything below stages inside the
 * repository for that reason — a scratch directory in /tmp would silently
 * produce nothing, which is exactly what it did the first time.
 */
const decompiler = () => {
  for (const command of ["ffdec", "ffdec.sh"]) {
    if (spawnSync(command, ["--help"], { stdio: "ignore" }).status === 0) {
      return { run: (args) => spawnSync(command, args, { encoding: "utf8" }) };
    }
  }
  const flatpak = spawnSync("flatpak", ["info", "com.jpexs.decompiler.flash"], { stdio: "ignore" });
  if (flatpak.status === 0) {
    return {
      flatpak: true,
      run: (args) =>
        spawnSync(
          "flatpak",
          ["run", "--command=ffdec.sh", "com.jpexs.decompiler.flash", ...args],
          { encoding: "utf8" }
        ),
    };
  }
  return null;
};

const main = async () => {
  const resources = argument("path");
  if (!resources) {
    console.error("usage: node tools/export-icons.js --path <the game's Resources directory> [--dry]");
    process.exit(2);
  }
  if (!fsSync.existsSync(resources)) {
    console.error(`no such directory: ${resources}`);
    process.exit(2);
  }

  const ffdec = decompiler();
  if (!ffdec) {
    console.error(
      "ffdec (JPEXS Free Flash Decompiler) is not installed.\n" +
        "  flatpak install flathub com.jpexs.decompiler.flash\n" +
        "or put ffdec on PATH from https://github.com/jindrapetrik/jpexs-decompiler"
    );
    process.exit(2);
  }

  const gameMaster = JSON.parse(
    await fs.readFile(path.join(root, "content/Resources/Levels/DB_GameMaster.json"), "utf8")
  );

  /* Which file each icon lives in, taken from the game's own table so that a
     weapon added to the tables is found without this script being edited. */
  const bySwf = new Map();
  for (const row of gameMaster.WeaponAesthetics ?? []) {
    if (!row.IconName || !row.UISwfFilepath) continue;
    if (!bySwf.has(row.UISwfFilepath)) bySwf.set(row.UISwfFilepath, new Set());
    bySwf.get(row.UISwfFilepath).add(row.IconName);
  }

  const out = path.join(root, "content/Resources/Art2D/Icons/Weapons");
  // Inside the repository, not /tmp: see `decompiler` above.
  const stage = path.join(root, ".export-staging");
  await fs.rm(stage, { recursive: true, force: true });
  if (!dry) await fs.mkdir(out, { recursive: true });

  let written = 0;
  const missing = [];

  for (const [relative, names] of bySwf) {
    const swf = path.join(resources, relative.replace(/^Resources\//, ""));
    if (!fsSync.existsSync(swf)) {
      console.warn(`  ${relative}: not in this copy of the game, skipped`);
      for (const name of names) missing.push(name);
      continue;
    }

    const into = path.join(stage, path.basename(swf, ".swf"));
    await fs.mkdir(into, { recursive: true });
    const result = ffdec.run(["-format", "sprite:png", "-export", "sprite", into, swf]);
    if (result.status !== 0) {
      console.warn(`  ${path.basename(swf)}: ffdec failed — ${(result.stderr || "").trim().slice(0, 120)}`);
      for (const name of names) missing.push(name);
      continue;
    }

    /* `DefineSprite_<id>_<class>` is ffdec's naming; the class is the icon
       name. Sprites without a class are the artwork's own scaffolding. */
    const found = new Map();
    for (const entry of await fs.readdir(into, { withFileTypes: true })) {
      const named = entry.isDirectory() && entry.name.match(/^DefineSprite_\d+_(.+)$/);
      if (named) found.set(named[1], path.join(into, entry.name, "1.png"));
    }

    let here = 0;
    for (const name of names) {
      const source = found.get(name);
      if (!source || !fsSync.existsSync(source)) {
        missing.push(name);
        continue;
      }
      if (!dry) await fs.copyFile(source, path.join(out, `${name}.png`));
      here += 1;
      written += 1;
    }
    console.log(`  ${path.basename(swf)}: ${here} of ${names.size}`);
  }

  await fs.rm(stage, { recursive: true, force: true });

  console.log(
    `\n${dry ? "would write" : "wrote"} ${written} icons` +
      (dry ? "" : ` to ${path.relative(root, out)}`)
  );
  if (missing.length) {
    console.log(`${missing.length} not found: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? " …" : ""}`);
  }
  /* Said out loud because the directory is ignored and refused by the release
     check, and somebody should know that is deliberate rather than an oversight. */
  if (!dry && written) {
    console.log("\ncontent/ is git-ignored: these stay on this machine.");
  }
};

await main();
