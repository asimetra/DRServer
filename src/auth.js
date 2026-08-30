import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/**
 * Who a caller says they are, proved.
 *
 * The client has no login screen: `DBFacade` reads `AccountId` and
 * `API_ValidationToken` out of its own configuration file and presents them
 * from then on — as `X-Account-Id` and `X-Validation-Token` headers on every
 * JSON-RPC call, and as the first two fields of the socket login. So the
 * credential is a bearer token in a file, and the only question this module
 * answers is whether a given token was issued by whoever holds the secret.
 *
 * The shape follows the captured one: a number, a colon, and a SHA-256-sized
 * hex string. The account id is deliberately absent from the text and present
 * in the signature — the client sends it separately, and signing it is what
 * stops a token issued for one account from opening another.
 */

/**
 * Two terms, because there are two kinds of token and only one is kept.
 *
 * `DBFacade` reads `API_ValidationToken` out of the configuration once at
 * startup and never writes the refreshed one back, so the token an operator
 * hands over is presented again at every launch, for as long as that player
 * keeps playing. Expiring it in days would lock out anyone who took a week off
 * and turn reissuing into a chore, so it lasts most of a year.
 *
 * The one the client asks for every hour never leaves memory and dies with the
 * session, so it is short — long enough to survive a few failed refreshes and
 * no longer.
 */
export const TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;
export const SESSION_TTL_SECONDS = 6 * 60 * 60;

const SHAPE = /^(\d+):([0-9a-f]{64})$/;

const sign = (secret, accountId, expiry) =>
  createHmac("sha256", secret).update(`${accountId}:${expiry}`).digest("hex");

/** A secret to sign with, for an operator who has not chosen one. */
export const generateSecret = () => randomBytes(32).toString("hex");

export const issueToken = (
  accountId,
  { secret = config.tokenSecret, expiry, term = "kept" } = {}
) => {
  if (!secret) throw new Error("cannot issue a token without a signing secret");
  const ttl = term === "session" ? SESSION_TTL_SECONDS : TOKEN_TTL_SECONDS;
  const at = expiry ?? Math.floor(Date.now() / 1000) + ttl;
  return `${at}:${sign(secret, Number(accountId), at)}`;
};

/**
 * Why a token was refused, or null when it was not.
 *
 * Three quite different failures used to answer `false` alike — a token from
 * an older secret, one that ran out last week, and a client sending something
 * that was never a token — so a player reporting "it does not work" and an
 * operator reading the log both learned nothing. Naming them costs a string.
 */
export const tokenProblem = (accountId, token, { secret = config.tokenSecret } = {}) => {
  if (!secret) return "this server has no signing secret";
  if (typeof token !== "string" || !token) return "no token";

  const shape = SHAPE.exec(token);
  if (!shape) return "malformed: not an expiry and a signature";

  const [, expiry, signature] = shape;
  if (Number(expiry) <= Math.floor(Date.now() / 1000)) {
    return `expired ${new Date(Number(expiry) * 1000).toISOString()}`;
  }

  /**
   * Compared in constant time. Both sides are 64 hex characters by the time
   * they reach here — the pattern above guarantees the length, which
   * timingSafeEqual requires and throws over.
   */
  const matches = timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(sign(secret, Number(accountId), Number(expiry)), "hex")
  );
  // Signed for another account, or under a secret this server does not hold;
  // the two are the same arithmetic and cannot be told apart from here.
  return matches ? null : "signature does not match this account or this secret";
};

export const verifyToken = (accountId, token, options) =>
  tokenProblem(accountId, token, options) === null;

/**
 * Whether this server is checking at all.
 *
 * Off is a real choice for a machine nobody else can reach, and it is the
 * behaviour every existing configuration already has, so it stays reachable —
 * but it is not the default, and a server running without it says so.
 */
export const authEnabled = () => config.authEnabled !== false && Boolean(config.tokenSecret);
