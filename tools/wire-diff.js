/**
 * Two captures of the same thing, side by side, named by the schema.
 *
 * The loop this replaces is a person playing, describing what looked wrong, and
 * someone guessing which constant they meant. Both sides are on the wire now —
 * the official's own logs, and ours via `DR_CAPTURE` on the probe — so the
 * comparison is mechanical.
 *
 *   node tools/wire-diff.js --theirs <capture…> --ours <capture…>
 *   node tools/wire-diff.js --theirs a.jsonl --ours b.jsonl --trap NORDIC_CAVE_TRAP_MACE
 *
 * Reported per distributed class and per field, as a rate rather than a count,
 * because two sessions are never the same length. A field one side sends and
 * the other never does is the shape almost every bug this session turned out to
 * have: the flame jet with no choreography, Loki with no trigger state, the
 * barrel whose bang arrived after its death.
 */
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";

import { loadGameMaster } from "../src/gamemaster.js";

const OP_UPDATE_FIELD = 124;
const OP_GENERATE = new Set([134, 135, 136]);
const OP_DISABLE = new Set([125, 126]);

const loadSchema = () => {
  const file = path.join(process.cwd(), "docs", "dc-schema.json");
  const schema = JSON.parse(fs.readFileSync(file, "utf8"));
  const byId = new Map();
  const classOf = new Map();
  const declared = [];
  for (const entry of schema.classes) {
    for (const field of entry.fields) {
      byId.set(field.id, `${entry.class}.${field.name}`);
      classOf.set(field.id, entry.class);
      declared.push({ id: field.id, name: field.name, class: entry.class });
    }
  }
  return { byId, classOf, declared };
};

/**
 * The whole protocol, not just the traps in it.
 *
 * Field ids are unique across the schema's fourteen classes, so a stream can be
 * summarised without knowing which object each doid is — and matchmaking, the
 * dungeon summary, buffs and doobers are as much a part of what this server has
 * to get right as anything on a floor. A field the official sends and we never
 * do is the same shape of finding wherever it lives.
 */
const protocolReport = (theirs, ours, schema, implemented) => {
  const ids = new Set([...theirs.totals.keys(), ...ours.totals.keys(), ...schema.classOf.keys()]);
  const rows = [...ids]
    .map((id) => ({
      id,
      name: schema.byId.get(id) ?? "(not in the schema)",
      class: schema.classOf.get(id) ?? "?",
      theirs: theirs.totals.get(id) ?? 0,
      ours: ours.totals.get(id) ?? 0,
    }))
    .sort((a, b) => a.class.localeCompare(b.class) || a.id - b.id);

  let current = null;
  const missing = [];
  for (const row of rows) {
    if (row.class !== current) {
      current = row.class;
      console.log(`\n${current}`);
    }
    /**
     * Two very different reasons for a zero.
     *
     * A field this server has no code for is a gap. A field it has code for but
     * this run never provoked — mana nobody spent, experience nobody earned, an
     * exit nobody walked through — is the scenario's silence, not the server's.
     * Only the first is worth acting on, so only the first is called out.
     */
    const known = implemented.has(row.id);
    const mark =
      row.theirs > 0 && row.ours === 0
        ? known
          ? "  <-- not exercised by this run"
          : "  <-- they send it, and we have no code for it"
        : row.ours > 0 && row.theirs === 0
          ? "  <-- we send it, they never did"
          : "";
    if (row.theirs > 0 && row.ours === 0 && !known) missing.push(row);
    console.log(
      `  ${String(row.id).padStart(4)}  ${row.name.split(".").pop().padEnd(34)}` +
        `theirs ${String(row.theirs).padStart(6)}   ours ${String(row.ours).padStart(6)}${mark}`
    );
  }
  console.log(
    `\n${missing.length} field(s) the official sends that this server has no code for:` +
      (missing.length ? "\n  " + missing.map((row) => `${row.id} ${row.name}`).join("\n  ") : " none")
  );
};

/** Field traffic per NPC constant, plus totals, from one side's capture. */
const read = async (files, npcName) => {
  const perTrap = new Map();
  const totals = new Map();
  /**
   * A trap on a timer fires as often as the session is long, so a rate per
   * placed instance still says nothing until it is also per second.
   *
   * Summed per capture, not spanned across them: ten sessions recorded over an
   * afternoon are not one six-hour session, and treating them as one made every
   * official rate round to zero.
   */
  let seconds = 0;
  /**
   * How long each trap was actually being told about.
   *
   * A doid only sends while the client holds interest in it, and a session
   * wanders: the official's twelve gargoyle emitters are each in view for a
   * few seconds of a two-minute run, while a tour that parks next to one keeps
   * it for the whole stop. Dividing by the session made theirs look seventeen
   * times slower than ours when the difference was mostly how long anybody was
   * looking.
   */
  const watched = new Map();
  const attention = new Map();
  // How many of each the side actually put on its floors. Without this the
  // report cannot tell "we never send this field" from "that trap was not on
  // the floor we walked", and the second is most of the noise.
  const generated = new Map();
  let frames = 0;

  for (const file of files) {
    const owner = new Map();
    let firstAt = null;
    let lastAt = null;
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row.hex || (row.dir && row.dir !== "in")) continue;
      const body = Buffer.from(row.hex, "hex");
      frames += 1;
      const at = Date.parse(row.ts);
      if (Number.isFinite(at)) {
        firstAt = firstAt === null ? at : Math.min(firstAt, at);
        lastAt = lastAt === null ? at : Math.max(lastAt, at);
      }

      if (OP_GENERATE.has(row.op) && body.length >= 20) {
        // Named `offset`, not `at`: the timestamp above is called that, and a
        // loop counter shadowing it recorded a trap as watched since 16
        // milliseconds after the epoch.
        for (let offset = 16; offset + 4 <= Math.min(body.length, 40); offset += 1) {
          const name = npcName.get(body.readUInt32LE(offset));
          if (name) {
            const doid = body.readUInt32LE(12);
            owner.set(doid, name);
            generated.set(name, (generated.get(name) ?? 0) + 1);
            if (Number.isFinite(at)) watched.set(doid, { name, from: at, to: at });
            break;
          }
        }
        continue;
      }
      // The doid follows the opcode, which is two bytes.
      if (OP_DISABLE.has(row.op) && body.length >= 6) {
        const seen = watched.get(body.readUInt32LE(2));
        if (seen && Number.isFinite(at)) seen.to = at;
        continue;
      }
      if (row.op !== OP_UPDATE_FIELD || body.length < 8) continue;
      const watching = watched.get(body.readUInt32LE(2));
      if (watching && Number.isFinite(at)) watching.to = at;

      const field = body.readUInt16LE(6);
      totals.set(field, (totals.get(field) ?? 0) + 1);
      const name = owner.get(body.readUInt32LE(2));
      if (!name) continue;
      const seen = perTrap.get(name) ?? new Map();
      seen.set(field, (seen.get(field) ?? 0) + 1);
      perTrap.set(name, seen);
    }
    seconds += Math.max(0, ((lastAt ?? 0) - (firstAt ?? 0)) / 1000);
    for (const { name, from, to } of watched.values()) {
      attention.set(name, (attention.get(name) ?? 0) + Math.max(0, (to - from) / 1000));
    }
    watched.clear();
  }
  return { perTrap, totals, generated, attention, frames, seconds: Math.max(1, seconds) };
};

const rate = (count, frames) => (frames ? (count / frames) * 1000 : 0);

const main = async () => {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const at = args.indexOf(flag);
    if (at < 0) return [];
    const out = [];
    for (let i = at + 1; i < args.length && !args[i].startsWith("--"); i += 1) out.push(args[i]);
    return out;
  };
  const theirFiles = take("--theirs");
  const ourFiles = take("--ours");
  const [only] = take("--trap");
  if (!theirFiles.length || !ourFiles.length) {
    console.error("usage: node tools/wire-diff.js --theirs <capture…> --ours <capture…> [--trap CONSTANT]");
    process.exit(2);
  }

  const gm = await loadGameMaster();
  const npcName = new Map([...gm.npcByConstant.values()].map((npc) => [npc.Id, npc.Constant]));
  const schema = loadSchema();
  const fieldName = schema.byId;

  const theirs = await read(theirFiles, npcName);
  const ours = await read(ourFiles, npcName);
  const protocol = args.includes("--protocol");
  console.log(
    `theirs: ${theirs.frames} frames over ${theirFiles.length} capture(s), ` +
      `${Math.round(theirs.seconds)}s`
  );
  console.log(
    `ours:   ${ours.frames} frames over ${ourFiles.length} capture(s), ${Math.round(ours.seconds)}s\n`
  );

  if (protocol) {
    // What src/socket names at all, which is how dc-schema --coverage answers
    // the same question.
    let source = "";
    for (const file of await fs.promises.readdir("src/socket")) {
      if (file.endsWith(".js")) source += await fs.promises.readFile(`src/socket/${file}`, "utf8");
    }
    const implemented = new Set(
      schema.declared.filter((field) => new RegExp(`\\b${field.id}\\b`).test(source)).map((f) => f.id)
    );
    return protocolReport(theirs, ours, schema, implemented);
  }

  // Only what both sides put on a floor is comparable at all.
  const constants = [...new Set([...theirs.generated.keys(), ...ours.generated.keys()])]
    .filter((name) => !only || name === only)
    .filter((name) => only || (theirs.generated.has(name) && ours.generated.has(name)))
    .filter((name) => /TRAP|STATUE|EMITTER|BARREL|SPIKE|FLAME|GARGOYLE|LAVA|CAGE|JAIL/.test(name))
    .sort();
  console.log(`${constants.length} trap(s) both sides placed\n`);

  let flagged = 0;
  for (const constant of constants) {
    const mine = ours.perTrap.get(constant) ?? new Map();
    const yours = theirs.perTrap.get(constant) ?? new Map();
    const fields = [...new Set([...mine.keys(), ...yours.keys()])].sort((a, b) => a - b);

    /**
     * Per placed instance, not per capture.
     *
     * One side having 158 spike beds on its floors and the other 26 makes raw
     * counts say nothing: 1269 state changes against 257 is the same trap
     * behaving the same way. Divided through, they are 8.0 and 9.9 — close
     * enough to be the same, where the raw numbers looked five times apart.
     */
    const theirPlaced = theirs.generated.get(constant) ?? 0;
    const ourPlaced = ours.generated.get(constant) ?? 0;
    // Per minute that anybody was actually being told about this trap.
    const theirWatched = theirs.attention.get(constant) ?? 0;
    const ourWatched = ours.attention.get(constant) ?? 0;
    const per = (count, watchedSeconds) =>
      watchedSeconds > 1 ? (count / watchedSeconds) * 60 : 0;

    // Two shapes are worth reporting and they are not the same thing: a field
    // one side never sends at all, and one both send at very different rates.
    const silent = fields.filter((field) => {
      const theirPer = per(yours.get(field) ?? 0, theirWatched);
      const ourPer = per(mine.get(field) ?? 0, ourWatched);
      return (theirPer > 0) !== (ourPer > 0);
    });
    const lopsided = fields.filter((field) => {
      const theirPer = per(yours.get(field) ?? 0, theirWatched);
      const ourPer = per(mine.get(field) ?? 0, ourWatched);
      if (!theirPer || !ourPer) return false;
      const ratio = theirPer > ourPer ? theirPer / ourPer : ourPer / theirPer;
      return ratio >= 3;
    });
    if (!silent.length && !lopsided.length && !only) continue;

    flagged += silent.length || lopsided.length ? 1 : 0;
    console.log(
      `${constant}   (placed: theirs ${theirPlaced}, ours ${ourPlaced}; ` +
        `watched: theirs ${Math.round(theirWatched)}s, ours ${Math.round(ourWatched)}s)`
    );
    for (const field of fields) {
      const theirPer = per(yours.get(field) ?? 0, theirWatched);
      const ourPer = per(mine.get(field) ?? 0, ourWatched);
      const mark = silent.includes(field)
        ? "  <-- only one side sends this"
        : lopsided.includes(field)
          ? "  <-- same field, very different rate"
          : "";
      console.log(
        `  ${String(field).padStart(4)} ${(fieldName.get(field) ?? "?").padEnd(42)}` +
          `theirs ${theirPer.toFixed(1).padStart(6)}   ours ${ourPer.toFixed(1).padStart(6)}` +
          ` /min watched${mark}`
      );
    }
    console.log("");
  }
  console.log(
    flagged
      ? `\n${flagged} trap(s) disagree. Rates are per minute the trap was being watched.`
      : "\nno trap disagrees."
  );
};

await main();
