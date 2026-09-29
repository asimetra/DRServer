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

test("configured pack names use the same case-folding as client declarations", async (t) => {
  const registry = await withPack(t, {
    packs: { Knight: { version: 2, skins: ["TEST_KNIGHT"] } },
  });
  assert.deepEqual(registry.problems.filter((problem) => problem.includes("TEST_KNIGHT")), []);
  assert.equal(registry.customSkins.get(KNIGHT).pack, "knight");
  assert.equal(presentSkin(viewFromKey("Knight@2"), KNIGHT), KNIGHT);
});

test("pack versions are limited to what a client can declare", async () => {
  const registry = buildRegistry(await packedGameMaster(), {
    packs: { knight: { version: 1_000_000, skins: ["TEST_KNIGHT"] } },
  });
  assert.match(registry.problems.join("\n"), /version.*1\.\.999999/i);
  assert.equal(registry.customSkins.has(KNIGHT), false);
});

test("pack names cannot collide after case-folding", async () => {
  const registry = buildRegistry(await packedGameMaster(), {
    packs: {
      Knight: { version: 1, skins: ["TEST_KNIGHT"] },
      knight: { version: 2, skins: ["TEST_KNIGHT"] },
    },
  });
  assert.match(registry.problems.join("\n"), /duplicates "knight" after case-folding/);
  assert.equal(registry.packs.get("knight"), 1, "the first unambiguous definition wins");
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

// --- A skin's own attacks ----------------------------------------------------------

/**
 * The client picks an attack's effects by attack alone, and its attacks from
 * the weapon it is told a hero holds. So a skin gets its own effects through a
 * variant of the weapon that swings variants of the attacks, each playing
 * exactly like its base.
 */
const KATANA = 12501;
const KATANA_VARIANT = 990201;
const COMBO = 902501; // KATANA_COMBO_1
const COMBO_VARIANT = 990202;

/**
 * The variant's timeline: the base's, with its own effect and nothing else —
 * unless a test changes it. `null` leaves it out altogether.
 */
const variantTimeline = async (change = (timeline) => timeline) => {
  const { timelines } = await loadGameMaster();
  const base = structuredClone(timelines.get("TM_KATANA_COMBO_1"));
  for (const frame of base.frames) {
    for (const action of frame.actions) {
      if (action.type === "attackEffect") action.name = "db_fx_pyro_fireball_hit";
    }
  }
  return change({ ...base, attackName: "TM_KATANA_COMBO_1__TEST_KNIGHT" });
};

const armedGameMaster = async ({ attack = {}, weapon = {}, aesthetics = true, timeline } = {}) => {
  const gm = await packedGameMaster();
  const { timelines } = await loadGameMaster();
  const mine = timeline === null ? null : await variantTimeline(timeline);
  const katana = gm.raw.WeaponItem.find((row) => row.Id === KATANA);
  const combo = gm.raw.Attack.find((row) => row.Id === COMBO);
  const looks = gm.raw.WeaponAesthetics.filter((row) => row.WeaponItemConstant === "HERO_LIGHT_KATANA");
  return {
    timelines: new Map([
      ...timelines,
      ...(mine ? [[mine.attackName, mine]] : []),
    ]),
    raw: {
      ...gm.raw,
      Attack: [
        ...gm.raw.Attack,
        {
          ...combo,
          Id: COMBO_VARIANT,
          Constant: "KATANA_COMBO_1__TEST_KNIGHT",
          AttackTimeline: "TM_KATANA_COMBO_1__TEST_KNIGHT",
          HitEffect: "db_fx_pyro_fireball_hit",
          ...attack,
        },
      ],
      WeaponItem: [
        ...gm.raw.WeaponItem,
        {
          ...katana,
          Id: KATANA_VARIANT,
          Constant: "HERO_LIGHT_KATANA__TEST_KNIGHT",
          Attack1: "KATANA_COMBO_1__TEST_KNIGHT",
          Attack3: "KATANA_COMBO_1__TEST_KNIGHT",
          ...weapon,
        },
      ],
      WeaponAesthetics: [
        ...gm.raw.WeaponAesthetics,
        ...(aesthetics ? looks.map((row) => ({ ...row, WeaponItemConstant: "HERO_LIGHT_KATANA__TEST_KNIGHT" })) : []),
      ],
    },
  };
};

const withArms = async (t, changes) => {
  t.after(() => installContentPacks(null));
  return installContentPacks(buildRegistry(await armedGameMaster(changes), PACK));
};

test("a skin's weapon and attack variants are accepted when they only look different", async (t) => {
  const registry = await withArms(t);
  assert.deepEqual(registry.problems.filter((problem) => problem.includes("TEST_KNIGHT")), []);
  const { presentWeapon, presentAttack, baseAttackOf } = packs;
  assert.equal(presentWeapon(viewFromKey("knight@2"), KNIGHT, KATANA), KATANA_VARIANT);
  assert.equal(presentWeapon(officialView(), KNIGHT, KATANA), KATANA);
  assert.equal(presentWeapon(viewFromKey("knight@2"), DEFAULT_SAMURAI, KATANA), KATANA, "only for the skin it dresses");
  assert.equal(presentAttack(viewFromKey("knight@2"), KNIGHT, COMBO), COMBO_VARIANT);
  assert.equal(presentAttack(officialView(), KNIGHT, COMBO), COMBO);
  assert.equal(baseAttackOf(COMBO_VARIANT), COMBO);
  assert.equal(baseAttackOf(COMBO), COMBO);
});

test("a variant that plays differently, swings the wrong attack or has no look is refused", async () => {
  const stronger = buildRegistry(await armedGameMaster({ attack: { DamageMod: 5 } }), PACK);
  assert.ok(stronger.problems.some((problem) => /KATANA_COMBO_1__TEST_KNIGHT: plays differently .*DamageMod/.test(problem)));
  assert.ok(
    stronger.problems.some((problem) => /HERO_LIGHT_KATANA__TEST_KNIGHT: Attack1 is KATANA_COMBO_1__TEST_KNIGHT/.test(problem)),
    "and the weapon swinging it goes with it"
  );

  const wrong = buildRegistry(await armedGameMaster({ weapon: { Attack2: "KATANA_SHADOW_SLASH" } }), PACK);
  assert.ok(wrong.problems.some((problem) => /Attack2 is KATANA_SHADOW_SLASH/.test(problem)));

  const bare = buildRegistry(await armedGameMaster({ aesthetics: false }), PACK);
  assert.ok(bare.problems.some((problem) => /has 0 WeaponAesthetics rows/.test(problem)));
  assert.equal(bare.customWeapons.size, 0);
});

test("an attack variant's timeline may change its look but not what it hits", async () => {
  /**
   * The column was allowed wholesale, and a hero's hits are the client's own
   * proposals: a variant timeline with a bigger collider would have hit what
   * the base cannot and still been accepted as cosmetic.
   */
  const wider = buildRegistry(
    await armedGameMaster({
      timeline: (timeline) => {
        for (const frame of timeline.frames) {
          for (const action of frame.actions) if (action.type === "rectangleCollider") action.halfWidth *= 2;
        }
        return timeline;
      },
    }),
    PACK
  );
  assert.ok(wider.problems.some((problem) => /TM_KATANA_COMBO_1__TEST_KNIGHT plays differently/.test(problem)));
  assert.equal(wider.customAttacks.size, 0);

  const slower = buildRegistry(
    await armedGameMaster({ timeline: (timeline) => ({ ...timeline, totalFrames: timeline.totalFrames + 6 }) }),
    PACK
  );
  assert.ok(slower.problems.some((problem) => /plays differently/.test(problem)), "timing is gameplay too");

  const missing = buildRegistry(await armedGameMaster({ timeline: null }), PACK);
  assert.ok(missing.problems.some((problem) => /not one the server has/.test(problem)));
  assert.equal(missing.customAttacks.size, 0);
});

test("a hero in the skin is shown holding the skin's weapon to a viewer with the pack", async (t) => {
  await withArms(t);
  const { decodeGenerate } = await import("../tools/wire.js");
  const armed = { ...HERO, weapons: [{ type: KATANA, power: 10, requiredlevel: 10, rarity: 4 }] };
  const weaponOf = (frame) => decodeGenerate(frame.subarray(2)).fields.weaponDetails[0][0];
  const frame = heroGenerate(armed);
  assert.equal(weaponOf(frameFor(frame, viewFromKey("knight@2"))), KATANA_VARIANT);
  assert.equal(weaponOf(frameFor(frame, officialView())), KATANA);
  assert.equal(weaponOf(frame), KATANA, "the game itself holds the base");
});

test("an attack is read as its base and relayed to each peer in its own terms", async (t) => {
  await withArms(t);
  const { withBaseAttack } = await import("../src/socket/combat.js");
  const { remoteAttackChoreography, CHOREOGRAPHY_ATTACK_AT } = await import("../src/socket/buster.js");
  const proposed = Buffer.alloc(16);
  proposed.writeUInt32LE(COMBO_VARIANT, CHOREOGRAPHY_ATTACK_AT);
  const base = withBaseAttack(proposed, CHOREOGRAPHY_ATTACK_AT);
  assert.equal(base.readUInt32LE(CHOREOGRAPHY_ATTACK_AT), COMBO, "the server hears the base");
  assert.equal(proposed.readUInt32LE(CHOREOGRAPHY_ATTACK_AT), COMBO_VARIANT, "without changing what it was given");

  const relayed = remoteAttackChoreography(500, base, KNIGHT);
  assert.ok(hasU32(frameFor(relayed, viewFromKey("knight@2")), COMBO_VARIANT));
  assert.ok(hasU32(frameFor(relayed, officialView()), COMBO) && !hasU32(frameFor(relayed, officialView()), COMBO_VARIANT));
  assert.equal(remoteAttackChoreography(500, base, DEFAULT_SAMURAI).forView, undefined, "other skins take the fast path");
});

test("a pack's timeline file adds timelines but never replaces one the game ships", async (t) => {
  const official = (await loadGameMaster()).timelines.get("TM_SWORD_COMBO_1");
  assert.ok(official, "the probe needs a shipped timeline");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pack-timelines-"));
  await fs.mkdir(path.join(root, "Resources", "Combat"), { recursive: true });
  await fs.writeFile(
    path.join(root, "Resources", "Combat", "AttackTimeline.json"),
    JSON.stringify({
      attacks: [
        { ...official, totalFrames: 999 },
        { ...official, attackName: "TM_SWORD_COMBO_1__knight" },
      ],
    })
  );
  const previous = config.contentDir;
  config.contentDir = root;
  t.after(async () => {
    config.contentDir = previous;
    await fs.rm(root, { recursive: true, force: true });
  });

  // A copy of the module of its own: the shared one keeps the GameMaster it loaded first.
  const fresh = await import("../src/gamemaster.js?pack-timelines");
  const { timelines } = await fresh.loadGameMaster();
  assert.equal(timelines.get("TM_SWORD_COMBO_1").totalFrames, official.totalFrames, "the shipped one stands");
  assert.equal(timelines.get("TM_SWORD_COMBO_1__knight").totalFrames, official.totalFrames, "a new name is added");
});
