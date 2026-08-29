/**
 * Commands typed into the game's own chat box.
 *
 * The original game has none of this. What makes it possible without touching
 * the client is that chat is an ordinary field on an ordinary distributed
 * object: the client writes a string, the server decides what a string means,
 * and a reply is the same field written back to one socket. Nothing in the
 * client knows the difference between a message and an answer.
 *
 * Everything is registered rather than switched on, so a new command is one
 * `define` next to the others and nothing here changes. The registry is also
 * what `/help` reads, which means a command cannot exist without being
 * documented and cannot be documented into existing.
 *
 * The reply lands on the caller's own player object and goes to that socket
 * alone, so it appears in their log and above their own head, and nobody else
 * in the room sees either.
 */
import { info, warn } from "../log.js";
import { ROLE, roleName, roleOf } from "./roles.js";
import { config } from "./../config.js";

/** The character that turns a line of chat into an instruction. */
export const COMMAND_PREFIX = "/";

/** name -> definition, in registration order so `/help` reads sensibly. */
const registry = new Map();

export const define = ({ name, role = ROLE.ADMIN, usage = "", summary, run }) => {
  if (registry.has(name)) throw new Error(`command ${name} is already defined`);
  registry.set(name, { name, role, usage, summary, run });
};

export const commands = () => [...registry.values()];

/** Only for tests: forget every registration. */
export const resetCommands = () => registry.clear();

/**
 * What rank this session speaks with.
 *
 * The account's own rank, unless the server was started with an override list.
 * `DR_ADMIN_ACCOUNTS` exists because the first admin has to come from
 * somewhere: with no command to grant a rank and no rank to run one, a fresh
 * database is a locked room. Naming an account id in the environment is the
 * key, and it is a flag rather than a seeded row so that turning it off is
 * restarting without it.
 */
export const rankOf = (session) => {
  const account = session?.dungeonAccount ?? session?.account;
  const id = Number(account?.id ?? session?.accountId ?? 0);
  if (id && config.adminAccounts?.includes(id)) return ROLE.ADMIN;
  return roleOf(account);
};

/** Splits on runs of whitespace; quoting is not worth the surprise it buys. */
const parse = (text) => {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  return { name: (words[0] ?? "").toLowerCase(), args: words.slice(1) };
};

/**
 * Guarantees the reply a command is handed has both halves.
 *
 * Commands call `reply.warn` to refuse, and the chat path supplies one that
 * answers in a different colour. But `runCommand` is also called directly — by
 * tests, and by anything else that wants to run a line — and those callers pass
 * a plain function. Normalising here means a command can rely on `.warn`
 * existing without every caller having to know that it should: a refusal loses
 * its colour, which is cosmetic, instead of throwing, which is not.
 */
const withWarn = (reply) => {
  if (typeof reply?.warn === "function") return reply;
  const wrapped = (text) => reply(text);
  wrapped.warn = wrapped;
  return wrapped;
};

/**
 * Runs a line if it is a command, and says whether it was one.
 *
 * A line that starts with the prefix is always consumed, even when it names
 * nothing: relaying `/tp 100 200` to the room after refusing it would broadcast
 * the attempt to everybody, and a typo would be published as chat.
 */
export const runCommand = async (session, line, rawReply = () => {}) => {
  const reply = withWarn(rawReply);
  const text = String(line ?? "");
  if (!text.startsWith(COMMAND_PREFIX)) return false;

  const { name, args } = parse(text.slice(COMMAND_PREFIX.length));

  const command = registry.get(name);
  if (!command) {
    reply.warn(`unknown command "${name}" — try ${COMMAND_PREFIX}help`);
    return true;
  }

  const rank = rankOf(session);
  if (rank < command.role) {
    // Deliberately says what it needs. Hiding a command's existence from
    // somebody who just typed its exact name protects nothing.
    reply.warn(`${COMMAND_PREFIX}${name} needs ${roleName(command.role)}; you are ${roleName(rank)}`);
    return true;
  }

  try {
    await command.run({ session, args, reply, rank });
    info(`[${session.id}] ran ${COMMAND_PREFIX}${name}${args.length ? ` ${args.join(" ")}` : ""}`);
  } catch (error) {
    // The caller gets the reason; a command that throws is a bug in the command
    // and not a reason to drop the session.
    reply.warn(`${COMMAND_PREFIX}${name} failed: ${error.message}`);
    warn(`[${session.id}] ${COMMAND_PREFIX}${name} threw: ${error.stack ?? error.message}`);
  }
  return true;
};
