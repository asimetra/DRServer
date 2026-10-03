/**
 * When each account last signed out of the website, which ends its browser game.
 *
 * The browser client is opened with a short session token and loads its files
 * on a play pass; both used to outlive signing out — six and twelve hours, and
 * both renewed while the game ran. What either was issued before the moment
 * recorded here is refused. The desktop client's kept token is not touched:
 * the website did not hand it out and does not get to end it.
 *
 * Held in this process. A restart already ends every connection; what it
 * forgets is a token or a pass from before the sign-out, which the browser
 * keeps for at most a session's six hours or a pass's twelve.
 */
const endedAt = new Map();

/** Ends every browser session of `accountId` issued up to `now`. */
export const endBrowserSessions = (accountId, now = Date.now()) => {
  const id = Number(accountId);
  endedAt.set(id, Math.max(endedAt.get(id) ?? 0, Number(now)));
};

/** Whether something of `accountId` issued at `issuedAtMs` came before its last sign-out. */
export const issuedBeforeSignOut = (accountId, issuedAtMs) => {
  const at = endedAt.get(Number(accountId));
  return at !== undefined && Number(issuedAtMs) <= at;
};
