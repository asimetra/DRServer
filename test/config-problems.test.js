import assert from "node:assert/strict";
import test from "node:test";
import { configProblems, loadServerConfig, publicBaseUrlFor } from "../src/config.js";

/**
 * A setting that is wrong should be said to be wrong.
 *
 * Every one of these used to start the server. A port that would not parse
 * became the default port; a storage backend spelled the long way became the
 * other backend, and everybody logged in to a fresh account on it; a switch set
 * to `true` instead of `1` was read as its opposite. None of it was reported,
 * so the operator went on believing the file they had written.
 */
const refusals = (environment) => configProblems(environment).refusals;
const warnings = (environment) => configProblems(environment).warnings;

test("the defaults, and a sensible deployment, have nothing wrong with them", () => {
  assert.deepEqual(configProblems({}), { refusals: [], warnings: [] });
  assert.deepEqual(
    configProblems({
      ODS_HOST: "0.0.0.0",
      ODS_PUBLIC_HOST: "192.168.1.10",
      ODS_ALLOW_INSECURE_REMOTE: "1",
      ODS_PORT: "9000",
      ODS_STORAGE: "postgres",
      ODS_ADMIN_ACCOUNTS: "1000000005, 1000000006",
      ODS_AUTH: "1",
    }),
    { refusals: [], warnings: [] }
  );
});

test("a port that is not a port is refused rather than replaced by the default", () => {
  for (const value of ["abc", "80a80", "0", "99999", "-5", "8080.5"]) {
    assert.match(refusals({ ODS_PORT: value })[0], /ODS_PORT must be a port number.*1.*65535/);
  }
  assert.match(refusals({ ODS_SOCKET_PORT: "seven" })[0], /ODS_SOCKET_PORT/);
  assert.match(refusals({ ODS_INTERNAL_PORT: "70000" })[0], /ODS_INTERNAL_PORT/);
  assert.match(refusals({ DR_PORT: "abc" })[0], /DR_PORT/, "named the way it was spelled");
});

test("a storage backend nobody recognises is refused, not run on files", () => {
  for (const value of ["postgresql", "Postgres", "pg", "sqlite"]) {
    assert.match(refusals({ ODS_STORAGE: value })[0], /ODS_STORAGE must be "file" or "postgres"/);
  }
});

test("a switch is 0 or 1, and anything else is said rather than guessed", () => {
  for (const name of [
    "ODS_AUTH",
    "ODS_MIGRATE",
    "ODS_DUNGEON",
    "ODS_STRICT",
    "ODS_ALLOW_INSECURE_REMOTE",
    "ODS_ALLOW_INSECURE_INTERNAL",
  ]) {
    for (const value of ["true", "false", "yes", "on"]) {
      assert.match(refusals({ [name]: value })[0], new RegExp(`${name} must be 0 or 1`));
    }
    assert.deepEqual(refusals({ [name]: "0" }), []);
    assert.deepEqual(refusals({ [name]: "1" }), []);
  }
});

test("an administrator list that does not parse is refused whole", () => {
  assert.match(
    refusals({ ODS_ADMIN_ACCOUNTS: "1000000005;1000000006" })[0],
    /ODS_ADMIN_ACCOUNTS.*comma-separated.*1000000005;1000000006/
  );
  assert.deepEqual(refusals({ ODS_ADMIN_ACCOUNTS: "" }), [], "empty is nobody, as before");
  assert.deepEqual(refusals({ ODS_ADMIN_ACCOUNTS: "1000000005,1000000006," }), [], "a trailing comma is not an entry");
});

test("the advertised host has to be something a client can connect to", () => {
  assert.match(refusals({ ODS_PUBLIC_HOST: "0.0.0.0" })[0], /ODS_PUBLIC_HOST.*cannot connect to 0\.0\.0\.0/);
  assert.match(refusals({ ODS_PUBLIC_HOST: "::" })[0], /ODS_PUBLIC_HOST/);
  assert.match(refusals({ ODS_PUBLIC_HOST: "http://play.example.net" })[0], /a host name or address only/);
  assert.match(refusals({ ODS_PUBLIC_HOST: "play.example.net:9000" })[0], /a host name or address only/);
  assert.deepEqual(refusals({ ODS_PUBLIC_HOST: "play.example.net" }), []);
  assert.deepEqual(refusals({ ODS_PUBLIC_HOST: "2001:db8::1" }), [], "an IPv6 literal is an address");
  assert.deepEqual(refusals({ ODS_PUBLIC_HOST: "[2001:db8::1]" }), [], "bracketed or not");
  assert.equal(
    publicBaseUrlFor(loadServerConfig({ ODS_PUBLIC_HOST: "[2001:db8::1]" })),
    "http://[2001:db8::1]:8080",
    "and bracketed once"
  );
});

test("listening for other machines while advertising this one is pointed out", () => {
  const [warning] = warnings({ ODS_HOST: "0.0.0.0", ODS_ALLOW_INSECURE_REMOTE: "1" });
  assert.match(warning, /ODS_PUBLIC_HOST/);
  assert.match(warning, /127\.0\.0\.1/);
  assert.deepEqual(warnings({ ODS_HOST: "127.0.0.1" }), [], "loopback advertising loopback is the default");
});

test("an IPv6 address is bracketed where it goes into a URL", () => {
  const loaded = loadServerConfig({ ODS_PUBLIC_HOST: "2001:db8::1", ODS_PORT: "9000" });
  assert.equal(publicBaseUrlFor(loaded), "http://[2001:db8::1]:9000");
  assert.equal(publicBaseUrlFor(loadServerConfig({ ODS_PUBLIC_HOST: "10.0.0.2" })), "http://10.0.0.2:8080");
});

/**
 * A router forwarding port 9000 to 8080, or a tunnel that hands out a host and
 * port of its own for each listener: the client reaches the server through an
 * address the server is not listening on. Discovery could only ever say the
 * ports that were bound, so the first request arrived and every one after it
 * went to a port that was closed.
 */
test("what clients are told can differ from what is bound", () => {
  const plain = loadServerConfig({ ODS_PUBLIC_HOST: "203.0.113.7", ODS_PORT: "8081", ODS_SOCKET_PORT: "7199" });
  assert.equal(publicBaseUrlFor(plain), "http://203.0.113.7:8081", "the bound port, unless told otherwise");
  assert.equal(plain.publicSocketHost, "203.0.113.7");
  assert.equal(plain.publicSocketPort, 7199);

  const forwarded = loadServerConfig({
    ODS_PUBLIC_HOST: "play.example.net",
    ODS_PUBLIC_PORT: "9000",
    ODS_PUBLIC_SOCKET_HOST: "tcp.tunnel.example",
    ODS_PUBLIC_SOCKET_PORT: "31337",
  });
  assert.equal(forwarded.port, 8080, "the listener stays where it was");
  assert.equal(forwarded.gameSocketPort, 7198);
  assert.equal(publicBaseUrlFor(forwarded), "http://play.example.net:9000");
  assert.equal(forwarded.publicSocketHost, "tcp.tunnel.example");
  assert.equal(forwarded.publicSocketPort, 31337);

  assert.match(refusals({ ODS_PUBLIC_PORT: "nine thousand" })[0], /ODS_PUBLIC_PORT must be a port number/);
  assert.match(refusals({ ODS_PUBLIC_SOCKET_PORT: "0" })[0], /ODS_PUBLIC_SOCKET_PORT/);
  assert.match(refusals({ ODS_PUBLIC_SOCKET_HOST: "tcp://x:1" })[0], /ODS_PUBLIC_SOCKET_HOST.*host name or address only/);
});

/**
 * A variable passed through with nothing in it — `ODS_PORT=` in a compose
 * file, an `Environment=` line left blank — has always meant "the default".
 * It still does, for every setting: the one place it did not was `ODS_STRICT`,
 * where an empty value was read as "not 1" and switched strictness off.
 */
test("a setting assigned nothing is the default, not a refusal and not its opposite", () => {
  const blank = {
    ODS_PORT: "",
    ODS_SOCKET_PORT: "",
    ODS_STORAGE: "",
    ODS_AUTH: "",
    ODS_MIGRATE: "",
    ODS_DUNGEON: "",
    ODS_STRICT: "",
    ODS_ALLOW_INSECURE_REMOTE: "",
    ODS_PUBLIC_HOST: "",
  };
  assert.deepEqual(configProblems(blank), { refusals: [], warnings: [] });

  const loaded = loadServerConfig(blank);
  const defaults = loadServerConfig({});
  for (const key of ["port", "gameSocketPort", "storage", "authEnabled", "migrate", "dungeonsEnabled", "permissive", "allowInsecureRemote", "publicHost"]) {
    assert.deepEqual(loaded[key], defaults[key], key);
  }
});
