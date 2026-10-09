import { findPath } from "./navigation.js";

/**
 * A body's route searches, remembered by the colliders they were made under.
 *
 * `findPath` answers from the active colliders, the two end points and the
 * radius, and from nothing else. A monster that cannot reach its target stands
 * where it is and searches again on every navigation revision — any timed trap
 * on the floor makes one, a busy floor sixteen a second — while those traps
 * cycle through the same states over and over. From the same spot, for the
 * same target, under a collider set it has already searched, the answer is the
 * one it got then. And those are the dear searches: a failed one exhausts every
 * cell the body can reach.
 *
 * Measured on nine tile libraries, three seeds each, 4000 turns, a scripted
 * player and the floors' own trap timers: with the player walking through walls
 * as the load simulator does, one search in eight was such a repeat; with a
 * player who keeps to the floor and gets stuck where monsters cannot follow,
 * more than nine in ten were, and one ice-cave floor spent 173 seconds of AI
 * time on 4000 turns. Remembered, the same 4000 turns take about 6.
 *
 * A hit needs the start, goal and radius equal to the bit, the same navigation
 * object and the same active collider set, so it is what the search would have
 * returned. The set is named by the trigger groups' states and the identity of
 * every obstacle's collider list; `navigation.js` swaps both whole and never
 * edits one in place, and no collider belongs to two groups (route-memo.test.js
 * holds the floors to that). A set that cannot be named is not remembered.
 *
 * Sixty-four, because a stranded monster on that ice-cave floor saw a few dozen
 * collider sets go round; sixteen kept two thirds of its repeats, sixty-four all.
 */
const MEMO_SIZE = 64;

const obstacleSerials = new WeakMap();
let nextObstacleSerial = 1;

const serialOf = (colliders) => {
  let serial = obstacleSerials.get(colliders);
  if (serial === undefined) {
    serial = nextObstacleSerial++;
    obstacleSerials.set(colliders, serial);
  }
  return serial;
};

/** A name for the active collider set, or null when there is none to give. */
export const colliderSetKey = (navigation) => {
  if (!(navigation?.triggerGroups instanceof Map) || !(navigation.obstacles instanceof Map)) {
    return null;
  }
  let key = "";
  for (const group of navigation.triggerGroups.values()) key += group.on ? "1" : "0";
  for (const colliders of navigation.obstacles.values()) key += `|${serialOf(colliders)}`;
  return key;
};

const copyOf = (path) => path.map((point) => ({ ...point }));

/**
 * `findPath(navigation, start, goal, radius)`, answered from `owner.routeMemo`
 * when it has already been asked under this collider set.
 */
export const searchRoute = (owner, navigation, start, goal, radius) => {
  // A route ends on a copy of the goal, so a goal carrying more than its two
  // coordinates could differ in what else it carries; those are not kept.
  const key = Object.keys(goal).length === 2 ? colliderSetKey(navigation) : null;
  if (key === null) return findPath(navigation, start, goal, radius);

  let memo = owner.routeMemo;
  if (
    !memo ||
    memo.navigation !== navigation ||
    // Object.is, since a route carries the goal's -0 where it has one.
    !Object.is(memo.startX, start.x) ||
    !Object.is(memo.startY, start.y) ||
    !Object.is(memo.goalX, goal.x) ||
    !Object.is(memo.goalY, goal.y) ||
    !Object.is(memo.radius, radius)
  ) {
    memo = {
      navigation,
      startX: start.x,
      startY: start.y,
      goalX: goal.x,
      goalY: goal.y,
      radius,
      routes: new Map(),
    };
    owner.routeMemo = memo;
  }

  const known = memo.routes.get(key);
  if (known) {
    // Most recently used last, so the oldest is the one let go.
    memo.routes.delete(key);
    memo.routes.set(key, known);
    return copyOf(known);
  }
  const path = findPath(navigation, start, goal, radius);
  if (memo.routes.size >= MEMO_SIZE) memo.routes.delete(memo.routes.keys().next().value);
  memo.routes.set(key, copyOf(path));
  return path;
};
