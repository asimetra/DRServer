/**
 * The wire protocol, read out of the client instead of out of captures.
 *
 * This is not a bespoke socket. It is a generated distributed-class layer —
 * doids, zones, generates, interest contexts, and a `dcHash` in the login
 * packet that both ends compare so they agree on the schema. The client ships
 * the generated half of it in `src/generatedCode/`: one NetworkComponent per
 * distributed class, each declaring its field ids and the exact read and write
 * sequence for every payload.
 *
 * So every layout this server discovered a byte at a time is *declared*, and
 * can be extracted:
 *
 *   node tools/dc-schema.js <path-to-client-worktree>              # schema
 *   node tools/dc-schema.js --coverage <path-to-client-worktree>   # coverage
 *   node tools/dc-schema.js --json <path-to-client-worktree>       # JSON
 *
 * Reading it is what makes a mistake like decoding `knockback` four bytes late
 * impossible rather than merely unlikely: the offsets stop being a thing anyone
 * counts.
 */
import fs from "node:fs/promises";
import path from "node:path";

const READ = /\breadUnsignedInt|\breadUnsignedShort|\breadUnsignedByte|\breadFloat|\breadDouble|\breadInt|\breadShort|\breadByte|\breadBoolean|\breadUTF/g;
const WIRE_TYPE = {
  readUnsignedInt: "u32", readUnsignedShort: "u16", readUnsignedByte: "u8",
  readFloat: "f32", readDouble: "f64", readInt: "i32", readShort: "i16",
  readByte: "i8", readBoolean: "bool", readUTF: "utf",
};

/** The body of a function, by brace matching from its opening line. */
const bodyOf = (source, at) => {
  const start = source.indexOf("{", at);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  return "";
};

/** Every wire read a function performs, in order, with nested structs named. */
const layoutOf = (source, functionName, structs) => {
  const at = source.search(new RegExp(`function\\s+${functionName}\\s*\\(`));
  if (at < 0) return null;
  const body = bodyOf(source, at);
  const reads = [];
  const pattern =
    /\b(readUnsignedInt|readUnsignedShort|readUnsignedByte|readFloat|readDouble|readInt|readShort|readByte|readBoolean|readUTF)\b|\b([A-Z][A-Za-z0-9_]*)\.readFromPacket\b/g;
  let match;
  while ((match = pattern.exec(body))) {
    if (match[1]) reads.push(WIRE_TYPE[match[1]]);
    else reads.push(`${match[2]}{${structs.get(match[2])?.join(" ") ?? "?"}}`);
  }
  // A fixed-length vector reads the same struct N times; the loop bound is the
  // literal the generator emitted.
  const repeat = body.match(/=\s*\((\d+)\s*:\s*UInt\);?[\s\S]{0,200}?while/);
  return { reads, repeat: repeat ? Number(repeat[1]) : 1 };
};

const parseStructs = async (dir) => {
  const structs = new Map();
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith(".hx") || /NetworkComponent|^I[A-Z]|GeneratedDcSocket/.test(name)) continue;
    const source = await fs.readFile(path.join(dir, name), "utf8");
    const layout = layoutOf(source, "readFromPacket", new Map());
    if (layout?.reads.length) structs.set(name.replace(/\.hx$/, ""), layout.reads);
  }
  return structs;
};

const parseClasses = async (dir, structs) => {
  const classes = [];
  /**
   * Every `send_` in the whole generated layer, not just the file a field is
   * declared in. A hero's fields are declared on `HeroGameObject` and sent from
   * `HeroGameObjectOwner`, so looking only in one file reported the client as
   * mute about exactly the class where it speaks.
   */
  const sendable = new Set();
  for (const name of (await fs.readdir(dir)).sort()) {
    if (!name.endsWith(".hx")) continue;
    const source = await fs.readFile(path.join(dir, name), "utf8");
    for (const match of source.matchAll(/function\s+send_([A-Za-z0-9_]+)\s*\(/g)) {
      sendable.add(match[1]);
    }
  }

  /**
   * Every component's source, so a field can be typed from the class that
   * actually reads it.
   *
   * A field is declared where it belongs and received where it is used, and the
   * two are not always the same file: `PlayerGameObject` declares
   * `FLID_basicCurrency` and has no `recv_basicCurrency` at all — the owner
   * component reads it, as a `readUnsignedInt`. Looking only in the declaring
   * file left that field with no layout, and a decoder reading nothing for it
   * left four bytes of every owner generate unexplained.
   */
  const sources = new Map();
  for (const name of (await fs.readdir(dir)).sort()) {
    if (name.endsWith("NetworkComponent.hx")) {
      sources.set(name.replace(/NetworkComponent\.hx$/, ""), await fs.readFile(path.join(dir, name), "utf8"));
    }
  }

  for (const name of (await fs.readdir(dir)).sort()) {
    if (!name.endsWith("NetworkComponent.hx")) continue;
    const source = await fs.readFile(path.join(dir, name), "utf8");
    const className = name.replace(/NetworkComponent\.hx$/, "");
    /** This class's own reader, or the owner's when only the owner has one. */
    const layoutFor = (field) =>
      layoutOf(source, `recv_${field}`, structs) ??
      layoutOf(sources.get(`${className}Owner`) ?? "", `recv_${field}`, structs);
    const fields = [];
    const declared = /FLID_([A-Za-z0-9_]+)\s*=\s*\((\d+)\s*:\s*UInt\)/g;
    let match;
    while ((match = declared.exec(source))) {
      /**
       * Which side may put this field on the wire.
       *
       * In this family a field carries keywords — `clsend`, `ownsend`, `airecv`
       * — saying who is allowed to send it, and the generated half keeps them:
       * a `send_` method exists only where the client is permitted to speak.
       * Reading that off is what turns "should the server own this?" from an
       * experiment into a lookup.
       *
       * The answer is lopsided and worth seeing: `DistributedNPCGameObject` has
       * sixteen fields the client can only receive and none it may send, so a
       * trap or a monster proposes nothing. `HeroGameObjectOwner` is the only
       * class where the client speaks for itself, and only about its own hero.
       */
      const clientMaySend = sendable.has(match[1]);
      fields.push({
        name: match[1],
        id: Number(match[2]),
        direction: clientMaySend ? "both" : "serverToClient",
        layout: layoutFor(match[1]),
      });
    }
    const generate = bodyOf(source, source.search(/function\s+generate\s*\(/))
      .split("\n")
      .map((line) => line.match(/recv_([A-Za-z0-9_]+)\s*\(/)?.[1])
      .filter(Boolean);
    classes.push({ class: name.replace(/NetworkComponent\.hx$/, ""), fields, generate });
  }
  return classes;
};

const describe = (layout) => {
  if (!layout?.reads.length) return "-";
  const body = layout.reads.join(" ");
  return layout.repeat > 1 ? `${layout.repeat} x [${body}]` : body;
};

const main = async () => {
  const args = process.argv.slice(2);
  const root = args.find((arg) => !arg.startsWith("--")) ?? "../client-worktree";
  const dir = path.join(root, "src", "generatedCode");
  const structs = await parseStructs(dir);
  const classes = await parseClasses(dir, structs);

  if (args.includes("--json")) {
    console.log(JSON.stringify({ structs: Object.fromEntries(structs), classes }, null, 2));
    return;
  }

  if (args.includes("--coverage")) {
    // What this server actually names on the wire. A field nobody mentions is
    // one the client can send or receive and we would not understand.
    const ours = await fs.readdir("src/socket");
    let text = "";
    for (const file of ours) {
      if (file.endsWith(".js")) text += await fs.readFile(path.join("src/socket", file), "utf8");
    }
    let known = 0;
    let total = 0;
    for (const entry of classes) {
      const missing = entry.fields.filter((field) => !new RegExp(`\\b${field.id}\\b`).test(text));
      total += entry.fields.length;
      known += entry.fields.length - missing.length;
      console.log(
        `${entry.class.padEnd(30)} ${String(entry.fields.length - missing.length).padStart(3)}/${String(entry.fields.length).padEnd(3)} handled` +
          (missing.length ? `   missing: ${missing.map((f) => `${f.id} ${f.name}`).join(", ")}` : "")
      );
    }
    console.log(`\n${known} of ${total} declared fields are named somewhere in src/socket.`);
    return;
  }

  console.log(`${classes.length} distributed classes, ${classes.reduce((n, c) => n + c.fields.length, 0)} fields\n`);
  for (const entry of classes) {
    console.log(`${entry.class}`);
    if (entry.generate.length) console.log(`  generate: ${entry.generate.join(" ")}`);
    for (const field of entry.fields) {
            console.log(
        `  ${String(field.id).padStart(4)}  ${field.name.padEnd(28)} ` +
          `${(field.direction === "both" ? "<->" : " ->").padEnd(4)}${describe(field.layout)}`
      );
    }
    console.log("");
  }
};

await main();
