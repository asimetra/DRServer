import assert from "node:assert/strict";
import test from "node:test";

import { performNpcAttack } from "../src/socket/combat.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketReader } from "../src/socket/packet.js";
import { handleProposeSelfRevive } from "../src/socket/revive.js";
import { createMatchWorld } from "../src/socket/match-world.js";

const readUpdate = (frame) => {
  const reader = new PacketReader(frame.subarray(2));
  assert.equal(reader.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  return { reader, doid: reader.u32(), fieldId: reader.u16() };
};

const makeSession = ({ healthBombs = 3, partyBombs = 2 } = {}) => {
  const sent = [];
  const saves = [];
  const heroDoid = 10;
  const npcDoid = 20;
  const session = {
    id: 7,
    areaDoid: 30,
    heroDoid,
    /**
     * The bomb is charged to the account's stock, so a session holding none
     * cannot get back up — see spendBomb.
     */
    dungeonAccount: {
      account_stackables: [
        { stack_id: 60001, count: healthBombs },
        { stack_id: 60018, count: partyBombs },
      ],
    },
    queueAccountSave: (target) => saves.push(target.id),
    heroManaPoints: 0,
    maxHeroManaPoints: 250,
    objects: new Map([
      [heroDoid, CLID.HeroGameObject],
      [npcDoid, CLID.DistributedNPCGameObject],
    ]),
    actors: new Map([
      [heroDoid, { hitPoints: 1, maxHitPoints: 200, position: { x: 0, y: 0 } }],
      [npcDoid, { hitPoints: 10, maxHitPoints: 10, position: { x: 40, y: 0 } }],
    ]),
    send: (frame) => sent.push(frame),
  };
  const stock = (stackId) =>
    session.dungeonAccount.account_stackables.find((row) => row.stack_id === stackId).count;
  return { sent, saves, session, heroDoid, npcDoid, stock };
};

test("hero enters the recoverable down state before any defeat", async () => {
  const { sent, session, heroDoid, npcDoid } = makeSession();

  await performNpcAttack(session, npcDoid, {
    attackType: 920050,
    damage: 1,
    impactFrame: 11,
  });

  assert.equal(session.actors.get(heroDoid).dead, true);
  assert.equal(session.floorCleared, undefined);
  /**
   * Read by field rather than by index. A monster's swing and the result of
   * that swing are two messages now — the animation goes out when it starts and
   * the damage when it lands — so counting packets says nothing useful.
   */
  const state = sent.map(readUpdate).find((packet) => packet.fieldId === 157);
  assert.ok(state, "the hero was put into a state");
  assert.equal(state.doid, heroDoid);
  assert.equal(state.reader.utf(), "down");

  // Dropping starts the clock rather than ending the run: the area is told how
  // long there is to get back up, and no dungeonEnding goes with it.
  const failing = sent.map(readUpdate).find((packet) => packet.fieldId === 217);
  assert.ok(failing, "and the clock started");
  assert.equal(failing.doid, session.areaDoid);
  assert.equal(failing.reader.u16(), 60);
});

test("damage to a remote party hero also enters the recoverable down state", async () => {
  const { applyDamage } = await import("../src/socket/combat.js");
  const first = makeSession();
  first.session.accountId = 100;
  first.session.socket = { destroyed: false };
  first.session.allocateDoid = (() => {
    let next = 900;
    return () => next++;
  })();
  const peerSent = [];
  const peer = {
    id: 8,
    accountId: 101,
    heroDoid: 11,
    objects: new Map(),
    actors: new Map(),
    doobers: new Map(),
    socket: { destroyed: false },
    send: (frame) => peerSent.push(frame),
    allocateDoid: first.session.allocateDoid,
  };
  const world = createMatchWorld(
    { id: 1, members: new Set([first.session, peer]) },
    first.session
  );
  world.contextFor(peer);
  world.objects.set(peer.heroDoid, CLID.HeroGameObject);
  world.actors.set(peer.heroDoid, {
    hitPoints: 50,
    maxHitPoints: 150,
    position: { x: 20, y: 0 },
  });
  world.playerActors = new Set([first.heroDoid, peer.heroDoid]);
  world.floorCleared = true;

  applyDamage(world.contextFor(first.session), peer.heroDoid, 50);

  const peerState = peerSent
    .map(readUpdate)
    .find(({ doid, fieldId }) => doid === peer.heroDoid && fieldId === 157);
  assert.ok(peerState, "the remote hero receives a state transition");
  assert.equal(peerState.reader.utf(), "down");
  assert.equal(world.actors.get(peer.heroDoid).dead, true);
  assert.equal(world.objects.has(peer.heroDoid), true, "a downed hero remains revivable");
  world.destroy();
});

test("a health bomb revives with forty percent health and mana", async () => {
  const { sent, session, heroDoid } = makeSession();
  const hero = session.actors.get(heroDoid);
  hero.hitPoints = 0;
  hero.dead = true;

  await handleProposeSelfRevive(session, new PacketReader(Buffer.from([0])));

  assert.equal(hero.dead, false);
  assert.equal(hero.hitPoints, 80);
  assert.equal(session.heroManaPoints, 100);
  assert.equal(hero.healthBombsUsed, 1);
  /**
   * The captured order: the response, the bomb count, the explosion, then the
   * hero's own hit points, Mana and state. 178 is HEALTH_BOMB_ATTACK going off.
   */
  assert.deepEqual(
    sent.map((frame) => readUpdate(frame).fieldId),
    [175, 154, 178, 151, 163, 157]
  );

  const response = readUpdate(sent[0]);
  assert.equal(response.reader.u8(), 1);
  assert.equal(response.reader.u8(), 0);
  const bomb = readUpdate(sent[2]);
  assert.equal(bomb.reader.utf(), "", "an empty state, as both captures send");
  bomb.reader.u8();
  bomb.reader.u8();
  assert.equal(bomb.reader.u32(), 950101, "HEALTH_BOMB_ATTACK");
  const mana = readUpdate(sent[4]);
  assert.equal(mana.reader.u16(), 100);
  const state = readUpdate(sent[5]);
  assert.equal(state.reader.utf(), "");
});

test("a bomb used while up tops the health bar back and still goes off", async () => {
  const { sent, session, stock } = makeSession();
  const hero = session.actors.get(10);
  hero.hitPoints = 40;

  await handleProposeSelfRevive(session, new PacketReader(Buffer.from([1])));

  assert.equal(hero.hitPoints, 200, "reported behaviour: it heals rather than doing nothing");
  assert.equal(stock(60018), 1, "and it costs the bomb either way");
  const fields = sent.map((frame) => readUpdate(frame).fieldId);
  assert.ok(fields.includes(176), "the party bomb names who dropped it");
  assert.ok(fields.includes(178), "and the explosion plays");
});

test("a bomb inside the window calls the defeat off", async () => {
  const { sent, session, heroDoid, npcDoid } = makeSession();

  await performNpcAttack(session, npcDoid, {
    attackType: 920050,
    damage: 1,
    impactFrame: 11,
  });
  assert.ok(session.floorFailingTimer, "the hero is down and the clock is running");

  sent.length = 0;
  await handleProposeSelfRevive(session, new PacketReader(Buffer.from([0])));

  assert.equal(session.floorFailingTimer, null, "and getting up stops it");
  const cancel = readUpdate(sent.at(-1));
  assert.equal(cancel.doid, session.areaDoid);
  assert.equal(cancel.fieldId, 217);
  assert.equal(cancel.reader.u16(), 0, "zero is what stops the counter on screen");
});

/**
 * The stock, from `socket-20260816-210034.jsonl` and the two accountdetails
 * fetches around it: one run with a party revive and a health revive left the
 * account at HEALTH_BOMB 37 → 36 and PARTY_BOMB 3 → 2, with nothing on the wire
 * saying so and no RPC made between entering and returning to town.
 */
test("each bomb is charged to the account, and only the one that was used", async () => {
  const { session, saves, stock } = makeSession({ healthBombs: 37, partyBombs: 3 });
  const hero = session.actors.get(10);

  hero.hitPoints = 0;
  hero.dead = true;
  await handleProposeSelfRevive(session, new PacketReader(Buffer.from([1])));
  assert.deepEqual([stock(60001), stock(60018)], [37, 2], "the party bomb went");

  hero.hitPoints = 0;
  hero.dead = true;
  await handleProposeSelfRevive(session, new PacketReader(Buffer.from([0])));
  assert.deepEqual([stock(60001), stock(60018)], [36, 2], "and then the health bomb");

  assert.deepEqual(saves, [7, 7], "both writes are queued to the account");
});

test("a hero with no bombs left stays down", async () => {
  const { sent, session, stock } = makeSession({ healthBombs: 0 });
  const hero = session.actors.get(10);
  hero.hitPoints = 0;
  hero.dead = true;

  await handleProposeSelfRevive(session, new PacketReader(Buffer.from([0])));

  assert.equal(hero.dead, true, "nothing to spend, so nothing happens");
  assert.equal(stock(60001), 0, "and the count cannot go negative");
  assert.equal(sent.length, 1, "only the refusal");
  const response = readUpdate(sent[0]);
  assert.equal(response.fieldId, 175);
  assert.equal(response.reader.u8(), 0);
});

/**
 * The explosion, from the two revives in `socket-20260816-210034.jsonl`. Field
 * 178 carries an empty state and the bomb's own attack — 910703 for the party
 * bomb, 950101 for the health bomb — with no combat results at all, and the
 * buff that follows is the INVULNERBILITY both attacks author as their
 * SelfBuff.
 */
test("the party bomb plays its own attack, not the health bomb's", async () => {
  const { sent, session } = makeSession();
  const hero = session.actors.get(10);
  hero.hitPoints = 0;
  hero.dead = true;

  await handleProposeSelfRevive(session, new PacketReader(Buffer.from([1])));

  const notice = sent.map(readUpdate).find((update) => update.fieldId === 176);
  assert.ok(notice, "the floor is told who dropped it");
  assert.equal(notice.reader.u32(), 10, "and it names the hero");

  const bomb = sent.map(readUpdate).find((update) => update.fieldId === 178);
  assert.equal(bomb.reader.utf(), "");
  bomb.reader.u8();
  bomb.reader.u8();
  assert.equal(bomb.reader.u32(), 910703, "PARTY_BOMB_ATTACK");
  assert.equal(bomb.reader.u32(), 0, "no target");
  assert.equal(bomb.reader.u8(), 0, "no loop");
  assert.equal(bomb.reader.f32(), 1);
  assert.equal(bomb.reader.f32(), 1);
  assert.equal(bomb.reader.u16(), 0, "and no combat results — the client proposes those");
});

test("a party bomb revives every down hero in the shared world", async () => {
  const first = makeSession({ partyBombs: 2 });
  first.session.accountId = 100;
  first.session.socket = { destroyed: false };
  first.session.allocateDoid = function (clid) {
    const doid = 900 + this.objects.size;
    this.objects.set(doid, clid);
    return doid;
  };
  const peerSent = [];
  const peer = {
    id: 8,
    accountId: 101,
    heroDoid: 11,
    objects: new Map(),
    actors: new Map(),
    doobers: new Map(),
    socket: { destroyed: false },
    send: (frame) => peerSent.push(frame),
    allocateDoid: first.session.allocateDoid,
  };
  const world = createMatchWorld(
    { id: 1, members: new Set([first.session, peer]) },
    first.session
  );
  world.contextFor(peer);
  world.objects.set(peer.heroDoid, CLID.HeroGameObject);
  const caller = world.actors.get(first.heroDoid);
  caller.hitPoints = 0;
  caller.dead = true;
  world.actors.set(peer.heroDoid, {
    hitPoints: 0,
    maxHitPoints: 150,
    dead: true,
    position: { x: 10, y: 0 },
  });

  await handleProposeSelfRevive(
    world.contextFor(first.session),
    new PacketReader(Buffer.from([1]))
  );

  assert.deepEqual(
    [caller.hitPoints, caller.dead, world.actors.get(peer.heroDoid).hitPoints,
      world.actors.get(peer.heroDoid).dead],
    [200, false, 150, false]
  );
  assert.equal(first.stock(60018), 1, "only the caller pays one party bomb");
  assert.ok(
    peerSent.map(readUpdate).some(({ doid, fieldId }) => doid === peer.heroDoid && fieldId === 151),
    "the peer receives authoritative health"
  );
  assert.deepEqual(
    [...new Set(
      peerSent
        .map(readUpdate)
        .filter(({ fieldId }) => fieldId === 178)
        .map(({ doid }) => doid)
    )].sort((a, b) => a - b),
    [first.heroDoid, peer.heroDoid],
    "every hero plays the party-bomb explosion on every client"
  );
});

test("a health revive leaves the invulnerability its attack authors", async () => {
  const { sent, session } = makeSession();
  const hero = session.actors.get(10);
  hero.hitPoints = 0;
  hero.dead = true;

  // grantBuff needs a floor to parent the buff to.
  session.floorDoid = 55;
  session.allocateDoid = () => 900;
  session.objects.set(55, CLID.DistributedDungeonFloor);

  await handleProposeSelfRevive(session, new PacketReader(Buffer.from([0])));

  const creates = sent.filter(
    (frame) => new PacketReader(frame.subarray(2)).u16() === OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP
  );
  assert.equal(creates.length, 1, "one buff object");
  const reader = new PacketReader(creates[0].subarray(2));
  reader.u16();
  reader.u32();
  reader.u32();
  assert.equal(reader.u16(), CLID.DistributedBuffGameObject);
  reader.u32();
  assert.equal(reader.u32(), 35081, "INVULNERBILITY, the id the capture generates");
  assert.equal(reader.u32(), 10, "on the hero that used it");
});

/**
 * Reviving inside the trap that killed you.
 *
 * Both revive bombs author a `SelfBuff` of INVULNERBILITY — five seconds of
 * `INVULNERABLE_ALL` — and the capture generates it against the reviving hero.
 * We granted it and then ignored it: nothing in combat ever asked. So a hero
 * who went down on a spike bed came back on the same spike bed, took a twelfth
 * of the bar a second through what the client was drawing as immunity, and went
 * down again into the same trap.
 *
 * Five seconds is the point. It is not a courtesy, it is how long you have to
 * walk out of whatever killed you.
 */
test("a revived hero is untouchable for long enough to walk out", async () => {
  const { applyDamage } = await import("../src/socket/combat.js");
  const { grantBuff, clearDungeonBuffs } = await import("../src/socket/buffs.js");
  const { CLID } = await import("../src/socket/opcodes.js");

  const heroDoid = 7001;
  const session = {
    id: 40,
    dungeonActive: true,
    heroDoid,
    floorDoid: 8000,
    allocateDoid: (() => { let next = 9000; return () => next++; })(),
    objects: new Map([[heroDoid, CLID.HeroGameObject]]),
    actors: new Map([
      [heroDoid, { hitPoints: 400, maxHitPoints: 400, constant: "RANGER" }],
    ]),
    send: () => {},
  };

  assert.equal(applyDamage(session, heroDoid, 50), true, "ordinarily the spikes bite");
  assert.equal(session.actors.get(heroDoid).hitPoints, 350);

  await grantBuff(session, "INVULNERBILITY", { affectedActor: heroDoid });

  assert.equal(applyDamage(session, heroDoid, 50), false, "and then they do not");
  assert.equal(session.actors.get(heroDoid).hitPoints, 350, "not a point of it");

  clearDungeonBuffs(session);
  assert.equal(applyDamage(session, heroDoid, 50), true, "until it runs out");
  assert.equal(session.actors.get(heroDoid).hitPoints, 300);
});
