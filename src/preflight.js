/**
 * Says at startup what would otherwise be found out by a player.
 *
 * The server binds its ports and reports itself healthy with no compatibility
 * data at all, because nothing reads that data until somebody enters a floor.
 * So a fresh install looks like it worked, and the first thing that goes wrong
 * goes wrong for a person who is already playing — an `ENOENT` in the log, a
 * client stuck on a loading screen, and nothing connecting the two to the
 * install step that was skipped.
 *
 * This does not refuse to start. Running the web services alone is a legitimate
 * thing to do, and a server that will not boot is a worse failure than one that
 * says clearly what it cannot do yet.
 *
 * The manifest is the single source of truth for what is required, the same
 * list tools/sync-game-data.js imports and verifies. Existence only: checksums
 * are `npm run check:data`'s job, and thirty-eight stats are not worth turning
 * into thirty-eight reads on every boot.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { info, warn } from "./log.js";
import { generateSecret } from "./auth.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestFile = path.join(serverRoot, "game-data", "manifest.json");

/** Where the manifest's `Resources/...` source path lands locally. */
const localPathFor = (entry) =>
  path.resolve(config.resourcesDir, String(entry.source).replace(/^Resources[\\/]/, ""));

export const checkCompatibilityData = () => {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch (problem) {
    warn(`compatibility manifest unreadable (${problem.message}); data check skipped`);
    return { required: 0, missing: 0 };
  }

  const entries = Array.isArray(manifest.files) ? manifest.files : [];
  const missing = entries.filter((entry) => !fs.existsSync(localPathFor(entry)));

  if (!missing.length) {
    info(`compatibility data present (${entries.length} files)`);
    return { required: entries.length, missing: 0 };
  }

  warn(`compatibility data incomplete: ${missing.length} of ${entries.length} files missing`);
  warn(`  looked in ${config.resourcesDir}`);
  for (const entry of missing.slice(0, 3)) warn(`  missing ${entry.source}`);
  if (missing.length > 3) warn(`  ...and ${missing.length - 3} more`);
  warn("  dungeons will fail to load until this is imported from your own client:");
  warn("  npm run sync:data -- --source /path/to/your/client");

  return { required: entries.length, missing: missing.length };
};

/**
 * Whether this server is supplying game data of its own, and at what address.
 *
 * Worth a line because the feature is invisible from the outside: it needs a
 * matching pair of keys in the *client's* configuration, and if either side is
 * unset the floors simply come off the player's disk with nothing said. An
 * operator who has set one and not the other has no other way to find out.
 */
export const reportContentOverride = () => {
  if (!config.contentBaseUrl || !config.contentDir) {
    info("content override off; clients load all game data from their own disk");
    return false;
  }

  let files = 0;
  const count = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) count(path.join(directory, entry.name));
      else files += 1;
    }
  };
  try {
    count(config.contentDir);
  } catch {
    warn(`content directory unreadable: ${config.contentDir}`);
    return false;
  }

  info(`serving ${files} content files at ${config.contentBaseUrl}`);
  info('  clients need download_root "" and a matching gameMasterPath');
  return true;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Both services carry the same bearer credential in cleartext. Refusing a
 * remote bind by default prevents an operator from publishing only the HTTP
 * side behind TLS while accidentally leaving the raw game socket exposed.
 */
export const ensureSafeTransport = () => {
  if (LOOPBACK_HOSTS.has(String(config.host).toLowerCase())) return true;
  if (config.allowInsecureRemote) {
    warn(
      `transport: cleartext HTTP and game socket exposed on ${config.host}; ` +
        "use only inside a trusted VPN or tunnel"
    );
    return false;
  }
  throw new Error(
    `refusing cleartext remote bind on ${config.host}; bind to loopback behind a VPN/tunnel, ` +
      "or set ODS_ALLOW_INSECURE_REMOTE=1 to acknowledge the risk"
  );
};

/**
 * The signing secret, made once and kept.
 *
 * An operator should not have to invent a key before the server will start, and
 * a key that changes on restart would sign every player out — which is exactly
 * what the previous in-memory token table did, unnoticed, because nothing ever
 * checked a token. So it is written beside the account data on first run and
 * read back afterwards. `ODS_TOKEN_SECRET` overrides it and is the right answer
 * for more than one machine.
 */
export const ensureTokenSecret = () => {
  if (config.tokenSecret) {
    warnIfWeakSecret(config.tokenSecret, "configured token secret");
    return config.tokenSecret;
  }

  const file = path.join(config.dataDir, "token-secret");
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8").trim();
  } catch (problem) {
    if (problem.code !== "ENOENT") {
      throw new Error(`cannot read signing secret ${file}: ${problem.message}`);
    }
  }

  if (existing) {
    if (process.platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0) {
      fs.chmodSync(file, 0o600);
      info(`auth: restricted signing-secret permissions to 0600 at ${file}`);
    }
    config.tokenSecret = existing;
    warnIfWeakSecret(existing, file);
    return config.tokenSecret;
  }

  fs.mkdirSync(config.dataDir, { recursive: true });
  config.tokenSecret = generateSecret();
  fs.writeFileSync(file, `${config.tokenSecret}\n`, { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  info(`auth: wrote a new signing secret to ${file}`);
  freshSecret = true;
  return config.tokenSecret;
};

const warnIfWeakSecret = (secret, source) => {
  if (Buffer.byteLength(secret, "utf8") < 32) {
    warn(`auth: ${source} is shorter than 32 bytes; replace it with a strong random secret`);
  }
};

/** Whether this run is the one that made the secret. */
let freshSecret = false;

/**
 * Says plainly whether this server checks who is calling, and on the run that
 * created the secret, says what to do about it.
 *
 * Nobody can connect to a server whose secret was made a moment ago: every
 * client is presenting a token signed by nothing, and the failure it shows is
 * an error popup rather than an explanation. This is the one step between
 * `npm start` and playing, so it is worth more than a clause.
 */
export const reportAuth = () => {
  if (config.authEnabled === false) {
    warn("auth is OFF — any client may claim any account id on this server");
    return false;
  }

  if (!freshSecret) {
    info("auth on; a player's first token comes from: node tools/token.js <accountId>");
    return true;
  }

  info("auth on, and this server has just made its signing secret.");
  info("  No client can connect until you give it one of this server's tokens:");
  info("");
  info("      node tools/token.js 1000000001");
  info("");
  info("  That prints an AccountId and an API_ValidationToken to paste into the");
  info("  client's configuration. Do the same, with a different number, for");
  info("  everybody else who plays here. See docs/client-setup.md.");
  return true;
};

/**
 * Whether the database is the one this server was written against.
 *
 * Reported here rather than discovered by the first query that reaches a new
 * column. That is how it went twice — "column is_new does not exist", then
 * "column tax does not exist" — and each names a column while saying nothing
 * about a schema, a migration, or what to run. The second arrived as a broken
 * market page.
 *
 * `docker-compose.yml` mounts db/schema.sql as an init script, and Postgres
 * runs those once, when the volume is made. A database started before a column
 * was added keeps its old shape however often it restarts, so this is not an
 * unusual state to be in — it is the ordinary consequence of pulling.
 *
 * It warns rather than refusing to start: a server whose market is short a
 * column still serves dungeons, and stopping the whole thing would be a worse
 * answer than saying which table to fix.
 */
export const checkDatabaseSchema = async () => {
  if (config.storage !== "postgres") return true;

  const [{ schemaExpects, driftBetween, columnsInDatabase, isAdditiveOnly }, { default: pg }] =
    await Promise.all([import("./storage/schema-check.js"), import("pg")]);

  const schemaFile = path.join(serverRoot, "db", "schema.sql");
  const sql = fs.readFileSync(schemaFile, "utf8");
  const expected = schemaExpects(sql);

  const client = new pg.Client({ connectionString: config.databaseUrl });
  try {
    await client.connect();
    const drift = driftBetween(expected, await columnsInDatabase(client));
    if (!drift.length) {
      info(`database schema is current (${Object.keys(expected).length} tables)`);
      return true;
    }

    for (const { table, missing } of drift) {
      info(missing === null ? `  database: no ${table} table` : `  database: ${table} has no ${missing.join(", ")}`);
    }

    if (config.migrate === false) {
      warn("the database is older than this server, and ODS_MIGRATE=0 says not to touch it");
      warn(`  apply it yourself with: psql ... < ${schemaFile}`);
      return false;
    }

    /**
     * Read before it is run. Everything in the file today adds and nothing
     * takes away, which is the only reason running it unattended is a
     * convenience rather than a risk — so that is checked each time rather
     * than assumed to still be true.
     */
    if (!isAdditiveOnly(sql)) {
      warn("the database is older than this server, and db/schema.sql now removes things.");
      warn("  It will not be applied automatically. Read it, then apply it yourself.");
      return false;
    }

    /**
     * One writer at a time. Two servers starting together would otherwise both
     * decide the schema is short and both run the DDL, and `CREATE TABLE IF
     * NOT EXISTS` racing itself is one of the few ways to deadlock Postgres.
     * The number is arbitrary and only has to be the same in every process.
     */
    await client.query("SELECT pg_advisory_lock($1)", [0x0d5_5c8e]);
    try {
      const after = driftBetween(expected, await columnsInDatabase(client));
      if (!after.length) {
        info("database schema brought up to date by another server");
        return true;
      }
      await client.query(sql);
      const remaining = driftBetween(expected, await columnsInDatabase(client));
      if (remaining.length) {
        /**
         * What running the file cannot fix.
         *
         * `CREATE TABLE IF NOT EXISTS` skips a table that already exists, so a
         * column added by editing a CREATE block reaches new databases and no
         * others. That is why every column added since the first release
         * carries an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` beside it —
         * the CREATE is for a fresh database and the ALTER is for every one
         * that is already running, and a column needs both.
         */
        warn("db/schema.sql was applied and the database is still short:");
        for (const { table, missing } of remaining) {
          warn(missing === null ? `  no ${table} table` : `  ${table}: no ${missing.join(", ")}`);
        }
        warn("  A column inside a CREATE TABLE does not reach a table that already exists.");
        warn("  Each of these needs a line in db/schema.sql beside its CREATE:");
        const [first] = remaining;
        if (first?.missing?.length) {
          warn(`    ALTER TABLE IF EXISTS ${first.table} ADD COLUMN IF NOT EXISTS ${first.missing[0]} <type>;`);
        }
        return false;
      }
      info(`database schema brought up to date (${drift.length} table(s) changed)`);
      return true;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [0x0d5_5c8e]).catch(() => undefined);
    }
  } catch (problem) {
    /*
     * A database this server may read but not alter is a legitimate way to run
     * it — so this says what to run rather than refusing to start, which is the
     * same choice every other check here makes.
     */
    warn(`could not bring the database up to date: ${problem.message}`);
    warn(`  apply it with: psql ... < ${schemaFile}`);
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
};
