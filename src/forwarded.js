/**
 * Who a connection is from, when a proxy stands in front of the server.
 *
 * Behind a TLS proxy every request and every game socket arrives from the
 * proxy, and the limits kept per address — requests every ten seconds, game
 * sockets at once — then apply to all the players together, as if they were
 * one. The proxy says whom it is passing on in `X-Forwarded-For`. Anybody can
 * send that header, though, so it is read only on a connection from an address
 * the operator named in `ODS_TRUSTED_PROXIES`, and otherwise ignored.
 *
 * The header is a list every proxy appends to, so only its right end was
 * written by somebody trusted. It is read from the right, past the proxies the
 * operator named, and the first address that is not one of them is the player.
 * Whatever the player put further left is never reached.
 */
import net from "node:net";

const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** An IPv4 address a dual-stack listener reports as IPv6, as the IPv4 it is. */
const plain = (address) => {
  const mapped = MAPPED_IPV4.exec(address);
  return mapped && net.isIPv4(mapped[1]) ? mapped[1] : address;
};

const familyOf = (address) => (net.isIPv6(address) ? "ipv6" : "ipv4");

/**
 * The proxies to believe, from "127.0.0.1, ::1, 10.0.0.0/8" or a list of them.
 *
 * `invalid` lists what could not be read, which the startup checks refuse:
 * an operator who meant to trust a proxy and misspelled it would otherwise run
 * with every player counted as one.
 */
export const parseTrustedProxies = (value) => {
  const entries = (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const list = new net.BlockList();
  const invalid = [];
  for (const entry of entries) {
    const slash = entry.indexOf("/");
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const family = net.isIP(address);
    if (!family) {
      invalid.push(entry);
      continue;
    }
    if (slash === -1) {
      list.addAddress(address, familyOf(address));
      continue;
    }
    const prefix = entry.slice(slash + 1);
    const bits = /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN;
    if (!(bits >= 0 && bits <= (family === 6 ? 128 : 32))) {
      invalid.push(entry);
      continue;
    }
    list.addSubnet(address, bits, familyOf(address));
  }
  return { list, entries, invalid, empty: entries.length === invalid.length };
};

const isTrusted = (trusted, address) =>
  !trusted.empty && net.isIP(address) !== 0 && trusted.list.check(address, familyOf(address));

/** One entry of the header as an address, or null: "198.51.100.7:4711" and "[2001:db8::7]:80" included. */
const entryAddress = (entry) => {
  const text = entry.trim();
  if (net.isIP(text)) return plain(text);
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed && net.isIPv6(bracketed[1])) return bracketed[1];
  const withPort = /^([^:]+):\d+$/.exec(text);
  if (withPort && net.isIPv4(withPort[1])) return withPort[1];
  return null;
};

/** The player's address, given the connection's and what its header says. */
export const clientAddress = (remoteAddress, forwardedFor, trusted) => {
  const remote = plain(String(remoteAddress ?? ""));
  if (!isTrusted(trusted, remote)) return remote;

  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : String(forwardedFor ?? "");
  if (!header.trim()) return remote;
  const hops = header.split(",");
  let nearest = remote;
  for (let index = hops.length - 1; index >= 0; index--) {
    const address = entryAddress(hops[index]);
    // An entry that is not an address stops the reading: nothing to its left
    // was vouched for by the proxy that wrote it.
    if (!address) return nearest;
    if (!isTrusted(trusted, address)) return address;
    nearest = address;
  }
  return nearest;
};

let parsed = { key: null, value: null };

/** The operator's list, parsed once for as long as it stays the same. */
export const trustedFrom = (entries = []) => {
  const key = entries.join(",");
  if (parsed.key !== key) parsed = { key, value: parseTrustedProxies(entries) };
  return parsed.value;
};

/** Whether this address is one of the proxies in `trusted`. */
export const isTrustedProxy = (address, trusted) => isTrusted(trusted, plain(String(address ?? "")));
