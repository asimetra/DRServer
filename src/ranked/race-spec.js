/**
 * What a race is, and how one is chosen.
 *
 * A spec is the whole of it: which node, which seed, which rules. Two players
 * given the same spec play the same layout. How the spec is chosen is a
 * *picker* — a function that returns one — so a random draw, a set seed, a seed
 * of the week or a race an admin arranged are the same to everything else.
 */

const MAX_SEED = 0x7fffffff;

/** Never in a ranked race: the first dungeon, places that are not dungeons, and Ultimate. */
const NEVER = new Set(["TUTORIAL"]);
/**
 * Ordinary dungeons only. The twelve BOSS nodes are the trophy dungeons: each
 * is a scripted fight and pays its trophy once per account, which a race
 * drawn there would spend (docs/trophy-rules-findings.md).
 */
const DEFAULT_NODE_TYPES = Object.freeze(["DUNGEON"]);

export const createSpec = ({ mapNodeId, seed, rules = {} }) => {
  if (!Number.isInteger(mapNodeId) || mapNodeId <= 0) throw new Error("a race spec needs a map node");
  if (!Number.isInteger(seed) || seed <= 0 || seed > MAX_SEED) throw new Error("a race spec needs a positive seed");
  return Object.freeze({ mapNodeId, seed, rules: Object.freeze({ ...rules }) });
};

/**
 * The nodes a race may be drawn from: every normal dungeon and boss by
 * default. `exclude` takes ids or constants.
 */
export const nodePool = (mapPages, { nodeTypes = DEFAULT_NODE_TYPES, exclude = [] } = {}) => {
  const types = new Set(nodeTypes);
  const left = new Set(exclude.map(String));
  return (mapPages ?? []).filter(
    (node) =>
      types.has(node?.NodeType) &&
      !NEVER.has(node.Constant) &&
      !left.has(String(node.Id)) &&
      !left.has(String(node.Constant))
  );
};

/** A node from the pool and a fresh seed, every time. */
export const randomPicker = ({ pool, random = Math.random, rules = {} }) => {
  if (!pool?.length) throw new Error("ranked: no dungeon to draw a race from — check the node pool");
  const nodes = [...pool];
  return () => {
    const node = nodes[Math.min(nodes.length - 1, Math.floor(random() * nodes.length))];
    const seed = 1 + Math.floor(random() * (MAX_SEED - 1));
    return createSpec({ mapNodeId: node.Id, seed, rules });
  };
};

/** The same spec every time: a set seed. */
export const fixedPicker = (spec) => () => spec;
