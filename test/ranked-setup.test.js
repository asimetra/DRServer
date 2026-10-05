import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

/**
 * What `startRanked` refuses at start, in one log line, rather than leaving to
 * every JOIN at entry: a lobby floor it cannot build.
 */
const dataDir = await mkdtemp(path.join(tmpdir(), "ods-ranked-setup-"));
process.env.ODS_DATA_DIR = dataDir;
process.env.ODS_STORAGE = "file";
process.env.ODS_RANKED = "1";
process.env.ODS_MATCH_WORKERS = "0";

const { config } = await import("../src/config.js");
const { startRanked } = await import("../src/ranked/setup.js");
const { rankedHooksInstalled } = await import("../src/ranked/hooks.js");

after(async () => {
  for (const name of ["ODS_DATA_DIR", "ODS_STORAGE", "ODS_RANKED", "ODS_MATCH_WORKERS"]) delete process.env[name];
  await rm(dataDir, { recursive: true, force: true });
});

test("a lobby tile the library lacks keeps ranked off, found at start and not by the first JOIN", async (t) => {
  const tiles = config.ranked.lobbyTiles;
  t.after(() => {
    config.ranked.lobbyTiles = tiles;
  });
  config.ranked.lobbyTiles = [{ x: 2700, y: 2700, tileId: "no-such-tile" }];
  const stop = await startRanked({ where: "local" });
  assert.equal(rankedHooksInstalled(), false, "nothing was installed");
  await stop();
});

test("with a lobby it can build, ranked comes up and goes down cleanly", async () => {
  const stop = await startRanked({ where: "local" });
  assert.equal(rankedHooksInstalled(), true);
  await stop();
  assert.equal(rankedHooksInstalled(), false);
});

test("the prizes are offers in the game data, carried with their names; one that is not pays nothing", async () => {
  const { rewardOffersOf } = await import("../src/ranked/setup.js");
  const { loadGameMaster } = await import("../src/gamemaster.js");
  const gm = await loadGameMaster();
  const rewards = rewardOffersOf({ win: { "*": 51101, Gold: 51102, Dragon: 999999 }, loss: { "*": 51101 } }, gm);
  assert.deepEqual(rewards.win["*"], { offerId: 51101, name: "1000 Coins" });
  assert.deepEqual(rewards.win.Gold, { offerId: 51102, name: "3500 Coins" });
  assert.equal(rewards.win.Dragon, undefined, "an offer the data lacks is dropped");
  assert.deepEqual(rewards.loss["*"], { offerId: 51101, name: "1000 Coins" });
  assert.equal(rewardOffersOf(null, gm), null, "null pays nothing");
  assert.deepEqual(rewardOffersOf({ loss: null, win: { "*": 51103 } }, gm), { win: { "*": { offerId: 51103, name: "8000 Coins" } } });
});
