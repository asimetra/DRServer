import assert from "node:assert/strict";
import test from "node:test";

import { rollNpcRewardDoobers, spawnNpcRewards } from "../src/socket/drops.js";
import { CLID, OP } from "../src/socket/opcodes.js";
import { PacketReader } from "../src/socket/packet.js";

const EXP_SMALL = {
  Id: 30004,
  Constant: "EXP_SMALL",
  DooberType: "EXP",
  Exp: 1,
  Rarity: "COMMON",
};
const GOLD_SMALL = {
  Id: 30001,
  Constant: "GOLD_SMALL",
  DooberType: "COIN",
  Gold: 1,
  Rarity: "COMMON",
};
const CROWD_SMALL = {
  Id: 30010,
  Constant: "CROWD_SMALL",
  DooberType: "CROWD",
  Crowd: 2,
  Rarity: "COMMON",
};

const npc = {
  Constant: "KNIGHT_TUTORIAL",
  CharType: "ENEMY",
  Exp: 20,
  DooberProb: 1,
  MinDoobers: 1,
  MaxDoobers: 1,
};

const rewardData = {
  allDoobers: [EXP_SMALL, GOLD_SMALL, CROWD_SMALL],
  candidates: [GOLD_SMALL, CROWD_SMALL],
  categoryProb: { CROWD: 1 },
  rarityProb: { COMMON: 1 },
};

test("enemy death rolls base XP/gold plus the authored category drop", () => {
  const rewards = rollNpcRewardDoobers(npc, rewardData, () => 0);
  assert.deepEqual(
    rewards.map((reward) => reward.Constant),
    ["EXP_SMALL", "GOLD_SMALL", "CROWD_SMALL"]
  );
});

test("death rewards generate at landing positions and animate from the victim", () => {
  const sent = [];
  let nextDoid = 100;
  const session = {
    id: 7,
    dungeonZone: 10,
    objects: new Map(),
    doobers: new Map(),
    allocateDoid(clid) {
      const doid = nextDoid++;
      this.objects.set(doid, clid);
      return doid;
    },
    send: (frame) => sent.push(frame),
  };

  const spawned = spawnNpcRewards(session, {
    floorDoid: 50,
    npc,
    rewardData,
    origin: { x: 400, y: 600 },
    random: () => 0,
  });

  assert.equal(spawned.length, 3);
  assert.equal(sent.length, 6);
  const crowd = session.doobers.get(102);
  assert.deepEqual(
    {
      constant: crowd.constant,
      gold: crowd.gold,
      xp: crowd.xp,
      crowd: crowd.crowd,
    },
    { constant: "CROWD_SMALL", gold: 0, xp: 0, crowd: 2 }
  );
  assert.ok(Math.abs(Math.hypot(crowd.x - 400, crowd.y - 600) - 90) < 0.001);

  const generate = new PacketReader(sent[0].subarray(2));
  assert.equal(generate.u16(), OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP);
  assert.equal(generate.u32(), 50);
  assert.equal(generate.u32(), 10);
  assert.equal(generate.u16(), CLID.DistributedDooberGameObject);
  assert.equal(generate.u32(), 100);
  assert.equal(generate.u32(), EXP_SMALL.Id);
  assert.equal(generate.f32(), 490);
  assert.equal(generate.f32(), 600);
  assert.equal(generate.u8(), 20);
  assert.equal(generate.eof(), true);

  const spawnFrom = new PacketReader(sent[1].subarray(2));
  assert.equal(spawnFrom.u16(), OP.CLIENT_OBJECT_UPDATE_FIELD);
  assert.equal(spawnFrom.u32(), 100);
  assert.equal(spawnFrom.u16(), 290);
  assert.equal(spawnFrom.f32(), 400);
  assert.equal(spawnFrom.f32(), 600);
  assert.equal(spawnFrom.eof(), true);
});
