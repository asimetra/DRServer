import test from "node:test";
import assert from "node:assert/strict";

import { config } from "../src/config.js";
import { loadGameMaster } from "../src/gamemaster.js";
import { activityLevelFor, gameStatusFor } from "../src/game-status.js";
import { routes } from "../src/routes.js";
import { DungeonMatchRegistry } from "../src/socket/matches.js";

/**
 * GET /game-status, which the world map polls every 59 seconds
 * (uI/map/PlayerActivityCount.hx) and draws as a glow on each node and a
 * "POPULATION:" line in its popup. The official answer, read live:
 *
 *   {"environmentName":"blue","statsAvailable":true,"currentHeroesInDungeons":122,
 *    "publicDungeonActivityLevel":{"50002":"Quiet","50003":"Active",…,"50158":"Bustling"}}
 *
 * Every node is listed, empty ones as Quiet. The thresholds are this server's
 * own: the answer names levels, never the counts behind them.
 */
let nextAccount = 1;
const player = () => ({ accountId: nextAccount++ });

const fill = (registry, mapNodeId, count, options = {}) => {
  const first = player();
  const { match } = registry.reserve({ session: first, mapNodeId, friendOnly: Boolean(options.private) });
  for (let index = 1; index < count; index++) {
    registry.attach(match, player());
  }
  return match;
};

test("the levels follow a party of four: one Active, two Popular, then Bustling and Rampaging", () => {
  const levels = [0, 1, 4, 5, 8, 9, 16, 17, 40].map((count) => activityLevelFor(count));
  assert.deepEqual(levels, [
    "Quiet", "Active", "Active", "Popular", "Popular", "Bustling", "Bustling", "Rampaging", "Rampaging",
  ]);
});

test("an empty server answers every node, Quiet, in the official shape", async () => {
  const gameMaster = await loadGameMaster();
  const status = await gameStatusFor({ registry: new DungeonMatchRegistry() });
  assert.equal(status.environmentName, config.serverName);
  assert.equal(status.statsAvailable, true);
  assert.equal(status.currentHeroesInDungeons, 0);
  const nodes = gameMaster.raw.MapPage.map((node) => String(node.Id));
  assert.deepEqual(Object.keys(status.publicDungeonActivityLevel).sort(), nodes.sort());
  assert.ok(Object.values(status.publicDungeonActivityLevel).every((level) => level === "Quiet"));
});

test("a node's level counts the players in its open public runs", async () => {
  const registry = new DungeonMatchRegistry();
  fill(registry, 50003, 3);
  fill(registry, 50004, 4);
  fill(registry, 50004, 2);
  fill(registry, 50005, 4, { private: true });
  const over = fill(registry, 50006, 4);
  registry.finish(over);

  const status = await gameStatusFor({ registry });
  const level = status.publicDungeonActivityLevel;
  assert.equal(level["50003"], "Active");
  assert.equal(level["50004"], "Popular", "two runs on one node add up");
  assert.equal(level["50005"], "Quiet", "a private run is nobody's business");
  assert.equal(level["50006"], "Quiet", "a finished run is on its way out");
  assert.equal(status.currentHeroesInDungeons, 17, "but every hero in a dungeon is counted");
});

test("the map polls it without an account, and gets the answer", async () => {
  const route = routes.find((entry) => entry.method === "GET" && entry.pattern === "/game-status");
  const response = await route.handler({ headers: {} });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.statsAvailable, true);
  assert.equal(typeof body.publicDungeonActivityLevel, "object");
  assert.equal(body.publicDungeonActivityLevel["50002"] !== undefined, true);
});
