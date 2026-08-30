#!/usr/bin/env node
/**
 * Issues the validation token a player pastes into their client configuration.
 *
 *   node tools/token.js 1000000005            # a token for that account
 *   node tools/token.js 1000000005 --days 90  # one that lasts longer
 *   node tools/token.js --check 1000000005 <token>
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
import { config } from "../src/config.js";
import { issueToken, verifyToken, TOKEN_TTL_SECONDS } from "../src/auth.js";

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};

const positional = process.argv.slice(2).filter((value) => !value.startsWith("--"));

if (!config.tokenSecret) {
  console.error(
    "No signing secret. Start the server once to have one written for you, or set ODS_TOKEN_SECRET."
  );
  process.exit(1);
}

const checking = process.argv.includes("--check");
if (checking) {
  const [accountId, token] = positional;
  const good = verifyToken(Number(accountId), token);
  console.log(good ? `valid for account ${accountId}` : "not valid");
  process.exit(good ? 0 : 1);
}

const accountId = Number(positional[0]);
if (!Number.isFinite(accountId) || accountId <= 0) {
  console.error("Usage: node tools/token.js <accountId> [--days N]");
  process.exit(1);
}

const days = Number(flag("days"));
const expiry = Number.isFinite(days) && days > 0
  ? Math.floor(Date.now() / 1000) + days * 86400
  : Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;

const token = issueToken(accountId, { expiry });
console.log(`Account ${accountId}, valid until ${new Date(expiry * 1000).toISOString()}\n`);
console.log("Put these two into the client's configuration:\n");
console.log(`  "AccountId": ${accountId},`);
console.log(`  "API_ValidationToken": "${token}"`);
