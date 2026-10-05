import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../src/config.js";
import { routes } from "../src/routes.js";

/**
 * A desktop player's ServiceDiscoveryUrl ends in /desktop, and the client adds
 * /game-status/service-discovery itself (ServiceDiscoveryLoader.hx).
 */
const discovery = async (pattern) => {
  const route = routes.find((entry) => entry.method === "GET" && entry.pattern === pattern);
  const response = await route.handler({ headers: {} });
  assert.equal(response.status, 200);
  return JSON.parse(response.body);
};

const ORDINARY = "/game-status/service-discovery";
const DESKTOP = "/desktop/game-status/service-discovery";

test("the desktop's discovery names its own socket, and everything else as everybody's", async (t) => {
  const kept = { host: config.desktopSocketHost, port: config.desktopSocketPort };
  t.after(() => {
    config.desktopSocketHost = kept.host;
    config.desktopSocketPort = kept.port;
  });
  config.desktopSocketHost = "game.example.net";
  config.desktopSocketPort = 7198;

  const ordinary = await discovery(ORDINARY);
  const desktop = await discovery(DESKTOP);
  assert.equal(desktop.gameSocketAddress, "game.example.net");
  assert.equal(desktop.gameSocketPort, 7198);
  assert.equal(desktop.webServicesUrl, ordinary.webServicesUrl, "its web services are the same ones");
  assert.notEqual(ordinary.gameSocketAddress, "game.example.net", "and the browser keeps its own");
});

test("with no desktop socket set, the desktop is told what everybody is", async (t) => {
  const kept = config.desktopSocketHost;
  t.after(() => {
    config.desktopSocketHost = kept;
  });
  config.desktopSocketHost = null;
  assert.deepEqual(await discovery(DESKTOP), await discovery(ORDINARY));
});
