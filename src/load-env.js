/**
 * Reads `.env` for a process that was not started with `--env-file`.
 *
 * `npm start` passes `--env-file-if-exists=.env`; a tool run as plain
 * `node tools/grant.js` does not, and nothing said so. The tool therefore fell
 * back to `config/server.defaults.json`, whose storage is `file`, while the
 * server it was meant to be feeding was reading PostgreSQL — so a grant
 * reported `+5 LEGENDARY CHEST` and exited zero having written a JSON file
 * nothing reads. Sixty-one chests accumulated in one before anybody noticed
 * that none of them had ever reached the game.
 *
 * Silence is the failure mode worth naming here. A tool that cannot reach the
 * database fails loudly and gets fixed; a tool that quietly reaches a different
 * one succeeds forever and is believed.
 *
 * Imported for its side effect and listed first, because ES modules evaluate
 * their dependencies in declaration order: `config.js` reads the environment
 * while it is being evaluated, so anything that wants to add to that
 * environment has to have finished before it starts.
 *
 * Deliberately *not* imported by `src/config.js`, which would be the tidier
 * place for it. The test suite imports config transitively and sets only
 * `ODS_DATA_DIR`; a `.env` that names PostgreSQL would then point the whole
 * suite at the live database, which is a worse fault than the one being fixed.
 * Entry points opt in — the server through its flag, tools through this.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");

// Values already in the environment win: `process.loadEnvFile` leaves them
// alone, so `ODS_DATA_DIR=/tmp/x node tools/grant.js` still means /tmp/x.
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
