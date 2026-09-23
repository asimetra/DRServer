import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../src/config.js";
import { register } from "../src/rpc.js";
import { routes } from "../src/routes.js";

const rpcRoute = routes.find((route) => route.pattern === "/rpc/:service/:method");

test("JSON-RPC preserves deliberate domain error codes and defaults unknown failures", async () => {
  const previous = config.authEnabled;
  config.authEnabled = false;
  try {
    register("test/permanent", () => {
      const problem = new Error("permanent refusal");
      problem.code = -538;
      throw problem;
    }, { account: null });
    register("test/unknown", () => {
      throw new Error("unexpected failure");
    }, { account: null });

    const request = (method) => ({ headers: {}, json: { id: 7, params: [] }, method });
    const permanent = await rpcRoute.handler(request("permanent"), ["test", "permanent"]);
    assert.deepEqual(JSON.parse(permanent.body).error, {
      code: -538,
      message: "permanent refusal",
    });

    const unknown = await rpcRoute.handler(request("unknown"), ["test", "unknown"]);
    assert.equal(JSON.parse(unknown.body).error.code, -1);
  } finally {
    config.authEnabled = previous;
  }
});
