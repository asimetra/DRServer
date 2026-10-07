import assert from "node:assert/strict";
import test from "node:test";

import { createRankedService } from "../src/modes/ranked/index.js";
import { createRecords } from "../src/modes/ranked/records.js";
import { createSpec, fixedPicker } from "../src/modes/ranked/race-spec.js";
import { createStockClientAdapter } from "../src/modes/ranked/stock-client/adapter.js";
import { createLobbyCopies, swingWithoutTargets } from "../src/modes/copies.js";
import { SYSTEM_FRIEND_ID } from "../src/modes/ranked/stock-client/system-friend.js";
import { CLID } from "../src/socket/opcodes.js";

const A = 1000000101;
const B = 1000000202;
const C = 1000000303;
const D = 1000000404;

/** What the runtime's builders would send, as records a test can read. */
const frames = {
  player: (details) => ({ kind: "player", ...details }),
  hero: (details) => ({ kind: "hero", ...details }),
  position: (doid, at) => ({ kind: "position", doid, at: { ...at } }),
  heading: (doid, heading) => ({ kind: "heading", doid, heading }),
  afk: (doid, afk) => ({ kind: "afk", doid, afk }),
  attack: (doid, payload, skinType) => ({ kind: "attack", doid, payload, skinType }),
  stopAttack: (doid) => ({ kind: "stopAttack", doid }),
  disable: (doid) => ({ kind: "disable", doid }),
};

/** A lobby player's world, as much of it as a copy touches. */
const lobbyWorld = (accountId, { skinType = 151, at = { x: 4000, y: 4200 } } = {}) => {
  let doid = 9000;
  return {
    accountId,
    floorDoid: 500,
    areaDoid: 400,
    dungeonZone: 10,
    floorFinished: false,
    objects: new Map(),
    allocateDoid: () => (doid += 1),
    sent: [],
    sendDirect(frame) {
      this.sent.push(frame);
    },
    heroSpawn: { heroType: 101, skinType, scale: 1.176, hitPoints: 205, playerId: 77, screenName: `Real${accountId}` },
    heroPosition: { ...at },
    heroHeading: 0,
    idleState: null,
  };
};

const lobbyOf = (ids, { most = 8 } = {}) => {
  const worlds = new Map(ids.map((id, i) => [id, lobbyWorld(id, { skinType: 151 + i, at: { x: 4000 + i * 10, y: 4200 } })]));
  const copies = createLobbyCopies({ most, sessionOf: (id) => worlds.get(id), contextOf: (world) => world, frames });
  const sentTo = (id, kind) => worlds.get(id).sent.filter((frame) => !kind || frame.kind === kind);
  const up = (...who) => who.forEach((id) => copies.floorUp(id, worlds.get(id).floorDoid));
  return { worlds, copies, sentTo, up };
};

test("each lobby is shown the others waiting, nameless, once its floor is up", () => {
  const { worlds, copies, sentTo, up } = lobbyOf([A, B]);
  up(A, B);
  copies.sync([A, B]);

  const [player] = sentTo(A, "player");
  const [hero] = sentTo(A, "hero");
  assert.equal(player.screenName, "", "an empty name draws no text");
  assert.equal(hero.screenName, "");
  assert.equal(hero.playerId, player.doid, "the hero points at its own player object");
  assert.equal(hero.skinType, worlds.get(B).heroSpawn.skinType, "B as B looks");
  assert.deepEqual(hero.position, worlds.get(B).heroPosition, "standing where B stands");
  assert.equal(hero.parent, worlds.get(A).floorDoid);
  assert.equal(worlds.get(A).objects.get(hero.doid), CLID.HeroGameObject, "kept among the world's objects, for the floor to take");
  assert.deepEqual(copies.shownTo(A), [B]);
  assert.deepEqual(copies.shownTo(B), [A]);

  copies.sync([A, B]);
  assert.equal(sentTo(A, "hero").length, 1, "made once");
});

test("nothing is made on a floor that is not up, or is ending", () => {
  const { worlds, copies, sentTo, up } = lobbyOf([A, B]);
  up(B);
  copies.sync([A, B]);
  assert.equal(sentTo(B).length, 0, "A has not asked for its hero yet, so there is nothing of A to copy");
  assert.equal(sentTo(A).length, 0);

  up(A);
  worlds.get(A).floorFinished = true;
  copies.sync([A, B]);
  assert.equal(sentTo(A).length, 0, "A's floor is ending: a copy made now would have no parent");
  assert.equal(sentTo(B, "hero").length, 1);
});

test("a copy follows its player: steps, turns, swings aimed at nothing, the away mark", () => {
  const { copies, sentTo, up } = lobbyOf([A, B]);
  up(A, B);
  copies.sync([A, B]);
  const [hero] = sentTo(A, "hero");

  copies.moved(B, { x: 4100, y: 4150 });
  copies.turned(B, 1.5);
  const swing = Buffer.alloc(21 + 37, 7);
  swing.writeUInt16LE(37, 19);
  copies.swung(B, swing);
  copies.swingStopped(B);
  copies.afk(B, true);

  const kinds = sentTo(A).slice(2).map((frame) => [frame.kind, frame.doid]);
  assert.deepEqual(kinds, [
    ["position", hero.doid],
    ["heading", hero.doid],
    ["attack", hero.doid],
    ["stopAttack", hero.doid],
    ["afk", hero.doid],
  ]);
  const [attack] = sentTo(A, "attack");
  assert.equal(attack.payload.readUInt32LE(6), 0, "no target");
  assert.equal(attack.payload.readUInt16LE(19), 0, "no results");
  assert.equal(attack.payload.length, 21);
  assert.equal(attack.skinType, hero.skinType);
  assert.equal(sentTo(B).filter((frame) => frame.kind !== "player" && frame.kind !== "hero").length, 0, "nothing of B's to B");
});

test("at most `most` copies each, and nobody left unseen while there is room", () => {
  const ids = [A, B, C, D];
  const { copies, up } = lobbyOf(ids, { most: 2 });
  up(...ids);
  copies.sync(ids);
  for (const id of ids) {
    assert.equal(copies.shownTo(id).length, 2, `${id} is shown two`);
    assert.ok(!copies.shownTo(id).includes(id), "never itself");
    assert.ok(copies.seenBy(id) >= 1, `${id} is seen by somebody`);
  }
});

test("a newcomer takes the places that free, until seen as much as the others", () => {
  const ids = Array.from({ length: 10 }, (_, i) => 1000000500 + i);
  const newcomer = 1000000599;
  const { copies, up } = lobbyOf([...ids, newcomer], { most: 8 });
  up(...ids);
  copies.sync(ids);
  assert.ok(ids.every((id) => copies.shownTo(id).length === 8), "every place is taken");

  up(newcomer);
  copies.sync([...ids, newcomer]);
  assert.equal(copies.shownTo(newcomer).length, 8, "the newcomer is shown the others at once");
  assert.equal(copies.seenBy(newcomer), 0, "but nobody has a free place for them yet");

  const [leaving, ...staying] = ids;
  copies.leave(leaving);
  copies.sync([...staying, newcomer]);
  const leastOfTheOthers = Math.min(...staying.map((id) => copies.seenBy(id)));
  assert.ok(copies.seenBy(newcomer) >= 1, "seen as soon as a place frees");
  assert.ok(
    copies.seenBy(newcomer) >= leastOfTheOthers - 1,
    `seen by ${copies.seenBy(newcomer)}, the least seen of the others by ${leastOfTheOthers}`
  );
});

test("one who leaves the lobby leaves every other; their own copies go with their floor", () => {
  const { copies, sentTo, up } = lobbyOf([A, B, C]);
  up(A, B, C);
  copies.sync([A, B, C]);
  const before = sentTo(A).length;

  copies.leave(A);
  assert.equal(sentTo(B, "disable").length, 2);
  assert.equal(sentTo(C, "disable").length, 2);
  assert.equal(sentTo(A).length, before, "nothing sent to A: the floor's end disables what it held");
  copies.sync([B, C]);
  assert.deepEqual(copies.shownTo(B), [C]);
});

test("a new floor under a viewer took its copies; new ones come once that floor is up", () => {
  const { worlds, copies, sentTo, up } = lobbyOf([A, B]);
  up(A, B);
  copies.sync([A, B]);
  worlds.get(A).floorDoid = 600;
  copies.sync([A, B]);
  assert.deepEqual(copies.shownTo(A), []);
  assert.equal(sentTo(A, "disable").length, 0, "the old floor's end disabled them");

  up(A);
  copies.sync([A, B]);
  const heroes = sentTo(A, "hero");
  assert.equal(heroes.length, 2);
  assert.equal(heroes[1].parent, 600);
  assert.notEqual(heroes[1].doid, heroes[0].doid);
});

test("a step a copy missed is caught up once a second", () => {
  const { worlds, copies, sentTo, up } = lobbyOf([A, B]);
  up(A, B);
  copies.sync([A, B]);
  worlds.get(B).heroPosition = { x: 3900, y: 4000 };
  copies.sync([A, B]);
  assert.deepEqual(sentTo(A, "position").map((frame) => frame.at), [{ x: 3900, y: 4000 }]);
  copies.sync([A, B]);
  assert.equal(sentTo(A, "position").length, 1, "and only once");
});

test("a swing too short to hold results keeps what it has, aimed at nothing", () => {
  const short = Buffer.alloc(12, 9);
  const kept = swingWithoutTargets(short);
  assert.equal(kept.length, 12);
  assert.equal(kept.readUInt32LE(6), 0);
  assert.equal(swingWithoutTargets(Buffer.alloc(4)).length, 4);
});

/** Through the adapter: the lobby's players, their hooks, and a race that takes two away. */
test("in the adapter, the two who start racing leave the lobby that stays", async () => {
  let now = 0;
  const worlds = new Map();
  const service = createRankedService({
    records: createRecords({ storage: "memory" }),
    picker: fixedPicker(createSpec({ mapNodeId: 50006, seed: 42 })),
    rules: { countdownMs: 10_000, maxDurationMs: 1_800_000, forfeitWindowMs: 120_000, drawWindowMs: 5000 },
    clock: () => now,
    start: (race) => adapter.start(race),
  });
  const adapter = createStockClientAdapter({
    service,
    settings: { lobbyNode: 50003, lobbyFloor: "castle/arena/lobby.json", lobbyIdleMs: 300_000, ring: null, lobbySpawn: null, lobbyCopies: 8 },
    sessionOf: (id) => worlds.get(id),
    contextOf: (world) => world,
    say: () => {},
    raceFloors: async () => [{ generated: { tileLibrary: "nordic", seed: 1 }, node: { Id: 50006 } }],
    completeFloor: (world) => {
      if (!adapter.hooks.floorCompleting(world)) return false;
      world.floorIndex += 1;
      world.floorDoid += 1;
      return true;
    },
    copyFrames: frames,
    clock: () => now,
  });
  service.onNotice(adapter.onNotice);

  for (const id of [A, B, C]) {
    const request = adapter.hooks.routeEntry({ accountId: id }, { mapNodeId: 0, friendId: SYSTEM_FRIEND_ID, mapId: 0 });
    const plan = await adapter.hooks.planFor({ accountId: id }, request.mapNodeId);
    const world = Object.assign(lobbyWorld(id), { floorIndex: 0, floorPlan: plan, floorCount: plan.floors.length });
    worlds.set(id, world);
    adapter.hooks.heroRequested(world);
  }
  adapter.sweep();
  assert.deepEqual(adapter.copiesShownTo(C).sort(), [A, B].sort());

  adapter.hooks.heroEvent(worlds.get(A), { type: "moved", position: { x: 4321, y: 4123 } });
  assert.ok(worlds.get(C).sent.some((frame) => frame.kind === "position" && frame.at.x === 4321));

  now = 1000;
  await service.tick();
  now = 12_000;
  await service.tick();
  await new Promise((resolve) => setImmediate(resolve));
  const racing = [A, B].filter((id) => adapter.players.get(id)?.phase === "race");
  assert.equal(racing.length, 2, "A and B, who came first, were paired and started");
  assert.equal(worlds.get(C).sent.filter((frame) => frame.kind === "disable").length, 4, "both copies leave C's lobby");
  adapter.sweep();
  assert.deepEqual(adapter.copiesShownTo(C), []);

  const sentBefore = worlds.get(C).sent.length;
  adapter.hooks.heroEvent(worlds.get(A), { type: "moved", position: { x: 1, y: 1 } });
  assert.equal(worlds.get(C).sent.length, sentBefore, "a racer's steps are nobody's copy");
});

test("a copy may be named, shaded with a buff, and shown only where a rule allows", () => {
  const worlds = new Map([[A, lobbyWorld(A)], [B, lobbyWorld(B, { skinType: 152, at: { x: 4100, y: 4200 } })]]);
  const allowed = new Set();
  const told = [];
  const copies = createLobbyCopies({
    most: 1,
    sessionOf: (id) => worlds.get(id),
    contextOf: (world) => world,
    frames: { ...frames, buff: (details) => ({ kind: "buff", ...details }) },
    visibleTo: (viewer, subject) => allowed.has(`${viewer}:${subject}`),
    name: "RIVAL",
    buff: 35092,
    onShown: (viewer, subject) => told.push([viewer, subject]),
  });
  const sentTo = (id, kind) => worlds.get(id).sent.filter((frame) => frame.kind === kind);
  copies.floorUp(A, 500);
  copies.floorUp(B, 500);

  copies.sync([A, B]);
  assert.equal(sentTo(A, "hero").length + sentTo(B, "hero").length, 0, "nothing until the rule allows it");

  allowed.add(`${A}:${B}`);
  copies.sync([A, B]);
  const [player] = sentTo(A, "player");
  const [hero] = sentTo(A, "hero");
  const [shade] = sentTo(A, "buff");
  assert.equal(player.screenName, "RIVAL");
  assert.equal(hero.screenName, "RIVAL");
  assert.deepEqual(
    { buffType: shade.buffType, affectedActor: shade.affectedActor, attackerActor: shade.attackerActor, parent: shade.parent },
    { buffType: 35092, affectedActor: hero.doid, attackerActor: hero.doid, parent: 500 }
  );
  assert.ok(worlds.get(A).objects.has(shade.doid), "the shade is the world's, so the floor's end takes it too");
  assert.deepEqual(told, [[A, B]]);
  assert.equal(sentTo(B, "hero").length, 0, "seeing is as the rule says, not mutual");

  allowed.delete(`${A}:${B}`);
  copies.sync([A, B]);
  assert.deepEqual(sentTo(A, "disable").map((frame) => frame.doid), [shade.doid, hero.doid, player.doid]);
  assert.equal(worlds.get(A).objects.size, 0);
});

test("a copy's tag may be the subject's own: a league mark for some, nothing for the rest", () => {
  const worlds = new Map([A, B, C].map((id, i) => [id, lobbyWorld(id, { skinType: 151 + i, at: { x: 4000 + i * 10, y: 4200 } })]));
  const copies = createLobbyCopies({
    most: 8,
    sessionOf: (id) => worlds.get(id),
    contextOf: (world) => world,
    frames,
    name: (subject) => (subject === B ? "★" : ""),
  });
  for (const id of [A, B, C]) copies.floorUp(id, worlds.get(id).floorDoid);
  copies.sync([A, B, C]);
  const tags = worlds.get(A).sent.filter((f) => f.kind === "hero").map((f) => f.screenName).sort();
  assert.deepEqual(tags, ["", "★"], "B wears the star in A's lobby, C wears nothing");
  assert.deepEqual(worlds.get(B).sent.filter((f) => f.kind === "hero").map((f) => f.screenName), ["", ""], "and B sees two plain copies");
});
