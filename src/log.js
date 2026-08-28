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

export const truncate = (text) => {
  if (typeof text !== "string") return String(text);
  return text.length > config.logBodyLimit
    ? `${text.slice(0, config.logBodyLimit)}… (${text.length} bytes)`
    : text;
};
