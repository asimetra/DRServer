/**
 * What the server keeps for itself, kept in the database on PostgreSQL.
 *
 * On file storage the server's own small records sit beside the accounts in
 * the data directory, and are backed up with them. On PostgreSQL the accounts
 * are in the database and those records were still files — so a server whose
 * disk is replaced with every deploy, as a container's is, came back having
 * forgotten every token it had revoked. Both records now live in the database
 * there:
 *
 *   token_generations   which tokens are revoked (src/auth.js)
 *   server_state        what each account's client last said it has
 *                       (src/content-packs.js)
 *
 * A server that kept them as files before is carried over on its first start:
 * what the files hold is copied in, and the files are not read again.
 *
 * What stays on disk is the token signing secret, if it was not given as
 * ODS_TOKEN_SECRET. It is left there on purpose: in the database it would be in
 * every dump of it, and a dump would then be enough to sign in as anybody.
 */
import fs from "node:fs";
import path from "node:path";

import { generationsInFile, keepGenerationsIn } from "../auth.js";
import { config } from "../config.js";
import { keepDeclarationsIn } from "../content-packs.js";
import { envSetting } from "../env.js";
import { info } from "../log.js";

const DECLARATIONS = "content-declarations";

export const keepServerStateInDatabase = async () => {
  const storage = await import("./postgres.js");

  const revoked = generationsInFile(path.join(config.dataDir, "token-generations.json"));
  if (revoked) {
    const raised = await storage.importTokenGenerations(revoked);
    if (raised) info(`auth: copied ${raised} token revocation(s) from token-generations.json into the database`);
  }
  await keepGenerationsIn(storage.tokenGenerationStore);

  if ((await storage.readServerState(DECLARATIONS)) === null) {
    const file = path.join(config.dataDir, "content-declarations.json");
    if (fs.existsSync(file)) {
      await storage.writeServerState(DECLARATIONS, JSON.parse(fs.readFileSync(file, "utf8")));
      info("content packs: copied content-declarations.json into the database");
    }
  }
  await keepDeclarationsIn({
    name: "the database",
    read: () => storage.readServerState(DECLARATIONS),
    write: (snapshot) => storage.writeServerState(DECLARATIONS, snapshot),
  });

  if (!envSetting("TOKEN_SECRET")) {
    info(
      `auth: the token signing secret is ${path.join(config.dataDir, "token-secret")}, the one thing this ` +
        "server keeps on disk — back it up, or give it as ODS_TOKEN_SECRET, or a new disk signs everybody out"
    );
  }
};
