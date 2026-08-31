import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { BOARDS, boardFor, runsSince, standingsFor, titleFor } from "./leaderboard.js";
import { levelForExperience } from "./chests.js";
import { loadGameMaster } from "./gamemaster.js";
import { presenceSummary } from "./socket/presence.js";
import { listen } from "./http.js";
import { createNewAccount, listAccountIds, loadAccount } from "./accounts.js";
import { issueToken, revokeAccountTokens } from "./auth.js";
import { TradeRefused, settleTrade } from "./trade.js";
import { info, warn } from "./log.js";

/**
 * What a web front end is allowed to ask this server to do.
 *
 * The web side owns its own tables — who signed up, with which email, holding
 * which session — and none of the account tables here. That division is not
 * tidiness: `account-registry.js` hands every holder of an account the one
 * object in play and `withAccountLock` serialises the writers, and both are
 * process-local. A second process writing these rows directly is outside both,
 * so a trade settled on the website while its owner is in a dungeon would be
 * undone by the save at the end of the run. Keeping this server the only
 * writer is what makes the pair safe, and this module is the door.
 *
 * The credential is a shared secret rather than a player token. A player's
 * token proves which account is calling; this proves the caller is the front
 * end, which is a different claim and answers for every account at once.
 */

const json = (body, status = 200) => ({
  status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Compared in constant time, over digests rather than the secrets themselves.
 *
 * `timingSafeEqual` throws on a length mismatch, and refusing early because the
 * lengths differ leaks the length. Hashing both sides first makes them the same
 * size whatever was sent.
 */
const digest = (value) => createHash("sha256").update(String(value)).digest();

const authorise = (req) => {
  const offered = req.headers?.["x-internal-token"];
  if (typeof offered !== "string" || !offered) {
    return json({ error: "missing X-Internal-Token" }, 401);
  }
  if (!timingSafeEqual(digest(offered), digest(config.internalToken))) {
    warn("internal: refused a call presenting the wrong token");
    return json({ error: "invalid internal token" }, 401);
  }
  return null;
};

/** The account id in a path segment, or null when it is not one. */
const accountIdIn = (capture) => {
  if (!/^[1-9]\d*$/.test(capture ?? "")) return null;
  const id = Number(capture);
  return Number.isSafeInteger(id) && id <= 0xffff_ffff ? id : null;
};

/**
 * Existence is asked rather than assumed, because `loadAccount` creates an
 * account it has never seen. That is right for a client presenting an id an
 * operator gave it, and wrong here: a typo in a front-end call would otherwise
 * conjure an account and hand back a working token for it.
 */
const accountExists = async (id) => (await listAccountIds()).includes(id);

/**
 * POST /internal/v1/accounts — registration, from this server's side.
 *
 * The website has taken an email and a password and written down a user of its
 * own. What it cannot do is invent the game account: the id has to be free,
 * the starting inventory comes from this server's template, and the token has
 * to be signed with a secret the web process does not hold. So it asks.
 */
const registerAccount = async (req) => {
  const refusal = authorise(req);
  if (refusal) return refusal;

  const name = req.json?.name;
  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    return json({ error: "name must be a non-empty string when given" }, 400);
  }

  const account = await createNewAccount({ name: name?.trim() });
  const token = issueToken(account.id);
  info(`internal: registered account ${account.id}`);
  return json(
    {
      accountId: account.id,
      name: account.name,
      token,
      expires: new Date(Number(token.split(":")[0]) * 1000).toISOString(),
    },
    201
  );
};

/**
 * POST /internal/v1/accounts/:id/token — a replacement token.
 *
 * For "I lost my client configuration" and for handing a fresh one to somebody
 * who has just proved themselves on the website. It does not invalidate the
 * old one; that is what the DELETE is for.
 */
const reissueToken = async (req, [capture]) => {
  const refusal = authorise(req);
  if (refusal) return refusal;

  const id = accountIdIn(capture);
  if (id === null) return json({ error: "account id must be an unsigned 32-bit integer" }, 400);
  if (!(await accountExists(id))) return json({ error: "no such account" }, 404);

  const token = issueToken(id);
  info(`internal: reissued a token for account ${id}`);
  return json({
    accountId: id,
    token,
    expires: new Date(Number(token.split(":")[0]) * 1000).toISOString(),
  });
};

/**
 * DELETE /internal/v1/accounts/:id/token — every token for this account, at once.
 *
 * This is the website's "sign out everywhere". Tokens are signed rather than
 * stored, so there is no list to delete from: the generation the signature
 * covers is bumped instead and every token issued under the old one stops
 * verifying. See `revokeAccountTokens`.
 */
const revokeTokens = async (req, [capture]) => {
  const refusal = authorise(req);
  if (refusal) return refusal;

  const id = accountIdIn(capture);
  if (id === null) return json({ error: "account id must be an unsigned 32-bit integer" }, 400);
  if (!(await accountExists(id))) return json({ error: "no such account" }, 404);

  const generation = revokeAccountTokens(id);
  info(`internal: revoked every token for account ${id}`);
  return json({ accountId: id, generation });
};

/**
 * GET /internal/v1/accounts/:id — the account as the client would receive it.
 *
 * The website could read the tables itself, and for a profile page it may well
 * be right to. This is here for the pages that want what the game considers an
 * account rather than what the schema stores — the assembled payload, with the
 * repairs `loadAccount` applies already applied.
 */
const readAccount = async (req, [capture]) => {
  const refusal = authorise(req);
  if (refusal) return refusal;

  const id = accountIdIn(capture);
  if (id === null) return json({ error: "account id must be an unsigned 32-bit integer" }, 400);
  if (!(await accountExists(id))) return json({ error: "no such account" }, 404);

  return json(await loadAccount(id));
};

/**
 * GET /internal/v1/accounts/:id/summary — the player, as a page would draw them.
 *
 * The whole account payload is available next door and is the wrong thing for a
 * character panel: it is long, most of it is inventory, and it says nothing
 * about the two facts a player actually looks for — what they are called and
 * how far along they are.
 *
 * Assembled here rather than in the front end because every part of it is a
 * rule this server owns. The title ladder is the trophy count's, the level is
 * the Leveling table's and differs per hero, and the standings are the boards'.
 * Working any of that out a second time on the website would be a second
 * opinion to keep in step.
 */
const readSummary = async (req, [capture]) => {
  const refusal = authorise(req);
  if (refusal) return refusal;

  const id = accountIdIn(capture);
  if (id === null) return json({ error: "account id must be an unsigned 32-bit integer" }, 400);
  if (!(await accountExists(id))) return json({ error: "no such account" }, 404);

  const account = await loadAccount(id);
  const gm = await loadGameMaster();
  const avatar = (account.account_avatars ?? []).find((row) => row.id === account.active_avatar)
    ?? (account.account_avatars ?? [])[0]
    ?? null;
  const hero = avatar ? gm.heroById.get(avatar.avatar_id) : null;
  const standings = await standingsFor(id);

  return json({
    account_id: account.id,
    name: account.name ?? null,
    trophies: account.trophies ?? 0,
    /* Twelve, because a trophy is the first clear of a boss node and there are
       twelve of those — so the panel can draw a bar without inventing a max. */
    trophies_of: 12,
    title: titleFor(account.trophies),
    heroes: (account.account_avatars ?? []).length,
    hero: hero
      ? {
          id: hero.Id,
          name: hero.Name ?? hero.Constant,
          /* The icon the client names for this skin, so a page can find the
             picture without a mapping table of its own. */
          icon: gm.raw.Skins?.find((skin) => skin.Id === avatar.skin_type)?.IconName ?? null,
          level: levelForExperience(gm, hero.Constant, avatar.experience ?? 0),
          experience: avatar.experience ?? 0,
        }
      : null,
    clears: standings.clears ?? 0,
    experience_total: standings.experience ?? 0,
  });
};

/**
 * POST /internal/v1/trades — both sides have agreed; move the goods.
 *
 * The front end runs the negotiation and owns every part of it that is a
 * conversation: who offered what, who has clicked accept, whether either
 * walked away. None of that is game state. This is the single moment that is,
 * and it is one call so that it is one transaction.
 *
 * A refusal carries `reason` as well as a sentence, because the trade screen
 * has to do different things with "they are in a dungeon" (wait, and say so)
 * and "that weapon is equipped" (tell them which, and let them fix it).
 */
const settleTradeRoute = async (req) => {
  const refusal = authorise(req);
  if (refusal) return refusal;

  try {
    const result = await settleTrade(req.json ?? {});
    return json(result);
  } catch (problem) {
    if (problem instanceof TradeRefused) {
      warn(`internal: refused a trade — ${problem.reason}: ${problem.message}`);
      return json({ error: problem.message, reason: problem.reason }, 409);
    }
    throw problem;
  }
};

/**
 * GET /internal/v1/leaderboards/:metric — a board, ordered and cut.
 *
 * Read-only and derived: nothing here touches an account, so it is outside the
 * registry and the write chains entirely. The front end draws boards from this
 * rather than from the tables, which keeps the schema free to change.
 *
 * `speedrun` is scoped to a dungeon and needs node, hero and party size —
 * ranking heroes against each other, or a solo clear against a four-player one,
 * would be a board about the roster rather than the players. The other two are
 * whole-account and take no scope.
 */
const readBoard = async (req, [metric]) => {
  const refusal = authorise(req);
  if (refusal) return refusal;

  const board = BOARDS[metric];
  if (!board) {
    return json({ error: `no such board`, boards: Object.keys(BOARDS) }, 404);
  }

  const query = req.query;
  const scope = {
    node: Number(query?.get("node")),
    hero: Number(query?.get("hero")),
    party: Number(query?.get("party") ?? 1),
    limit: query?.get("limit") ?? 20,
  };

  if (board.scope === "node" && !(scope.node > 0 && scope.hero > 0)) {
    return json({ error: "this board needs node and hero" }, 400);
  }

  return json({
    metric,
    better: board.better,
    scope: board.scope === "node" ? scope : null,
    entries: await boardFor(metric, scope),
  });
};

/**
 * GET /internal/v1/status — what the front page puts in its margins.
 *
 * The numbers a server portal has always carried: who is on, how many are down
 * a dungeon rather than standing in town, how much has happened today, and how
 * long this has been up. Cheap enough to answer on every page load — the
 * presence figures are a map already in memory and the run count is one indexed
 * query over a day.
 *
 * A count rather than a roster. Who exactly is online is a different question
 * with a different answer about privacy, and the front page does not need it.
 */
const readStatus = async (req) => {
  const refusal = authorise(req);
  if (refusal) return refusal;

  const presence = presenceSummary();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  return json({
    online: presence.online,
    in_dungeon: presence.inDungeon,
    runs_today: await runsSince(dayAgo),
    uptime_seconds: Math.floor(process.uptime()),
  });
};

export const internalRoutes = [
  { method: "GET", pattern: "/internal/v1/status", handler: readStatus },
  { method: "GET", pattern: "/internal/v1/leaderboards/:metric", handler: readBoard },
  { method: "POST", pattern: "/internal/v1/accounts", handler: registerAccount },
  { method: "GET", pattern: "/internal/v1/accounts/:id", handler: readAccount },
  { method: "GET", pattern: "/internal/v1/accounts/:id/summary", handler: readSummary },
  { method: "POST", pattern: "/internal/v1/accounts/:id/token", handler: reissueToken },
  { method: "DELETE", pattern: "/internal/v1/accounts/:id/token", handler: revokeTokens },
  { method: "POST", pattern: "/internal/v1/trades", handler: settleTradeRoute },
];

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Off unless a token is configured.
 *
 * An internal API that is open until somebody remembers to close it is the
 * wrong way round, and there is no default secret worth having: one shipped in
 * a defaults file is not a secret. So the absence of a token is a decision not
 * to run this, not a decision to run it unprotected.
 */
export const start = () => {
  if (!config.internalToken) {
    info("internal API: off — set ODS_INTERNAL_TOKEN to enable it");
    return null;
  }

  if (!LOOPBACK.has(config.internalHost)) {
    warn(
      `internal API bound to ${config.internalHost}, which is not loopback — ` +
        "anything that can reach it and holds the token can act for every account"
    );
  }

  return listen({
    routeTable: internalRoutes,
    host: config.internalHost,
    port: config.internalPort,
    // Its caller is one address making every call there is; the player-facing
    // budget is measured per address against what one game client does.
    rateLimited: false,
    onReady: () =>
      info(`internal API listening on http://${config.internalHost}:${config.internalPort}`),
  });
};
