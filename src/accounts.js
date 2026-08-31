import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { heldAccount } from "./account-registry.js";
import { NameRefused, checkName, nameTaken } from "./account-names.js";
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

/** One promise chain per key: each caller waits for the one before it. */
const serialise = async (chains, id, work) => {
  const key = Number(id);
  const previous = chains.get(key) ?? Promise.resolve();
  // The next caller waits for this one either way: a thrown error must not
  // wedge the chain for everybody behind it.
  const mine = previous.then(work, work);
  const tail = mine.then(
    () => {},
    () => {}
  );
  chains.set(key, tail);
  try {
    return await mine;
  } finally {
    // Whoever is last out clears the entry, so the map does not only grow.
    if (chains.get(key) === tail) chains.delete(key);
  }
};

export const withAccountLock = (id, work) => serialise(accountChains, id, work);

/**
 * And a second, narrower chain: one write at a time per account.
 *
 * `saveAccountsToFiles` takes its snapshot when it is called and renames when the
 * disk is ready, so two writes that overlap are two snapshots racing to be
 * last — and the earlier one can win, discarding everything that happened
 * between them. Measured at 6.7% of 300 forced attempts.
 *
 * `withAccountLock` does not cover it. That one serialises whole JSON-RPC
 * transactions, and the writes it is racing against come from the socket:
 * dungeon rewards, the powerup settle, the chest a player keeps. Those are a
 * different chain and always will be, because a dungeon cannot hold a
 * transaction lock for the length of a run.
 *
 * So this sits underneath both. Deliberately separate rather than the same
 * lock: a save happens *inside* `withAccountLock` on every RPC, and one chain
 * taken twice is a wait for itself. Nothing takes the transaction lock while
 * holding this one, so the pair cannot cycle.
 */
const writeChains = new Map();

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

/**
 * A first login, written down because it happened rather than by accident.
 *
 * There is no registration on this server: an operator signs a token for an id
 * and the account materialises the first time somebody arrives holding it. So
 * this is the moment a player comes into existence, and it has to reach
 * storage on its own terms.
 *
 * It used to survive only as a side effect. `repairLoadedAccount` saves when a
 * repair changed something, and for a brand-new account exactly one of the five
 * fires — `repairAccountAttributes`, because the template's preference rows
 * carry no ids yet. Give those rows ids in the template, which is precisely the
 * tidy-up somebody would make, and every repair returns false: the account is
 * served, never written, and rebuilt identically on the next request. The
 * player would keep nothing and nothing would report it.
 */
const createAndPersist = async (id) => {
  info(`accounts: creating new account ${id}`);
  const account = await repairLoadedAccount(createAccount(id));
  await saveAccount(account);
  return account;
};

const readAccount = async (id) => {
  if (usingDatabase()) {
    const existing = await (await db()).loadAccount(id);
    if (existing) return repairLoadedAccount(existing);
    return createAndPersist(id);
  }

  const file = filePathFor(id);
  try {
    const raw = await fs.readFile(file, "utf8");
    return repairLoadedAccount(JSON.parse(raw));
  } catch (err) {
    if (err.code !== "ENOENT") {
      warn(`accounts: could not read ${file}: ${err.message} — recreating`);
    }
    return createAndPersist(id);
  }
};

/**
 * Every write chain these accounts need, taken smallest id first.
 *
 * Sorted for the same reason `withTwoAccountLocks` is sorted: a save of the
 * pair (A, B) and a save of (B, A) that each took theirs in the order they were
 * handed would hold one apiece and wait for the other. Taking them in one
 * agreed order is all it takes for that cycle to be impossible.
 */
const withWriteChains = (ids, work) =>
  [...new Set(ids.map(Number))]
    .sort((a, b) => a - b)
    .reduceRight((next, id) => () => serialise(writeChains, id, next), work)();

/**
 * Several accounts at once, so that a move between two of them cannot half
 * happen.
 *
 * `withTwoAccountLocks` stops two writers interleaving and the write chain
 * stops two writes overtaking; neither says anything about one writer stopping
 * halfway. A gift takes a stackable off the sender and puts it on the
 * recipient, and saving them one after the other means a crash in between
 * leaves the item on neither account or on both.
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

  return withWriteChains(
    unique.map((account) => account.id),
    async () => {
      if (usingDatabase()) {
        await (await db()).saveAccounts(unique);
        return unique;
      }
      return saveAccountsToFiles(unique);
    }
  );
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

/**
 * Where ids for accounts this server invents begin.
 *
 * Above the client's persistent-object range and in the neighbourhood the
 * captures show real accounts occupying, so an id minted here looks like one
 * the client has always dealt with. Accounts an operator imports or names by
 * hand are free to sit anywhere below it.
 */
export const ACCOUNT_ID_FLOOR = 1_000_000_000;

let allocationChain = Promise.resolve();

/**
 * An account nobody asked for by id — which is what registering is.
 *
 * Every other path into this module opens an account whose id the caller
 * already knows, because that is how the client works: `DBFacade` reads an
 * `AccountId` out of its configuration and presents it. A sign-up form has no
 * such number to present, so one has to be chosen, and choosing it is the only
 * thing here that two callers can get wrong at once — read the taken ids
 * together and they pick the same free one. Allocation is therefore taken one
 * at a time, on a chain of its own rather than on an account lock, since the
 * account being locked is the one that does not exist yet.
 */
export const createNewAccount = async ({ name } = {}) => {
  const mine = allocationChain.then(async () => {
    const taken = await listAccountIds();
    const highest = taken.reduce(
      (top, id) => (Number.isSafeInteger(id) && id > top ? id : top),
      ACCOUNT_ID_FLOOR
    );
    const id = highest + 1;
    if (id > 0xffff_ffff) {
      throw new RangeError("account id space exhausted");
    }

    const account = createAccount(id);
    /*
     * Checked and claimed inside the allocation chain, which is what makes it
     * one decision rather than two racing ones: two registrations arriving at
     * the same moment with the same name are serialised here, so the second
     * sees the first's account and is refused.
     *
     * A name that is not given keeps the template's, which carries the id and
     * so cannot collide — that path is the tools and the tests, not a player.
     */
    if (name !== undefined) {
      const wanted = checkName(name);
      if (await nameTaken(wanted, { listAccountIds, loadAccount })) {
        throw new NameRefused("name_taken", `${wanted} is already taken`);
      }
      account.name = wanted;
    }
    /*
     * Whole before it is first written, rather than whole the first time it is
     * read. The template's preference rows carry a name and a value and no id,
     * and this is the same pass that gives them one on load — running it here
     * as well is what stops the first save being a row Postgres will not take.
     * A JSON document accepts it silently, which is why the file backend never
     * showed this and registering against a database answered 500.
     */
    await repairAccountAttributes(account);
    await saveAccount(account);
    info(`accounts: registered new account ${id}`);
    return account;
  });
  // The next allocation waits either way; a failure must not wedge the chain.
  allocationChain = mine.then(
    () => {},
    () => {}
  );
  return mine;
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
   * Serialised here, which is to say when this write's turn has come.
   *
   * The write chain above holds callers back until then, so a queued save
   * takes its snapshot late and carries whatever changed while it waited —
   * which is the point of the chain, and the opposite of taking the snapshot
   * when the save was asked for.
   *
   * All of them together, before the first await, so that the second account
   * is not read after the first has already been written down.
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
