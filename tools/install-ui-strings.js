#!/usr/bin/env node
/**
 * Puts this server's banner strings into a client, so that its banners print
 * words and not `mia:KEY`.
 *
 *   node tools/install-ui-strings.js "<client>/bin/linux/bin" [more client directories]
 *
 * Two of the client's own data files; no code is touched:
 *
 *   Resources/Locale/Locale.override.json   the strings, under "strings". The
 *       game ships this file empty for translators, its table named
 *       "RENAME_ME_TO_strings" until somebody uses it; it is renamed here, and
 *       whatever is already in it is kept.
 *   DbConfiguration/Config.json             `Demographics.uiStrings`, which the
 *       client sends with every entry request: how the server knows this
 *       client holds the strings and may be sent them (src/socket/ui-strings.js).
 *
 * The strings are the `strings` of the effect book (config/ui-effects.json, or
 * ODS_UI_EFFECTS_FILE). Each file is copied to `<file>.before-ui-strings` the
 * first time. Run it again after the book's strings change; restart the client
 * after it runs, because it reads both files when it starts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrings } from "../src/socket/ui-strings.js";

const BOOK = process.env.ODS_UI_EFFECTS_FILE ||
  fileURLToPath(new URL("../config/ui-effects.json", import.meta.url));

/** The game's template keeps its table under this name until it is used. */
const TEMPLATE_TABLE = "RENAME_ME_TO_strings";

/** The file's own indentation, so that a rewritten file differs only where it changed. */
const indentOf = (text) => text.match(/\n([ \t]+)"/)?.[1] ?? 2;

const rewrite = (file, change) => {
  const text = fs.readFileSync(file, "utf8");
  const next = change(JSON.parse(text));
  const backup = `${file}.before-ui-strings`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, `${JSON.stringify(next, null, indentOf(text))}\n`);
};

const demographicsOf = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Not a declaration this tool can extend; it starts a new one.
    }
  }
  return {};
};

/** Writes `strings` ({ table, id } from parseStrings) into the client in `clientDir`. */
export const installUiStrings = (clientDir, strings) => {
  const overrideFile = path.join(clientDir, "Resources", "Locale", "Locale.override.json");
  const configFile = path.join(clientDir, "DbConfiguration", "Config.json");
  for (const file of [overrideFile, configFile]) {
    if (!fs.existsSync(file)) {
      throw new Error(`no ${path.relative(clientDir, file)} in ${clientDir}: not a client's bin directory`);
    }
  }
  if (!strings.id) throw new Error("the effect book has no strings to install");

  rewrite(overrideFile, (override) => {
    const { [TEMPLATE_TABLE]: template, ...rest } = override;
    return { ...rest, strings: { ...template, ...override.strings, ...strings.table } };
  });
  rewrite(configFile, (clientConfig) => ({
    ...clientConfig,
    Demographics: { ...demographicsOf(clientConfig.Demographics), uiStrings: strings.id },
  }));
  return { overrideFile, configFile };
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.error('usage: node tools/install-ui-strings.js "<client>/bin/linux/bin" [more]');
    process.exit(2);
  }
  const strings = parseStrings(JSON.parse(fs.readFileSync(BOOK, "utf8")).strings);
  let failed = false;
  for (const dir of dirs) {
    try {
      installUiStrings(dir, strings);
      console.log(`${dir}: ${strings.keys.size} strings, uiStrings ${strings.id} — restart this client`);
    } catch (problem) {
      failed = true;
      console.error(`${dir}: ${problem.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
