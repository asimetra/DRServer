import assert from "node:assert/strict";
import test from "node:test";

import { internalApiProblem } from "../src/internal.js";

const strong = "i".repeat(48);

test("the internal API requires a strong shared secret when enabled", () => {
  assert.match(
    internalApiProblem({ internalToken: "short", internalHost: "127.0.0.1" }),
    /at least 32/
  );
  assert.equal(
    internalApiProblem({ internalToken: strong, internalHost: "127.0.0.2" }),
    null
  );
});

test("a cleartext remote internal bind requires explicit acknowledgement", () => {
  assert.match(
    internalApiProblem({
      internalToken: strong,
      internalHost: "0.0.0.0",
      allowInsecureInternal: false,
    }),
    /refusing cleartext internal API bind/
  );
  assert.equal(
    internalApiProblem({
      internalToken: strong,
      internalHost: "0.0.0.0",
      allowInsecureInternal: true,
    }),
    null
  );
});
