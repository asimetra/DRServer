import { config } from "./config.js";
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
 */
export const register = (key, handler, { account = 0 } = {}) =>
  handlers.set(key, { handler, account });

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
export const dispatch = async (service, method, params, caller = null) => {
  const key = `${service}/${method}`;
  const entry = handlers.get(key);

  if (entry) {
    const { handler, account } = entry;
    if (caller !== null && account !== null && Number(params?.[account]) !== Number(caller)) {
      warn(`rpc ${key}: account ${caller} tried to act for ${params?.[account]}`);
      throw new Error("this account may not act for another");
    }
    return handler(params ?? []);
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
