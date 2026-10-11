import { blockedAt, hasLineOfSight, lineIsClear, withinFloorAt } from "./clearance.js";
import { canGather, clearOfGathered, gatherNear } from "./collider-index.js";
import { squaredDistance } from "./geometry.js";
import { ANCHOR_MARGIN, ANCHOR_X, ANCHOR_Y, routeCacheFor } from "./route-cache.js";

/**
 * The route search: A* over the floor's cells, each entered at its anchor,
 * asking and filling the per-radius cache of route-cache.js.
 */

/**
 * The open list of a route search, as two parallel arrays rather than one
 * object per entry. The same binary heap, with the same comparisons in the same
 * order, so entries of equal priority still leave it in the order they did.
 *
 * Shared by every search: `findPath` runs to completion without calling itself,
 * and empties the heap before it starts.
 */
let heapPriorities = new Float64Array(1024);
let heapKeys = new Int32Array(1024);
let heapLength = 0;

const heapPush = (key, priority) => {
  if (heapLength === heapKeys.length) {
    const priorities = new Float64Array(heapLength * 2);
    const keys = new Int32Array(heapLength * 2);
    priorities.set(heapPriorities);
    keys.set(heapKeys);
    heapPriorities = priorities;
    heapKeys = keys;
  }
  let index = heapLength++;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heapPriorities[parent] <= priority) break;
    heapPriorities[index] = heapPriorities[parent];
    heapKeys[index] = heapKeys[parent];
    index = parent;
  }
  heapPriorities[index] = priority;
  heapKeys[index] = key;
};

/** Removes the lowest entry and returns its key. */
const heapPop = () => {
  const first = heapKeys[0];
  heapLength--;
  const lastPriority = heapPriorities[heapLength];
  const lastKey = heapKeys[heapLength];
  if (!heapLength) return first;

  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heapLength) break;
    const child = right < heapLength && heapPriorities[right] < heapPriorities[left] ? right : left;
    if (heapPriorities[child] >= lastPriority) break;
    heapPriorities[index] = heapPriorities[child];
    heapKeys[index] = heapKeys[child];
    index = child;
  }
  heapPriorities[index] = lastPriority;
  heapKeys[index] = lastKey;
  return first;
};

/**
 * Per-cell search state, kept between searches and told apart by a stamp: a
 * slot belongs to this search only when its stamp is this search's. Stands in
 * for the cost and came-from maps and the closed set, which were rebuilt and
 * grown for every route.
 */
let searchStamp = 0;
let costStamps = new Uint32Array(0);
let costs = new Float64Array(0);
let parentStamps = new Uint32Array(0);
let parents = new Int32Array(0);
let viasInto = [];
let closedStamps = new Uint32Array(0);

const beginSearch = (size) => {
  heapLength = 0;
  if (costStamps.length < size) {
    costStamps = new Uint32Array(size);
    costs = new Float64Array(size);
    parentStamps = new Uint32Array(size);
    parents = new Int32Array(size);
    viasInto = new Array(size).fill(null);
    closedStamps = new Uint32Array(size);
    searchStamp = 0;
  }
  if (searchStamp === 0xffffffff) {
    costStamps.fill(0);
    parentStamps.fill(0);
    closedStamps.fill(0);
    searchStamp = 0;
  }
  return ++searchStamp;
};

/**
 * Gathers the colliders near a cell's off-centre anchor probes, once its
 * centre has been refused: the count for `clearOfGathered`, or -1 to probe one
 * at a time. The box is taken over the probes' own coordinates.
 */
const gatherProbes = (navigation, centreX, centreY, cellSize, probeRadius) => {
  if (
    typeof centreX !== "number" ||
    typeof centreY !== "number" ||
    typeof probeRadius !== "number" ||
    !(probeRadius >= 0) ||
    !canGather(navigation)
  ) {
    return -1;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let at = 1; at < ANCHOR_X.length; at++) {
    const pointX = centreX + ANCHOR_X[at] * cellSize;
    const pointY = centreY + ANCHOR_Y[at] * cellSize;
    if (pointX < minX) minX = pointX;
    if (pointX > maxX) maxX = pointX;
    if (pointY < minY) minY = pointY;
    if (pointY > maxY) maxY = pointY;
  }
  return gatherNear(
    navigation.colliderIndex,
    minX - probeRadius,
    maxX + probeRadius,
    minY - probeRadius,
    maxY + probeRadius,
    undefined
  );
};

/**
 * The eight steps out of a cell: x, y and cost, in the order they are tried.
 * A link is cached under its cell and its index here.
 */
const STEP_X = [-1, 1, 0, 0, -1, 1, -1, 1];
const STEP_Y = [0, 0, -1, 1, -1, -1, 1, 1];
const STEP_COST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

const octileDistance = (ax, ay, bx, by) => {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
};

/** The cells a landing is looked for in, and how near the goal each could hold one; kept between searches as the heap is. */
let landingKeys = new Int32Array(1024);
let landingBounds = new Float64Array(0);
/** How far from its centre a cell's lattice reaches, in cells. */
const LATTICE_REACH = Math.max(...ANCHOR_X.map(Math.abs), ...ANCHOR_Y.map(Math.abs));
/** How much farther from the goal than the nearest anchor a place in sight is looked for, in cells. */
const LOOK_CELLS = 3;
/** How far apart a landing's sight line is asked: under the thinnest board of the nine tile libraries, 6.6 units. */
const SIGHT_STEP = 4;

/**
 * Whether the goal is in sight from (x, y) by a line of no width.
 *
 * `lineIsClear` asks such a line every 16 units, and a swing is let go on
 * that; it is asked first, as it is the cheaper. But a line asked that
 * seldom passes through a board thinner than 16, and a landing is looked for
 * among many places: a knight in a test with a 10-unit wall between it and
 * the hero was sent to the one point of its lattice whose samples fell
 * either side of the wall, and swung through it. So the line is asked again,
 * every `SIGHT_STEP`.
 */
const inSight = (navigation, x, y, goal) => {
  if (!lineIsClear(navigation, x, y, goal.x, goal.y, 0, undefined)) return false;
  const samples = Math.ceil(Math.hypot(goal.x - x, goal.y - y) / SIGHT_STEP);
  for (let at = 1; at < samples; at++) {
    const along = at / samples;
    if (blockedAt(navigation, x + (goal.x - x) * along, y + (goal.y - y) * along, 0, undefined)) return false;
  }
  return true;
};

/**
 * Where a route that cannot reach its goal ends, once the search has run out
 * and so has closed every cell the body can get to: the place in those cells
 * nearest the goal from which the goal is in sight. `{ key, point }`, the
 * cell and the place in it, or null when there is none.
 *
 * In sight is a line of no width from the place to the goal. That is the line
 * a swing is let go on: `victimInSight` (npc-act.js) draws it from the
 * monster's feet, where the route leaves the body, and asks nothing of the
 * body's width. A place is any point of a cell's lattice — the points its
 * anchor was chosen among — where the body fits as at an anchor and which it
 * can walk to straight from the anchor. Anchors alone are too few: between the
 * prison's barrel racks a hero is in sight from a strip of floor a few units
 * wide, which held a point of one reached cell's lattice 151 units from the
 * hero and no anchor nearer than 403.
 *
 * No place in sight, no route: a place the body can stand at but not see
 * from is no use to it, and with no route the AI walks straight at the goal,
 * which is what the official does (routing.js). The landing this replaces,
 * the open cell nearest the goal on the grid, was chosen without asking
 * either: behind the prison's wall from the barrel racks, 201 from the hero,
 * where a knight then stood.
 *
 * Places are looked for no more than three cells farther from the goal than
 * the nearest of the cells' anchors. With no bound the look tries the lattice
 * of every cell the body can reach whenever nothing sees the goal, which made
 * the searches that cannot reach ten times dearer than with it; and of the
 * 1123 heroes in tools/gap-census.js with a place to swing at them from that
 * the monster could reach, it swung at 98.0% with no bound and within three
 * cells alike, and 97.4% within one. The cells are taken by the nearest their
 * lattice could come, and the look ends when that is no nearer than the place
 * in hand, so a goal seen from close by costs a few sight lines.
 */
const placeReached = (navigation, goal, radius, grid, stamp) => {
  const { minX, minY, cellSize, columns, size, anchorOf } = grid;
  if (landingKeys.length < size) landingKeys = new Int32Array(size);
  if (landingBounds.length < size) landingBounds = new Float64Array(size);
  let count = 0;
  let nearestDistance = Infinity;
  for (let key = 0; key < size; key++) {
    if (closedStamps[key] !== stamp) continue;
    nearestDistance = Math.min(nearestDistance, squaredDistance(anchorOf(key), goal));
    landingKeys[count++] = key;
  }
  if (nearestDistance === Infinity) return null;
  const farthest = (Math.sqrt(nearestDistance) + LOOK_CELLS * cellSize) ** 2;
  const reach = LATTICE_REACH * cellSize;
  let kept = 0;
  for (let at = 0; at < count; at++) {
    const key = landingKeys[at];
    const gapX = Math.max(0, Math.abs(minX + ((key % columns) + 0.5) * cellSize - goal.x) - reach);
    const gapY = Math.max(0, Math.abs(minY + (Math.floor(key / columns) + 0.5) * cellSize - goal.y) - reach);
    const bound = gapX * gapX + gapY * gapY;
    if (bound >= farthest) continue;
    landingBounds[key] = bound;
    landingKeys[kept++] = key;
  }
  const order = landingKeys.subarray(0, kept).sort((a, b) => landingBounds[a] - landingBounds[b] || a - b);
  let best = null;
  let bestDistance = farthest;
  for (let at = 0; at < kept && landingBounds[order[at]] < bestDistance; at++) {
    const key = order[at];
    const anchor = anchorOf(key);
    const centreX = minX + ((key % columns) + 0.5) * cellSize;
    const centreY = minY + (Math.floor(key / columns) + 0.5) * cellSize;
    for (let point = 0; point < ANCHOR_X.length; point++) {
      const x = centreX + ANCHOR_X[point] * cellSize;
      const y = centreY + ANCHOR_Y[point] * cellSize;
      const distance = (x - goal.x) ** 2 + (y - goal.y) ** 2;
      if (
        distance >= bestDistance ||
        blockedAt(navigation, x, y, radius + ANCHOR_MARGIN, undefined) ||
        !inSight(navigation, x, y, goal) ||
        !lineIsClear(navigation, anchor.x, anchor.y, x, y, radius, undefined)
      ) {
        continue;
      }
      best = { key, point: { x, y } };
      bestDistance = distance;
    }
  }
  return best;
};

/** A link between two anchors needing no corner; shared, since most are. */
const DIRECT_LINK = Object.freeze({ via: null });

/** A link's cached answer: two bits per direction, eight directions to a cell's 16 bits. */
const LINK_UNKNOWN = 0;
const LINK_NONE = 1;
const LINK_DIRECT = 2;
const LINK_VIA = 3;

/**
 * A* over the authored floor collision geometry, returning compressed world waypoints.
 *
 * The route ends at the goal, or, where the body cannot get there, at the
 * nearest place it can get to with the goal in sight (`placeReached`); such a
 * route carries `endsShort: true`, and what the body does from its end is the
 * AI's (see routing.js). An empty route is no route at all.
 *
 * A cell is open when a body fits somewhere in it, not only at its centre, and
 * the route runs through that spot — the cell's anchor. Asking the centre alone
 * closed any gap the grid happened to straddle: a doorway a knight fits with 26
 * units to spare was found at 9 of 20 alignments to the grid, and the monster
 * stood at it, "blocked", with the player on the other side. Anchors find a gap
 * 12 units wider than the body at every alignment. An open floor costs what it
 * did, since a cell whose centre is clear stops there; the extra probes are
 * spent in cells against a wall.
 */
export const findPath = (navigation, start, goal, radius = 0) => {
  if (!navigation) return [goal];
  if (hasLineOfSight(navigation, start, goal, radius)) return [{ ...goal }];

  const { bounds, cellSize } = navigation;
  const columns = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cellSize));
  const rows = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / cellSize));
  const clamp = (value, max) => Math.max(0, Math.min(max - 1, value));
  const toCell = (point) => ({
    x: clamp(Math.floor((point.x - bounds.minX) / cellSize), columns),
    y: clamp(Math.floor((point.y - bounds.minY) / cellSize), rows),
  });
  const toWorld = (x, y) => ({
    x: bounds.minX + x * cellSize + cellSize / 2,
    y: bounds.minY + y * cellSize + cellSize / 2,
  });
  const keyFor = (x, y) => y * columns + x;
  const cells = routeCacheFor(navigation, radius, columns, rows);
  const SHUT = 1;
  const CENTRED = 2;
  const stateOf = (x, y) => {
    const key = keyFor(x, y);
    if (cells.state[key] === 0) {
      const centreX = bounds.minX + x * cellSize + cellSize / 2;
      const centreY = bounds.minY + y * cellSize + cellSize / 2;
      cells.state[key] = SHUT;
      const probeRadius = radius + ANCHOR_MARGIN;
      // -2 until the centre has been refused; then the gathered count, or -1.
      let gathered = -2;
      for (let at = 0; at < ANCHOR_X.length; at++) {
        const dx = ANCHOR_X[at];
        const dy = ANCHOR_Y[at];
        const pointX = centreX + dx * cellSize;
        const pointY = centreY + dy * cellSize;
        if (at === 1) gathered = gatherProbes(navigation, centreX, centreY, cellSize, probeRadius);
        if (
          gathered >= 0
            ? !withinFloorAt(navigation, pointX, pointY, probeRadius) ||
              !clearOfGathered(pointX, pointY, probeRadius, gathered)
            : blockedAt(navigation, pointX, pointY, probeRadius, undefined)
        ) {
          continue;
        }
        if (dx === 0 && dy === 0) {
          cells.state[key] = CENTRED;
        } else {
          cells.state[key] = 3;
          cells.anchors.set(key, { x: pointX, y: pointY });
        }
        break;
      }
    }
    return cells.state[key];
  };
  /** Where a body can stand in this cell, or null when nowhere in it. */
  const anchorOf = (x, y) => {
    const state = stateOf(x, y);
    if (state === SHUT) return null;
    return state === CENTRED ? toWorld(x, y) : cells.anchors.get(keyFor(x, y));
  };
  const blocked = (x, y) => stateOf(x, y) === SHUT;
  /**
   * How to get from one cell's anchor to its neighbour's: `{ via }`, or null
   * when a body cannot.
   *
   * The step between two anchors has to be walkable, centres included: a thin
   * slanted board can run between two clear centres. Answers are kept per
   * radius, and a collider change forgets only those within its reach
   * (`forgetAround`), so each is worked out once per change near it. When
   * the straight step clips the wall — the
   * anchor in a doorway sits to one side of the centres above and below it — a
   * right-angled one is tried through either corner of the pair, which is the
   * walk into a doorway and out of it.
   */
  const { links, vias: linkVias } = cells;
  /** The step from (fromX, fromY) to its neighbour (toX, toY), which lies in `direction`. */
  const linkBetween = (fromX, fromY, toX, toY, direction) => {
    const fromKey = keyFor(fromX, fromY);
    const shift = direction * 2;
    let known = (links[fromKey] >>> shift) & 3;
    if (known === LINK_UNKNOWN) {
      const link = walkBetween(fromX, fromY, toX, toY);
      known = !link ? LINK_NONE : link.via ? LINK_VIA : LINK_DIRECT;
      if (known === LINK_VIA) linkVias.set(fromKey * 8 + direction, link);
      links[fromKey] = (links[fromKey] & ~(3 << shift)) | (known << shift);
    }
    if (known === LINK_NONE) return null;
    return known === LINK_DIRECT ? DIRECT_LINK : linkVias.get(fromKey * 8 + direction);
  };
  const walkBetween = (fromX, fromY, toX, toY) => walkFrom(anchorOf(fromX, fromY), anchorOf(toX, toY));
  /** How a body walks from one point to another: straight, round a corner, or not at all. */
  const walkFrom = (a, b) => {
    if (lineIsClear(navigation, a.x, a.y, b.x, b.y, radius, undefined)) return DIRECT_LINK;
    // Either corner of the pair, in that order; an object only for the one taken.
    if (
      !blockedAt(navigation, a.x, b.y, radius, undefined) &&
      lineIsClear(navigation, a.x, a.y, a.x, b.y, radius, undefined) &&
      lineIsClear(navigation, a.x, b.y, b.x, b.y, radius, undefined)
    ) {
      return { via: { x: a.x, y: b.y } };
    }
    if (
      !blockedAt(navigation, b.x, a.y, radius, undefined) &&
      lineIsClear(navigation, a.x, a.y, b.x, a.y, radius, undefined) &&
      lineIsClear(navigation, b.x, a.y, b.x, b.y, radius, undefined)
    ) {
      return { via: { x: b.x, y: a.y } };
    }
    return null;
  };
  const startCell = toCell(start);
  const goalCell = toCell(goal);
  const goalKey = keyFor(goalCell.x, goalCell.y);
  /**
   * The goal is a point too. Where the body can stand at it, the route ends
   * there: through its own cell's anchor when the goal can be walked to from
   * that, straight or round a corner, as it always did; else through any of
   * the nine cells round it whose anchor can, judged as the start's step is,
   * since a goal just past the end of the wall that shuts its cell has no
   * anchor of its own. Where it cannot stand — a hero in a slot a knight
   * does not fit — nothing walks to it, the search runs out, and the route
   * ends at the nearest place in sight of it (`placeReached`).
   */
  const stands = !blockedAt(navigation, goal.x, goal.y, radius, undefined);
  const ownAnchor = stands ? anchorOf(goalCell.x, goalCell.y) : null;
  const ownLink = ownAnchor ? walkFrom(ownAnchor, goal) : null;
  /** The goal point as a node of the search, one past the grid. */
  const GOAL = columns * rows;
  const target = ownLink ? goalKey : GOAL;
  const aimX = goalCell.x;
  const aimY = goalCell.y;
  const stamp = beginSearch(GOAL + 1);
  /**
   * Offers a node a way in; taken when it is the cheapest so far. The cell
   * (x, y) measures what is left to the aim: the goal node is offered as its
   * own cell, which is the aim, so nothing is left.
   */
  const offer = (key, x, y, from, nextCost, via) => {
    if (costStamps[key] === stamp && costs[key] <= nextCost) return;
    costStamps[key] = stamp;
    costs[key] = nextCost;
    parentStamps[key] = stamp;
    parents[key] = from;
    viasInto[key] = via;
    heapPush(key, nextCost + octileDistance(x, y, aimX, aimY));
  };
  /**
   * A cell round the goal is asked for its walk to the goal once, when the
   * search reaches it; the goal's own cell was asked above. The walk is the
   * route's last leg, measured in cells like the rest.
   */
  const linkGoalFrom = (key, x, y) => {
    if (key === goalKey || Math.abs(x - goalCell.x) > 1 || Math.abs(y - goalCell.y) > 1) return;
    const anchor = anchorOf(x, y);
    const link = walkFrom(anchor, goal);
    if (!link) return;
    const walk = costs[key] + Math.hypot(goal.x - anchor.x, goal.y - anchor.y) / cellSize;
    offer(GOAL, goalCell.x, goalCell.y, key, walk, link.via);
  };

  /**
   * The start is a point, not a cell: the body stands at `start`, not at its
   * cell's anchor, so its first step is judged from there, into any of the nine
   * cells around it whose anchor it can walk to, its own at no cost. Whether its
   * own cell has an anchor is beside the point — a body stands clear in one that
   * has none, just past the end of the wall that shuts it — and nothing here is
   * cached, since the step is the body's and not the cell's. Left as a cell, in
   * any direction when it had no anchor, a yeti stood 8 units past a wall's end
   * for the rest of a floor: the step north it was given could not be walked,
   * and the step east it could have taken was never asked for. The walk is all
   * that is asked; the rule below against cutting the corner of two colliders
   * is for anchors, and refused a body the clear step north-east it could see.
   */
  const START = -1;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = startCell.x + dx;
      const y = startCell.y + dy;
      if (x < 0 || y < 0 || x >= columns || y >= rows || blocked(x, y)) continue;
      const link = walkFrom(start, anchorOf(x, y));
      if (link) offer(keyFor(x, y), x, y, START, Math.hypot(dx, dy), link.via);
    }
  }

  // The authored floor bounds make this a finite search. Do not impose an
  // arbitrary node ceiling: it turns a valid route on a larger floor into a
  // false "blocked" result, which strands enemies in place for the player.
  while (heapLength) {
    const currentKey = heapPop();
    if (closedStamps[currentKey] === stamp) continue;
    if (currentKey === target) break;
    closedStamps[currentKey] = stamp;
    const currentX = currentKey % columns;
    const currentY = Math.floor(currentKey / columns);

    if (target === GOAL && stands) linkGoalFrom(currentKey, currentX, currentY);

    for (let direction = 0; direction < 8; direction++) {
      const dx = STEP_X[direction];
      const dy = STEP_Y[direction];
      const x = currentX + dx;
      const y = currentY + dy;
      if (x < 0 || y < 0 || x >= columns || y >= rows || blocked(x, y)) continue;
      // Do not cut diagonally through the corner of two colliders.
      if (dx !== 0 && dy !== 0 && (blocked(currentX + dx, currentY) || blocked(currentX, currentY + dy))) {
        continue;
      }
      const link = linkBetween(currentX, currentY, x, y, direction);
      if (!link) continue;
      offer(keyFor(x, y), x, y, currentKey, costs[currentKey] + STEP_COST[direction], link.via);
    }
  }

  let end = target;
  let landing = null;
  if (parentStamps[end] !== stamp) {
    // Not reached, so the search has been everywhere the body can go, and
    // the route ends at the best place in that, short.
    const anchorAt = (key) => anchorOf(key % columns, Math.floor(key / columns));
    const grid = { minX: bounds.minX, minY: bounds.minY, cellSize, columns, size: GOAL, anchorOf: anchorAt };
    const found = placeReached(navigation, goal, radius, grid, stamp);
    if (!found) return [];
    end = found.key;
    landing = found.point;
  }
  const endLink = end === GOAL ? { via: viasInto[GOAL] } : end === goalKey && !landing ? ownLink : null;
  const lastCell = end === GOAL ? parents[GOAL] : end;

  // Walked back from the last cell and turned round once, rather than built by
  // putting each point at the front. A landing off its cell's anchor is
  // walked to straight from it.
  const raw = [];
  for (let key = lastCell; key !== START; key = parents[key]) {
    const anchor = anchorOf(key % columns, Math.floor(key / columns));
    raw.push({ x: anchor.x, y: anchor.y });
    const via = viasInto[key];
    if (via) raw.push({ ...via });
  }
  raw.reverse();
  if (landing && squaredDistance(raw.at(-1), landing) > 0.001) raw.push(landing);

  // Of those, the points a body needs to walk them in turn from the start:
  // each the farthest it can see from the one before. Every point can be
  // walked to from the one before it, the first from the start, so none goes
  // unseen; if one did, a route through a wall is still not handed out.
  const compressed = [];
  let anchor = start;
  for (let index = 0; index < raw.length; ) {
    let farthest = raw.length - 1;
    while (farthest >= index && !hasLineOfSight(navigation, anchor, raw[farthest], radius)) farthest--;
    if (farthest < index) return [];
    compressed.push(raw[farthest]);
    anchor = raw[farthest];
    index = farthest + 1;
  }

  // The last anchor can itself be the corner that clears an obstacle, so the
  // goal follows it rather than replaces it: put in its place, the preceding
  // segment would cut back through that obstacle on a multi-corner route.
  if (endLink) {
    if (endLink.via && squaredDistance(anchor, endLink.via) > 0.001) compressed.push({ ...endLink.via });
    if (squaredDistance(anchor, goal) > 0.001) compressed.push({ ...goal });
  } else if (hasLineOfSight(navigation, anchor, goal, radius)) {
    if (squaredDistance(anchor, goal) > 0.001) compressed.push({ ...goal });
  } else {
    compressed.endsShort = true;
  }
  return compressed;
};
