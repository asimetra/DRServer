import { config } from "./config.js";

/**
 * What a player may be called, and the promise that it is theirs.
 *
 * A name is the only thing other players see of somebody. It used to be
 * `Player1000000005` — the account id with a word in front of it — which is
 * both unreadable and a leak: an account id is the number the client
 * authenticates with, and printing it next to everybody's score put it on
 * every page of the site.
 *
 * So a name is chosen, and it is unique. Unique is the part that makes it worth
 * showing: if two people can both be "Sable" then a name identifies nobody and
 * every screen has to fall back to the number again.
 */

export class NameRefused extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "NameRefused";
    this.reason = reason;
  }
}

const refuse = (reason, message) => new NameRefused(reason, message);

export const NAME_MIN = 3;
export const NAME_MAX = 16;

/*
 * Letters and digits in any script, plus a few separators between them.
 *
 * `\p{L}` rather than A–Z because the people playing this server do not all
 * type in ASCII, and a rule that refuses "Şafak" is a rule about the developer's
 * keyboard. The separators may sit between characters but never at either end
 * and never two in a row, which is what stops "a  b" and "a " being different
 * names that look identical.
 */
const SHAPE = /^[\p{L}\p{N}](?:[ _.-]?[\p{L}\p{N}])*$/u;

/**
 * The name as it will be stored: outer whitespace gone, inner runs collapsed.
 *
 * Trimming is not being lenient — it is deciding, once, that a name with a
 * space on the end is the same name. Otherwise the uniqueness check below is
 * trivially beaten by pressing the space bar.
 */
export const tidyName = (value) => String(value ?? "").trim().replace(/\s+/g, " ");

/**
 * The form two names are compared in.
 *
 * Case-folded, so "Sable" and "sable" are one name rather than two people who
 * will be mistaken for each other forever.
 *
 * The four I forms are folded *before* lowercasing, and the order is the whole
 * point. `"İ".toLowerCase()` is not `"i"` — it is `"i"` followed by a combining
 * dot above, so folding afterwards never matches and "İstanbul" and "istanbul"
 * came out as two different names. Measured; the test holds it.
 */
export const nameKey = (value) =>
  tidyName(value).replace(/[İI]/g, "I").replace(/ı/g, "i").toLowerCase();

/** Checks the shape only. Whether anybody already has it is a separate question. */
export const checkName = (value) => {
  const name = tidyName(value);

  if (!name) throw refuse("bad_name", "a name is required");
  /* Counted in code points: an emoji or a combining character is one thing a
     player typed, not two, and `.length` disagrees. */
  const length = [...name].length;
  if (length < NAME_MIN || length > NAME_MAX) {
    throw refuse("bad_name", `a name is ${NAME_MIN} to ${NAME_MAX} characters`);
  }
  if (!SHAPE.test(name)) {
    throw refuse(
      "bad_name",
      "a name is letters and digits, with single spaces, dots, hyphens or underscores between them"
    );
  }
  return name;
};

/**
 * Whether anybody has it already.
 *
 * The file backend reads the population, which is what this server's population
 * makes reasonable — the data directory *is* the population. Postgres answers
 * from an index. Both are called from inside the allocation chain, which is
 * what makes the check and the write that follows it one decision rather than
 * two racing ones.
 */
export const accountIdNamed = async (name, { listAccountIds, loadAccount }) => {
  const wanted = nameKey(name);
  if (!wanted) return null;

  if (config.storage === "postgres") {
    const db = await import("./storage/postgres.js");
    return db.accountIdWithName(wanted);
  }

  for (const id of await listAccountIds()) {
    const account = await loadAccount(id);
    if (nameKey(account?.name) === wanted) return id;
  }
  return null;
};

export const nameTaken = async (name, stores) => (await accountIdNamed(name, stores)) !== null;
