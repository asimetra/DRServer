/**
 * The ranked match log: one record per pairing, written once when it is
 * decided, never changed.
 *
 * It is the only thing ranked keeps. Ratings are replayed from it at start
 * (rating.js, `replayRatings`), so there is no second store to drift from it.
 * Records carry account ids and no names; a name is read when a page shows it,
 * so a deleted account leaves its matches — and everybody else's ratings —
 * standing without its name in them.
 *
 * Kept as any mode keeps its records (src/modes/records.js): a match is
 * `{ id, decidedAt, players, ... }`, and is written with `at` and `accounts`
 * beside, which is how the store orders it and finds a player's own. A log
 * written before that, in ranked_matches or ranked-matches.jsonl, is carried
 * over by tools/migrate-ranked-records.js.
 */
import { createModeRecords } from "../records.js";
import { RANKED_MODE } from "./hooks.js";

/**
 * `storage` is "postgres", "file" or "memory", the server's own by default;
 * `db` stands in for the postgres module in a test.
 */
export const createRecords = ({ storage, dataDir, db } = {}) => {
  const records = createModeRecords({
    mode: RANKED_MODE,
    ...(storage ? { storage } : {}),
    ...(dataDir ? { dataDir } : {}),
    ...(db ? { db } : {}),
  });
  return {
    /** True once it is kept. A failure is logged and answered false, never thrown. */
    append: (match) => records.append({ ...match, at: match.decidedAt, accounts: (match.players ?? []).map(Number) }),
    /** Every match, oldest first: what ratings are replayed from. */
    all: () => records.all(),
    /** A token that differs once a match has been added; null when the store cannot say. */
    version: () => records.version(),
    /** One account's matches, newest first. */
    forAccount: (accountId, options) => records.forAccount(accountId, options),
  };
};
