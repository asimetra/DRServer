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
import { damageTurnedAside } from "./combat.js";
import { buffMultiplierFor } from "./buffs.js";
import { heroCooldownMultiplier } from "./cooldowns.js";
import { TICK_MS as MANA_TICK_MS, manaRegenFor } from "./regen.js";
import { statOffsetsFor } from "../combat-damage.js";
import { heroById, loadGameMaster } from "../gamemaster.js";
import { STAT_NAMES, statTotals } from "../hero-stats.js";
import { heroLevel } from "../progression.js";

const number = (text, what) => {
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error(`${what} must be a number, not "${text}"`);
  return value;
};

/** Enough precision to see a number move, not enough to print a float's tail. */
const rounded = (value) => String(Math.round(Number(value) * 100) / 100);

const percent = (share) => `${Math.round(share * 100)}%`;

/** `1.33` alone, or `1.33 ×1.3 = 1.73` when something is currently changing it. */
const withBuff = (base, multiplier) =>
  multiplier === 1
    ? rounded(base)
    : `${rounded(base)} ×${rounded(multiplier)} = ${rounded(base * multiplier)}`;

/** The three damage types, which is the axis both attack and defence turn on. */
const DAMAGE_TYPES = ["MELEE", "SHOOTING", "MAGIC"];

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
   * What this hero is, in the dungeon, at the moment of asking.
   *
   * Everything here is state a run can change *and this server owns*. Training
   * is absent — which slot holds which stat and how many points are in it is
   * the same before the floor as after it, the client's own screen already
   * shows it, and putting it here buried the lines somebody is watching.
   *
   * Movement is absent for the harder reason. This server does not move a hero:
   * the client walks it and only claims a position, which `handleHeroPosition`
   * audits rather than authors. Printing the movement stat would be this server
   * reporting what it believes the client ought to be doing, which is the one
   * kind of number a diagnostic must not carry — it agrees with the client
   * right up until the moment something is wrong, which is the moment it is
   * read. Health and mana are not in that company: nothing but this server ever
   * writes them, and the client never sends either.
   *
   * The stat vector is absent for the same reason once removed. A player asking
   * whether defence works wants the share of a hit it turns aside; that number
   * is not `MELEE_DEF 0.25`, is not the reduction either half applies alone,
   * and appears on no screen the game has.
   *
   * Attack and defence are listed by the type of the *hit* rather than by the
   * stat that answers it, because the game cross-wires the two: a MELEE hit is
   * resisted by SHOOT_DEF. Printing the stat names would file the Berserker's
   * melee tanking under "shooting" and read as a bug in the readout.
   *
   * One message rather than a dozen. The client's log keeps fifty lines and
   * draws them into a single text field, so newlines cost one entry where
   * separate replies cost one each — a per-line `/stats` threw away a fifth of
   * the player's chat history every time it was run.
   *
   * At player rank. It reads the caller's own hero and writes nothing.
   */
  define({
    name: "stats",
    role: ROLE.PLAYER,
    summary: "read your hero's live numbers, buffs included",
    run: async ({ session, reply }) => {
      const avatar = session.dungeonAvatar;
      if (!avatar || !session.heroDoid) return reply.warn("you are not on a floor");

      const gm = await loadGameMaster();
      const hero = await heroById(avatar.avatar_id);
      if (!hero) return reply.warn(`no hero row for avatar type ${avatar.avatar_id}`);

      /**
       * `session.heroStats` rather than a fresh `statTotals`: that map is what
       * combat prices hits against, so a stale one is precisely the fault worth
       * seeing. Recomputed only for a session that predates it.
       */
      const totals = session.heroStats ?? statTotals(gm, hero, avatar);
      const stat = (name) => Number(totals.get(name) ?? 0);
      const buff = (name) => buffMultiplierFor(session, session.heroDoid, name);

      const heroActor = session.actors?.get(session.heroDoid);
      const regen = manaRegenFor(hero, avatar);
      const lines = [
        `${hero.Constant} lv ${heroLevel(gm, hero, Number(avatar.experience ?? 0))}`,
        `health ${heroActor?.hitPoints ?? "?"}/${heroActor?.maxHitPoints ?? "?"} · ` +
          `mana ${session.heroManaPoints ?? "?"}/${session.maxHeroManaPoints ?? "?"}` +
          // Per tick, and the tick is five seconds — see regen.js. Divided into
          // a per-second figure it would read as a rate the bar never moves at.
          (regen ? ` +${rounded(regen)}/${MANA_TICK_MS / 1000}s` : ""),
        // The meter, which only the two buster bottles and the crowd pickups
        // fill, and which a player watches for the whole of a floor.
        `buster ${session.dungeonBusterPoints ?? 0}/${session.maxDungeonBusterPoints ?? "?"}`,
      ];

      for (const type of DAMAGE_TYPES) {
        const offsets = statOffsetsFor({ AttackType: type });
        const offence = STAT_NAMES[offsets.offence];
        const aside = damageTurnedAside(session, session.heroDoid, totals, offsets);
        /**
         * `deal +n`, not `deal n`. The offence stat is a flat term added to
         * what the weapon already contributes — damage is
         * `(power × Bonus + stat) × buff × DamageMod` — so a bare number reads
         * as the whole hit, which it is not: a Berserker's 253 sits on top of a
         * 100-power weapon's 100 for 353, and the same swing untrained is 100.
         */
        lines.push(
          `${type.toLowerCase().padEnd(8)} deal +${withBuff(stat(offence), buff(offence))}` +
            ` · take −${percent(aside)}`
        );
      }

      // Only when there is any. It is the Sorcerer's third slot and nobody
      // else's, so a zero line would be noise on five heroes out of six.
      const cooldown = await heroCooldownMultiplier(session);
      if (cooldown > 0) lines.push(`cooldown −${percent(cooldown)}`);

      const buffs = [...(session.activeBuffs?.values() ?? [])]
        .filter((active) => active.affectedActor === session.heroDoid)
        .map((active) => active.buff?.Constant)
        .filter(Boolean);
      if (buffs.length) lines.push(`buffs ${buffs.join(", ")}`);

      reply(lines.join("\n"));
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
