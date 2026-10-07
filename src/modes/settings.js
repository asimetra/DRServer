/**
 * A mode's own settings: its section of the config file (`"ranked": {...}`),
 * with ODS_* environment overrides, read by the mode and meaning what the mode
 * says. The core keeps no setting of any mode's — ODS_RANKED, ODS_ONELIFE and
 * ODS_DELVE are each read by their own mode, through this.
 */
import { settingsSection } from "../config.js";

const asInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * `section` of the config file, and its environment: `file` as written (an
 * object, empty when absent), `env(name)` an ODS_<name> (or DR_<name>)
 * override or undefined, `int(name, fallback)` one read as a whole number,
 * and `flag(name, fallback)` one that is on only as "1".
 */
export const modeSettings = (section, environment = process.env) => {
  const { file, env } = settingsSection(section, environment);
  return {
    file,
    env,
    int: (name, fallback) => asInt(env(name), fallback),
    flag: (name, fallback = false) => (env(name) === undefined ? Boolean(fallback) : env(name) === "1"),
  };
};
