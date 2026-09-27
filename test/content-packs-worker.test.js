import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Content packs through a real match worker: the account's view crosses to the
 * thread with the member, and the frames the worker builds reach each client in
 * that client's terms.
 *
 * An official skin stands in for a pack's here — BRAVEHEART_BERSERKER — so the
 * test does not depend on a deployment's own content.
 */
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dr-content-packs-worker-"));
process.env.ODS_DATA_DIR = dir;
process.env.ODS_CONTENT_PACKS = path.join(dir, "content-packs.json");
await fs.writeFile(
  process.env.ODS_CONTENT_PACKS,
  JSON.stringify({ packs: { bravescar: { version: 1, skins: ["BRAVEHEART_BERSERKER"] } } })
);

const { MatchWorkerPool, installWorkerPool } = await import("../src/socket/match-worker-pool.js");
const { installMatchExecutor, matchExecutor } = await import("../src/socket/match-runtime.js");
const { dungeonMatches } = await import("../src/socket/matches.js");
const { MemberSession } = await import("../src/socket/member-session.js");
const { PacketWriter } = await import("../src/socket/packet.js");
const { CLID, OP } = await import("../src/socket/opcodes.js");
const { buildEntryResponse } = await import("../src/socket/matchmaker.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");
const { readyContentPacks, viewFromKey } = await import("../src/content-packs.js");
const { decodeGenerate } = await import("../tools/wire.js");

const MAP_NODE = 50002;
const MATCHMAKER_DOID = 11;
const BRAVESCAR = 161;
const DEFAULT_BERSERKER = 151;

await readyContentPacks({ quiet: true });
const pool = new MatchWorkerPool({ size: 1, loadReportMs: 0 });
const restore = installWorkerPool(pool, { installExecutor: installMatchExecutor });
await pool.ready;
test.after(async () => {
  await pool.close();
  restore();
});

let nextSessionId = 1;
const connect = (accountId, view) => {
  const sent = [];
  const session = new MemberSession({
    id: nextSessionId++,
    accountId,
    authenticated: true,
    matchMakerDoid: MATCHMAKER_DOID,
    presenceDoid: 12,
    objects: new Map(),
    actors: new Map(),
    closed: false,
    send: (frame) => {
      sent.push(Buffer.from(frame));
      return true;
    },
  });
  // What the main thread records from the entry request's Demographics.
  session.contentView = view;
  session.close = () => {
    session.closed = true;
    matchExecutor.leave(session);
  };
  return { session, sent };
};

const waitFor = async (check, what, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const field = (doid, fieldId) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD).u32(doid).u16(fieldId).frame().subarray(2);

const ownerCreate = (sent, clid) =>
  sent.find(
    (frame) =>
      frame.readUInt16LE(2) === OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP && frame.readUInt16LE(4) === clid
  );

/** Enters the tutorial wearing the stand-in pack skin; returns the skin its own hero arrived in. */
const ownHeroSkin = async (accountId, view) => {
  const account = await loadAccount(accountId);
  account.account_avatars[0].avatar_id = 101;
  account.account_avatars[0].skin_type = BRAVESCAR;
  account.account_skins = [{ id: accountId, account_id: accountId, skin_type: BRAVESCAR }];
  await saveAccount(account);

  const { session, sent } = connect(accountId, view);
  const result = dungeonMatches.reserve({ session, mapNodeId: MAP_NODE, friendOnly: true, group: "" });
  const joined = matchExecutor.join(session, result, { mapNodeId: MAP_NODE }, {
    onPlayerReady: () => session.send(buildEntryResponse(MATCHMAKER_DOID, 0, MAP_NODE)),
  });
  const player = await waitFor(() => ownerCreate(sent, CLID.PlayerGameObject), "the owner player");
  matchExecutor.forward(session, field(player.readUInt32LE(6), 185));
  matchExecutor.forward(session, field(player.readUInt32LE(6), 184));
  await joined;
  const hero = await waitFor(() => ownerCreate(sent, CLID.HeroGameObject), "the owner hero");
  await matchExecutor.leave(session, { notifyClient: true });
  return decodeGenerate(hero.subarray(2)).fields.skinType;
};

test("a client that declared nothing gets its own pack-skinned hero in the hero's default", async () => {
  assert.equal(await ownHeroSkin(1000400001, viewFromKey("")), DEFAULT_BERSERKER);
});

test("a client that declared the pack gets the skin it is wearing", async () => {
  assert.equal(await ownHeroSkin(1000400002, viewFromKey("bravescar@1")), BRAVESCAR);
});
