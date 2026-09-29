import fs from "node:fs";
import { config } from "./config.js";
import { loadGameMaster } from "./gamemaster.js";
import { info, warn } from "./log.js";

/**
 * Content packs: skins and summons a player only has if they installed them.
 *
 * A pack is rows in the client's own GameMaster plus bundles in its `lib/`. A
 * client without the rows segfaults the moment it is told about one: tested
 * with the real client, a hero generated with a skin id its GameMaster lacks
 * dies in `HeroGameObject.set_skinType`, whose own fall-back to the default
 * skin reads the hero row before the object has one. A client with the rows but
 * not the bundles does not crash; the loads fail through `handleIOError`.
 *
 * So the rule is the one Minecraft's Polymer and Forge follow: a client says
 * what it has, and is sent nothing else. The saying is the `Demographics`
 * object of the client's `DbConfiguration/Config.json`, which the client
 * forwards unread on every dungeon entry request (`MatchMaker.hx:81`) and on
 * `leaderboard/getFriendData` (`DBAccountInfo.hx:504`) — no client change. A
 * pack's installer writes, alongside its rows and bundles,
 *
 *   "Demographics": { "contentPacks": ["knight@1"] }
 *
 * and a client that says nothing is sent only the game's own ids. Everything a
 * pack adds is replaced on the way out by what the game already had: a skin by
 * its hero's default, a summon's `<npc>__<skin>` variant by the `<npc>` it
 * dresses. The game state itself never changes; only what each client is told.
 *
 * A declaration is believed, not checked. Declaring a pack you do not have
 * crashes nobody but yourself.
 */

/**
 * Columns a variant may change, per table: what it looks like and sounds like,
 * never what it does. A summon's body and icons; an attack's timeline (whose
 * gameplay frames the server keeps from the base — see `baseAttackOf`), its
 * trail, hit effect and sounds; a weapon's names and help text, and which
 * attacks it swings, which are checked on their own.
 */
const SHARED_LOOKS = ["Id", "Constant", "Name", "Description"];
const LOOKS = {
  Npc: new Set([
    ...SHARED_LOOKS,
    "AssetClassName",
    "SwfFilepath",
    "HDSwfFilepath",
    "IconSwfFilepath",
    "IconName",
    "PortraitName",
    "CardName",
    "UISwfFilepath",
  ]),
  Attack: new Set([
    ...SHARED_LOOKS,
    "AttackTimeline",
    "SwordTrail",
    "SwordTrailSize",
    "TrailTint",
    "TrailSaturation",
    "HitEffect",
    "HitEffectFilepath",
    "HitEffectNoRotation",
    "AttackVol",
    "AttackSound",
    "ImpactVol",
    "ImpactSound",
    "IconName",
    "IconFilepath",
  ]),
  WeaponItem: new Set([
    ...SHARED_LOOKS,
    "TapIcon",
    "TapTitle",
    "TapDescription",
    "HoldIcon",
    "HoldTitle",
    "HoldDescription",
    "SpeedDisplay",
  ]),
};

/** The columns of a weapon that name the attacks it swings. */
const WEAPON_ATTACKS = ["HoldingAttack", "ChargeAttack", ...Array.from({ length: 9 }, (_, i) => `Attack${i + 1}`)];

const PACK_NAME = /^[a-z0-9_-]{1,32}$/i;
const DECLARED_PACK = /^([a-z0-9_-]{1,32})@(\d{1,6})$/i;
const MAX_PACK_VERSION = 999_999;
/** Bounds on what a client may declare, so a padded config costs nothing. */
const MAX_DECLARATION_LENGTH = 4096;
const MAX_DECLARED_PACKS = 16;
const MAX_SHARED_VIEWS = 1024;

// --- The registry ------------------------------------------------------------

const EMPTY = Object.freeze({
  customSkins: new Map(),
  customNpcs: new Map(),
  variants: new Map(),
  customAttacks: new Map(),
  attackVariants: new Map(),
  skinsWithAttacks: new Set(),
  customWeapons: new Map(),
  weaponVariants: new Map(),
  packs: new Map(),
});

let registry = EMPTY;

const sameGameplay = (variant, base, looks, ignore = new Set()) => {
  for (const key of new Set([...Object.keys(variant), ...Object.keys(base)])) {
    if (looks.has(key) || ignore.has(key)) continue;
    if (JSON.stringify(variant[key]) !== JSON.stringify(base[key])) return key;
  }
  return null;
};

/** Why a variant is refused for how it plays, or null. A weapon's attacks are checked apart. */
const playsDifferently = (table, row, base) => {
  const ignore = new Set(table === "WeaponItem" ? WEAPON_ATTACKS : []);
  const differs = sameGameplay(row, base, LOOKS[table], ignore);
  return differs ? `plays differently from ${base.Constant} (${differs}), so it is never used` : null;
};

/**
 * What a timeline does, with what it only shows left out.
 *
 * An attack variant's timeline is allowed its own look and nothing else. The
 * server keeps the base's gameplay (`baseAttackOf`), but a hero's hits arrive
 * as the client's own proposals, judged by who cast and how far — not by
 * whether the base's collider could have reached. So a timeline with a wider,
 * earlier or extra collider would hit what the base cannot, while passing a
 * check that ignored the column. Compared frame by frame; a `#` action is
 * switched off in the data and does nothing.
 */
const TIMELINE_LOOKS = new Set([
  "playAnim",
  "animFrame",
  "attackEffect",
  "effect",
  "attackSound",
  "sound",
  "shake",
  "color",
  "fadebackground",
  "zoom",
  "visible",
  "hideSpecialEffect",
]);
/** A projectile's flight is gameplay; what it is drawn with is not. */
const PROJECTILE_LOOKS = new Set(["attackEffectPath", "attackEffectName", "attackEffectOffset", "attackEffectTimeOffset", "layer"]);

const sortedJson = (value) =>
  JSON.stringify(value, (key, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.keys(inner).sort().map((name) => [name, inner[name]]))
      : inner
  );

const timelinePlay = (timeline) =>
  sortedJson({
    totalFrames: timeline.totalFrames,
    choreographed: timeline.choreographed,
    actions: (timeline.frames ?? []).flatMap((frame) =>
      (frame.actions ?? [])
        .filter((action) => !String(action.type).startsWith("#") && !TIMELINE_LOOKS.has(action.type))
        .map((action) => [
          frame.frame,
          action.type === "projectile"
            ? Object.fromEntries(Object.entries(action).filter(([name]) => !PROJECTILE_LOOKS.has(name)))
            : action,
        ])
    ),
  });

/** Why a variant's timeline cannot stand in for its base's, or null if it can. */
const timelineRefusal = (timelines, variant, base) => {
  if ((variant ?? "") === (base ?? "")) return null;
  const mine = timelines?.get(variant);
  const theirs = timelines?.get(base);
  if (!mine) return `its timeline ${variant} is not one the server has, so what it hits cannot be checked`;
  if (!theirs) return `its base's timeline ${base} is not one the server has`;
  return timelinePlay(mine) === timelinePlay(theirs) ? null : `its timeline ${variant} plays differently from ${base}`;
};

/** `<base>__<skin>` split, or null for a row that is not a variant. */
const variantName = (constant) => {
  const at = String(constant ?? "").indexOf("__");
  return at > 0 ? { base: constant.slice(0, at), skin: constant.slice(at + 2) } : null;
};

const packEntries = (pack) =>
  (Array.isArray(pack?.skins) ? pack.skins : []).map((entry) =>
    typeof entry === "string" ? { constant: entry, since: 1 } : { constant: entry?.constant, since: Number(entry?.since ?? 1) }
  );

/**
 * What the packs add, and what each addition becomes for a client without it.
 *
 * `gm` needs `raw.Skins`, `raw.Npc` and `raw.Hero`. Anything that does not hold
 * up is left out and reported in `problems`: a skin whose hero has no default
 * has nothing to stand in for it, and a variant that plays differently from its
 * base would be one monster to one client and another to the next.
 */
export const buildRegistry = (gm, packsConfig = {}) => {
  const skinsByConstant = new Map((gm?.raw?.Skins ?? []).map((row) => [row.Constant, row]));
  const heroesByConstant = new Map((gm?.raw?.Hero ?? []).map((row) => [row.Constant, row]));
  const npcsByConstant = new Map((gm?.raw?.Npc ?? []).map((row) => [row.Constant, row]));
  const customSkins = new Map();
  const skinPackByConstant = new Map();
  const packs = new Map();
  const problems = [];

  for (const [name, pack] of Object.entries(packsConfig?.packs ?? {})) {
    const version = Number(pack?.version ?? 1);
    const canonicalName = name.toLowerCase();
    if (!PACK_NAME.test(name) || !Number.isSafeInteger(version) || version < 1 || version > MAX_PACK_VERSION) {
      problems.push(`pack "${name}": needs a name of letters, digits, _ or - and a whole version from 1..${MAX_PACK_VERSION}`);
      continue;
    }
    if (packs.has(canonicalName)) {
      problems.push(`pack "${name}": duplicates "${canonicalName}" after case-folding`);
      continue;
    }
    packs.set(canonicalName, version);
    for (const { constant, since } of packEntries(pack)) {
      const skin = skinsByConstant.get(constant);
      const hero = heroesByConstant.get(skin?.ForHero);
      const fallback = skinsByConstant.get(hero?.DefaultSkin);
      if (!skin) problems.push(`pack "${name}": no Skins row ${constant}`);
      else if (!fallback) problems.push(`pack "${name}": ${constant} has no hero default to stand in for it`);
      else if (!Number.isSafeInteger(since) || since < 1 || since > version) {
        problems.push(`pack "${name}": ${constant} since ${since} is outside versions 1..${version}`);
      } else if (fallback.Id === skin.Id) {
        problems.push(`pack "${name}": ${constant} is its hero's own default and cannot be withheld`);
      } else {
        const entry = { pack: canonicalName, since, fallback: Number(fallback.Id), constant };
        customSkins.set(Number(skin.Id), entry);
        skinPackByConstant.set(constant, entry);
      }
    }
  }

  /**
   * Every `<base>__<skin>` row of one table that holds up, as
   * `{ row, base, skin }`. `check` may refuse a row for its own reasons.
   */
  const variantsOf = (table, check = () => null) => {
    const rows = gm?.raw?.[table] ?? [];
    const byConstant = new Map(rows.map((row) => [row.Constant, row]));
    const accepted = [];
    for (const row of rows) {
      const name = variantName(row.Constant);
      if (!name) continue;
      const base = byConstant.get(name.base);
      const skin = skinPackByConstant.get(name.skin);
      const refusal = !base
        ? `no ${table} row ${name.base} to dress`
        : !skin
          ? `${name.skin} is not a skin of any content pack, so it is never used`
          : check(row, base, name) ?? playsDifferently(table, row, base);
      if (refusal) {
        problems.push(`${row.Constant}: ${refusal}`);
        continue;
      }
      accepted.push({ row, base, skin: { ...skin, id: Number(skinsByConstant.get(name.skin).Id) } });
    }
    return accepted;
  };

  const customNpcs = new Map();
  const variants = new Map();
  for (const { row, base, skin } of variantsOf("Npc")) {
    customNpcs.set(Number(row.Id), { pack: skin.pack, since: skin.since, fallback: Number(base.Id) });
    variants.set(`${base.Constant}|${skin.id}`, row.Constant);
  }

  const customAttacks = new Map();
  const attackVariants = new Map();
  const attackVariantByConstant = new Map();
  const skinsWithAttacks = new Set();
  for (const { row, base, skin } of variantsOf("Attack", (row, base) =>
    timelineRefusal(gm?.timelines, row.AttackTimeline, base.AttackTimeline)
  )) {
    customAttacks.set(Number(row.Id), { pack: skin.pack, since: skin.since, fallback: Number(base.Id) });
    attackVariants.set(`${base.Id}|${skin.id}`, Number(row.Id));
    attackVariantByConstant.set(row.Constant, row);
    skinsWithAttacks.add(skin.id);
  }

  /**
   * A weapon variant swings its base's attacks or their variants for the same
   * skin, attack for attack, and comes with its own look for every look its
   * base has — the client reads a weapon's model from those rows and has
   * nothing to draw without one.
   */
  const aestheticsFor = (constant) =>
    (gm?.raw?.WeaponAesthetics ?? []).filter((row) => row.WeaponItemConstant === constant).length;
  const customWeapons = new Map();
  const weaponVariants = new Map();
  for (const { row, base, skin } of variantsOf("WeaponItem", (row, base, name) => {
    for (const column of WEAPON_ATTACKS) {
      const swung = row[column];
      if (swung === base[column]) continue;
      if (swung !== `${base[column]}__${name.skin}` || !attackVariantByConstant.has(swung)) {
        return `${column} is ${swung}, neither ${base[column]} nor its accepted ${name.skin} variant`;
      }
    }
    if (aestheticsFor(row.Constant) < aestheticsFor(base.Constant)) {
      return `has ${aestheticsFor(row.Constant)} WeaponAesthetics rows where ${base.Constant} has ${aestheticsFor(base.Constant)}`;
    }
    return null;
  })) {
    customWeapons.set(Number(row.Id), { pack: skin.pack, since: skin.since, fallback: Number(base.Id) });
    weaponVariants.set(`${base.Id}|${skin.id}`, Number(row.Id));
  }

  return {
    customSkins,
    customNpcs,
    variants,
    customAttacks,
    attackVariants,
    skinsWithAttacks,
    customWeapons,
    weaponVariants,
    packs,
    problems,
  };
};

/** Installs a registry for this thread. Tests pass one; servers call `readyContentPacks`. */
export const installContentPacks = (next) => {
  registry = next ?? EMPTY;
  return registry;
};

const readPacksConfig = (file) => {
  if (!file || !fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
};

/**
 * Reads the packs and checks them against the GameMaster, once per thread. No
 * file is no packs, and then every function here returns what it is given.
 */
export const readyContentPacks = async ({ file = config.contentPacksFile, quiet = false } = {}) => {
  let packsConfig;
  try {
    packsConfig = readPacksConfig(file);
  } catch (problem) {
    warn(`content packs: could not read ${file} — ${problem.message}; serving the game's own content only`);
    return installContentPacks(EMPTY);
  }
  const built = buildRegistry(await loadGameMaster(), packsConfig);
  if (!quiet) {
    for (const problem of built.problems) warn(`content packs: ${problem}`);
    if (built.packs.size) {
      const summary = [...built.packs].map(([name, version]) => `${name}@${version}`).join(", ");
      info(
        `content packs: ${summary} — ${built.customSkins.size} skin(s), ` +
          `${built.customNpcs.size} summon, ${built.customWeapons.size} weapon and ` +
          `${built.customAttacks.size} attack variant(s) withheld from clients that do not declare them`
      );
    }
  }
  return installContentPacks(built);
};

// --- What a client said it has ------------------------------------------------

const OFFICIAL = Object.freeze({ key: "", packs: new Map() });
const views = new Map([["", OFFICIAL]]);

/** One frozen view per distinct declaration, shared by every session making it. */
export const viewFromKey = (key) => {
  const text = String(key ?? "");
  const known = views.get(text);
  if (known) return known;
  const packs = new Map();
  for (const part of text.split(",")) {
    const match = DECLARED_PACK.exec(part);
    if (match) packs.set(match[1].toLowerCase(), Math.max(packs.get(match[1].toLowerCase()) ?? 0, Number(match[2])));
    if (packs.size >= MAX_DECLARED_PACKS) break;
  }
  const canonical = [...packs].sort(([a], [b]) => a.localeCompare(b)).map(([name, v]) => `${name}@${v}`).join(",");
  const existing = views.get(canonical);
  if (existing) return existing;
  const view = Object.freeze({ key: canonical, packs });
  // Shared only up to a bound: a client inventing a new declaration per
  // request would otherwise grow this for as long as the server runs.
  if (views.size < MAX_SHARED_VIEWS) views.set(canonical, view);
  return view;
};

export const officialView = () => OFFICIAL;

/**
 * The view a `Demographics` value declares, or null when it declares nothing.
 *
 * Null and a declaration of no packs are not the same thing. A client always
 * sends its Demographics — `{}` without a pack — and that is a statement that it
 * has none. An empty string is what the server's own door requests carry, and
 * that says nothing about the client, so it keeps whatever was said before.
 */
export const viewFromDemographics = (value) => {
  let object = value;
  if (typeof value === "string") {
    if (!value || value.length > MAX_DECLARATION_LENGTH) return null;
    try {
      object = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!object || typeof object !== "object" || Array.isArray(object)) return null;
  const declared = Array.isArray(object.contentPacks) ? object.contentPacks : [];
  const key = declared
    .slice(0, MAX_DECLARED_PACKS)
    .filter((entry) => typeof entry === "string" && DECLARED_PACK.test(entry))
    .join(",");
  return viewFromKey(key);
};

const has = (view, entry) => (view?.packs?.get(entry.pack) ?? 0) >= entry.since;

/** The skin id this viewer may be told, which is the one given unless it is withheld. */
export const presentSkin = (view, skinId) => {
  const entry = registry.customSkins.get(Number(skinId));
  return !entry || has(view, entry) ? skinId : entry.fallback;
};

/** The NPC type this viewer may be told. */
export const presentNpc = (view, npcId) => {
  const entry = registry.customNpcs.get(Number(npcId));
  return !entry || has(view, entry) ? npcId : entry.fallback;
};

/**
 * What a hero in `skinId` holds, as this viewer is told: the skin's variant of
 * the weapon if it has one and the viewer has its pack, the weapon itself
 * otherwise. The variant swings the skin's own attacks, which is how the
 * client — choosing effects by attack alone — plays a skin's own effects.
 */
export const presentWeapon = (view, skinId, weaponId) => {
  const variant = registry.weaponVariants.get(`${Number(weaponId)}|${Number(skinId)}`);
  return variant !== undefined && has(view, registry.customWeapons.get(variant)) ? variant : weaponId;
};

/** A hero's attack as this viewer is told it, by the same rule as its weapon. */
export const presentAttack = (view, skinId, attackId) => {
  const variant = registry.attackVariants.get(`${Number(attackId)}|${Number(skinId)}`);
  return variant !== undefined && has(view, registry.customAttacks.get(variant)) ? variant : attackId;
};

/**
 * The attack a client's proposal means. A client with the pack swings its
 * skin's variants; the server prices, times and audits the base they dress,
 * which is the same attack by construction, so the game has one of each.
 */
export const baseAttackOf = (attackId) => registry.customAttacks.get(Number(attackId))?.fallback ?? attackId;

/** Whether this skin dresses any attack, which is the relay's fast path. */
export const skinDressesAttacks = (skinId) => registry.skinsWithAttacks.has(Number(skinId));

/** Whether anything at all is withheld from somebody, which is the fast path's test. */
export const packsInstalled = () => registry.customSkins.size > 0 || registry.customNpcs.size > 0;

export const isCustomSkin = (skinId) => registry.customSkins.has(Number(skinId));
export const isCustomNpc = (npcId) => registry.customNpcs.has(Number(npcId));

/** The summon a skin dresses `baseConstant` as, if a pack gives it one that passed the checks. */
export const variantFor = (baseConstant, skinId) => registry.variants.get(`${baseConstant}|${Number(skinId)}`) ?? null;

// --- Frames ------------------------------------------------------------------

/**
 * A frame that names pack content, with how to build it for any viewer.
 *
 * The frame itself is the canonical one, and is what every other path — the
 * snapshot, the capture, a test — sees. `send` asks it for the viewer's copy.
 * Built at most once per distinct view, so a party of five costs two frames.
 */
export const presentable = (frame, rebuild) => {
  const built = new Map();
  frame.forView = (view) => {
    const key = view?.key ?? "";
    let copy = built.get(key);
    if (!copy) {
      copy = rebuild(view ?? OFFICIAL);
      built.set(key, copy);
    }
    return copy;
  };
  return frame;
};

/** What goes on the wire to this viewer. Frames with no pack content pass as they are. */
export const frameFor = (frame, view) => (typeof frame?.forView === "function" ? frame.forView(view) : frame);

/** A copy that keeps its way of being presented, for code that has to copy frames. */
export const keepPresentation = (from, copy) => {
  if (typeof from?.forView === "function") copy.forView = from.forView;
  return copy;
};

// --- Per account, for HTTP ----------------------------------------------------

/**
 * The last declaration each account made, kept across launches and restarts.
 *
 * It has to be. The first thing a client asks for is its own account, before
 * any request that carries its Demographics, and a client without a pack does
 * not survive its own account naming the pack's skin either — tested: the
 * player's own hero in the Knight segfaulted a client lacking the row about a
 * second after login. So that first answer is given in the terms the account's
 * client used last time, and a player who bought a skin sees it as theirs
 * instead of being offered it again.
 *
 * Last time is a guess about this time — the same account may be launched from
 * a machine without the pack — so a launch's guess stands only once the launch
 * confirms it with a declaration of its own. One that asks for its account
 * again without having said anything, with no connection up in between, is
 * taken to have died of the guess, and gets the game's own content instead: a
 * wrong guess costs one crash, never a loop of them.
 */
const declarations = new Map();
const unconfirmed = new Set();
let declarationsFile = null;

const saveDeclarations = () => {
  if (!declarationsFile) return;
  try {
    const temporary = `${declarationsFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries([...declarations].map(([id, view]) => [id, view.key]))));
    fs.renameSync(temporary, declarationsFile);
  } catch (problem) {
    warn(`content packs: could not save declarations to ${declarationsFile} — ${problem.message}`);
  }
};

/** Where declarations are kept between runs; the main thread's, read once at startup. */
export const keepDeclarationsIn = (file) => {
  declarationsFile = file;
  declarations.clear();
  unconfirmed.clear();
  if (!file || !fs.existsSync(file)) return;
  try {
    for (const [id, key] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) {
      const view = viewFromKey(key);
      if (view !== OFFICIAL) declarations.set(Number(id), view);
    }
  } catch (problem) {
    warn(`content packs: could not read ${file} — ${problem.message}; starting without declarations`);
  }
};

export const declare = (accountId, view) => {
  const id = Number(accountId);
  if (!Number.isSafeInteger(id) || id <= 0 || !view) return;
  unconfirmed.delete(id);
  const before = declarations.get(id) ?? OFFICIAL;
  if (view === OFFICIAL) declarations.delete(id);
  else declarations.set(id, view);
  if (before !== view) saveDeclarations();
};

export const declaredView = (accountId) => declarations.get(Number(accountId)) ?? OFFICIAL;

export const forgetDeclaration = (accountId) => {
  const id = Number(accountId);
  unconfirmed.delete(id);
  if (declarations.delete(id)) saveDeclarations();
};

/**
 * The view an account's own details go out in. `connected` is whether a socket
 * of this account is up: then this is a refresh inside a running client, which
 * has already said what it has, not the first question of a launch.
 */
export const viewForOwnAccount = (accountId, { connected = false } = {}) => {
  const id = Number(accountId);
  const remembered = declarations.get(id);
  if (!remembered || connected) return remembered ?? OFFICIAL;
  if (unconfirmed.has(id)) {
    warn(
      `content packs: account ${id} came back without confirming ${remembered.key}; ` +
        `its client is sent the game's own content until it declares again`
    );
    forgetDeclaration(id);
    return OFFICIAL;
  }
  unconfirmed.add(id);
  return remembered;
};

/**
 * The keys an HTTP answer names a skin under — friend rows, boards, requests,
 * the account itself — as they come out of `JSON.stringify`, the number quoted
 * or not. A key inside a string value is written `\"active_skin\"` and does not
 * match.
 */
const SKIN_FIELD = /"(active_skin|skin_type)":("?)(\d+)\2/g;

/**
 * JSON for this viewer.
 *
 * Written plainly and then corrected in one pass over the text: a replacer
 * function on `JSON.stringify` did the same at twice the cost of the
 * serialisation, 116 µs against 53 on an account's details.
 */
export const jsonFor = (value, view) => {
  const text = JSON.stringify(value);
  if (!packsInstalled() || typeof text !== "string") return text;
  return text.replace(SKIN_FIELD, (whole, key, quote, id) => {
    const shown = presentSkin(view, Number(id));
    return shown === Number(id) ? whole : `"${key}":${quote}${shown}${quote}`;
  });
};
