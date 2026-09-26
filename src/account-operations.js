import { AccountLeasedError } from "./accounts.js";

/**
 * Writes that are not RPCs, run where their accounts live.
 *
 * The internal API settles trades and market sales for the web front end. In
 * one thread that is a transaction on the same objects a dungeon is changing.
 * With match workers, an account in a dungeon lives in its worker, so the
 * transaction is sent there whole — the same arrangement rpc.js makes for the
 * game's own calls. An operation is named, so the far side can find it, and
 * takes and returns plain data, so it can cross.
 *
 * The refusals an operation throws are part of its answer (the web screen reads
 * `reason`), so they are rebuilt as their own classes when they come back.
 */
const operations = new Map();
let forwarder = null;

/** Where an operation goes when an account it needs is leased; unset in one thread. */
export const installAccountOperationForwarder = (next) => {
  const previous = forwarder;
  forwarder = next ?? null;
  return previous;
};

/**
 * Registers `run` under `name` and returns the function callers use instead.
 * `errors` lists the refusal classes `run` throws, each taking (reason, message).
 */
export const defineAccountOperation = (name, run, { errors = [] } = {}) => {
  if (operations.has(name)) throw new Error(`account operation ${name} defined twice`);
  operations.set(name, { run, errors });
  return (...args) => runAccountOperation(name, args);
};

const rebuild = (problem, errors) => {
  const known = errors.find((type) => type.name === problem?.name);
  if (!known) return problem;
  const rebuilt = new known(problem.reason, problem.message);
  return rebuilt;
};

/**
 * Runs here, and if an account turns out to be leased, runs again — whole — on
 * the worker holding it. Once only: an operation forwarded and refused there
 * too is answered with that refusal.
 */
export const runAccountOperation = async (name, args, { forwarded = false } = {}) => {
  const operation = operations.get(name);
  if (!operation) throw new Error(`no account operation ${name}`);
  try {
    return await operation.run(...args);
  } catch (problem) {
    if (forwarded || !forwarder || !(problem instanceof AccountLeasedError)) throw problem;
    try {
      return await forwarder(problem.owner, name, args);
    } catch (remote) {
      throw rebuild(remote, operation.errors);
    }
  }
};
