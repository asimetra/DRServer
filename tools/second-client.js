#!/usr/bin/env node
/**
 * A second client, on a second account, without touching the first.
 *
 *   node tools/second-client.js 1000000006
 *   node tools/second-client.js 1000000006 --run
 *   node tools/second-client.js 1000000006 --from ~/some/other/client
 *   node tools/second-client.js --list
 *
 * Friends, presence and matchmaking all need two players, and until now testing
 * them meant one. The client does not have to be modified to get a second:
 * `DBConfigManager` opens `./DbConfiguration/Config.json` and `DBFacade` reads
 * `AccountId` out of it. So a directory with its own config and its own copy of
 * the binary, linking the rest, is a whole second client for about fifty
 * megabytes against the original's gigabyte.
 *
 * The account does not have to exist first. `loadAccount` creates one for any
 * id it has not seen, so a new number is a new player with a new hero and an
 * empty inventory — which is exactly what a second tester wants.
 *
 * Three things have to be right, and each of them was wrong once.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One: which client gets copied.
 *
 * There is more than one on this machine and they do not point at the same
 * place. A separate worktree may still be configured for a third-party service;
 * copying that one produces a second client that dutifully logs in somewhere
 * else, where a made-up account id means nothing. The one that points at
 * `127.0.0.1:8080` is the one worth copying.
 *
 * So the default is the local client, and a base whose config names anything
 * else is refused rather than quietly built — that mistake costs a run of the
 * game and a confusing log before anybody notices where it connected.
 */
const DEFAULT_CLIENT = path.join(os.homedir(), "Documents/bin/linux/bin");
const CONFIG_DIR = "DbConfiguration";
const CONFIG = path.join(CONFIG_DIR, "Config.json");
const BINARY = process.env.ODS_CLIENT_BINARY ?? "";
const LAUNCHER = "run.sh";

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

/**
 * Two: Steam wins unless you tell it not to.
 *
 * `AccountId` in the config is only a default. If the Steam login succeeds the
 * client does `dbFacade.accountId = toInt(playerId)`, so the number this tool
 * writes is replaced by whichever Steam account is signed in and both instances
 * are the same player again. Not hypothetical: of the logins this server has
 * received, 131 carried the configured id and 4 carried the Steam one.
 *
 * The client has a switch for exactly this. `DBFacade` reads
 * `getConfigBoolean("UseSteamLogin", true)` — note the default, which is why an
 * absent key means Steam wins — and `SteamAccountInfo.getOrCreateAccount`
 * begins:
 *
 *     if (!dbFacade.mUseSteamLogin) { Logger.info("Skipping logging into Steam."); ... }
 *
 * So the instance sets it false and keeps the id it was given. That is a
 * documented switch rather than a trick, and it leaves the Steamworks API up —
 * overlay, achievements and the rest keep working, which removing
 * `steam_appid.txt` would have taken away along with the login.
 */
const STEAM_LOGIN_OFF = { UseSteamLogin: false };

/** Instances live beside the client rather than inside it, so `git status` there stays clean. */
const home = path.join(os.homedir(), ".open-dungeon-server-clients");

const usage = () => {
  if (!BINARY) console.error("set ODS_CLIENT_BINARY to the local client executable name");
  console.error("usage: node tools/second-client.js <accountId> [--run] [--from <client dir>]");
  console.error("       node tools/second-client.js --list");
  process.exit(1);
};

const expand = (value) =>
  value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : path.resolve(value);

const listInstances = () => {
  if (!fs.existsSync(home)) return console.log("no second clients yet");
  for (const entry of fs.readdirSync(home)) {
    const config = path.join(home, entry, CONFIG);
    if (!fs.existsSync(config)) continue;
    const { AccountId, ServiceDiscoveryUrl } = JSON.parse(fs.readFileSync(config, "utf8"));
    const { UseSteamLogin } = JSON.parse(fs.readFileSync(config, "utf8"));
    const steam = UseSteamLogin === false ? "" : "  STEAM CAN OVERRIDE THE ACCOUNT";
    console.log(`  ${entry.padEnd(20)} account ${AccountId}  ${ServiceDiscoveryUrl}${steam}`);
  }
};

/**
 * Three kinds of entry, and getting them wrong is what makes this not work.
 *
 * `DbConfiguration` is the point of the exercise and is copied whole rather
 * than one file at a time, so a client that gains a second file there is
 * followed instead of half-copied.
 *
 * The binary is copied rather than linked. It contains `/proc/self/exe`, which
 * resolves through a symlink to the original path — so a linked one would very
 * likely find the original directory and read the original account back out of
 * it, which is the one thing this must not do. Fifty-two megabytes is a cheap
 * price for not having to wonder.
 *
 * Anything the client writes to is its own and empty: two instances sharing one
 * `client.log` interleave into something nobody can read, and `logs/` is where
 * the packet captures land, so sharing it would put both players' traffic in
 * one file and lose which was which. That directory is already 252MB in the
 * original, which is its own reason not to link it.
 *
 * Everything else — `Resources`, `lib`, `manifest`, the rest — is linked,
 * because it is most of a gigabyte and none of it is what makes this a
 * different player.
 */
const OWN_COPY = new Set([BINARY]);
const OWN_AND_EMPTY = new Set(["logs", "client.log"]);

/**
 * Three: it has to be started from its own directory.
 *
 * The config path is `./DbConfiguration/Config.json` — relative to the working
 * directory, not to the binary. Launched by its full path from somewhere else,
 * the client looks for the config under wherever the shell happened to be,
 * does not find one, and stops at the loading screen with
 * `Loader.handleIOErrorUrl from path: ./DbConfiguration/Config.json`.
 *
 * A launcher that puts itself in the right place first means it does not matter
 * how it is started.
 */
const launcher = `#!/bin/sh
# The client opens ./DbConfiguration/Config.json relative to the working
# directory, so it has to be started from here however it is launched.
cd "$(dirname "$0")" || exit 1
exec "./${BINARY}" "$@"
`;

const build = (accountId, client) => {
  const root = path.join(home, `account-${accountId}`);
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });

  for (const entry of fs.readdirSync(client)) {
    if (entry === CONFIG_DIR) continue;
    const target = path.join(root, entry);
    const source = path.join(client, entry);

    if (OWN_AND_EMPTY.has(entry)) {
      // Left alone once made, so a run's logs survive the next rebuild.
      if (!fs.existsSync(target)) {
        if (fs.statSync(source).isDirectory()) fs.mkdirSync(target, { recursive: true });
        else fs.writeFileSync(target, "");
      }
      continue;
    }

    // Rebuilt each time so a client that has since gained files is followed.
    if (fs.lstatSync(target, { throwIfNoEntry: false })) {
      fs.rmSync(target, { recursive: true, force: true });
    }

    if (OWN_COPY.has(entry)) {
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o755);
      continue;
    }
    fs.symlinkSync(source, target);
  }

  // The whole config directory, then the one field that makes this another player.
  for (const entry of fs.readdirSync(path.join(client, CONFIG_DIR))) {
    fs.copyFileSync(path.join(client, CONFIG_DIR, entry), path.join(root, CONFIG_DIR, entry));
  }
  const config = JSON.parse(fs.readFileSync(path.join(client, CONFIG), "utf8"));
  const original = config.AccountId;
  Object.assign(config, { AccountId: Number(accountId) }, STEAM_LOGIN_OFF);
  fs.writeFileSync(path.join(root, CONFIG), `${JSON.stringify(config, null, 2)}\n`);

  fs.writeFileSync(path.join(root, LAUNCHER), launcher, { mode: 0o755 });

  return { root, original, url: config.ServiceDiscoveryUrl };
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.includes("--list")) return listInstances();
  if (!BINARY) usage();

  const accountId = Number(args.find((argument) => /^\d+$/.test(argument)));
  if (!Number.isInteger(accountId) || accountId <= 0) usage();

  const from = args.indexOf("--from");
  const client = from === -1 ? DEFAULT_CLIENT : expand(args[from + 1] ?? "");

  if (!fs.existsSync(path.join(client, CONFIG))) {
    console.error(`no client config at ${path.join(client, CONFIG)}`);
    process.exit(1);
  }

  const { ServiceDiscoveryUrl } = JSON.parse(fs.readFileSync(path.join(client, CONFIG), "utf8"));
  if (!LOCAL.test(String(ServiceDiscoveryUrl ?? ""))) {
    console.error(`${client}`);
    console.error(`  points at ${ServiceDiscoveryUrl}, which is not this server.`);
    console.error(`  A second account id means nothing there, so this is refused.`);
    console.error(`  The local client is ${DEFAULT_CLIENT}; pass --from to override.`);
    process.exit(1);
  }

  const { root, original, url } = build(accountId, client);
  console.log(`second client ready: ${root}`);
  console.log(`  from ${client} -> ${url}`);
  console.log(`  account ${accountId} (the original stays ${original})`);
  console.log(`  UseSteamLogin false, so Steam cannot sign it in as somebody else`);

  if (!args.includes("--run")) {
    console.log(`\nrun it with:\n  ${path.join(root, LAUNCHER)}`);
    return;
  }

  const { spawn } = await import("node:child_process");
  console.log(`\nstarting it`);
  const child = spawn(path.join(root, LAUNCHER), [], { cwd: root, stdio: "inherit" });
  child.on("error", (error) => console.error(`could not start it: ${error.message}`));
};

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exit(1);
});
