import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = await mkdtemp(path.join(tmpdir(), "ods-ranked-api-"));
process.env.ODS_DATA_DIR = dataDir;
process.env.ODS_STORAGE = "file";
process.env.ODS_TOKEN_SECRET = "0".repeat(64);
process.env.ODS_INTERNAL_TOKEN = "a-shared-secret-the-front-end-holds";
process.env.ODS_INTERNAL_PORT = "0";
process.env.ODS_RANKED = "1";

const { start } = await import("../src/internal.js");
const { routeTable } = await import("../src/routes.js");
const { issueToken } = await import("../src/auth.js");
const { rankedSettings } = await import("../src/modes/ranked/settings.js");
const { installRankedWeb } = await import("../src/modes/ranked/web.js");
const { DEFAULT_LEAGUES } = await import("../src/modes/ranked/leagues.js");
const { NEW_PLAYER } = await import("../src/modes/ranked/rating.js");

// Ranked's routes and profile field, as its start puts them up where HTTP is served.
installRankedWeb();
const server = start();
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  server.close();
  for (const name of ["ODS_DATA_DIR", "ODS_STORAGE", "ODS_TOKEN_SECRET", "ODS_INTERNAL_TOKEN", "ODS_INTERNAL_PORT", "ODS_RANKED"]) {
    delete process.env[name];
  }
  await rm(dataDir, { recursive: true, force: true });
});

const call = async (route, { method = "GET", body } = {}) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      "X-Internal-Token": process.env.ODS_INTERNAL_TOKEN,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

const register = async (name) => (await call("/internal/v1/accounts", { method: "POST", body: { name } })).body.accountId;

/** Ash beats both, Birch and Cedar draw: Ash first, then the two of them. */
const ash = await register("Ash");
const birch = await register("Birch");
const cedar = await register("Cedar");
await register("Dune");
const race = (n, players, winner) => ({ id: `race-${n}`, state: "finished", players, winner, reason: "finished", decidedAt: n * 1000 });
await mkdir(path.join(dataDir, "modes"), { recursive: true });
await writeFile(
  path.join(dataDir, "modes", "ranked.jsonl"),
  [race(1, [ash, birch], ash), race(2, [ash, cedar], ash), race(3, [birch, cedar], null)]
    .map((record) => JSON.stringify({ ...record, at: record.decidedAt, accounts: record.players }))
    .join("\n") + "\n"
);

const withRankedOff = (t) => {
  rankedSettings.enabled = false;
  t.after(() => {
    rankedSettings.enabled = true;
  });
};

const STANDING = ["league", "color", "rating", "place", "of", "games", "won", "lost", "drawn", "next"];

test("the board lists the leagues and every player who has raced, best first, by name", async () => {
  const { status, body } = await call("/internal/v1/ranked/board");
  assert.equal(status, 200);
  assert.equal(body.enabled, true);
  assert.deepEqual(body.leagues, JSON.parse(JSON.stringify(DEFAULT_LEAGUES)), "bands with `from`, the top league with `top`");
  assert.deepEqual(body.players.map((row) => row.name).sort(), ["Ash", "Birch", "Cedar"], "Dune has not raced, so is not on it");
  assert.equal(body.players[0].name, "Ash");
  assert.deepEqual(body.players.map((row) => row.place), [1, 2, 3]);

  const [first] = body.players;
  assert.deepEqual(Object.keys(first).sort(), ["name", ...STANDING].sort());
  assert.equal(first.place, 1);
  assert.equal(first.of, 3);
  assert.deepEqual([first.games, first.won, first.lost, first.drawn], [2, 2, 0, 0]);
  assert.ok(body.players.slice(1).every((row) => row.drawn === 1 && row.lost === 1));
  for (const row of body.players) {
    assert.ok(!("accountId" in row), "a name, never the account id");
    assert.equal(row.color, DEFAULT_LEAGUES.find((league) => league.name === row.league).color);
  }
});

test("the board is cut where asked, and a nonsense limit is the default", async () => {
  assert.equal((await call("/internal/v1/ranked/board?limit=1")).body.players.length, 1);
  assert.equal((await call("/internal/v1/ranked/board?limit=0")).body.players.length, 1, "at least one");
  assert.equal((await call("/internal/v1/ranked/board?limit=lots")).body.players.length, 3);
});

test("with ranked off the board says so, and still names the leagues", async (t) => {
  withRankedOff(t);
  const { status, body } = await call("/internal/v1/ranked/board");
  assert.equal(status, 200);
  assert.equal(body.enabled, false);
  assert.deepEqual(body.players, []);
  assert.equal(body.leagues.length, DEFAULT_LEAGUES.length);
});

test("a profile carries the player's league, place and record", async () => {
  const { body } = await call("/internal/v1/players/Ash");
  assert.deepEqual(Object.keys(body.ranked).sort(), [...STANDING].sort());
  assert.equal(body.ranked.place, 1);
  assert.equal(body.ranked.won, 2);
});

test("somebody who has not raced starts in the first league, with no place yet", async () => {
  const { body } = await call("/internal/v1/players/Dune");
  assert.equal(body.ranked.rating, NEW_PLAYER.rating);
  assert.equal(body.ranked.league, DEFAULT_LEAGUES[0].name);
  assert.equal(body.ranked.place, null);
  assert.equal(body.ranked.games, 0);
  assert.deepEqual(body.ranked.next, { league: DEFAULT_LEAGUES[1].name, from: DEFAULT_LEAGUES[1].from });
});

test("with ranked off a profile's standing is null", async (t) => {
  withRankedOff(t);
  assert.equal((await call("/internal/v1/players/Ash")).body.ranked, null);
});

/** The website's character panel draws its frame in the league's colour. */
test("a character summary carries the standing its profile has", async (t) => {
  const summary = (await call(`/internal/v1/accounts/${ash}/summary`)).body.ranked;
  assert.deepEqual(summary, (await call("/internal/v1/players/Ash")).body.ranked);
  withRankedOff(t);
  assert.equal((await call(`/internal/v1/accounts/${ash}/summary`)).body.ranked, null);
});

/** The client's own call, for a mod that shows it: signed like the rest of its calls. */
const ownStanding = async (headers) => {
  const route = [...routeTable].find((entry) => entry.method === "GET" && entry.pattern === "/api/ranked/standing");
  const response = await route.handler({ headers });
  return { status: response.status, body: JSON.parse(response.body) };
};
const signedAs = (accountId) => ({ "x-account-id": String(accountId), "x-validation-token": issueToken(accountId) });

test("a client is told its own standing, as its profile has it", async () => {
  const { status, body } = await ownStanding(signedAs(birch));
  assert.equal(status, 200);
  const profile = (await call("/internal/v1/players/Birch")).body.ranked;
  assert.deepEqual(body, profile);
});

test("a client's standing needs its token, and ranked to be on", async (t) => {
  assert.equal((await ownStanding({ "x-account-id": String(ash) })).status, 401);
  assert.equal((await ownStanding({ "x-account-id": String(ash), "x-validation-token": issueToken(birch) })).status, 401);
  withRankedOff(t);
  assert.equal((await ownStanding(signedAs(ash))).status, 404);
});

/**
 * A ranked log that cannot be read is ranked's fault, not the profile's: the
 * profile still answers, without a standing, and the board says so itself.
 */
test("an unreadable ranked log leaves a profile standing null and the board unavailable, not a 500", async (t) => {
  const log = path.join(dataDir, "modes", "ranked.jsonl");
  const kept = await readFile(log, "utf8");
  await rm(log);
  await mkdir(log); // a directory where the file was: every read of it fails
  t.after(async () => {
    await rm(log, { recursive: true, force: true });
    await writeFile(log, kept);
  });

  const profile = await call("/internal/v1/players/Ash");
  assert.equal(profile.status, 200);
  assert.equal(profile.body.ranked, null);
  assert.equal(profile.body.name, "Ash", "the rest of the profile is there");

  const board = await call("/internal/v1/ranked/board");
  assert.equal(board.status, 503);
  assert.match(board.body.error, /cannot be read/);
});
