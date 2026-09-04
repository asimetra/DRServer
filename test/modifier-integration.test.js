import test from "node:test";
import assert from "node:assert/strict";

import { statOffsetsFor } from "../src/combat-damage.js";
import { damageTurnedAside, dealTrapHit } from "../src/socket/combat.js";
import { prepareDungeonMember } from "../src/socket/dungeon.js";
import { clearDungeonBuffs } from "../src/socket/buffs.js";
import { createMatchWorld } from "../src/socket/match-world.js";
import { CLID } from "../src/socket/opcodes.js";

const member = (id, heroDoid, heroWeapons = []) => {
  const sent = [];
  let nextDoid = id * 1000;
  return {
    id,
    accountId: id,
    heroDoid,
    heroWeapons,
    objects: new Map(),
    actors: new Map(),
    doobers: new Map(),
    activeBuffs: new Map(),
    invulnerableUntil: new Map(),
    socket: { destroyed: false },
    sent,
    send: (frame) => sent.push(frame),
    allocateDoid() {
      nextDoid += 1;
      return nextDoid;
    },
  };
};

const twoPlayerWorld = ({ peerWeapons }) => {
  const host = member(701, 1701);
  const peer = member(702, 1702, peerWeapons);
  host.objects.set(host.heroDoid, CLID.HeroGameObject);
  host.objects.set(peer.heroDoid, CLID.HeroGameObject);
  host.actors.set(host.heroDoid, {
    hitPoints: 100,
    maxHitPoints: 100,
    position: { x: 0, y: 0 },
    team: 1,
  });
  host.actors.set(peer.heroDoid, {
    hitPoints: 100,
    maxHitPoints: 100,
    position: { x: 20, y: 0 },
    team: 1,
  });
  host.playerActors = new Set([host.heroDoid, peer.heroDoid]);

  const world = createMatchWorld({ id: 77, members: new Set([host, peer]) }, host);
  world.contextFor(peer);
  return { host, peer, world, context: world.contextFor(host) };
};

test("legendary shields follow attack type instead of the cross-wired defence column", () => {
  const HERO = 500;
  const session = {
    heroDoid: HERO,
    heroWeapons: [{ legendarymodifier: 10 }], // Barrier: melee
    activeBuffs: new Map(),
  };

  assert.equal(
    damageTurnedAside(session, HERO, new Map(), statOffsetsFor({ AttackType: "MELEE" })),
    0.5,
    "Barrier did not reduce melee damage"
  );
  assert.equal(
    damageTurnedAside(session, HERO, new Map(), statOffsetsFor({ AttackType: "SHOOTING" })),
    0,
    "Barrier incorrectly reduced ranged damage"
  );
});

test("a shared hazard uses the victim member's legendary shield", () => {
  const { peer, context } = twoPlayerWorld({
    peerWeapons: [{ legendarymodifier: 10 }], // Barrier
  });

  assert.equal(
    damageTurnedAside(context, peer.heroDoid, new Map(), statOffsetsFor({ AttackType: "MELEE" })),
    0.5,
    "the peer's Barrier was replaced by the host's loadout"
  );
});

test("typed legendary shields also cover percent-health trap attacks", async () => {
  const { peer, world, context } = twoPlayerWorld({
    peerWeapons: [{ legendarymodifier: 10 }], // Barrier
  });
  const trapDoid = 9900;
  world.objects.set(trapDoid, CLID.DistributedNPCGameObject);
  world.actors.set(trapDoid, {
    hitPoints: 1,
    maxHitPoints: 1,
    position: { x: 0, y: 0 },
    team: 2,
    constant: "SPIKE_TRAP",
  });

  await dealTrapHit(
    context,
    trapDoid,
    {
      Id: 1,
      Constant: "TEST_SPIKES",
      AttackType: "MELEE",
      Team: "HOSTILE",
      DoPercentHealthDamage: true,
      PercentHealthDamageValue: 0.12,
    },
    peer.heroDoid
  );

  assert.equal(world.actors.get(peer.heroDoid).hitPoints, 94, "Barrier did not halve the 12-point trap hit");
});

test("Admiral's Luck is read from the remote victim, not the hazard owner", async () => {
  const { peer, world, context } = twoPlayerWorld({
    peerWeapons: [{ legendarymodifier: 6 }],
  });
  const trapDoid = 9901;
  world.objects.set(trapDoid, CLID.DistributedNPCGameObject);
  world.actors.set(trapDoid, {
    hitPoints: 1,
    maxHitPoints: 1,
    position: { x: 0, y: 0 },
    team: 2,
    constant: "SPIKE_TRAP",
  });

  await dealTrapHit(
    context,
    trapDoid,
    {
      Id: 2,
      Constant: "TEST_SPIKES",
      AttackType: "MELEE",
      Team: "HOSTILE",
      DoPercentHealthDamage: true,
      PercentHealthDamageValue: 0.12,
    },
    peer.heroDoid
  );

  assert.equal(world.actors.get(peer.heroDoid).hitPoints, 91, "Admiral's Luck did not reduce 12 to 9");
});

test("Aptitude raises the authoritative mana ceiling while the wire stays base", async () => {
  const avatar = {
    id: 8106,
    avatar_id: 106,
    experience: 5_249_298,
    statupgrade1: 0,
    statupgrade2: 75,
    statupgrade3: 75,
    statupgrade4: 50,
  };
  const account = {
    id: 806,
    name: "Aptitude",
    active_avatar: avatar.id,
    basic_currency: 0,
    account_avatars: [avatar],
    account_items: [{
      avatar_id: avatar.id,
      avatar_slot: 0,
      item_id: 12502,
      power: 30,
      requiredlevel: 98,
      rarity: 4,
      modifier1: 0,
      modifier2: 0,
      legendarymodifier: 2,
    }],
  };
  const session = member(account.id, 0);
  session.dungeonZone = 1;

  await prepareDungeonMember(session, { account, sendPlayerOwner: false });

  assert.equal(session.heroSpawn.manaPoints, 80, "the wire value counted Aptitude twice");
  assert.equal(session.heroManaPoints, 80, "the current mana no longer matches the wire");
  assert.equal(session.maxHeroManaPoints, 129, "the server discarded Aptitude's 49-point ceiling");
});

test("damage-over-time ownership state is shared and cleared with the floor", () => {
  const host = member(711, 1711);
  const peer = member(712, 1712);
  host.damageOverTimeByBuff = new Map();
  host.damageOverTimeTimers = new Set();
  const world = createMatchWorld({ id: 78, members: new Set([host, peer]) }, host);
  const hostContext = world.contextFor(host);
  const peerContext = world.contextFor(peer);

  assert.equal(
    hostContext.damageOverTimeByBuff,
    peerContext.damageOverTimeByBuff,
    "two players can start separate clocks for the same shared buff"
  );

  const timer = setInterval(() => {}, 60_000);
  timer.unref?.();
  hostContext.damageOverTimeTimers.add(timer);
  hostContext.damageOverTimeByBuff.set(123, timer);
  clearDungeonBuffs(hostContext);

  assert.equal(hostContext.damageOverTimeTimers.size, 0);
  assert.equal(hostContext.damageOverTimeByBuff.size, 0, "floor teardown retained stale buff clocks");

  const teardownTimer = setInterval(() => {}, 60_000);
  teardownTimer.unref?.();
  hostContext.damageOverTimeTimers.add(teardownTimer);
  hostContext.damageOverTimeByBuff.set(124, teardownTimer);
  world.quiesce();
  assert.equal(hostContext.damageOverTimeByBuff.size, 0, "match teardown retained stale buff clocks");
});
