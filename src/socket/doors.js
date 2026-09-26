/**
 * A threshold you walk through.
 *
 * Interacting with a monster turned out to be the wrong shape for choosing
 * where to go: hitting a statue does not answer "what is this for", and a mob
 * cannot be labelled — an NPC has no name field. A door and somebody standing
 * next to it answer both without a word of interface. The keeper is the sign;
 * the door is the threshold.
 *
 * Going through one is an ordinary entry, not a trick. `enterDungeon` already
 * begins by tearing down whatever dungeon the session is in, so the same two
 * calls the matchmaker makes for a player picking a node off the map do the
 * whole job — which also means the destination is not bound by the hub's
 * preload the way a mid-run floor swap would be.
 */
import { transitionsOf } from "./session-transitions.js";

/**
 * Takes whoever entered the doorway to where it leads — a transition of the
 * connection's own, so that a door, an entry and an exit can never overlap.
 * The rules it keeps (ask first, leave second; one crossing at a time; refused
 * the way a map click is) are in `SessionTransitions.walkThrough`.
 *
 * `check`, `admit`, `join` and `leave` are injectable so a test can watch a
 * crossing without running a dungeon entry.
 */
export const walkThrough = (session, destination, dependencies = {}) =>
  transitionsOf(session).walkThrough(destination, dependencies);
