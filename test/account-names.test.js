import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(tmpdir(), "ods-names-test-"));
process.env.ODS_DATA_DIR = dataDir;

const { NAME_MAX, NAME_MIN, checkName, nameKey, tidyName } = await import(
  "../src/account-names.js"
);
const { createNewAccount } = await import("../src/accounts.js");

test.after(async () => {
  delete process.env.ODS_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

const refusedAs = (reason) => (error) => error.name === "NameRefused" && error.reason === reason;

test("a name is trimmed, and its inner runs collapsed", () => {
  assert.equal(tidyName("  Sable  "), "Sable");
  assert.equal(tidyName("Iron   Wolf"), "Iron Wolf");
  assert.equal(checkName(" Grimwald "), "Grimwald");
});

/**
 * The rule is about the developer's keyboard if it refuses the players'.
 * A private server whose people type Turkish must accept Turkish.
 */
test("letters are letters, in any script", () => {
  for (const name of ["Şafak", "Ayşegül", "Ölüm", "Иван", "さくら", "Grimwald"]) {
    assert.equal(checkName(name), name, `${name} is a name`);
  }
});

test("separators sit between characters and never at an end or doubled", () => {
  assert.equal(checkName("Iron Wolf"), "Iron Wolf");
  assert.equal(checkName("dr.who"), "dr.who");
  assert.equal(checkName("kara-kedi"), "kara-kedi");
  assert.equal(checkName("night_owl"), "night_owl");

  for (const bad of ["-Sable", "Sable-", "_Sable", "Sable.", "a--b", "a__b", "a.-b"]) {
    assert.throws(() => checkName(bad), refusedAs("bad_name"), `${bad} is not a name`);
  }
});

test("a name is neither empty nor an essay", () => {
  assert.throws(() => checkName(""), refusedAs("bad_name"));
  assert.throws(() => checkName("   "), refusedAs("bad_name"));
  assert.throws(() => checkName("ab"), refusedAs("bad_name"), `${NAME_MIN} is the floor`);
  assert.throws(() => checkName("a".repeat(NAME_MAX + 1)), refusedAs("bad_name"));
  assert.equal(checkName("a".repeat(NAME_MAX)).length, NAME_MAX);
});

test("nothing but letters, digits and those separators", () => {
  for (const bad of ["Sable!", "<script>", "a b@c", "★star", "a/b", "12:34"]) {
    assert.throws(() => checkName(bad), refusedAs("bad_name"), `${bad} is not a name`);
  }

  /* A tab or a newline is whitespace, and whitespace is a space — collapsed on
     the way in rather than refused, so a paste from somewhere else works. */
  assert.equal(checkName("sable\ttab"), "sable tab");
  assert.equal(checkName("iron\nwolf"), "iron wolf");

  /*
   * "drop table" is a name. It is letters and a space, and it is only alarming
   * if a name is ever concatenated into a query — which is the thing to keep
   * true, rather than a reason to refuse people whose names contain English
   * words. Every query here is parameterised and every screen renders it as
   * text.
   */
  assert.equal(checkName("drop table"), "drop table");
});

/**
 * The one that was wrong, and was only found by measuring.
 *
 * `"İ".toLowerCase()` is not `"i"` — it is an `i` followed by a combining dot
 * above — so folding the I forms *after* lowercasing never matched, and
 * "İstanbul" and "istanbul" were two different names. Folding before it is what
 * makes them one, and this is the test that says so.
 */
test("the four I forms are one letter", () => {
  assert.equal(nameKey("İstanbul"), nameKey("istanbul"));
  assert.equal(nameKey("ISTANBUL"), nameKey("istanbul"));
  assert.equal(nameKey("ıŞıK"), nameKey("IŞIK"));
  assert.equal(nameKey("Sable"), nameKey("sABLE"));

  // And it does not fold everything into everything.
  assert.notEqual(nameKey("Sable"), nameKey("Stable"));
});

test("a key ignores case and the whitespace a name was typed with", () => {
  assert.equal(nameKey("  Iron   Wolf "), nameKey("iron wolf"));
});

/* ------------------------------------------------------------ claiming it - */

test("a name is claimed by the first account to take it", async () => {
  const first = await createNewAccount({ name: "Grimwald" });
  assert.equal(first.name, "Grimwald");

  await assert.rejects(() => createNewAccount({ name: "Grimwald" }), refusedAs("name_taken"));
});

test("the same name in another case is the same name", async () => {
  await createNewAccount({ name: "Sable" });

  for (const attempt of ["sable", "SABLE", " sAbLe "]) {
    await assert.rejects(() => createNewAccount({ name: attempt }), refusedAs("name_taken"));
  }
});

test("and in the other Turkish I", async () => {
  await createNewAccount({ name: "Işık" });
  await assert.rejects(() => createNewAccount({ name: "ışık" }), refusedAs("name_taken"));
  await assert.rejects(() => createNewAccount({ name: "IŞIK" }), refusedAs("name_taken"));
});

/**
 * A refused name must not cost an account. The check runs before the write, so
 * a collision leaves nothing behind but the id it did not use.
 */
test("a refused name creates nothing", async () => {
  const { listAccountIds, loadAccount } = await import("../src/accounts.js");
  await createNewAccount({ name: "Mox" });

  const before = (await listAccountIds()).length;
  await assert.rejects(() => createNewAccount({ name: "mox" }), refusedAs("name_taken"));
  const after = await listAccountIds();

  assert.equal(after.length, before, "no account was left behind");
  const names = await Promise.all(after.map(async (id) => (await loadAccount(id)).name));
  assert.equal(names.filter((name) => nameKey(name) === nameKey("Mox")).length, 1);
});

/**
 * The tools and the tests still register without one. That path keeps the
 * template's name, which carries the account id and so cannot collide — it is
 * not a name a player was ever offered.
 */
test("an account registered without a name still gets a unique one", async () => {
  const one = await createNewAccount();
  const two = await createNewAccount();
  assert.notEqual(one.name, two.name);
  assert.match(one.name, /^Player\d+$/);
});
