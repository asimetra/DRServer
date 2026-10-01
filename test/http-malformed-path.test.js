import assert from "node:assert/strict";
import test from "node:test";
import { listen } from "../src/http.js";

/**
 * A path is the one part of a request anybody can send without a token.
 *
 * `%E0%A4%A` is not valid percent-encoding, and decoding it throws. That went
 * up through the router as an unhandled failure: a 500 to the caller and a
 * seven-line stack in the log, per request — so any scanner walking the port
 * filled the log at whatever rate the limiter allowed.
 */
const routeTable = [
  { method: "GET", pattern: "/content/*", handler: (request, [rest]) => ({ status: 200, headers: {}, body: `file:${rest}` }) },
  { method: "GET", pattern: "/players/:name", handler: (request, [name]) => ({ status: 200, headers: {}, body: `player:${name}` }) },
];

const serving = async (t) => {
  const server = listen({ routeTable, host: "127.0.0.1", port: 0, rateLimited: false });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
};

test("a path that cannot be decoded is the caller's mistake, not the server's", async (t) => {
  const base = await serving(t);

  for (const path of ["/content/%E0%A4%A", "/players/%zz", "/content/a/%/b"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 400, path);
    assert.deepEqual(await response.json(), { error: "malformed path" });
  }
});

test("a well-formed escape still reaches the handler decoded once", async (t) => {
  const base = await serving(t);

  assert.equal(await (await fetch(`${base}/players/50%25`)).text(), "player:50%");
  assert.equal(await (await fetch(`${base}/content/a%20b/c.json`)).text(), "file:a b/c.json");
});
