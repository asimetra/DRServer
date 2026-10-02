import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/**
 * The play pass: what lets a browser load the web client's files.
 *
 * Behind ODS_WEB_CLIENT_GATE the client's files are for people signed in on the
 * website, not for whoever knows the address. The website's Play link carries a
 * one-time code; trading it at POST /launch gives the page a session token and
 * the browser this pass, as an HttpOnly cookie scoped to /play.
 *
 * It is signed with the token secret but under its own label, so it is not a
 * token and a token is not one: a stolen pass loads the client's files and
 * opens no account. It lasts long enough for an evening and is renewed while
 * the game keeps asking for files, so a long session does not lose its art
 * halfway; a fresh Play link mints a new one.
 */

export const PLAY_PASS_COOKIE = "dr_play";
export const PLAY_PASS_TTL_SECONDS = 12 * 60 * 60;
/** Renewed on a file asked for in its last few hours. */
const RENEW_WITHIN_SECONDS = 4 * 60 * 60;

const SHAPE = /^([1-9]\d{0,9})\.(\d{1,12})\.([0-9a-f]{64})$/;

const signature = (accountId, expiry, secret) =>
  createHmac("sha256", secret).update(`play-pass:${accountId}:${expiry}`).digest("hex");

export const issuePlayPass = (accountId, now = Date.now(), secret = config.tokenSecret) => {
  if (!secret) throw new Error("cannot issue a play pass without a signing secret");
  const expiry = Math.floor(now / 1000) + PLAY_PASS_TTL_SECONDS;
  return `${Number(accountId)}.${expiry}.${signature(Number(accountId), expiry, secret)}`;
};

/** `{ accountId, expiry }` for a pass that is genuine and current, null otherwise. */
export const checkPlayPass = (pass, now = Date.now(), secret = config.tokenSecret) => {
  const parts = typeof pass === "string" ? SHAPE.exec(pass) : null;
  if (!parts || !secret) return null;
  const accountId = Number(parts[1]);
  const expiry = Number(parts[2]);
  const offered = Buffer.from(parts[3], "hex");
  const expected = Buffer.from(signature(accountId, expiry, secret), "hex");
  if (!timingSafeEqual(offered, expected)) return null;
  if (expiry * 1000 <= now) return null;
  return { accountId, expiry };
};

/** The pass out of a Cookie header, or null. */
export const playPassFrom = (cookieHeader) => {
  for (const part of String(cookieHeader ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === PLAY_PASS_COOKIE) return part.slice(at + 1).trim();
  }
  return null;
};

/** The Set-Cookie value that hands `pass` to the browser, for /play only. */
export const playPassCookie = (pass) =>
  [
    `${PLAY_PASS_COOKIE}=${pass}`,
    "Path=/play",
    `Max-Age=${PLAY_PASS_TTL_SECONDS}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(config.publicScheme === "https" ? ["Secure"] : []),
  ].join("; ");

/** A fresh pass when this one is in its last hours, else null. */
export const renewedPlayPass = (held, now = Date.now()) =>
  held.expiry * 1000 - now < RENEW_WITHIN_SECONDS * 1000 ? issuePlayPass(held.accountId, now) : null;
