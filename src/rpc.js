import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { unimplemented } from "./log.js";

/**
 * JSON-RPC 2.0 over POST <rpcRoot><service>/<method>.
 * See brain/jsonRPC/JSONRPCService.hx: the client sends
 * {jsonrpc, method, params, id} and reads `result`, treating a non-null
 * `error` as a failure. A null `result` is accepted.
 */

/** Tokens we have handed out, so the socket layer can validate them later. */
const issuedTokens = new Map();

export const mintToken = (accountId) => {
  const token = `${accountId}:${randomBytes(16).toString("hex")}`;
  issuedTokens.set(String(accountId), token);
  return token;
};

export const isValidToken = (accountId, token) =>
  issuedTokens.get(String(accountId)) === token;

/** handlers are keyed "service/method" and receive the params array. */
const handlers = new Map();

export const register = (key, handler) => handlers.set(key, handler);

/**
 * Dispatches a decoded JSON-RPC request. Returns the value for `result`.
 * Throws to produce a JSON-RPC error response.
 */
export const dispatch = async (service, method, params) => {
  const key = `${service}/${method}`;
  const handler = handlers.get(key);

  if (handler) return handler(params ?? []);

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
