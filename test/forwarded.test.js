import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import test from "node:test";

import { config, configProblems, loadServerConfig } from "../src/config.js";
import { clientAddress, parseTrustedProxies } from "../src/forwarded.js";

/**
 * Who a player is, behind a proxy.
 *
 * A server reached through a TLS proxy sees every connection come from the
 * proxy, and the limits it keeps per address — requests every ten seconds,
 * game sockets at once — then apply to all its players as if they were one.
 * The proxy says who it is passing on in `X-Forwarded-For`, but anybody can
 * send that header; it is believed only from an address the operator named.
 */

const trusting = (...entries) => parseTrustedProxies(entries.join(","));

test("nothing is trusted unless named, and then a header is just a header", () => {
  const nobody = trusting();
  assert.equal(clientAddress("127.0.0.1", "198.51.100.7", nobody), "127.0.0.1");
  assert.equal(clientAddress("203.0.113.5", "198.51.100.7", trusting("127.0.0.1")), "203.0.113.5",
    "a player who sends the header themselves is still themselves");
});

test("from a trusted proxy, the address it names is the player", () => {
  const local = trusting("127.0.0.1", "::1");
  assert.equal(clientAddress("127.0.0.1", "198.51.100.7", local), "198.51.100.7");
  assert.equal(clientAddress("::1", "2001:db8::7", local), "2001:db8::7");
  assert.equal(clientAddress("::ffff:127.0.0.1", "198.51.100.7", local), "198.51.100.7",
    "a dual-stack listener reports IPv4 as mapped IPv6");
  assert.equal(clientAddress("127.0.0.1", undefined, local), "127.0.0.1", "no header, no change");
});

/**
 * The header is a list each proxy appends to. Only the right end was written by
 * somebody trusted; everything to its left could have been sent by the player.
 * So it is read from the right, past the proxies the operator named, and the
 * first address that is not one of them is the player.
 */
test("a chain is read from the right, and what the player wrote is not believed", () => {
  const chain = trusting("127.0.0.1", "10.0.0.0/8");
  assert.equal(clientAddress("127.0.0.1", "1.1.1.1, 198.51.100.7, 10.0.0.5", chain), "198.51.100.7");
  assert.equal(clientAddress("127.0.0.1", "10.1.1.1, 10.0.0.5", chain), "10.1.1.1",
    "every hop trusted: the far end is as close as it gets");
  assert.equal(clientAddress("127.0.0.1", ["1.1.1.1", "198.51.100.7"], chain), "198.51.100.7",
    "two header lines read as one list");
});

test("a port or brackets on an entry are not part of the address", () => {
  const local = trusting("127.0.0.1");
  assert.equal(clientAddress("127.0.0.1", "198.51.100.7:4711", local), "198.51.100.7");
  assert.equal(clientAddress("127.0.0.1", "[2001:db8::7]:4711", local), "2001:db8::7");
  assert.equal(clientAddress("127.0.0.1", "[2001:db8::7]", local), "2001:db8::7");
});

test("an entry that is not an address stops the reading where it is", () => {
  const local = trusting("127.0.0.1");
  assert.equal(clientAddress("127.0.0.1", "unknown", local), "127.0.0.1");
  assert.equal(clientAddress("127.0.0.1", "", local), "127.0.0.1");
  assert.equal(clientAddress("127.0.0.1", "198.51.100.7, nonsense", local), "127.0.0.1",
    "the proxy's own entry is unreadable, so nothing past it is believed");
});

test("the proxies are a setting, and one that is not an address stops the server", () => {
  assert.deepEqual(loadServerConfig({}).trustedProxies, []);
  assert.deepEqual(
    loadServerConfig({ ODS_TRUSTED_PROXIES: "127.0.0.1, ::1 ,10.0.0.0/8" }).trustedProxies,
    ["127.0.0.1", "::1", "10.0.0.0/8"]
  );

  assert.deepEqual(configProblems({ ODS_TRUSTED_PROXIES: "127.0.0.1,fd00::/8" }).refusals, []);
  for (const wrong of ["localhost", "10.0.0.0/33", "300.1.1.1", "10.0.0.0/eight"]) {
    const [refusal] = configProblems({ ODS_TRUSTED_PROXIES: `127.0.0.1,${wrong}` }).refusals;
    assert.match(refusal ?? "", /ODS_TRUSTED_PROXIES/, wrong);
    assert.ok(refusal.includes(JSON.stringify(wrong)), `and names ${wrong}`);
  }
});

/** Runs `body` trusting `entries`, and puts the setting back. */
const withTrust = async (entries, body) => {
  const usual = config.trustedProxies;
  config.trustedProxies = entries;
  try {
    return await body();
  } finally {
    config.trustedProxies = usual;
  }
};

test("each player behind a trusted proxy has a request budget of their own", async (t) => {
  const { listen } = await import("../src/http.js");
  const routeTable = [
    { method: "GET", pattern: "/ping", handler: () => ({ status: 200, headers: {}, body: "pong" }) },
  ];
  const server = listen({ routeTable, host: "127.0.0.1", port: 0, rateLimit: 2 });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/ping`;
  const answered = (from) =>
    fetch(url, { headers: { connection: "close", "x-forwarded-for": from } }).then(
      (response) => response.status === 200,
      () => false
    );

  await withTrust(["127.0.0.1"], async () => {
    const first = [await answered("198.51.100.1"), await answered("198.51.100.1"), await answered("198.51.100.1")];
    assert.deepEqual(first, [true, true, false], "one player's budget runs out");
    assert.equal(await answered("198.51.100.2"), true, "and the next player's has not");
  });

  await withTrust([], async () => {
    // A fresh listener's worth of budget is not needed: the proxy's own
    // address has made no requests yet under its own name.
    const untrusted = [await answered("198.51.100.3"), await answered("198.51.100.4"), await answered("198.51.100.5")];
    assert.deepEqual(untrusted, [true, true, false], "without trust the header changes nothing");
  });
});

const fakeSocket = (remoteAddress) => {
  const socket = new EventEmitter();
  socket.remoteAddress = remoteAddress;
  socket.destroyed = false;
  socket.write = () => true;
  socket.pause = () => {};
  socket.resume = () => {};
  socket.end = () => socket.destroy();
  socket.destroy = () => {
    if (socket.destroyed) return;
    socket.destroyed = true;
    socket.emit("close");
  };
  return socket;
};

/** A browser's connection as it reaches a session: the stream over the proxy's socket. */
const throughProxy = (proxy, player) => {
  const raw = fakeSocket(proxy);
  const stream = fakeSocket(player);
  stream.socket = raw;
  raw.on("close", () => stream.destroy());
  return { raw, stream };
};

const withSocketLimits = async (perAddress, body) => {
  const usual = [config.maxSocketConnections, config.maxSocketConnectionsPerIp];
  config.maxSocketConnections = 100;
  config.maxSocketConnectionsPerIp = perAddress;
  try {
    return await body();
  } finally {
    [config.maxSocketConnections, config.maxSocketConnectionsPerIp] = usual;
  }
};

/**
 * A connection from the proxy is not yet anybody: who it carries is in the
 * upgrade request, which has not arrived when the connection is admitted. So
 * the proxy's own connections count against the server's total only, and the
 * per-address limit is applied once the player is known.
 */
test("each player behind a trusted proxy has game sockets of their own", async () => {
  const { admitSocket, onConnection } = await import("../src/socket/index.js");

  await withTrust(["127.0.0.1"], () =>
    withSocketLimits(1, () => {
      const first = throughProxy("127.0.0.1", "198.51.100.1");
      const second = throughProxy("127.0.0.1", "198.51.100.2");
      assert.equal(admitSocket(first.raw), true);
      assert.equal(admitSocket(second.raw), true, "the proxy is not one address with one slot");

      const session = onConnection(first.stream);
      assert.ok(session);
      assert.equal(session.remoteAddress, "198.51.100.1", "the player is who the session is from");
      assert.ok(onConnection(second.stream), "a second player behind the same proxy");

      const again = throughProxy("127.0.0.1", "198.51.100.1");
      assert.equal(admitSocket(again.raw), true);
      assert.equal(onConnection(again.stream), null, "the first player's second socket is over their limit");
      assert.equal(again.raw.destroyed, true);

      first.raw.destroy();
      const back = throughProxy("127.0.0.1", "198.51.100.1");
      admitSocket(back.raw);
      assert.ok(onConnection(back.stream), "closing a socket frees its player's slot");
      for (const each of [second, back]) each.raw.destroy();
    })
  );
});

test("a raw connection through a trusted proxy is counted as the proxy", async () => {
  const { admitSocket, onConnection } = await import("../src/socket/index.js");

  await withTrust(["127.0.0.1"], () =>
    withSocketLimits(1, () => {
      // A desktop client through a TCP forwarder carries no header to read.
      const first = fakeSocket("127.0.0.1");
      const second = fakeSocket("127.0.0.1");
      assert.equal(admitSocket(first), true);
      assert.ok(onConnection(first));
      assert.equal(admitSocket(second), true);
      assert.equal(onConnection(second), null, "the proxy's address is the only one there is");
      first.destroy();
    })
  );
});

test("without trust, the proxy's connections share one address as before", async () => {
  const { admitSocket } = await import("../src/socket/index.js");

  await withTrust([], () =>
    withSocketLimits(1, () => {
      const first = throughProxy("127.0.0.1", "198.51.100.1");
      const second = throughProxy("127.0.0.1", "198.51.100.2");
      assert.equal(admitSocket(first.raw), true);
      assert.equal(admitSocket(second.raw), false);
      first.raw.destroy();
    })
  );
});

test("a browser's upgrade through a trusted proxy names the player", async (t) => {
  const { acceptGameSocket } = await import("../src/socket/websocket.js");
  const seen = [];
  const server = net.createServer((socket) => acceptGameSocket(socket, (conn) => seen.push(conn)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const upgradeFrom = async (forwarded) => {
    const client = net.connect(server.address().port, "127.0.0.1");
    await new Promise((resolve) => client.once("connect", resolve));
    const answer = new Promise((resolve) => client.once("data", resolve));
    client.write(
      "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
        forwarded.map((line) => `X-Forwarded-For: ${line}\r\n`).join("") +
        "\r\n"
    );
    assert.match((await answer).toString("latin1"), /^HTTP\/1\.1 101 /);
    client.destroy();
    return seen.at(-1).remoteAddress;
  };

  await withTrust(["127.0.0.1"], async () => {
    assert.equal(await upgradeFrom(["198.51.100.9"]), "198.51.100.9");
    assert.equal(await upgradeFrom(["1.1.1.1", "198.51.100.9"]), "198.51.100.9", "two header lines");
  });
  await withTrust([], async () => {
    assert.equal(await upgradeFrom(["198.51.100.9"]), "127.0.0.1");
  });
});
