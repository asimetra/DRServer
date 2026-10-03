import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

/**
 * A standing carries its hero's level as it is now — the line under each name
 * on a board. Not what the hero carries: that would say something only about a
 * record set with it, and runs do not keep what was carried.
 */

const dataDir = await mkdtemp(path.join(tmpdir(), "ods-board-weapons-"));
process.env.ODS_DATA_DIR = dataDir;
process.env.ODS_TOKEN_SECRET = "0".repeat(64);
process.env.ODS_INTERNAL_TOKEN = "a-shared-secret-the-front-end-holds";
process.env.ODS_INTERNAL_PORT = "0";

const { start } = await import("../src/internal.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { recordRuns, waitForRunRecords } = await import("../src/leaderboard.js");

const server = start();
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  server.close();
  await rm(dataDir, { recursive: true, force: true });
});

const call = (route) => fetch(`${base}${route}`, { headers: { "X-Internal-Token": process.env.ODS_INTERNAL_TOKEN } });

test("each standing carries its hero's level, and no weapons", async () => {
  const registered = await (await fetch(`${base}/internal/v1/accounts`, {
    method: "POST",
    headers: { "X-Internal-Token": process.env.ODS_INTERNAL_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Climber" }),
  })).json();
  const account = await loadAccount(registered.accountId);
  const avatar = account.account_avatars[0];
  avatar.experience = 100_000_000;
  await saveAccount(account);

  await recordRuns([{
    account_id: account.id, name: "Climber", avatar_id: avatar.id, hero_id: avatar.avatar_id, map_node_id: 58_888,
    party_size: 1, started_at: "2026-09-01T12:00:00Z", finished_at: "2026-09-01T12:02:00Z", duration_ms: 60_000,
    success: true, floors: 1, kills: 1, damage: 1, gold: 1, xp: 1, trophies: 1, rankable: true,
  }]);
  await waitForRunRecords();

  const { entries } = await (await call("/internal/v1/leaderboards/clears")).json();
  const mine = entries.find((entry) => entry.account_id === account.id);
  assert.ok(mine.level > 1, "the level its experience has earned");
  assert.equal("weapons" in mine, false);
});
