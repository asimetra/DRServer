#!/usr/bin/env node
/**
 * Issues the validation token a player pastes into their client configuration.
 *
 *   node tools/token.js 1000000005            # a token for that account, good for a year
 *   node tools/token.js 1000000005 --days 30  # one that expires sooner
 *   node tools/token.js --check 1000000005 <token>
 *   node tools/token.js --revoke 1000000005
 *
 * This is the whole of "signing up" for this server. The client has no login
 * screen — `DBFacade` reads `AccountId` and `API_ValidationToken` out of its
 * own configuration and presents them from then on — so whoever hands those
 * two values to a player has performed the authentication, and this is the
 * tool that does it. Anything issuing tokens with the same secret works just
 * as well: a web page, a bot, a spreadsheet. The game server only verifies.
 *
 * It needs the signing secret and nothing else — no database, no account.
 */
// Must be first: it fills the environment config.js reads as it is evaluated.
import "../src/load-env.js";
import path from "node:path";
import { config } from "../src/config.js";
import { ensureTokenSecret } from "../src/preflight.js";
import {
  issueToken,
  revokeAccountTokens,
  verifyToken,
  TOKEN_TTL_SECONDS,
} from "../src/auth.js";

/**
 * The same secret the server signs with, found the same way — and only found.
 *
 * This runs as its own process, so `config.tokenSecret` is whatever the
 * environment said and nothing more — the file the server wrote on its first
 * run is not read unless somebody reads it. Without this the tool reported
 * having no secret while one sat next to the account data, which is exactly
 * when an operator reaches for it.
 *
 * It does not make one. Pointed at a different data directory from the
 * server's — the server's set in a service file, this run from a shell — it
 * used to write a fresh secret there and print a token signed with it, and the
 * first anybody heard of it was the server refusing the token.
 */
ensureTokenSecret({ create: false });
const secretSource = process.env.ODS_TOKEN_SECRET || process.env.DR_TOKEN_SECRET
  ? "ODS_TOKEN_SECRET"
  : path.join(config.dataDir, "token-secret");

const usage = () => {
  console.error(
    [
      "Usage: node tools/token.js <accountId> [--days N]    issue a token",
      "       node tools/token.js --check <accountId> <token>",
      "       node tools/token.js --revoke <accountId>",
    ].join("\n")
  );
  process.exit(1);
};

/**
 * Flags that take a value keep it. Everything without two dashes used to be
 * positional, so in `--days 90 1000000005` the account was 90.
 */
const TAKES_VALUE = new Set(["--days"]);
const SWITCHES = new Set(["--check", "--revoke"]);
const options = new Map();
const positional = [];
const given = process.argv.slice(2);
for (let index = 0; index < given.length; index += 1) {
  const argument = given[index];
  if (TAKES_VALUE.has(argument)) options.set(argument, given[++index] ?? "");
  else if (SWITCHES.has(argument)) options.set(argument, true);
  else if (argument.startsWith("--")) usage();
  else positional.push(argument);
}

/** An id the protocol can carry: a whole number that fits its 32 bits. */
const accountIdFrom = (text) => {
  const id = /^\d+$/.test(String(text ?? "")) ? Number(text) : NaN;
  return id >= 1 && id <= 0xffff_ffff ? id : null;
};

const accountId = accountIdFrom(positional[0]);
if (accountId === null) usage();

if (!config.tokenSecret) {
  console.error(
    `No signing secret at ${secretSource}. Start the server once to have one written, set ` +
      "ODS_TOKEN_SECRET, or point ODS_DATA_DIR at the directory the server uses."
  );
  process.exit(1);
}

if (options.has("--check")) {
  const token = positional[1];
  if (!token) usage();
  const good = verifyToken(accountId, token);
  console.log(good ? `valid for account ${accountId}` : "not valid");
  process.exit(good ? 0 : 1);
}

if (options.has("--revoke")) {
  const generation = revokeAccountTokens(accountId);
  console.log(`Revoked existing tokens for account ${accountId} (generation ${generation}).`);
  console.log("Run the issue command again to create a replacement token.");
  process.exit(0);
}

let lifetime = TOKEN_TTL_SECONDS;
if (options.has("--days")) {
  const days = Number(options.get("--days"));
  if (!(Number.isFinite(days) && days > 0)) usage();
  lifetime = Math.round(days * 86400);
}
const expiry = Math.floor(Date.now() / 1000) + lifetime;

const token = issueToken(accountId, { expiry });
console.log(`Account ${accountId}, valid until ${new Date(expiry * 1000).toISOString()}`);
console.log(`signing secret: ${secretSource}\n`);
console.log("Put these two into the client's configuration:\n");
console.log(`  "AccountId": ${accountId},`);
console.log(`  "API_ValidationToken": "${token}"`);
