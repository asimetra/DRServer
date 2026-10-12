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

/** A stationary row: one that gets an AI only as a boss set in its arena (npc-spawn.js). */
export const isStationaryRow = (npc) => npc.Aggro_AI_Type === "STATIONARY_AI";

/**
 * When its first swing may come: never, for a stationary boss, until its
 * opening TIMELINE_TRIGGERABLE wakes it; without the hold the first 250 ms AI
 * tick could attack before GOLEM_INTRO arrives. At once for anything else.
 */
export const firstSwingAt = (npc) => (isStationaryRow(npc) ? Number.POSITIVE_INFINITY : 0);

/** Set in its arena: it asks no route and is not held to sight (ai.js), and stands. */
export const stationary = {
  routes: false,
  seesAlways: true,
  intent: () => STILL,
};
