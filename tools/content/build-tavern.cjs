#!/usr/bin/env node
/**
 * The hub, authored rather than copied.
 *
 * Every constant is one the player already has on disk: this is a layout, not
 * artwork. Nothing of the publisher's is reproduced — only the names of things
 * and where we decided to put them.
 *
 * A snowed village square rather than a stone room. There is no PALACE theme to
 * build in — its attacks survive in the rules table (`TRAP_ARROWS_PALACE`,
 * `PROJ_ARROW_PALACE`) but no art for it shipped — and of the nine that did,
 * the village is the only one that already looks like somewhere people would
 * stand about rather than somewhere they would be ambushed.
 *
 * Backgrounds carry their own walls, encoded [N, E, S, W] with 5 open and 0
 * closed, and the collision lives in the navigation library under the
 * background constant rather than on any prop. The floor uses
 * NORDIC_VILLAGE_5555_SQUARESOLID, which has no collision at all, so the square
 * is one uninterrupted space and the ring of FILLER — a solid 900x900 block
 * that is also *drawn* — is both its wall and its horizon.
 */
const fs = require("fs");
const path = require("path");

const TILE = 900;
const CENTRE = TILE / 2;
let serial = 0;
const id = () => `tavern.${++serial}`;

const prop = (constant, x, y, extra = {}) => ({
  type: "LEProp", constant, x, y, id: id(), layer: "sorted", ...extra,
});

const background = (constant) => ({
  type: "LEBackground", constant, layer: "background",
  x: CENTRE, y: CENTRE, id: id(),
});

const tile = (tileId, backgroundConstant, objects = []) => ({
  type: "LETile",
  id: tileId,
  theme: "VILLAGE",
  category: "FILLER_TILE",
  rarity: "COMMON",
  minTier: 1,
  maxTier: 10,
  // Nothing leads anywhere: a hub is somewhere you stay.
  exits: [0, 0, 0, 0],
  exitTriggers: ["", "", "", ""],
  LEBackground: background(backgroundConstant),
  LEObjects: objects,
});

/** One id, named once, so a trigger and its subject cannot drift apart. */
const KEEPER = "tavern.keeper";
const STONE = "tavern.stone";

/**
 * A keeper you can talk to.
 *
 * `voiceHero` gives the speaker a hero body, which is what carries the chat
 * balloon and the nametag — and the balloon is the point, because the chat log
 * is closed most of the time. It costs the monster artwork. The star is not
 * decoration: `PlayerSpecialStatus` reads the first character of a name and
 * paints it #05CE78.
 */
const keeper = (x, y) => ({
  type: "LENPC", constant: "TAVERN_KEEPER", x, y,
  voice: "★Tavern Keeper", voiceHero: "RANGER", id: KEEPER,
});

/** A stone you knock to choose with. Meant to be hit, so it keeps a body. */
const stone = (x, y) => ({
  type: "LENPC", constant: "STANDING_STONE", x, y, voice: "Standing Stone", id: STONE,
});

const greeting = (x, y, chatText, { speaker, radius = 170 } = {}) => ({
  type: "LETrigger", constant: "PROXIMITY_TRIGGER", x, y, radius, chatText, speaker, id: id(),
});

/**
 * A way out, and somebody standing next to it to say what it is.
 *
 * The keeper is the sign and the gap in the treeline is the threshold — between
 * them they answer "what is this for" without an interface, which is the thing
 * hitting a statue could never do. Walking into the gap is an ordinary dungeon
 * entry, so the destination is not bound by what this square preloaded.
 */
const doorway = (x, y, destination, { name, says }) => {
  const doorman = `${destination}.doorman`;
  return [
    { type: "LENPC", constant: "TAVERN_KEEPER", x: x - 150, y: y + 40,
      voice: `★${name}`, voiceHero: "RANGER", id: doorman },
    // Read from a step away, so you are told before you are taken.
    { type: "LETrigger", constant: "PROXIMITY_TRIGGER", x: x - 150, y: y + 110,
      radius: 190, chatText: says, speaker: doorman, id: id() },
    // And the threshold itself, kept tight so it is stepped into, not brushed.
    { type: "LETrigger", constant: "PROXIMITY_TRIGGER", x, y, radius: 90,
      destination, id: id() },
  ];
};

const knock = (x, y, chatText) => ({
  type: "LETrigger", constant: "NPC_DAMAGE_TRIGGER", npcId: STONE, x, y,
  chatText, speaker: STONE, highlight: "HIGHLIGHT_SELECTED", repeats: true, id: id(),
});

/** Trees down an edge, so the square reads as enclosed before the wall does. */
const treeLine = (xs, y, kind = "A") =>
  xs.map((x, i) => prop(`NORDIC_VILLAGE_GROUND_TREE_${i % 2 ? "B" : kind}`, x, y));

const westHalf = [
  { type: "LEHeroSpawnProp", constant: "HERO_SPAWN_PROP", x: 640, y: 660, id: id() },
  ...treeLine([120, 330, 560, 790], 110),
  prop("NORDIC_VILLAGE_GROUND_TREE_B", 110, 420),
  prop("NORDIC_VILLAGE_GROUND_SNOW_A", 300, 380),
  prop("NORDIC_VILLAGE_DECO_BRICKS", 470, 500),
  prop("NORDIC_VILLAGE_GROUND_STUMP", 250, 560),
  prop("NORDIC_VILLAGE_DECO_DIRT", 600, 300),
  keeper(450, 300),
  greeting(450, 380, "Nowhere to be, then. Sit where you like.", { speaker: KEEPER }),
];

const eastHalf = [
  // A gap where 570 would be: the doorway needs to read as a way out.
  ...treeLine([110, 340, 800], 110, "B"),
  prop("NORDIC_VILLAGE_GROUND_TREE_A", 800, 430),
  prop("NORDIC_VILLAGE_GROUND_SNOW_B", 520, 620),
  prop("NORDIC_VILLAGE_GROUND_SNOW_C", 250, 300),
  prop("NORDIC_VILLAGE_GROUND_STUMP", 640, 560),
  prop("NORDIC_VILLAGE_DECO_DIRT_B", 300, 700),
  prop("NORDIC_VILLAGE_DECO_ROCK_C", 180, 520),
  ...doorway(570, 120, 50009, {
    name: "Doorman",
    says: "Ice Caverns, through the trees. Step past when you are ready.",
  }),
];

const library = {
  LETriggers: [],
  theme: "VILLAGE",
  version: "Version 2.9.0",
  fileType: "tiles",
  LETiles: [
    tile("TAVERN_WEST", "NORDIC_VILLAGE_5555_SQUARESOLID", westHalf),
    tile("TAVERN_EAST", "NORDIC_VILLAGE_5555_SQUARESOLID", eastHalf),
    tile("TAVERN_FILL", "NORDIC_VILLAGE_FILLER", []),
  ],
};

const room = [[0, 0, "TAVERN_WEST"], [TILE, 0, "TAVERN_EAST"]];
const occupied = new Set(room.map(([x, y]) => `${x},${y}`));
const tiles = room.map(([x, y, tileId]) => ({ type: "LEFloorTile", tileId, x, y, id: id() }));

for (let x = -TILE; x <= TILE * 2; x += TILE) {
  for (let y = -TILE; y <= TILE; y += TILE) {
    if (occupied.has(`${x},${y}`)) continue;
    tiles.push({ type: "LEFloorTile", tileId: "TAVERN_FILL", x, y, id: id() });
  }
}

const floor = {
  FullAggro: false,
  tileLibrary: "Resources/Levels/tavern/db_tiles_TAVERN.json",
  tiles,
  version: "Version 2.9.0",
  fileType: "floor",
};

const root = path.join(process.cwd(), "content", "Resources", "Levels", "tavern");
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "db_tiles_TAVERN.json"), JSON.stringify(library, null, 1));
fs.writeFileSync(path.join(root, "db_floor_TAVERN.json"), JSON.stringify(floor, null, 1));
console.error(
  `${library.LETiles.length} tile kinds, ${tiles.length} placements ` +
    `(${room.length} square, ${tiles.length - room.length} filler)`
);
