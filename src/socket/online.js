/**
 * Who is connected, for whoever runs the server: account, name, where, how
 * long, from where, and when their token runs out.
 *
 * Asked by the status listener (`/players`) and by the internal API for the
 * website's admin pages; both read the same roll presence keeps, so they agree.
 */
import { loadExistingAccount } from "../accounts.js";
import { activeSessions, presenceEntries } from "./presence.js";

export const onlinePlayers = async () => {
  const where = new Map(presenceEntries());
  const now = Date.now();
  return Promise.all(
    activeSessions()
      .filter((session) => session.authenticated !== false && session.accountId)
      .map(async (session) => {
        const mapNode = Number(where.get(session.accountId) ?? 0);
        return {
          account_id: session.accountId,
          // The stored name; a failure to read it is not a reason to hide the player.
          name: await loadExistingAccount(session.accountId).then((account) => account?.name ?? null, () => null),
          map_node: mapNode,
          in_dungeon: mapNode !== 0,
          connected_seconds: Math.floor((now - (session.connectedAt ?? now)) / 1000),
          address: session.remoteAddress ?? null,
          token_expires_at: session.tokenExpiry ? new Date(session.tokenExpiry * 1000).toISOString() : null,
        };
      })
  );
};
