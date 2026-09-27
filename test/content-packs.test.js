import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DR_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "dr-content-packs-"));

const packs = await import("../src/content-packs.js");
const { loadGameMaster } = await import("../src/gamemaster.js");
const { heroGenerate, heroOwnerGenerate, npcGenerate } = await import("../src/socket/objects.js");
const { config } = await import("../src/config.js");
const { register } = await import("../src/rpc.js");
const { routes } = await import("../src/routes.js");
const { loadAccount, saveAccount } = await import("../src/accounts.js");

const {
  buildRegistry,
  declare,
  declaredView,
  forgetDeclaration,
  frameFor,
  installContentPacks,
  jsonFor,
  keepPresentation,
  officialView,
  presentNpc,
  presentSkin,
  viewFromDemographics,
  viewFromKey,
} = packs;

/**
 * Content a client may not have, withheld from any client that does not say it
 * has it. The real client segfaults on a skin id its GameMaster lacks — tested:
 * `HeroGameObject.set_skinType` falls back to the hero's default by reading a
 * hero row the object does not have yet — so the unit under test is what each
 * client is told, not what the server holds.
 */

const KNIGHT = 990100;
const CLONE_VARIANT = 990101;
const DEFAULT_SAMURAI = 156;
const SAMURAI_CLONE = 3306;
const PACK = { packs: { knight: { version: 2, skins: ["TEST_KNIGHT"] } } };

/** The game's tables and one pack: a samurai skin and the clone it dresses. */
const packedGameMaster = async () => {
  const gm = await loadGameMaster();
  const samurai = gm.raw.Skins.find((row) => row.Id === DEFAULT_SAMURAI);
  const clone = gm.npcByConstant.get("GHOST_SAMURAI_CLONE");
  return {
    raw: {
      ...gm.raw,
      Skins: [...gm.raw.Skins, { ...samurai, Id: KNIGHT, Constant: "TEST_KNIGHT", SwfFilepath: "knight.swf" }],
      Npc: [
        ...gm.raw.Npc,
        { ...clone, Id: CLONE_VARIANT, Constant: "GHOST_SAMURAI_CLONE__TEST_KNIGHT", SwfFilepath: "knight.swf", Name: "Knight Clone" },
      ],
    },
  };
};

const withPack = async (t, config = PACK) => {
  t.after(() => installContentPacks(null));
  return installContentPacks(buildRegistry(await packedGameMaster(), config));
};

const hasU32 = (frame, value) => {
  for (let at = 0; at + 4 <= frame.length; at += 1) if (frame.readUInt32LE(at) === value) return true;
  return false;
};

// --- The registry --------------------------------------------------------------

test("a pack's skin stands in as its hero's default, and its summon variant as the base", async (t) => {
  const registry = await withPack(t);
  // A local GameMaster may carry packs of its own; only this one is judged here.
  assert.deepEqual(registry.problems.filter((problem) => problem.includes("TEST_KNIGHT")), []);
  assert.equal(registry.customSkins.get(KNIGHT).fallback, DEFAULT_SAMURAI);
  assert.equal(registry.customNpcs.get(CLONE_VARIANT).fallback, SAMURAI_CLONE);
  assert.equal(registry.customNpcs.get(CLONE_VARIANT).pack, "knight", "the variant belongs to its skin's pack");
});

test("what does not hold up is reported and left out", async () => {
  const gm = await packedGameMaster();
  const registry = buildRegistry(gm, {
    packs: {
      "bad name!": { skins: ["TEST_KNIGHT"] },
      ghosts: { version: 1, skins: ["NO_SUCH_SKIN", "DEFAULT_GHOST_SAMURAI", { constant: "TEST_KNIGHT", since: 3 }] },
    },
  });
  const said = registry.problems.join("\n");
  assert.match(said, /bad name!/);
  assert.match(said, /no Skins row NO_SUCH_SKIN/);
  assert.match(said, /DEFAULT_GHOST_SAMURAI is its hero's own default/);
  assert.match(said, /since 3 is outside versions 1\.\.1/);
  assert.equal(registry.customSkins.size, 0);
  assert.match(said, /GHOST_SAMURAI_CLONE__TEST_KNIGHT: TEST_KNIGHT is not a skin of any content pack/);
});

// --- Declarations ---------------------------------------------------------------

test("a client's Demographics declare its packs; an empty string declares nothing", () => {
  assert.equal(viewFromDemographics(""), null, "a door request says nothing about the client");
  assert.equal(viewFromDemographics(undefined), null);
  assert.equal(viewFromDemographics("not json"), null);
  assert.equal(viewFromDemographics("[1]"), null);
  assert.equal(viewFromDemographics("{}"), officialView(), "no packs is still a statement");
  assert.equal(viewFromDemographics({}), officialView(), "RPC params arrive already parsed");

  const view = viewFromDemographics('{"contentPacks":["Knight@2","junk","other@1","knight@1"]}');
  assert.equal(view.key, "knight@2,other@1", "names folded, the highest version kept, junk dropped");
  assert.equal(viewFromDemographics({ contentPacks: ["other@1", "knight@2"] }), view, "one shared view per declaration");
  assert.equal(viewFromKey(view.key), view);
  assert.equal(viewFromDemographics(`{"contentPacks":["x@1"],"pad":"${"x".repeat(5000)}"}`), null, "bounded");
});

test("a skin is withheld unless its pack is declared at its version", async (t) => {
  await withPack(t, { packs: { knight: { version: 2, skins: [{ constant: "TEST_KNIGHT", since: 2 }] } } });
  assert.equal(presentSkin(officialView(), KNIGHT), DEFAULT_SAMURAI);
  assert.equal(presentSkin(viewFromKey("knight@1"), KNIGHT), DEFAULT_SAMURAI, "an older install lacks it");
  assert.equal(presentSkin(viewFromKey("knight@2"), KNIGHT), KNIGHT);
  assert.equal(presentSkin(officialView(), DEFAULT_SAMURAI), DEFAULT_SAMURAI, "the game's own pass untouched");
  assert.equal(presentNpc(officialView(), CLONE_VARIANT), SAMURAI_CLONE);
  assert.equal(presentNpc(viewFromKey("knight@2"), CLONE_VARIANT), CLONE_VARIANT);
});

// --- Frames ---------------------------------------------------------------------

const HERO = {
  doid: 500,
  parent: 400,
  heroType: 106,
  skinType: KNIGHT,
  playerId: 7,
  screenName: "Knight",
  experiencePoints: 0,
  slotPoints: [0, 0, 0, 0],
  weapons: [],
  consumables: [],
  position: { x: 1, y: 2 },
};

test("a hero in a pack's skin is sent in its default to a client without the pack, owner included", async (t) => {
  await withPack(t);
  for (const build of [heroGenerate, heroOwnerGenerate]) {
    const frame = build(HERO);
    assert.ok(hasU32(frame, KNIGHT), "the frame itself is the real one");
    const plain = frameFor(frame, officialView());
    assert.ok(!hasU32(plain, KNIGHT) && hasU32(plain, DEFAULT_SAMURAI));
    assert.equal(frameFor(frame, viewFromKey("knight@2")), frame, "a client with the pack gets it as it is");
    assert.equal(frameFor(frame, officialView()), plain, "built once per view");
  }
  const official = heroGenerate({ ...HERO, skinType: DEFAULT_SAMURAI });
  assert.equal(official.forView, undefined, "the game's own skins take the fast path");
  assert.equal(frameFor(official, officialView()), official);
});

test("a summon variant is sent as the NPC it dresses, and a copy keeps that", async (t) => {
  await withPack(t);
  const frame = npcGenerate({ doid: 900, parent: 400, npcType: CLONE_VARIANT, position: { x: 0, y: 0 } });
  const plain = frameFor(frame, officialView());
  assert.ok(hasU32(plain, SAMURAI_CLONE) && !hasU32(plain, CLONE_VARIANT));

  const copy = keepPresentation(frame, Buffer.from(frame));
  assert.ok(hasU32(frameFor(copy, officialView()), SAMURAI_CLONE), "the late joiner's snapshot copy too");
});

test("with no packs installed nothing is touched", () => {
  installContentPacks(null);
  const frame = heroGenerate(HERO);
  assert.equal(frameFor(frame, officialView()), frame);
  assert.equal(jsonFor({ active_skin: KNIGHT }, officialView()), JSON.stringify({ active_skin: KNIGHT }));
});

// --- HTTP ----------------------------------------------------------------------

const rpcRoute = routes.find((route) => route.pattern === "/rpc/:service/:method");
const detailsRoute = routes.find((route) => route.pattern === "/api/dbAccountInfo/accountdetails");
const ME = 1000300001;

const call = async (service, method, params) => {
  const reply = await rpcRoute.handler(
    { headers: { "x-account-id": String(ME) }, json: { id: 1, params } },
    [service, method]
  );
  return JSON.parse(reply.body).result;
};

test("getFriendData declares the client's packs, and every list after it is answered in them", async (t) => {
  await withPack(t);
  const previous = config.authEnabled;
  config.authEnabled = false;
  t.after(() => {
    config.authEnabled = previous;
    forgetDeclaration(ME);
  });
  register("leaderboard/getFriendData", () => [{ account_id: 2, active_skin: KNIGHT }]);
  register("friendrequests/DRFriendRequestPending", () => [{ account_id: 3, active_skin: KNIGHT }]);

  forgetDeclaration(ME);
  assert.equal((await call("friendrequests", "DRFriendRequestPending", [ME]))[0].active_skin, DEFAULT_SAMURAI,
    "asked before any declaration: the game's own skin");

  const withKnight = await call("leaderboard", "getFriendData", [ME, { contentPacks: ["knight@2"] }, "token"]);
  assert.equal(withKnight[0].active_skin, KNIGHT, "the declaring call is answered in its own terms");
  assert.equal(declaredView(ME).key, "knight@2");
  assert.equal((await call("friendrequests", "DRFriendRequestPending", [ME]))[0].active_skin, KNIGHT);

  const without = await call("leaderboard", "getFriendData", [ME, {}, "token"]);
  assert.equal(without[0].active_skin, DEFAULT_SAMURAI, "a client with no pack says so and is believed");
});

test("the account's own skin reaches a client without the pack as its hero's default", async (t) => {
  await withPack(t);
  const previous = config.authEnabled;
  config.authEnabled = false;
  t.after(() => {
    config.authEnabled = previous;
    forgetDeclaration(ME);
  });
  const account = await loadAccount(ME);
  account.account_avatars[0].skin_type = KNIGHT;
  account.account_skins = [{ id: 1, account_id: ME, skin_type: KNIGHT }];
  await saveAccount(account);

  const plain = JSON.parse((await detailsRoute.handler({ headers: { "x-account-id": String(ME) } })).body);
  assert.equal(plain.account_avatars[0].skin_type, DEFAULT_SAMURAI);
  assert.equal(plain.account_skins[0].skin_type, DEFAULT_SAMURAI);
  assert.equal((await loadAccount(ME)).account_avatars[0].skin_type, KNIGHT, "only the answer changes");

  declare(ME, viewFromKey("knight@2"));
  const packed = JSON.parse((await detailsRoute.handler({ headers: { "x-account-id": String(ME) } })).body);
  assert.equal(packed.account_avatars[0].skin_type, KNIGHT);
});

// --- The socket -----------------------------------------------------------------

test("an entry request's Demographics declare the client's packs; a door's empty one keeps them", async (t) => {
  const { handleField, FLID } = await import("../src/socket/matchmaker.js");
  const { PacketReader, PacketWriter } = await import("../src/socket/packet.js");
  const previous = config.dungeonsEnabled;
  config.dungeonsEnabled = false; // answered before any match is built
  t.after(() => {
    config.dungeonsEnabled = previous;
    forgetDeclaration(ME);
  });
  const session = { id: 1, accountId: ME, matchMakerDoid: 11, send: () => true };
  const entry = (demographics) =>
    new PacketReader(new PacketWriter().utf(demographics).u32(0).u32(50002).u32(0).u32(0).u8(0).utf("").body());

  handleField(session, FLID.ClientRequestEntry, entry('{"contentPacks":["knight@2"]}'));
  assert.equal(session.contentView.key, "knight@2");
  assert.equal(declaredView(ME).key, "knight@2", "and HTTP answers in it from now on");

  handleField(session, FLID.ClientRequestEntry, entry(""));
  assert.equal(session.contentView.key, "knight@2", "the server's own door request says nothing");

  handleField(session, FLID.ClientRequestEntry, entry("{}"));
  assert.equal(session.contentView, officialView());
  assert.equal(declaredView(ME), officialView());
});

// --- Across launches --------------------------------------------------------------

/**
 * A launching client asks for its own account before anything it sends says
 * what it has — and a client without the pack does not survive its own hero in
 * the pack's skin either (tested). So the account's last declaration answers
 * that first question, and the launch has to confirm it.
 */
test("an account's own details go out in its last declaration, confirmed by the launch", async (t) => {
  await withPack(t);
  t.after(() => forgetDeclaration(ME));
  const { viewForOwnAccount } = packs;

  declare(ME, viewFromKey("knight@2"));
  assert.equal(viewForOwnAccount(ME).key, "knight@2", "a launch starts from what was said last time");
  declare(ME, viewFromKey("knight@2")); // the launch's own daily-reward request
  assert.equal(viewForOwnAccount(ME).key, "knight@2", "and the next launch too, once this one confirmed it");

  assert.equal(viewForOwnAccount(ME, { connected: true }).key, "knight@2", "a refresh inside a running client");
  assert.equal(viewForOwnAccount(ME, { connected: true }).key, "knight@2", "is not a new launch");

  // This launch never confirms: the client died of the guess.
  assert.equal(viewForOwnAccount(ME).key, "", "the launch after it gets the game's own content");
  assert.equal(declaredView(ME), officialView(), "and nothing is guessed until it declares again");
  assert.equal(viewForOwnAccount(ME).key, "");
});

test("declarations survive a restart", async (t) => {
  const { keepDeclarationsIn } = packs;
  const file = path.join(process.env.DR_DATA_DIR, "declarations.json");
  t.after(() => keepDeclarationsIn(null));
  keepDeclarationsIn(file);
  declare(ME, viewFromKey("knight@2"));
  declare(ME + 1, officialView());

  keepDeclarationsIn(file);
  assert.equal(declaredView(ME).key, "knight@2");
  assert.equal(declaredView(ME + 1), officialView());
  forgetDeclaration(ME);
  keepDeclarationsIn(file);
  assert.equal(declaredView(ME), officialView(), "and forgetting is kept too");
});

test("the daily reward question declares, a moment after login", async (t) => {
  await withPack(t);
  const previous = config.authEnabled;
  config.authEnabled = false;
  t.after(() => {
    config.authEnabled = previous;
    forgetDeclaration(ME);
  });
  register("store/AskAboutDailyReward", () => ({}));
  forgetDeclaration(ME);
  await call("store", "AskAboutDailyReward", [ME, "token", { contentPacks: ["knight@2"] }]);
  assert.equal(declaredView(ME).key, "knight@2");
});
