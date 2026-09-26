import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadServerConfig } from "../src/config.js";

const serverRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

test("JSON defaults make the server independent from the client repository", () => {
  const loaded = loadServerConfig({});

  assert.equal(loaded.host, "127.0.0.1");
  assert.equal(loaded.port, 8080);
  assert.equal(loaded.resourcesDir, path.join(serverRoot, "local-data", "Resources"));
  assert.equal(loaded.accountTemplateFile, path.join(serverRoot, "config", "account-template.json"));
  assert.equal(loaded.floorCatalogFile, path.join(serverRoot, "config", "floors.json"));
  assert.equal(loaded.npcAggroRadius, 900);
  assert.equal(loaded.npcAiTickMs, 250);
  assert.equal(loaded.projectileTickMs, 20);
  assert.equal(loaded.maxOutboundBufferBytes, 4 * 1024 * 1024);
  assert.equal(loaded.allowInsecureInternal, false);
  assert.equal(loaded.logLevel, "info");
  assert.equal(loaded.matchWorkerCount, 0);
});

test("auto match workers leave the main thread a core and stop at four", async () => {
  const { availableParallelism } = await import("node:os");
  const loaded = loadServerConfig({ ODS_MATCH_WORKERS: "auto" });
  assert.equal(loaded.matchWorkerCount, Math.max(0, Math.min(4, availableParallelism() - 1)));
});

test("an explicit match worker count stops at sixteen", () => {
  assert.equal(loadServerConfig({ ODS_MATCH_WORKERS: "64" }).matchWorkerCount, 16);
  assert.equal(loadServerConfig({ ODS_MATCH_WORKERS: "-3" }).matchWorkerCount, 0);
});

test("environment values override JSON defaults", () => {
  const loaded = loadServerConfig({
    DR_HOST: "0.0.0.0",
    DR_PORT: "18080",
    DR_STRICT: "1",
    DR_DUNGEON: "0",
    DR_NPC_AGGRO_RADIUS: "2400",
    DR_LOG_LEVEL: "warn",
    DR_MATCH_WORKERS: "4",
  });

  assert.equal(loaded.host, "0.0.0.0");
  assert.equal(loaded.port, 18080);
  assert.equal(loaded.permissive, false);
  assert.equal(loaded.dungeonsEnabled, false);
  assert.equal(loaded.npcAggroRadius, 2400);
  assert.equal(loaded.logLevel, "warn");
  assert.equal(loaded.matchWorkerCount, 4);
});

test("public ODS settings take precedence over legacy DR aliases", () => {
  const loaded = loadServerConfig({
    ODS_HOST: "127.0.0.2",
    DR_HOST: "0.0.0.0",
    ODS_PORT: "28080",
    DR_PORT: "18080",
    ODS_RESOURCES_DIR: "./vendor-resources",
    ODS_MAX_OUTBOUND_BUFFER_BYTES: "2097152",
  });

  assert.equal(loaded.host, "127.0.0.2");
  assert.equal(loaded.port, 28080);
  assert.equal(loaded.resourcesDir, path.resolve("./vendor-resources"));
  assert.equal(loaded.maxOutboundBufferBytes, 2 * 1024 * 1024);
});

test("remote internal exposure requires its own explicit acknowledgement", () => {
  const loaded = loadServerConfig({
    ODS_INTERNAL_HOST: "0.0.0.0",
    ODS_ALLOW_INSECURE_INTERNAL: "1",
  });
  assert.equal(loaded.internalHost, "0.0.0.0");
  assert.equal(loaded.allowInsecureInternal, true);
});

test("activity thresholds come from the environment, and a bad list falls back", () => {
  assert.deepEqual(loadServerConfig({}).activityThresholds, [1, 5, 9, 17]);
  assert.deepEqual(loadServerConfig({ ODS_ACTIVITY_THRESHOLDS: "2, 6, 12, 24" }).activityThresholds, [2, 6, 12, 24]);
  for (const bad of ["1,5,9", "1,5,5,9", "0,5,9,17", "a,b,c,d"]) {
    assert.deepEqual(loadServerConfig({ ODS_ACTIVITY_THRESHOLDS: bad }).activityThresholds, [1, 5, 9, 17], bad);
  }
});
