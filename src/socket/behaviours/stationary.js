import { STILL } from "./chase.js";

/**
 * A stationary boss is deliberately embedded in its arena set piece.
 * Route planning reads that as "inside scenery" and keeps it forever in
 * escape state, which keeps its attack from ever running. It
 * authors IsNavigable=0 and LockRotation=true: it neither finds a route nor
 * asks the scenery for line of sight; its attack timelines place their own
 * colliders in the arena.
 *
 * So the AI gives it no route (`NO_ROUTE_ASKED`, routing.js) and takes its
 * victim as seen (`act`, npc-act.js), and it never walks. Today that is
 * BOSS_GOLEM, the one STATIONARY_AI row with an AI.
 */
export const isStationary = (ai) => ai.behavior === "STATIONARY_AI";

export const stationary = {
  intent: () => STILL,
};
