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
  assert.equal(loaded.projectileTickMs, 20);
  assert.equal(loaded.maxOutboundBufferBytes, 4 * 1024 * 1024);
  assert.equal(loaded.allowInsecureInternal, false);
});

test("environment values override JSON defaults", () => {
  const loaded = loadServerConfig({
    DR_HOST: "0.0.0.0",
    DR_PORT: "18080",
    DR_STRICT: "1",
    DR_DUNGEON: "0",
    DR_NPC_AGGRO_RADIUS: "2400",
  });

  assert.equal(loaded.host, "0.0.0.0");
  assert.equal(loaded.port, 18080);
  assert.equal(loaded.permissive, false);
  assert.equal(loaded.dungeonsEnabled, false);
  assert.equal(loaded.npcAggroRadius, 2400);
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
