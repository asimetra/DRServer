#!/usr/bin/env node
/**
 * The rules this server adds to the game's own table.
 *
 * The client reads its rules from wherever `gameMasterPath` points, and this
 * server reads the same file, so a row written here is a row both sides agree
 * on. That is what turns "use a monster as an NPC" from a trick into a
 * definition: a knight that keeps a tavern is a knight's row with the knight
 * taken out of it.
 *
 * Only the deltas live here. The base table is the game's, read and written
 * back out whole, so this script is a patch and not a copy — and re-running it
 * after a game-data refresh reapplies the same intent to the new table.
 */
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const source = path.join(root, "local-data", "Resources", "Levels", "DB_GameMaster.json");
const target = path.join(root, "content", "Resources", "Levels", "DB_GameMaster.json");

const gm = JSON.parse(fs.readFileSync(source, "utf8"));

/** Ids well above anything the game ships, so a refresh cannot collide. */
let nextId = 9000001;

/**
 * A monster's artwork with its behaviour removed.
 *
 * `CharType` is what decides everything that matters here. dungeon.js gives an
 * actor a brain only when it is `ENEMY && IsMover && <has a native attack>`, and
 * counts it towards clearing the floor only when it is `ENEMY`. A PROP is
 * therefore inert by construction rather than by being asked nicely: nothing
 * schedules it, nothing chases, and the floor does not wait for it to die.
 *
 * It keeps the SwfFilepath, so it is the same knight on screen.
 */
const asKeeper = (fromConstant, constant, name) => {
  const source = gm.Npc.find((npc) => npc.Constant === fromConstant);
  if (!source) throw new Error(`no NPC row named ${fromConstant}`);
  return {
    ...source,
    Id: nextId++,
    Constant: constant,
    Name: name,
    CharType: "PROP",
    IsMover: 0,
    IsAttackable: 0,
    // No attack of its own, and nothing to give it a reason to have one.
    Attack1: "",
    Attack2: "",
    AggroRadius: 0,
    // A doorman does not drop loot.
    DooberDropTable: "",
  };
};

/**
 * A buff that does nothing but be seen.
 *
 * The client draws a buff on the actor it names: a looping VFX above it and a
 * `colorMatrixFilter` tween on its body at `repeat: -1, yoyo: true`, so the
 * body pulses between its own colour and this one rather than being flatly
 * painted. That is what makes it read as attention rather than as damage.
 *
 * `ShowInHUD` is off, and would not matter anyway — the HUD icon is inside an
 * `isOwner` guard, so a buff on a stone never reaches the player's bar. 98 of
 * the game's own 157 rows do not ask for one either.
 *
 * No DeltaValues, no Ability, no Exp or Gold: it changes nothing about the
 * thing it marks.
 */
const highlight = (constant, name, tint, duration) => ({
  Id: nextId++,
  Constant: constant,
  Name: name,
  Team: "FRIENDLY",
  Duration: duration,
  TintColor: tint,
  TintAmountF: 0.65,
  VFX: "",
  VFXFilepath: "Resources/Art2D/FX/db_fx_library.swf",
  ShowInHUD: false,
  LayerPriority: 1,
});

/**
 * Something built to be hit repeatedly has to outlast being hit.
 *
 * The arena's king statue is the right shape and the wrong durability: 80 hit
 * points is a few swings, and a selector that shatters on the fourth choice is
 * not a selector. This is its artwork with a number that means "not by hand" —
 * still attackable, so the blow registers and the damage trigger fires, and
 * still a PROP, so nothing gives it a brain or waits for it to die.
 */
const asStanding = (fromConstant, constant, name) => {
  const source = gm.Npc.find((npc) => npc.Constant === fromConstant);
  if (!source) throw new Error(`no NPC row named ${fromConstant}`);
  return {
    ...source,
    Id: nextId++,
    Constant: constant,
    Name: name,
    CharType: "PROP",
    IsMover: 0,
    IsAttackable: 1,
    HP: 1000000,
    DooberDropTable: "",
  };
};

const added = [
  asKeeper("KNIGHT", "TAVERN_KEEPER", "Tavern Keeper"),
  asStanding("AZTECH_STATUE", "STANDING_STONE", "Standing Stone"),
];

const addedBuffs = [
  highlight("HIGHLIGHT_SELECTED", "Selected", "0x66ccff", 6),
];

const byConstant = new Map(gm.Npc.map((npc) => [npc.Constant, npc]));
for (const row of added) {
  if (byConstant.has(row.Constant)) throw new Error(`${row.Constant} already exists`);
  gm.Npc.push(row);
}

const buffsByConstant = new Map((gm.Buff ?? []).map((buff) => [buff.Constant, buff]));
for (const row of addedBuffs) {
  if (buffsByConstant.has(row.Constant)) throw new Error(`${row.Constant} already exists`);
  gm.Buff.push(row);
}

/**
 * The tavern's own place on the map.
 *
 * Id 50200 is not chosen: `UIMapWorldMap.hackToHandleKeyPressToPlayNode` binds
 * R to it, and the shipped table has no such node — a key left pointing at
 * somewhere that was removed. So the door already exists in the client and only
 * needed something behind it.
 *
 * That is what makes it fit the constraint. Nothing new appears on the map
 * screen, no player edits anything but `ALLOW_HACKS_TO_PLAY_MAP_NODE` in the
 * config they already edit, and the solo path is untouched.
 *
 * `NodeType` is deliberately none of the game's own. DUNGEON and BOSS are what
 * `avatarCompletedAllNormalNodes` counts, and a hub nobody completes would
 * leave that check permanently unsatisfied; INFINITE turns on depth scaling;
 * TAVERN turns off attacks. An unknown type falls through every client switch
 * to its default — FloorEndingGui to the regular screen, isTavern to false —
 * which is what a hub wants.
 */
const HUB = {
  Id: 50200,
  Constant: "TAVERN_HUB",
  Name: "The Tavern",
  NodeType: "HUB",
  /**
   * A real tier, because the map screen dereferences whatever this names
   * without checking. `UIMapWorldMap.initializeOpenMapNodes` does
   * `coliseumTierByConstant.itemFor(TierRank)` and then reads `.TotalFloors`
   * off it on the next line — an empty string is a null row and a segfault.
   * Nothing here reads it: no enemies are stocked on a floor with no
   * generators, whatever pool the tier names.
   */
  TierRank: "CASTLE_TIER1",
  DifficultyName: "A place to stand about in",
  NodeIcon: "SkullNode",
  CompletionXPBonus: 0,
  TotalEnemyXP: 0,
  TotalEnemyCoin: 0,
  BasicKeys: 0,
  PremiumKeys: 0,
  /**
   * Out of the map screen's reach, on purpose.
   *
   * The client builds its own list of unlocked nodes: it walks every row in the
   * table and adds any whose `LevelRequirement` and `TrophyRequirement` it
   * meets and which has no parent — which described this one exactly, so the
   * hub appeared on the world map, had no artwork to draw, and took the map
   * screen down with it.
   *
   * A requirement nobody meets keeps it off that list without a special case,
   * and costs nothing: the door is the R key, which calls
   * `hackToPlayNode` and never consults the map at all.
   */
  LevelReq: 999,
  TrophyReq: 999999,
  ForceExactMatch: false,
  MaxMatchmaker: 20,
  MaxPlayers: 20,
  AlwaysVisible: false,
  IsDoubleXp: false,
  MinTreasure: 0,
  MaxTreasure: 0,
};

if (!gm.MapPage.some((node) => Number(node.Id) === HUB.Id)) gm.MapPage.push(HUB);

/**
 * The node keeps the type the game gave it.
 *
 * `TAVERN` was tried and handed back. Its only behaviour is that
 * `HeroGameObjectOwner.setupWeapons` swaps in `TavernPlayerOwnerAttackController`,
 * whose `tryAttack` does nothing but change the current weapon — so in a tavern
 * you cannot hit anything, and hitting things is half the vocabulary a room has
 * for being touched. A social space that cannot be interacted with is a
 * corridor with chairs.
 *
 * Nothing else was lost by giving it back: FloorEndingGui's TAVERN case falls
 * through to the regular screen, and an enemy-less floor never completes either
 * way — `checkFloorCleared` returns early on `!enemies`, so a room with nobody
 * to kill is never cleared and never ends.
 */

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(gm));
console.error(
  `map node ${HUB.Id} ${HUB.Constant} (${HUB.NodeType})\n` +
    `${added.length} npc + ${addedBuffs.length} buff row(s): ` +
    [...added, ...addedBuffs].map((r) => `${r.Constant}=${r.Id}`).join(", ") +

    `\nwritten ${(fs.statSync(target).size / 1048576).toFixed(1)} MB`
);
