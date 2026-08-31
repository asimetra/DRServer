import test from "node:test";
import assert from "node:assert/strict";
import { writeAccount } from "../src/storage/postgres.js";

/**
 * Saving an account must not destroy the row and make a new one.
 *
 * The file backend rewrites a whole document every time, and the Postgres
 * backend copied the shape: delete the account, insert it again, insert its
 * children. Inside this server that reads the same, because the children
 * cascade and are rewritten anyway.
 *
 * Outside it does not. The website's `web.users.account_id` references
 * `accounts(id)` with ON DELETE SET NULL, so every save quietly detached a
 * player's login from their character — finishing one dungeon was enough, and
 * what the site then said was "confirm your email address first" to somebody
 * who had confirmed it days ago.
 *
 * A recording client is used rather than a database: the point is which
 * statements are issued, and a test that needs Postgres standing behind it is
 * a test that stops being run.
 */

const recorder = () => {
  const queries = [];
  return {
    queries,
    async query(text, values) {
      queries.push({ text: String(text), values });
      return { rows: [] };
    },
  };
};

const anAccount = () => ({
  id: 1000000005,
  name: "Somebody",
  basic_currency: 10,
  account_items: [{ id: 1, item_id: 11001, power: 5 }],
  account_attributes: [{ id: 2, name: "optionsHudStyle", value: "1" }],
});

test("an account is written without its row ever being deleted", async () => {
  const client = recorder();
  await writeAccount(client, anAccount());

  const destroys = client.queries.filter(({ text }) =>
    /DELETE\s+FROM\s+accounts\b/i.test(text)
  );
  assert.deepEqual(
    destroys.map(({ text }) => text),
    [],
    "the row anything outside this server points at was removed and remade"
  );
});

test("and the account row is still written", async () => {
  const client = recorder();
  await writeAccount(client, anAccount());

  assert.ok(
    client.queries.some(({ text }) => /INSERT\s+INTO\s+accounts\b/i.test(text)),
    "nothing wrote the account at all"
  );
  assert.ok(
    client.queries.some(({ text }) => /ON CONFLICT/i.test(text)),
    "writing it twice would collide without an upsert"
  );
});

/**
 * The children are a different case: they are a list, and a save has to be
 * able to shorten one. Clearing and rewriting them is how a sold weapon leaves
 * the bag, and nothing outside this server references them.
 */
test("children are still cleared, because a save has to be able to remove one", async () => {
  const client = recorder();
  await writeAccount(client, anAccount());

  assert.ok(
    client.queries.some(({ text }) => /DELETE\s+FROM\s+account_items\b/i.test(text)),
    "a weapon that left the bag would come back on the next save"
  );
});
