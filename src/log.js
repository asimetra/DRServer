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
export const truncate = (value) => {
  const limit = config.logBodyLimit;

  if (Buffer.isBuffer(value)) {
    const head = value.subarray(0, limit).toString("utf8");
    if (BINARY.test(head)) return `<${value.length} bytes>`;
    return value.length > limit ? `${head}… (${value.length} bytes)` : head;
  }

  const text = typeof value === "string" ? value : String(value);
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length} bytes)` : text;
};
