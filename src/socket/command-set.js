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
import { matchHost } from "./match-host.js";
import { heroPositionUpdate } from "./objects.js";
import { damageTurnedAside } from "./combat.js";
import { buffMultiplierFor } from "./buffs.js";
import { heroCooldownMultiplier } from "./cooldowns.js";
import {
  VICTORY_DELAY_MS,
  authorsItsOwnEnding,
  cancelFloorFailing,
  completeFloor,
  floorHolds,
} from "./floorstate.js";
import { membersOf } from "./match-world.js";
import { presenceSummary } from "./presence.js";
import { TILE_SIZE } from "./tilegen.js";
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

/** `1 enemy`, `2 enemies`. */
const counted = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The tile a position is on, or null where the floor has none.
 *
 * A tile is placed by its corner and is `TILE_SIZE` square. A secret room's
 * tile is not among the floor's own until it is opened — the floor is cached
 * and shared between runs, so what a run has revealed is kept on the session.
 */
const tileAt = (session, at) =>
  [...(session.currentFloor?.tiles ?? []), ...(session.revealedTiles ?? [])].find(
    (tile) =>
      at.x >= tile.x && at.x < tile.x + TILE_SIZE && at.y >= tile.y && at.y < tile.y + TILE_SIZE
  ) ?? null;

/** `floor 2 of 3`, which is how a player counts them. */
const floorOrdinal = (session) => {
  const number = (session.floorIndex ?? 0) + 1;
  return session.floorCount ? `floor ${number} of ${session.floorCount}` : `floor ${number}`;
};

/**
 * What reproduces the floor: the map's file for an authored one, the library
 * and the seed for one that was laid out. A floor's name already holds either;
 * only the directory every one of them shares is dropped.
 */
const mapLine = (floor) => {
  if (!floor?.name) return null;
  const [name, seed] = String(floor.name).replace(/^Resources\/Levels\//, "").split("#");
  return seed === undefined ? `map ${name}` : `map ${name} seed ${seed}`;
};

/** How much `/near` prints before it says how many it left out. */
const NEAR_LIMIT = 8;

/** How many nodes `/online` names, and running generators `/floor` does. */
const LIST_LIMIT = 6;

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
   * moderators may use is a notice board. Held to an allowance per account,
   * and not delivered to anybody who has blocked the speaker (global-chat.js).
   */
  define({
    name: "g",
    role: ROLE.PLAYER,
    usage: "<message>",
    summary: "say something to everyone, wherever they are",
    run: async ({ session, args, reply }) => {
      const text = args.join(" ").trim();
      if (!text) throw new Error(`usage: ${COMMAND_PREFIX}g <message>`);

      const heard = await matchHost().sayGlobally(session, text);
      if (heard === null) return reply.warn("slow down: one global line every two seconds");
      // Said rather than counted silently: with nobody else on, the difference
      // between "it worked" and "it went nowhere" is the whole message.
      if (!heard) reply("nobody else is on a floor to hear that");
    },
  });

  /**
   * Where the caller is, in the words a report needs.
   *
   * A position alone says nothing to anybody who was not there: the same
   * coordinates are a different place on every map and on every seed. So this
   * names the node, the floor, the map — the file for an authored floor, the
   * library and seed for one that was laid out — and the tile underfoot, which
   * is the unit a level is authored in and the thing a fault is nearly always
   * about. The position inside the tile is how that tile's own objects are
   * placed, so it can be held against the level data directly.
   */
  define({
    name: "where",
    role: ROLE.PLAYER,
    summary: "say where you are: node, floor, map, tile and position",
    run: ({ session, reply }) => {
      const at = session.heroPosition;
      if (!at) return reply.warn("nowhere yet — you are not on a floor");

      const x = Math.round(at.x);
      const y = Math.round(at.y);
      const tile = tileAt(session, at);
      const node = [session.mapNodeId ?? "?", session.mapPage?.Name].filter(Boolean).join(" ");
      reply(
        [
          `node ${node} · ${floorOrdinal(session)} (#${session.floorDoid ?? "?"})`,
          mapLine(session.currentFloor),
          tile ? `tile ${tile.tileId} at ${tile.x}, ${tile.y}` : "no tile here",
          `x ${x}, y ${y}` + (tile ? ` — ${x - tile.x}, ${y - tile.y} inside the tile` : ""),
        ]
          .filter(Boolean)
          .join("\n")
      );
    },
  });

  /**
   * What the floor is waiting for.
   *
   * "The floor will not end" is the report this answers, and the answer is
   * nearly always one of three things nobody can see: a generator that has not
   * finished, an enemy standing somewhere out of sight, or a last floor that
   * ends by its own trigger and not by the last kill. `floorHolds` is the rule's
   * own reading, so what this prints is what the rule is looking at.
   *
   * The nearest of the enemies still standing is named with its tile and what
   * it is doing, because the one holding a floor is usually the one that is
   * stuck — and `blocked` beside it says so.
   */
  define({
    name: "floor",
    role: ROLE.PLAYER,
    summary: "say what this floor is still waiting for",
    run: ({ session, reply }) => {
      const at = session.heroPosition;
      if (!at || !session.actors) return reply.warn("you are not on a floor");

      const last = !session.floorExits?.length;
      const ownEnding = last && authorsItsOwnEnding(session);
      const state = session.floorFinished ? "finished" : session.floorCleared ? "cleared" : "not cleared";
      const lines = [`${floorOrdinal(session)} — ${state}`];

      if (session.floorCleared || session.floorFinished) {
        if (!last) lines.push("the exit is open");
        else if (ownEnding && !session.floorFinished) {
          lines.push("last floor: it ends by its own trigger, a chest to break or a switch to reach");
        }
        return reply(lines.join("\n"));
      }

      const { generators, enemies, alive } = floorHolds(session);
      const seen = session.enemiesSeen || enemies;
      if (!seen) lines.push("nothing has spawned yet, so there is nothing to clear");
      else lines.push(`${counted(alive.length, "enemy", "enemies")} alive, ${seen} seen`);

      const nearest = alive
        .filter(({ actor }) => actor.position)
        .map((entry) => ({ ...entry, away: distance(at, entry.actor.position) }))
        .sort((a, b) => a.away - b.away)[0];
      if (nearest) {
        const { actor, away } = nearest;
        const tile = tileAt(session, actor.position);
        lines.push(
          `nearest ${actor.constant ?? "?"}, ${Math.round(away)} away at ` +
            `${Math.round(actor.position.x)}, ${Math.round(actor.position.y)} ` +
            (tile ? `on tile ${tile.tileId}` : "on no tile") +
            (actor.ai?.state ? `, ${actor.ai.state}` : "")
        );
      }

      /**
       * The running ones are listed; the ones that have not started are
       * counted, and the nearest is placed. A floor of cages has a dozen of
       * the second kind and a line each would bury the one that matters —
       * which is usually the one nobody has walked up to yet.
       */
      if (generators.length) {
        const running = generators.filter((generator) => generator.started);
        const waiting = generators.filter((generator) => !generator.started);
        lines.push(
          `${counted(generators.length, "generator", "generators")} unfinished: ` +
            `${running.length} running, ${waiting.length} not started`
        );
        for (const generator of running.slice(0, LIST_LIMIT)) {
          lines.push(
            `  ${generator.placement?.spawnConstant ?? "?"} ` +
              `${generator.attemptedSpawns ?? 0} of ${generator.maxSpawns ?? "?"} spawned, ` +
              `${generator.alive ?? 0} alive`
          );
        }
        if (running.length > LIST_LIMIT) lines.push(`  and ${running.length - LIST_LIMIT} more`);

        const next = waiting
          .filter(({ placement }) => Number.isFinite(placement?.x) && Number.isFinite(placement?.y))
          .map((generator) => ({ generator, away: distance(at, generator.placement) }))
          .sort((a, b) => a.away - b.away)[0];
        if (next) {
          const { placement, maxSpawns } = next.generator;
          const tile = tileAt(session, placement);
          lines.push(
            `  nearest not started: ${placement.spawnConstant ?? "?"} at ` +
              `${Math.round(placement.x)}, ${Math.round(placement.y)} ` +
              (tile ? `on tile ${tile.tileId}` : "on no tile") +
              `, ${maxSpawns ?? "?"} to spawn`
          );
        }
      }

      if (!last) lines.push("clearing it opens the exit");
      else if (ownEnding) {
        lines.push("last floor: it ends by its own trigger, a chest to break or a switch to reach");
      } else lines.push("last floor: it ends when the last enemy falls");

      reply(lines.join("\n"));
    },
  });

  /**
   * What stands around the caller, closest first.
   *
   * For "this one will not move" and "that one cannot be hit": the constant is
   * what the game data calls it, the number is the object the server's log
   * lines carry, and the last word is what its AI believes it is doing. Heroes
   * are left out — `/party` is for them — and so is anything dead.
   *
   * A tile's width by default, which is about a screen.
   */
  define({
    name: "near",
    role: ROLE.PLAYER,
    usage: "[reach]",
    summary: "list the monsters and props around you",
    run: ({ session, args, reply }) => {
      const at = session.heroPosition;
      if (!at || !session.actors) return reply.warn("you are not on a floor");
      const reach = args.length ? Math.max(1, number(args[0], "reach")) : TILE_SIZE;

      const around = [];
      for (const [doid, actor] of session.actors) {
        if (actor.dead || !actor.position) continue;
        if (doid === session.heroDoid || session.objects?.get(doid) === CLID.HeroGameObject) continue;
        const away = distance(at, actor.position);
        if (away <= reach) around.push({ doid, actor, away });
      }
      if (!around.length) return reply(`nothing within ${Math.round(reach)}`);

      around.sort((a, b) => a.away - b.away);
      const lines = around.slice(0, NEAR_LIMIT).map(({ doid, actor, away }) =>
        [
          `${actor.constant ?? "?"} #${doid}`,
          `${Math.round(away)} away`,
          `${actor.hitPoints ?? "?"}/${actor.maxHitPoints ?? "?"}`,
          actor.isEnemy ? actor.ai?.state ?? "enemy" : "not an enemy",
        ].join(" · ")
      );
      if (around.length > NEAR_LIMIT) lines.push(`and ${around.length - NEAR_LIMIT} more`);
      reply(lines.join("\n"));
    },
  });

  /** Who is on this run, the hero each brought, and who is down. */
  define({
    name: "party",
    role: ROLE.PLAYER,
    summary: "list who is on this run",
    run: async ({ session, reply }) => {
      if (!session.heroDoid) return reply.warn("you are not on a floor");

      const gm = await loadGameMaster();
      const lines = [];
      for (const member of membersOf(session)) {
        const avatar = member.dungeonAvatar;
        const hero = avatar ? await heroById(avatar.avatar_id) : null;
        const actor = session.actors?.get(member.heroDoid);
        const name = member.dungeonAccount?.name ?? "(unnamed)";
        const health = !actor
          ? "off the floor"
          : actor.dead || !(actor.hitPoints > 0)
            ? "down"
            : `${actor.hitPoints}/${actor.maxHitPoints ?? "?"}`;
        lines.push(
          `${name}${member.heroDoid === session.heroDoid ? " (you)" : ""} — ` +
            (hero
              ? `${hero.Constant} lv ${heroLevel(gm, hero, Number(avatar.experience ?? 0))}`
              : "no hero") +
            ` · ${health}`
        );
      }
      reply(lines.join("\n"));
    },
  });

  /**
   * What the run has paid in experience, and what a kill on it is worth.
   *
   * A kill's worth is the run's and not the monster's — the node's total over
   * the weight of everything the run will make, see run-xp.js — so the same
   * monster pays differently on two nodes and no screen says by how much. The
   * three weights printed are the three a row authors.
   */
  define({
    name: "xp",
    role: ROLE.PLAYER,
    summary: "say what this run has paid and what a kill is worth",
    run: ({ session, reply }) => {
      if (!session.heroDoid) return reply.warn("you are not on a floor");

      const earned = `${Math.round(session.dungeonRewards?.xp ?? 0)} xp this run`;
      const unit = session.runXp?.unit;
      if (unit === null || unit === undefined) return reply(`${earned} · kills are not priced yet`);
      if (!(unit > 0)) return reply(`${earned} · this node's monsters carry no experience`);
      reply(
        `${earned} · node total ${session.mapPage?.TotalEnemyXP ?? "?"}\n` +
          `a kill pays by its weight: weight 1 pays ${rounded(unit)}, ` +
          `3 pays ${rounded(unit * 3)}, 10 pays ${rounded(unit * 10)}`
      );
    },
  });

  /**
   * How many are connected and where the ones in dungeons are.
   *
   * Counts and nodes, never who: the roll is the same summary the status
   * routes give out, and naming accounts to the room is a different question
   * with a different answer about privacy — see `presenceSummary`.
   */
  define({
    name: "online",
    role: ROLE.PLAYER,
    summary: "say how many players are on, and on which nodes",
    run: ({ reply }) => {
      const { online, inDungeon, byNode } = presenceSummary();
      const nodes = Object.entries(byNode).sort((a, b) => b[1] - a[1]);
      const lines = [`${online} online, ${inDungeon} in dungeons`];
      if (nodes.length) {
        lines.push(
          nodes
            .slice(0, LIST_LIMIT)
            .map(([node, count]) => `node ${node} ×${count}`)
            .join(", ") + (nodes.length > LIST_LIMIT ? `, and ${nodes.length - LIST_LIMIT} more` : "")
        );
      }
      reply(lines.join("\n"));
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

  /**
   * Ends the floor the caller is standing on, the way the floor ends itself.
   *
   * For reaching a later floor without fighting through the ones before it.
   * It goes through `completeFloor`, which is the one place that decides what
   * a finished floor means: a floor with another after it hands over, the last
   * one wins the run after its delay, with its report and its reward. For
   * everybody on the floor, since a floor is the party's.
   *
   * Nothing is killed for it. A death drops loot, pays its star, counts on the
   * report and fires whatever the floor wired to it, and none of that is what
   * was asked for. The floor is marked cleared first, which is what stops a
   * hero falling in the last seconds from failing a run that is already won.
   *
   * The run stops counting from here, for the whole party: it is kept off the
   * boards and an Infinite dungeon neither pays its floors nor records its
   * depth — see `runAssisted`. What the run earned before the command stays.
   *
   * Not while the floor is still being built: its objects are arriving, and
   * tearing a floor down under its own construction is the race the build's
   * `isActive` checks exist to survive, not one to start on purpose.
   */
  define({
    name: "complete",
    role: ROLE.ADMIN,
    summary: "end this floor as though it had been cleared",
    run: ({ session, reply }) => {
      if (!session.heroDoid || !session.areaDoid) return reply.warn("you are not on a floor");
      if (session.floorSettled === false) return reply.warn("this floor is still being built");
      if (session.floorFinished) return reply.warn("this floor is already finishing");

      const ordinal = floorOrdinal(session);
      const next = (session.floorIndex ?? 0) + 2;
      const last = next > (session.floorCount ?? 1);

      // Before the floor is ended, so that ending it pays nothing either.
      session.runAssisted = true;
      session.floorCleared = true;
      cancelFloorFailing(session);
      (session.completeFloor ?? completeFloor)(session);

      if (last) {
        const seconds = Math.round((session.victoryDelayMs ?? VICTORY_DELAY_MS) / 1000);
        return reply(`last floor completed — the run ends in ${seconds}s`);
      }
      reply(`${ordinal} completed — on to floor ${next}`);
    },
  });
};
