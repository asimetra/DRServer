import { AccountLeasedError } from "../accounts.js";

/**
 * Request and answer over one worker message port, in both directions.
 *
 * The main thread and a match worker each ask the other for things — an
 * account lease, a lock, a forwarded RPC — and need the answer back. This is
 * the whole of that: a numbered `call`, a `result` carrying the same number,
 * and errors rebuilt on the far side as errors. Everything that is not a call
 * or a result goes to `onMessage` untouched, in the order it arrived.
 *
 * `beforePost` runs ahead of every message this side sends. The worker uses it
 * to flush the frames it is holding, so nothing it sends can overtake frames it
 * produced earlier.
 */
export const createWorkerChannel = ({ port, handle, onMessage = () => {}, beforePost = () => {} }) => {
  let nextCallId = 1;
  const waiting = new Map();

  const post = (message, transfer) => {
    beforePost();
    port.postMessage(message, transfer);
  };

  const call = (op, args) =>
    new Promise((resolve, reject) => {
      const cid = nextCallId++;
      waiting.set(cid, { resolve, reject });
      try {
        post({ t: "call", cid, op, args });
      } catch (problem) {
        waiting.delete(cid);
        reject(problem);
      }
    });

  const answer = async ({ cid, op, args }) => {
    try {
      const value = await handle(op, args);
      post({ t: "result", cid, ok: true, value });
    } catch (problem) {
      post({ t: "result", cid, ok: false, error: serialiseError(problem) });
    }
  };

  const receive = (message) => {
    if (message?.t === "call") return void answer(message);
    if (message?.t === "result") {
      const pending = waiting.get(message.cid);
      if (!pending) return undefined;
      waiting.delete(message.cid);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(rebuildError(message.error));
      return undefined;
    }
    return onMessage(message);
  };

  /** Every call still unanswered fails, because nobody is left to answer it. */
  const failAll = (problem) => {
    for (const { reject } of waiting.values()) reject(problem);
    waiting.clear();
  };

  return { call, post, receive, failAll };
};

const serialiseError = (problem) => ({
  name: problem?.name ?? "Error",
  message: problem?.message ?? String(problem),
  stack: problem?.stack ?? null,
  accountId: problem?.accountId ?? null,
  owner: problem?.owner ?? null,
  reason: problem?.reason ?? null,
});

const rebuildError = (details = {}) => {
  const problem = details.name === "AccountLeasedError"
    ? new AccountLeasedError(details.accountId, details.owner)
    : new Error(details.message ?? "worker call failed");
  if (details.name && details.name !== problem.name) problem.name = details.name;
  // A refusal's reason is part of the answer; the caller rebuilds its class.
  if (details.reason !== null && details.reason !== undefined) problem.reason = details.reason;
  if (details.stack) problem.remoteStack = details.stack;
  return problem;
};

/** A promise and the two ways to settle it, for answers that arrive later. */
export const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
};
