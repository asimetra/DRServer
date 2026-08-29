/**
 * The commands this server ships with.
 *
 * Kept apart from the registry so that the machinery can be read without the
 * list, and so a fork can drop this file and register its own.
 *
 * Each one is scoped to the dungeon, because that is where chat exists: the
 * client only builds `UIChatLog` inside a floor. Anything that wants to be
 * typed from a lobby needs the lobby first.
 */
import { CLID } from "./opcodes.js";
import { COMMAND_PREFIX, commands, define, rankOf } from "./commands.js";
import { ROLE, roleName } from "./roles.js";
import { hitPointsUpdate } from "./combat.js";
import { sayGlobally } from "./global-chat.js";
import { heroPositionUpdate } from "./objects.js";

const number = (text, what) => {
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`${what} must be a number, not "${text}"`);
  return value;
};

export const registerBuiltinCommands = () => {
  define({
    name: "help",
    role: ROLE.PLAYER,
    summary: "list the commands you can run",
    run: ({ reply, rank }) => {
      const mine = commands().filter((command) => rank >= command.role);
      if (!mine.length) return reply.warn("you have no commands");
      reply(`commands for ${roleName(rank)}:`);
      for (const command of mine) {
        const usage = command.usage ? ` ${command.usage}` : "";
        reply(`  ${COMMAND_PREFIX}${command.name}${usage} — ${command.summary}`);
      }
    },
  });

  /**
   * The channel the game never had.
   *
   * At player rank because that is the point of it — a global channel only
   * moderators may use is a notice board. Rate limiting and muting are the
   * obvious next things and are deliberately not guessed at here; what this
   * needs first is somebody to talk to.
   */
  define({
    name: "g",
    role: ROLE.PLAYER,
    usage: "<message>",
    summary: "say something to everyone, wherever they are",
    run: ({ session, args, reply }) => {
      const text = args.join(" ").trim();
      if (!text) throw new Error(`usage: ${COMMAND_PREFIX}g <message>`);

      const heard = sayGlobally(session, text);
      // Said rather than counted silently: with nobody else on, the difference
      // between "it worked" and "it went nowhere" is the whole message.
      if (!heard) reply("nobody else is on a floor to hear that");
    },
  });

  define({
    name: "where",
    role: ROLE.PLAYER,
    summary: "say where you are",
    run: ({ session, reply }) => {
      const at = session.heroPosition;
      if (!at) return reply.warn("nowhere yet — you are not on a floor");
      reply(`x ${Math.round(at.x)}, y ${Math.round(at.y)} on floor ${session.floorDoid ?? "?"}`);
    },
  });

  define({
    name: "who",
    role: ROLE.PLAYER,
    summary: "say who you are to this server",
    run: ({ session, reply, rank }) => {
      const name = session.dungeonAccount?.name ?? "(unnamed)";
      reply(`${name}, account ${session.accountId ?? "?"}, ${roleName(rank)}`);
    },
  });

  /**
   * Moving somebody is a server decision, and the client accepts it:
   * `HeroGameObjectOwner.set_position` forwards straight to the base setter, so
   * field 147 sent inbound moves the local hero rather than being ignored as
   * an echo of its own claim.
   *
   * The session's own idea of the position has to move with it, or the next
   * claim the client sends looks like a jump from the old place and the
   * movement audit refuses it.
   */
  define({
    name: "tp",
    role: ROLE.ADMIN,
    usage: "<x> <y>",
    summary: "put yourself somewhere",
    run: ({ session, args, reply }) => {
      if (args.length < 2) throw new Error(`usage: ${COMMAND_PREFIX}tp <x> <y>`);
      const to = { x: number(args[0], "x"), y: number(args[1], "y") };
      if (!session.heroDoid) return reply.warn("you are not on a floor");

      session.heroPosition = to;
      session.reportedHeroPosition = to;
      session.reportedHeroPositionAt = Date.now();
      const hero = session.actors?.get(session.heroDoid);
      if (hero) hero.position = { ...to };

      session.send(heroPositionUpdate(session.heroDoid, to));
      reply(`moved to ${Math.round(to.x)}, ${Math.round(to.y)}`);
    },
  });

  define({
    name: "hp",
    role: ROLE.ADMIN,
    usage: "[amount]",
    summary: "set your health, or read it",
    run: ({ session, args, reply }) => {
      const hero = session.actors?.get(session.heroDoid);
      if (!hero) return reply.warn("you are not on a floor");
      if (!args.length) return reply(`${hero.hitPoints} of ${hero.maxHitPoints}`);

      const wanted = Math.max(0, Math.round(number(args[0], "amount")));
      hero.hitPoints = Math.min(wanted, hero.maxHitPoints ?? wanted);
      session.send(hitPointsUpdate(session.heroDoid, CLID.HeroGameObject, hero.hitPoints));
      reply(`health is ${hero.hitPoints}`);
    },
  });
};
