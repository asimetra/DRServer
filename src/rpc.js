import { config } from "./config.js";
import { AccountLeasedError, withAccountLock } from "./accounts.js";
import { unimplemented, warn } from "./log.js";

/**
 * JSON-RPC 2.0 over POST <rpcRoot><service>/<method>.
 * See brain/jsonRPC/JSONRPCService.hx: the client sends
 * {jsonrpc, method, params, id} and reads `result`, treating a non-null
 * `error` as a failure. A null `result` is accepted.
 *
 * Tokens are not this module's business: they are signed rather than
 * remembered, so there is nothing to keep. See auth.js.
 */

/** handlers are keyed "service/method" and receive the params array. */
const handlers = new Map();

/**
 * `account` is which parameter names the account being acted on, so dispatch
 * can insist it is the one that proved itself. First is the common case and
 * therefore the default: getting it wrong on a method that has one refuses
 * legitimate calls, which is noisy, while forgetting to declare one is the
 * failure that matters and this way it cannot happen silently.
 *
 * Pass `null` for a method that acts on no account at all.
 *
 * `locks` is whether dispatch holds that account for the length of the call.
 * On by default, and off only for a handler that takes its own — `GiftOffer`
 * holds two, and taking one here as well would have it wait for itself.
 */
export const register = (key, handler, { account = 0, locks = true } = {}) =>
  handlers.set(key, { handler, account, locks });

/**
 * Where a call goes when its account is in a dungeon on a match worker.
 *
 * Unset in the ordinary server. With workers, the live object of an account in
 * a dungeon exists only on that worker, so the call is run there — against the
 * same object the run is changing, exactly as it would be here. `ownerOf`
 * names the worker holding an account, or null; `forward` runs the dispatch on
 * it and answers what it answered.
 */
let forwarder = null;

export const installRpcForwarder = (next) => {
  const previous = forwarder;
  forwarder = next ?? null;
  return previous;
};

/**
 * Runs the call where its accounts live.
 *
 * Its own account decides first. Another account it touches is only found out
 * when the handler reaches for its lock, and that is early enough: nothing is
 * written before a lock is held, so the call is sent whole to that account's
 * owner and starts again there. Once only — a call whose two accounts are in
 * dungeons on two different workers has nowhere it can run whole, and is
 * refused with the error that says so.
 */
const dispatchWhereOwned = async ({ service, method, run, params, account, forwarded }) => {
  if (!forwarder || forwarded) return run();
  const owner = account === null ? null : forwarder.ownerOf(Number(params?.[account]));
  if (owner !== null && owner !== undefined) {
    return forwarder.forward(owner, service, method, params, {
      accountId: Number(params?.[account]),
      own: true,
    });
  }
  try {
    return await run();
  } catch (problem) {
    if (!(problem instanceof AccountLeasedError)) throw problem;
    return forwarder.forward(problem.owner, service, method, params, {
      accountId: problem.accountId,
      own: false,
    });
  }
};

/**
 * Dispatches a decoded JSON-RPC request. Returns the value for `result`.
 * Throws to produce a JSON-RPC error response.
 *
 * `caller` is the account the request proved it holds a token for, or null
 * where this server is not checking. Proving who you are settles nothing on
 * its own: the handlers read the account out of `params`, and a caller free to
 * write another number there could spend somebody else's gold with a token of
 * their own. So the two have to be the same number.
 */
export const dispatch = async (service, method, params, caller = null, { forwarded = false } = {}) => {
  const key = `${service}/${method}`;
  const entry = handlers.get(key);

  if (entry) {
    const { handler, account, locks } = entry;
    if (caller !== null && account !== null && Number(params?.[account]) !== Number(caller)) {
      warn(`rpc ${key}: account ${caller} tried to act for ${params?.[account]}`);
      throw new Error("this account may not act for another");
    }

    /**
     * And one at a time per account, held here rather than in each handler.
     *
     * Every mutating method is the same four steps — load, await, change, save
     * the whole account back — so two that overlap read the same state and the
     * second write drops the first. Measured on a pair of purchases fired
     * together: 1000 coins spent and one key delivered where the client had
     * been told both had gone through. Not a way to get anything for free, the
     * arithmetic stays consistent, but a transaction the player was promised
     * quietly disappears.
     *
     * `GiftOffer` already carried the only fix of this kind, and its comment
     * describes exactly this failure. Twenty other handlers have the same
     * shape, which is why the lock belongs at the one place they all pass
     * through instead of at each of them.
     *
     * Reads are held too. A read that lands mid-write sees a half-changed
     * account, and nothing here is hot enough for the serialisation to matter.
     */
    const held = Number(params?.[account]);
    const run = account !== null && locks && Number.isFinite(held)
      ? () => withAccountLock(held, () => handler(params ?? []))
      : () => handler(params ?? []);
    return dispatchWhereOwned({ service, method, run, params, account, forwarded });
  }

  if (config.permissive) {
    unimplemented(`rpc ${key}`, `params=${JSON.stringify(params ?? [])}`);
    // An empty array, not null: several client callbacks index the result
    // straight away (result[0]) and a null there is a hard crash in the C++
    // build, which would end the run before it can log the next gap.
    return [];
  }
  throw new Error(`No handler for RPC method ${key}`);
};

export const hasHandler = (service, method) =>
  handlers.has(`${service}/${method}`);
