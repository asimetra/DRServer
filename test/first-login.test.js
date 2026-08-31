import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A first login has to reach storage on its own terms.
 *
 * There is no registration on this server: an operator signs a token for an id
 * and the account materialises the first time somebody arrives holding it. So
 * creation is the moment a player comes into existence.
 *
 * It used to be written down only as a side effect. `repairLoadedAccount` saves
 * when a repair changed something, and for a brand-new account exactly one of
 * the five fires — `repairAccountAttributes`, because the template's preference
 * rows carry no ids. Give those rows ids, which is exactly the tidy-up somebody
 * would make, and every repair returns false: the account is served, never
 * written, and rebuilt identically on the next request. The player keeps
 * nothing and nothing reports it.
 *
 * That is what this file arranges. The template it points the server at already
 * has ids on its attribute rows, so no repair has anything to do — which is the
 * only shape in which the old behaviour is visibly wrong.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "first-login-"));
const template = path.join(scratch, "account-template.json");

const source = JSON.parse(
  fs.readFileSync(new URL("../config/account-template.json", import.meta.url), "utf8")
);
fs.writeFileSync(
  template,
  JSON.stringify(
    {
      ...source,
      account_attributes: (source.account_attributes ?? []).map((row, index) => ({
        id: 1_300_000_000 + index,
        ...row,
      })),
    },
    null,
    2
  )
);

process.env.ODS_DATA_DIR = scratch;
process.env.ODS_ACCOUNT_TEMPLATE = template;

const { loadAccount } = await import("../src/accounts.js");
const { repairAccountAttributes } = await import("../src/accounts.js");
const { createAccount } = await import("../src/accounts.js");

test.after(() => {
  delete process.env.ODS_DATA_DIR;
  delete process.env.ODS_ACCOUNT_TEMPLATE;
  fs.rmSync(scratch, { recursive: true, force: true });
});

let nextId = 970000001;
const anId = () => nextId++;

test("this template gives the repairs nothing to do", async () => {
  const fresh = createAccount(anId());
  assert.equal(
    await repairAccountAttributes(fresh),
    false,
    "otherwise the test below would pass for the wrong reason"
  );
});

test("a first login is written down", async () => {
  const id = anId();

  const served = await loadAccount(id);

  assert.equal(served.id, id);
  assert.ok(
    fs.existsSync(path.join(scratch, `${id}.json`)),
    "creation reaches storage without waiting for a repair to want it"
  );
});

test("and what was written is what was served", async () => {
  const id = anId();

  const served = await loadAccount(id);
  const stored = JSON.parse(fs.readFileSync(path.join(scratch, `${id}.json`), "utf8"));

  assert.equal(stored.id, served.id);
  assert.equal(stored.active_avatar, served.active_avatar);
  assert.deepEqual(
    stored.account_avatars.map((avatar) => avatar.avatar_id),
    served.account_avatars.map((avatar) => avatar.avatar_id)
  );
});
