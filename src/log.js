import { config } from "./config.js";

const stamp = () => new Date().toISOString().slice(11, 23);

const write = (level, message) => {
  process.stdout.write(`${stamp()} ${level} ${message}\n`);
};

export const info = (message) => write("INFO ", message);
export const warn = (message) => write("WARN ", message);
export const error = (message) => write("ERROR", message);

/**
 * Loud marker for a request the client made that we do not implement yet.
 * Enumerating these while playing is how the remaining surface gets mapped.
 */
export const unimplemented = (what, detail = "") => {
  write("TODO ", `UNIMPLEMENTED ${what}${detail ? ` ${detail}` : ""}`);
};

/** Control characters that mean a body is not text and should not be printed. */
const BINARY = /[\u0000-\u0008\u000e-\u001f]/;

/**
 * Bounds anything that goes in a log line, whatever type it is.
 *
 * Non-strings used to be handed straight to `String()`, unbounded — and that is
 * exactly where a bound is needed. `/content/*` answers with a Buffer, the
 * game-master table is four megabytes of it, and every client asks for that
 * file when it logs in. So each login printed four megabytes of JSON to the
 * terminal: the server appeared to lose its mind and then recover, once per
 * player.
 *
 * A Buffer is sliced before it is decoded rather than after, so a large body is
 * never materialised as a string just to throw it away. Compressed content
 * would be control characters in somebody's terminal, so its size is reported
 * instead of its bytes.
 */
/**
 * A validation token, wherever it turns up in something about to be written
 * down. Recognised by its shape rather than by where it sits, because that
 * varies per method: `params` carries it first, second, third or sixth.
 */
/** Longest a token can be: ten digits, a colon and sixty-four hex characters. */
const MAX_TOKEN_LENGTH = 80;

/**
 * Bounded by what is *not* there rather than by a word boundary: a token
 * sitting straight after a letter has no boundary before it, and a rule that
 * only works while the surrounding text is JSON is a rule waiting to be
 * surprised. The lookarounds stop a longer number or a longer run of hex from
 * having its middle mistaken for one.
 */
const TOKEN = /(?<!\d)(\d{9,}):([0-9a-f]{64})(?![0-9a-f])/g;

/**
 * The half of a token that is not a secret.
 *
 * A log is read by whoever is chasing a bug, and gets tailed, copied and
 * pasted into reports — the socket capture already refuses to carry a
 * credential for exactly this reason. Dropping the whole thing would take away
 * the only answer to "why was I refused", so the expiry stays, which is both
 * public and the likeliest answer, and eight characters of signature stay so
 * two lines can be recognised as the same token. Fifty-six are gone, which is
 * what makes the rest useless to whoever finds it.
 */
const fingerprint = (text) =>
  text.replace(TOKEN, (_, expiry, signature) => `${expiry}:${signature.slice(0, 8)}…`);

export const truncate = (value) => {
  const limit = config.logBodyLimit;

  /**
   * Cut after the token is dealt with, never before. The pattern wants all
   * sixty-four characters of a signature and a cut can land in the middle of
   * one, which left twenty-nine of them written out as themselves — a shorter
   * credential rather than none.
   *
   * A Buffer is still sliced first, because the game-master table is four
   * megabytes and decoding it whole is what the slicing is for; taking a
   * token's length of slack is enough for any token that starts before the
   * limit to arrive complete.
   */
  if (Buffer.isBuffer(value)) {
    const head = value.subarray(0, limit + MAX_TOKEN_LENGTH).toString("utf8");
    if (BINARY.test(head)) return `<${value.length} bytes>`;
    const safe = fingerprint(head);
    if (value.length <= limit) return safe;
    return `${safe.slice(0, limit)}… (${value.length} bytes)`;
  }

  const text = fingerprint(typeof value === "string" ? value : String(value));
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length} bytes)` : text;
};
