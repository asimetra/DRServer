import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installUiStrings } from "../tools/install-ui-strings.js";
import { declaredUiStrings, parseStrings } from "../src/socket/ui-strings.js";

/** The override file exactly as the game ships it: empty, for translators. */
const SHIPPED_OVERRIDE = `{
  "Instructions":
  {
    "INSTRUCTION_01": "When Modifying the file, check the Locale Console Channel for any potential mistakes."
  },
  "RENAME_ME_TO_strings":
  {
  },
  "errors":
  {
  }
}
`;

/** A client bin directory the test owns, removed afterwards. */
const clientDir = (t, { override = SHIPPED_OVERRIDE, demographics = { contentPacks: ["knight@1"] } } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-strings-client-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "Resources", "Locale"), { recursive: true });
  fs.mkdirSync(path.join(dir, "DbConfiguration"));
  fs.writeFileSync(path.join(dir, "Resources", "Locale", "Locale.override.json"), override);
  fs.writeFileSync(
    path.join(dir, "DbConfiguration", "Config.json"),
    `${JSON.stringify({ ServiceDiscoveryUrl: "http://127.0.0.1:8080", AccountId: 1000000005, Demographics: demographics }, null, 2)}\n`
  );
  return dir;
};

const read = (dir, ...parts) => JSON.parse(fs.readFileSync(path.join(dir, ...parts), "utf8"));
const STRINGS = parseStrings({ RIVAL_FOUND: "RIVAL FOUND!", RIVAL_GO: "GO!" });

test("the strings go into the game's own override table, and the client says it holds them", (t) => {
  const dir = clientDir(t);
  installUiStrings(dir, STRINGS);

  const override = read(dir, "Resources", "Locale", "Locale.override.json");
  assert.deepEqual(override.strings, STRINGS.table, "under the name the client reads");
  assert.equal(override.RENAME_ME_TO_strings, undefined, "the template's placeholder is renamed, not left beside it");
  assert.ok(override.Instructions && override.errors, "the rest of the file is kept");

  const clientConfig = read(dir, "DbConfiguration", "Config.json");
  assert.deepEqual(clientConfig.Demographics.contentPacks, ["knight@1"], "what it already declared is kept");
  assert.equal(declaredUiStrings(clientConfig.Demographics), STRINGS.id, "and the server reads the declaration back");
  assert.equal(clientConfig.AccountId, 1000000005);
});

test("a translation already in the file is kept beside the server's strings", (t) => {
  const dir = clientDir(t, {
    override: JSON.stringify({ strings: { VICTORY: "ZAFER" }, errors: {} }),
  });
  installUiStrings(dir, STRINGS);
  assert.deepEqual(read(dir, "Resources", "Locale", "Locale.override.json").strings, {
    VICTORY: "ZAFER",
    ...STRINGS.table,
  });
});

test("running it again changes nothing more, and the first copy of each file is kept", (t) => {
  const dir = clientDir(t);
  const overrideFile = path.join(dir, "Resources", "Locale", "Locale.override.json");
  installUiStrings(dir, STRINGS);
  const once = fs.readFileSync(overrideFile, "utf8");
  installUiStrings(dir, STRINGS);

  assert.equal(fs.readFileSync(overrideFile, "utf8"), once);
  assert.equal(fs.readFileSync(`${overrideFile}.before-ui-strings`, "utf8"), SHIPPED_OVERRIDE);
  assert.ok(fs.existsSync(path.join(dir, "DbConfiguration", "Config.json.before-ui-strings")));
});

test("a directory that is not a client's is refused before anything is written", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-strings-not-a-client-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => installUiStrings(dir, STRINGS), /not a client's bin directory/);
  assert.deepEqual(fs.readdirSync(dir), []);
});
