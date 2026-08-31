import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { heldAccount } from "./account-registry.js";
import { loadGameMaster } from "./gamemaster.js";
import { modifierIdFor } from "./store.js";
import { readJsonFile } from "./json-file.js";
import { repairSpentPowerups } from "./powerup-slots.js";
import { info, warn } from "./log.js";
import {
  ACCOUNT_OBJECT_ID_FLOOR,
  CLIENT_PERSISTENT_OBJECT_ID_MAX,
  LEGACY_AVATAR_ID_OFFSET,
  isClientLocalObjectId,
} from "./account-object-ids.js";

const accountTemplate = readJsonFile(config.accountTemplateFile);

const hydrate = (value, replacements) => {
  if (Array.isArray(value)) return value.map((item) => hydrate(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, hydrate(item, replacements)])
    );
  }
  if (typeof value !== "string") return value;

  const exact = /^\$\{([A-Z_]+)\}$/.exec(value);
  if (exact && Object.hasOwn(replacements, exact[1])) return replacements[exact[1]];

  return value.replace(/\$\{([A-Z_]+)\}/g, (placeholder, name) =>
    Object.hasOwn(replacements, name) ? String(replacements[name]) : placeholder
  );
};

const accountScopedIds = (accountId) => {
  const id = Number(accountId);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff) {
    throw new RangeError(`account ${accountId} cannot supply persistent object ids`);
  }
  const offset = id % 400_000_000;
  return {
    avatarId: ACCOUNT_OBJECT_ID_FLOOR + offset,
    starterItemId: ACCOUNT_OBJECT_ID_FLOOR + 400_000_000 + offset,
  };
};

/**
 * Builds a fresh account with IDs unique to that account.
 *
 * The old template used avatar id 1 for everybody. Session-owned dungeons hid
 * the collision; a shared world cannot. XOR keeps a one-to-one mapping across
 * u32 account ids without a file-storage scan or a process-local counter.
 */
export const createAccount = (id, now = new Date().toISOString()) =>
  hydrate(accountTemplate, {
    ACCOUNT_ID: id,
    NOW: now,
    AVATAR_ID: accountScopedIds(id).avatarId,
    STARTER_ITEM_ID: accountScopedIds(id).starterItemId,
  });

const filePathFor = (id) => path.join(config.dataDir, `${id}.json`);
let temporaryFileId = 0;

/**
 * Accounts live either in one JSON file each or in Postgres. Both backends
 * expose the same pair of functions over the same object — the payload the
 * client receives — so nothing above this module knows the difference.
 *
 * The database module is imported lazily: `pg` should not have to be installed
 * to run with file storage.
 */
let database = null;

const usingDatabase = () => config.storage === "postgres";

const db = async () => {
  database ??= await import("./storage/postgres.js");
  return database;
};

const hasMapProgress = (mask) =>
  Array.from(mask ?? "", (character) => character.charCodeAt(0) & 0xff).some(Boolean);

/**
 * Repairs saves made before dungeon completion updated the avatar row.
 *
 * The client normally keeps node progress per hero. The bad server version
 * only wrote the account-wide mask, leaving every avatar empty. That shape is
 * the only unambiguous legacy case: once any avatar has progress, it is a real
 * per-hero save and must not be copied to another hero.
 */
export const repairActiveAvatarProgress = (account) => {
  const avatars = account?.account_avatars ?? [];
  const avatar = avatars.find((row) => row.id === account.active_avatar);
  if (
    !avatar ||
    !hasMapProgress(account.completed_mapnode_mask) ||
    avatars.some((row) => hasMapProgress(row.completed_mapnode_mask))
  ) {
    return false;
  }

  avatar.completed_mapnode_mask = account.completed_mapnode_mask;
  return true;
};

/**
 * Moves avatar instance ids out of the native client's LocalUniqueID range.
 *
 * Avatar ids are not just database keys: the official protocol reuses the
 * active avatar id as HeroGameObjectOwner's distributed-object id. Old server
 * sequences began inside the client's 1,000,000..1,099,999 local-object range,
 * so a purchased hero could replace an unrelated local GameObject and never be
 * attached to its floor. The first incoming damage effect then dereferenced a
 * null dungeon floor and segfaulted.
 */
export const repairAvatarInstanceIds = (account) => {
  const avatars = account?.account_avatars ?? [];
  const remapped = new Map();
  const occupied = new Set(
    avatars.map((avatar) => Number(avatar.id)).filter((id) => !isClientLocalObjectId(id))
  );

  for (const avatar of avatars) {
    const oldId = Number(avatar.id);
    if (!isClientLocalObjectId(oldId)) continue;

    const newId = LEGACY_AVATAR_ID_OFFSET + oldId;
    if (!Number.isSafeInteger(newId) || newId > 0xffffffff || occupied.has(newId)) {
      throw new RangeError(`cannot safely migrate avatar instance id ${oldId}`);
    }
    remapped.set(oldId, newId);
    occupied.add(newId);
    avatar.id = newId;
  }

  if (!remapped.size) return 0;

  const remap = (value) => remapped.get(Number(value)) ?? value;
  account.active_avatar = remap(account.active_avatar);
  for (const item of account.account_items ?? []) {
    if (item.avatar_id != null) item.avatar_id = remap(item.avatar_id);
  }
  for (const pet of account.account_pets ?? []) {
    if (pet.equipped_hero != null) pet.equipped_hero = remap(pet.equipped_hero);
  }
  return remapped.size;
};

/**
 * Weapons whose modifiers were stored under their name rather than their id.
 *
 * `OfferDetails` names them and the shop wrote the name straight through, which
 * nothing complains about: the item sits in the bag at the right rarity, and
 * every reader of the modifier quietly discards it — `ItemInfo.parseJson`
 * because NaN fails its `> 0` guard, the wire because it encodes a u32, and
 * this server's own sell price because it sums the pair. So the rows are
 * repaired on load; leaving them would mean a player only ever finding out by
 * noticing an absence.
 */
const COLUMNS = [
  ["modifier1", "Modifiers"],
  ["modifier2", "Modifiers"],
  ["legendarymodifier", "LegendaryModifiers"],
];

export const repairItemModifiers = async (account) => {
  const items = account.account_items ?? [];
  if (!items.some((item) => COLUMNS.some(([column]) => typeof item?.[column] === "string"))) {
    return 0;
  }

  const gm = await loadGameMaster();
  let repaired = 0;
  for (const item of items) {
    for (const [column, table] of COLUMNS) {
      if (typeof item?.[column] !== "string") continue;
      item[column] = modifierIdFor(gm, item[column], table);
      repaired += 1;
    }
  }
  return repaired;
};

/**
 * Account attributes are the client's preference store.
 *
 * The checked-in template supplies defaults for new and legacy accounts, while
 * an existing row always wins so a player's later choice survives login. Rows
 * also need real ids before Postgres can persist them; the file backend uses
 * the same shape to keep switching storage modes lossless.
 */
export const repairAccountAttributes = async (account) => {
  const defaults = hydrate(accountTemplate.account_attributes ?? [], {
    ACCOUNT_ID: account.id,
  });
  const original = Array.isArray(account.account_attributes)
    ? account.account_attributes
    : [];
  const unique = [];
  const names = new Set();
  let changed = !Array.isArray(account.account_attributes);

  for (const row of original) {
    const name = String(row?.name ?? "");
    if (!name || names.has(name)) {
      changed = true;
      continue;
    }
    names.add(name);
    unique.push(row);
  }

  for (const row of defaults) {
    if (names.has(row.name)) continue;
    names.add(row.name);
    unique.push({ ...row });
    changed = true;
  }

  account.account_attributes = unique;
  for (const row of unique) {
    if (row.account_id !== account.id) {
      row.account_id = account.id;
      changed = true;
    }
    if (!Number.isSafeInteger(row.id) || row.id <= 0) {
      row.id = await nextObjectId(account);
      changed = true;
    }
    const value = String(row.value ?? "");
    if (row.value !== value) {
      row.value = value;
      changed = true;
    }
  }
  return changed;
};

const repairLoadedAccount = async (account) => {
  const migratedAvatars = repairAvatarInstanceIds(account);
  const restoredProgress = repairActiveAvatarProgress(account);
  const restoredAttributes = await repairAccountAttributes(account);
  const namedModifiers = await repairItemModifiers(account);
  const spentPowerups = repairSpentPowerups(account);
  if (
    !migratedAvatars &&
    !restoredProgress &&
    !restoredAttributes &&
    !namedModifiers &&
    !spentPowerups
  ) {
    return account;
  }

  await saveAccount(account);
  if (migratedAvatars) {
    info(
      `accounts: moved ${migratedAvatars} avatar id(s) out of the client-local range`
    );
  }
  if (restoredProgress) {
    info(`accounts: restored map progress to active avatar ${account.active_avatar}`);
  }
  if (restoredAttributes) {
    info(`accounts: restored default preferences for account ${account.id}`);
  }
  if (namedModifiers) {
    info(`accounts: gave ${namedModifiers} named weapon modifier(s) their ids`);
  }
  if (spentPowerups) {
    info(`accounts: cleared ${spentPowerups} spent powerup(s) from account ${account.id}`);
  }
  return account;
};

/**
 * One at a time, per account.
 *
 * `loadAccount` hands back a fresh object on every call and nothing between the
 * HTTP server and a handler serialises anything, so two requests naming one
 * account both read it, both change their own copy, and the second save
 * silently discards the first. That is not a subtle loss: two `PurchaseOffer`
 * calls fired together deduct one price and grant two items, and two
 * `GiftOffer` calls pass one cooldown and send two gifts. Read-modify-write
 * without a lock is an item duplicator anywhere an account is spent down.
 *
 * A promise chain per id is the whole mechanism: each caller waits on the one
 * before it and becomes the tail. Held only for the length of the callback, so
 * a handler that loads, changes and saves inside it cannot be interleaved with
 * another doing the same.
 *
 * It is not a transaction. Different accounts still run at once, which is the
 * point, and a handler touching two of them must take both through
 * `withTwoAccountLocks` rather than nesting these by hand.
 */
const accountChains = new Map();

export const withAccountLock = async (id, work) => {
  const key = Number(id);
  const previous = accountChains.get(key) ?? Promise.resolve();
  // The next caller waits for this one either way: a thrown error must not
  // wedge the chain for everybody behind it.
  const mine = previous.then(work, work);
  const tail = mine.then(
    () => {},
    () => {}
  );
  accountChains.set(key, tail);
  try {
    return await mine;
  } finally {
    // Whoever is last out clears the entry, so the map does not only grow.
    if (accountChains.get(key) === tail) accountChains.delete(key);
  }
};

/**
 * Both of them, smallest id first.
 *
 * Nesting two of these in whatever order the work happens to want is how two
 * requests end up holding one lock each and waiting for the other: A gifting B
 * while B gifts A is exactly that, and neither ever finishes. Sorting the pair
 * means every caller takes them in the same order, which is all it takes for a
 * cycle to be impossible.
 */
export const withTwoAccountLocks = async (first, second, work) => {
  const [low, high] = [Number(first), Number(second)].sort((a, b) => a - b);
  if (low === high) return withAccountLock(low, work);
  return withAccountLock(low, () => withAccountLock(high, work));
};

/**
 * Loads an account, creating a fresh one on first sight.
 *
 * An account somebody is already playing is handed back as the object they are
 * playing, not as a second copy of it — see `src/account-registry.js` for why.
 * Re-reading the file here is what let a JSON-RPC edit and a dungeon session
 * hold divergent versions of one row, with the later save silently discarding
 * the other.
 */
export const loadAccount = async (id) => {
  const live = heldAccount(id);
  if (live) return live;
  return readAccount(id);
};

const readAccount = async (id) => {
  if (usingDatabase()) {
    const existing = await (await db()).loadAccount(id);
    if (existing) return repairLoadedAccount(existing);

    info(`accounts: creating new account ${id}`);
    return repairLoadedAccount(createAccount(id));
  }

  const file = filePathFor(id);
  try {
    const raw = await fs.readFile(file, "utf8");
    return repairLoadedAccount(JSON.parse(raw));
  } catch (err) {
    if (err.code !== "ENOENT") {
      warn(`accounts: could not read ${file}: ${err.message} — recreating`);
    } else {
      info(`accounts: creating new account ${id}`);
    }
    const account = createAccount(id);
    return repairLoadedAccount(account);
  }
};

/**
 * Several accounts at once, so that a move between two of them cannot half
 * happen.
 *
 * `withTwoAccountLocks` stops two writers interleaving; it does nothing about
 * one writer stopping halfway. A gift takes a stackable off the sender and puts
 * it on the recipient, and saving them one after the other means a crash in
 * between leaves the item on neither account or on both.
 *
 * On Postgres this is one transaction. On files it cannot be — two renames are
 * two operations and no filesystem call makes them one — so it is the nearest
 * thing: every file is written to a temporary first and the renames happen
 * together at the end. A failure before the first rename leaves nothing
 * changed, and the window where one has landed and the other has not is a pair
 * of adjacent rename calls rather than a whole serialise and write.
 */
export const saveAccounts = async (accounts) => {
  const unique = [];
  for (const account of accounts) {
    const already = unique.find((other) => Number(other.id) === Number(account.id));
    if (!already) {
      unique.push(account);
      continue;
    }
    /**
     * The same account twice is ordinary — a sender and a recipient who turn
     * out to be one person are the same object, because the registry hands
     * every holder the object already in play. Two *different* objects for one
     * id are the divergence that registry exists to prevent, and writing one
     * while discarding the other is the silent loss this function was added to
     * stop, so it is refused rather than resolved.
     */
    if (already !== account) {
      throw new Error(`accounts: two different objects offered for account ${account.id}`);
    }
  }

  if (usingDatabase()) {
    await (await db()).saveAccounts(unique);
    return unique;
  }
  return saveAccountsToFiles(unique);
};

export const saveAccount = async (account) => {
  await saveAccounts([account]);
  return account;
};

/**
 * Every account this server knows about.
 *
 * The friends and leaderboard endpoints answer questions about *other people*,
 * which on the official server is a separate service holding millions of rows.
 * A custom server's population is whoever plays on it, so the population is the
 * data directory. Ids only — callers load the few they actually need.
 */
export const listAccountIds = async () => {
  if (usingDatabase()) return (await db()).listAccountIds?.() ?? [];
  try {
    const names = await fs.readdir(config.dataDir);
    return names
      .filter((name) => name.endsWith(".json"))
      .map((name) => Number(name.slice(0, -5)))
      .filter((id) => Number.isFinite(id));
  } catch (err) {
    if (err.code !== "ENOENT") {
      warn(`accounts: could not list ${config.dataDir}: ${err.message}`);
    }
    return [];
  }
};

/**
 * Ids for objects the server hands out — chest awards and the like.
 *
 * Postgres has a sequence. File storage has to derive one, and an in-memory
 * counter is not enough: it resets with the process and starts handing out ids
 * that already exist. So the floor is raised past every id currently on disk
 * before the first allocation.
 */
const FILE_ID_FLOOR = ACCOUNT_OBJECT_ID_FLOOR;
let fileObjectId = 0;
let fileObjectIdReady = null;

const highestIdIn = (account) => {
  let highest = 0;
  for (const value of Object.values(account)) {
    if (!Array.isArray(value)) continue;
    for (const row of value) {
      if (
        typeof row?.id === "number" &&
        row.id <= CLIENT_PERSISTENT_OBJECT_ID_MAX &&
        row.id > highest
      ) highest = row.id;
    }
  }
  return highest;
};

const initializeFileObjectId = async () => {
  let highest = FILE_ID_FLOOR;
  try {
    const names = await fs.readdir(config.dataDir);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const account = JSON.parse(
          await fs.readFile(path.join(config.dataDir, name), "utf8")
        );
        highest = Math.max(highest, highestIdIn(account));
      } catch (err) {
        warn(`accounts: could not inspect ${name} while allocating ids: ${err.message}`);
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      warn(`accounts: could not inspect ${config.dataDir} while allocating ids: ${err.message}`);
    }
  }
  fileObjectId = Math.max(fileObjectId, highest);
};

export const nextObjectId = async (account = null) => {
  if (usingDatabase()) {
    const id = await (await db()).nextId();
    if (id > CLIENT_PERSISTENT_OBJECT_ID_MAX) {
      throw new RangeError("persistent object id space exhausted");
    }
    return id;
  }

  fileObjectIdReady ??= initializeFileObjectId();
  await fileObjectIdReady;
  const floor = Math.max(FILE_ID_FLOOR, fileObjectId, account ? highestIdIn(account) : 0);
  fileObjectId = floor + 1;
  if (fileObjectId > CLIENT_PERSISTENT_OBJECT_ID_MAX) {
    throw new RangeError("persistent object id space exhausted");
  }
  return fileObjectId;
};

const saveAccountsToFiles = async (accounts) => {
  /**
   * Serialised on entry, every one of them, before the first await.
   *
   * Callers chain saves so that two cannot rename out of order, and that
   * ordering only means something if each save holds the snapshot its caller
   * had rather than whatever the object has become by the time its turn to be
   * written comes round. See `settleDungeonAccount`, which relies on it.
   */
  const staged = accounts.map((account) => {
    const file = filePathFor(account.id);
    return {
      file,
      temporary: `${file}.${process.pid}.${++temporaryFileId}.tmp`,
      contents: `${JSON.stringify(account, null, 2)}\n`,
    };
  });

  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    for (const { temporary, contents } of staged) {
      await fs.writeFile(temporary, contents, "utf8");
    }
    for (const { temporary, file } of staged) {
      await fs.rename(temporary, file);
    }
  } catch (error) {
    await Promise.all(staged.map(({ temporary }) => fs.rm(temporary, { force: true })));
    throw error;
  }
  return accounts;
};
