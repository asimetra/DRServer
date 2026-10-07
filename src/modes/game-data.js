/**
 * What a game mode may read of the game data (src/modes/README.md, "What a
 * mode may rely on"): the map's nodes, any node's floors as the core would lay
 * them out, and the tile files those floors need preloaded. A mode that draws
 * its own floors — a race's dungeon, a boss rush's next boss — builds them from
 * these, and reaches for nothing in src/gamemaster.js or src/socket/floors.js.
 *
 * The game data is the deployment's own (local-data, never in the repository),
 * read once and cached by the core; these are reads, never writes.
 */
import { loadGameMaster, mapNode as nodeById } from "../gamemaster.js";
import { floorPlanForMapNode, tileLibrariesFor } from "../socket/floors.js";

/** Every map node (MapPage rows): `{ Id, Constant, Name, NodeType, TierRank, ... }`. */
export const mapNodes = async () => [...((await loadGameMaster()).raw?.MapPage ?? [])];

/** One map node by id, or null. */
export const mapNode = async (id) => (await nodeById(Number(id))) ?? null;

/**
 * A node's floors as the core lays them out (`{ floors, tier, npcLevel }`, the
 * plan shape of README "The floor plan"): its authored files where it has
 * them, generated floors from its tier otherwise. `seed` fixes the generated
 * ones. Null for a node the game data lacks.
 */
export const nodePlan = (id, { seed } = {}) => floorPlanForMapNode(Number(id), { seed });

/** The tile files a plan's floors are built from, for `preloadTileLibraries`. */
export const planTileLibraries = (plan) => tileLibrariesFor(plan);

/** Any table of the game data by name (DungeonModifier, Offers, Npc, ...), as rows; empty for none. */
export const gameTable = async (name) => [...((await loadGameMaster()).raw?.[name] ?? [])];
