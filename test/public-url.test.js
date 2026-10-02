import assert from "node:assert/strict";
import test from "node:test";

import { configProblems, loadServerConfig, publicBaseUrlFor } from "../src/config.js";

/**
 * The address players are given, as one URL.
 *
 * Discovery answered `http://` whatever was in front of the server. Behind a
 * TLS proxy that is the one answer that cannot work: the browser client is on
 * an https page, and a page that is https does not fetch from http — every
 * service call after discovery was blocked as mixed content. And the game
 * socket from an https page is `wss://`, which the game port does not speak,
 * so it has to be the proxy's port too.
 */

const refusals = (environment) => configProblems(environment).refusals;
const warnings = (environment) => configProblems(environment).warnings;

test("an https address is what discovery hands out, socket included", () => {
  const loaded = loadServerConfig({ ODS_PUBLIC_URL: "https://play.example.net" });

  assert.equal(publicBaseUrlFor(loaded), "https://play.example.net");
  assert.equal(loaded.publicSocketHost, "play.example.net");
  assert.equal(loaded.publicSocketPort, 443, "the browser's wss:// goes through the proxy as well");
  assert.equal(loaded.port, 8080, "and nothing changes about what is bound");
  assert.equal(loaded.gameSocketPort, 7198);
});

test("a port in the address is kept, and the socket follows it", () => {
  const loaded = loadServerConfig({ ODS_PUBLIC_URL: "https://play.example.net:8443/" });
  assert.equal(publicBaseUrlFor(loaded), "https://play.example.net:8443");
  assert.equal(loaded.publicSocketPort, 8443);
});

/**
 * Plain http is the same address in one setting instead of two. A cleartext
 * game socket is still reached directly, on its own port, so only https moves it.
 */
test("an http address names the web services and leaves the game socket where it was", () => {
  const loaded = loadServerConfig({ ODS_PUBLIC_URL: "http://203.0.113.7:9000", ODS_SOCKET_PORT: "7199" });
  assert.equal(publicBaseUrlFor(loaded), "http://203.0.113.7:9000");
  assert.equal(loaded.publicSocketHost, "203.0.113.7");
  assert.equal(loaded.publicSocketPort, 7199);

  assert.equal(publicBaseUrlFor(loadServerConfig({ ODS_PUBLIC_URL: "http://play.example.net" })), "http://play.example.net");
});

test("the socket's own settings still win, for a socket somewhere else", () => {
  const loaded = loadServerConfig({
    ODS_PUBLIC_URL: "https://play.example.net",
    ODS_PUBLIC_SOCKET_HOST: "game.example.net",
    ODS_PUBLIC_SOCKET_PORT: "9443",
  });
  assert.equal(loaded.publicSocketHost, "game.example.net");
  assert.equal(loaded.publicSocketPort, 9443);
});

test("an IPv6 address is written the way a URL needs it", () => {
  const loaded = loadServerConfig({ ODS_PUBLIC_URL: "https://[2001:db8::1]:8443" });
  assert.equal(publicBaseUrlFor(loaded), "https://[2001:db8::1]:8443");
  assert.equal(loaded.publicSocketHost, "2001:db8::1");
});

/** Content the server hands out is fetched by the same page, so it moves with it. */
test("the content address follows the public one", (t) => {
  if (!loadServerConfig({}).contentBaseUrl) return t.skip("this checkout has no content directory to hand out");
  const loaded = loadServerConfig({ ODS_PUBLIC_URL: "https://play.example.net" });
  assert.equal(loaded.contentBaseUrl, "https://play.example.net/content");
});

test("without it, nothing changes", () => {
  const loaded = loadServerConfig({ ODS_PUBLIC_HOST: "10.0.0.2" });
  assert.equal(publicBaseUrlFor(loaded), "http://10.0.0.2:8080");
  assert.equal(loaded.publicSocketPort, 7198);
});

test("an address that cannot be handed to a client stops the server", () => {
  for (const wrong of [
    "play.example.net",
    "ftp://play.example.net",
    "https://play.example.net/game",
    "https://play.example.net/?x=1",
    "https://user:pass@play.example.net",
    "https://0.0.0.0",
    "https://play.example.net:99999",
  ]) {
    const [refusal] = refusals({ ODS_PUBLIC_URL: wrong });
    assert.match(refusal ?? "", /ODS_PUBLIC_URL/, wrong);
  }
  assert.deepEqual(refusals({ ODS_PUBLIC_URL: "https://play.example.net/" }), [], "a bare slash is no path");
  assert.deepEqual(refusals({ ODS_PUBLIC_URL: "" }), [], "assigned nothing is the default");
});

/** Two settings for one address can only disagree, so only one is taken. */
test("the URL and the host and port it replaces are not given together", () => {
  for (const other of [{ ODS_PUBLIC_HOST: "play.example.net" }, { ODS_PUBLIC_PORT: "443" }]) {
    const [refusal] = refusals({ ODS_PUBLIC_URL: "https://play.example.net", ...other });
    assert.match(refusal ?? "", /ODS_PUBLIC_URL/);
    assert.match(refusal, new RegExp(Object.keys(other)[0]));
  }
});

/**
 * An https address means a proxy in front. Without that proxy trusted, every
 * player shares its address, and with it its limits — the server still works,
 * but sixty-five players are enough to lock out the sixty-sixth.
 */
test("an https address with no proxy trusted is warned about", () => {
  const [warning] = warnings({ ODS_PUBLIC_URL: "https://play.example.net" });
  assert.match(warning ?? "", /ODS_TRUSTED_PROXIES/);
  assert.deepEqual(warnings({ ODS_PUBLIC_URL: "https://play.example.net", ODS_TRUSTED_PROXIES: "127.0.0.1" }), []);
  assert.deepEqual(warnings({ ODS_PUBLIC_URL: "http://203.0.113.7:9000" }), []);
});
