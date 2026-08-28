import fs from "node:fs";

/** Reads checked-in configuration synchronously so invalid JSON fails at startup. */
export const readJsonFile = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not load JSON file ${file}: ${error.message}`, {
      cause: error,
    });
  }
};
