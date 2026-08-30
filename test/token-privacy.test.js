import test from "node:test";
import assert from "node:assert/strict";
import { truncate } from "../src/log.js";
import { issueToken, tokenProblem, verifyToken } from "../src/auth.js";

const SECRET = "privacy-test-secret";

/**
 * A log is not a place for a credential, and is the first place one lands.
 *
 * Every JSON-RPC body is logged whole, and the token rides inside `params` on
 * most calls, so a server that had been up for an afternoon held thousands of
 * working credentials in a file that gets tailed, copied and pasted into bug
 * reports. The socket capture already refuses to carry one for exactly this
 * reason and says so in its own comment.
 *
 * Deleting it outright would take away the only way to answer "why was I
 * refused", so what is kept is the half that is not secret: the expiry, which
 * is also the likeliest answer.
 */

test("a token in a logged body keeps its expiry and loses its signature", () => {
  const token = issueToken(1000, { secret: SECRET });
  const [expiry, signature] = token.split(":");

  const logged = truncate(`{"params":[1000,"${token}"],"id":1}`);

  assert.ok(logged.includes(expiry), "when it expires is worth reading and is not secret");
  assert.ok(!logged.includes(signature), "the part that proves anything is gone");
  assert.ok(
    logged.includes(signature.slice(0, 8)),
    "a stub is left so two lines can be told to be the same token"
  );
});

test("what is left cannot be used", () => {
  const token = issueToken(1000, { secret: SECRET });
  const logged = truncate(`["${token}"]`);
  const recovered = /\d+:[0-9a-f]+/.exec(logged)[0];

  assert.equal(verifyToken(1000, recovered, { secret: SECRET }), false);
});

/**
 * A body long enough to be cut is the case that matters, because the cut can
 * land inside the token: the pattern wants all sixty-four characters and a
 * half-written signature is not one, so it was written out raw. Measured at
 * twenty-nine characters of real signature surviving before this.
 */
test("a token cut in half by the length limit is still not written out", async () => {
  const { config } = await import("../src/config.js");
  const token = issueToken(1000, { secret: SECRET });
  const signature = token.split(":")[1];

  for (const back of [10, 20, 30, 40, 60]) {
    const logged = truncate("z".repeat(config.logBodyLimit - back) + token);
    const hex = /[0-9a-f]{16,}/.exec(logged);
    assert.ok(
      !hex || !signature.startsWith(hex[0]),
      `${hex?.[0]?.length ?? 0} characters of signature survived a cut ${back} in`
    );
  }
});

test("ordinary bodies are logged as they were", () => {
  const body = '{"params":[1000,"COLOUR","green"],"id":1}';
  assert.equal(truncate(body), body);
});

/**
 * Three different failures answered `false` alike, so a player saying "it does
 * not work" and an operator reading the log learned the same nothing from it.
 */
test("a refusal says which of the three it was", () => {
  const good = issueToken(1000, { secret: SECRET });
  const [expiry, signature] = good.split(":");
  const expired = issueToken(1000, {
    secret: SECRET,
    expiry: Math.floor(Date.now() / 1000) - 60,
  });

  assert.equal(tokenProblem(1000, good, { secret: SECRET }), null, "nothing wrong with a good one");
  assert.match(tokenProblem(1000, "nonsense", { secret: SECRET }), /shape|malformed/i);
  assert.match(tokenProblem(1000, expired, { secret: SECRET }), /expired/i);
  assert.match(
    tokenProblem(1001, good, { secret: SECRET }),
    /signature|another account/i,
    "a good token for somebody else fails on its signature"
  );
  assert.match(
    tokenProblem(1000, `${expiry}:${signature.replace(/^./, "0")}`, { secret: SECRET }),
    /signature/i
  );
});

test("the gate still answers yes or no", () => {
  const token = issueToken(1000, { secret: SECRET });
  assert.equal(verifyToken(1000, token, { secret: SECRET }), true);
  assert.equal(verifyToken(1001, token, { secret: SECRET }), false);
});
