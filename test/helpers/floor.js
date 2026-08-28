import { loadGameMaster, npcForConstant } from "../../src/gamemaster.js";
import { buildFloor as layOutFloor, loadFloor } from "../../src/socket/floors.js";
import { loadNavigationLibrary } from "../../src/socket/navigation.js";
import { buildFloorWorld } from "../../src/socket/dungeon.js";
import { CLID } from "../../src/socket/opcodes.js";

/**
 * Builds a real floor in process and hands back what went on the wire.
 *
 * Every test in this repository until now asserted on a fixture assembled by
 * hand — a session literal with the three fields the function under test reads.
 * That catches a wrong formula and nothing else, and the gap showed: a `gm`
 * that was never in scope threw on the first NPC of every floor and 288 tests
 * stayed green, while the game showed a black screen. A heading mirrored twice
 * turned every flipped wall trap around; a mine generated on the enemies' team
 * could not be stepped on. None of them were assertable without a person
 * playing the game and reporting back, which is the real cost.
 *
 * So this builds the floor the server builds, with the real placements, the
 * real navigation and the real spawn path, and records the frames. Assertions
 * are then about what the client would actually receive.
 *
 * It is deliberately not a mock: the only things standing in are the session's
 * own callbacks, which belong to the dungeon rather than the floor.
 */

const FLOOR_DOID = 1002;
const HERO_DOID = 1003;

/** Decodes the header every field update and generate shares. */
export const readFrame = (frame) => {
  const body = frame.subarray(2);
  const op = body.readUInt16LE(0);
  if (op === 134 || op === 135) {
    return {
      op,
      kind: "generate",
      parent: body.readUInt32LE(2),
      zone: body.readUInt32LE(6),
      clid: body.readUInt16LE(10),
      doid: body.readUInt32LE(12),
      body,
    };
  }
  if (op === 124) {
    return { op, kind: "field", doid: body.readUInt32LE(2), field: body.readUInt16LE(6), body };
  }
  if (op === 125 || op === 126) {
    return { op, kind: "disable", doid: body.readUInt32LE(2), body };
  }
  return { op, kind: "other", body };
};

/**
 * The required block of a `DistributedNPCGameObject`, in the order
 * `DistributedNPCGameObjectNetworkComponent.generate` reads it. Kept here
 * rather than in each test so a field added upstream is fixed in one place.
 */
export const readNpc = (body) => {
  let at = 16;
  const u8 = () => body.readUInt8(at++);
  const i8 = () => { const v = body.readInt8(at); at += 1; return v; };
  const u16 = () => { const v = body.readUInt16LE(at); at += 2; return v; };
  const u32 = () => { const v = body.readUInt32LE(at); at += 4; return v; };
  const f32 = () => { const v = body.readFloatLE(at); at += 4; return v; };

  const type = u32();
  const level = u8();
  const x = f32();
  const y = f32();
  const heading = f32();
  const scale = f32();
  const flip = u8();
  const hitPoints = u32();
  const weapons = [];
  for (let slot = 0; slot < 4; slot += 1) {
    weapons.push({ type: u32(), power: u16(), requiredlevel: u8(), rarity: u8() });
    u32(); u32(); u32();
  }
  const stateLength = u16();
  const state = body.toString("utf8", at, at + stateLength);
  at += stateLength;
  return {
    type, level, x, y, heading, scale, flip, hitPoints, weapons, state,
    team: i8(), layer: i8(), triggerState: u8(), masterId: u32(),
  };
};

/**
 * Runs the floor named in the catalogue and returns its traffic.
 *
 * `catalogue` names a floor file directly, so a test does not depend on which
 * node a nickname currently points at.
 */
/**
 * `name` may be an authored floor file or a tile library.
 *
 * A library is laid out first, which is the only way to reach the rules that
 * only apply to a generated floor — `isInert` is gated on `floor.generated`,
 * so on an authored one nothing is ever stranded and half the trap logic is
 * unreachable. Every bug this file holds came from a laid-out floor and none
 * of them could be written down until now.
 */
export const buildFloor = async (name, { npcLevel = 1, tier = null, seed = 1, tileCount = 24 } = {}) => {
  await loadNavigationLibrary();
  const gm = await loadGameMaster();
  const floor = name.endsWith("tiles.json")
    ? await layOutFloor(name.startsWith("Resources/") ? name : `Resources/Levels/${name}`, {
        tier: tier ?? 10,
        tileCount,
        seed,
      })
    : await loadFloor(name);

  const sent = [];
  const session = {
    id: 900,
    dungeonActive: true,
    dungeonEpoch: 1,
    mapNodeId: 50002,
    heroDoid: HERO_DOID,
    floorDoid: FLOOR_DOID,
    floorIndex: 0,
    floorCount: 1,
    npcLevel,
    floorPlan: { floors: [{ authored: name }], tier, npcLevel },
    heroPosition: { x: floor.spawn?.x ?? 0, y: floor.spawn?.y ?? 0 },
    heroSpawn: {
      doid: HERO_DOID,
      heroType: 101,
      skinType: 151,
      playerId: 1,
      screenName: "Test",
      experiencePoints: 0,
      slotPoints: [0, 0, 0, 0],
      weapons: [],
      consumables: [],
      hitPoints: 200,
      manaPoints: 100,
      effectiveHitPoints: 200,
      collisionRadius: 22,
      constant: "RANGER",
    },
    heroManaPoints: 100,
    maxHeroManaPoints: 100,
    dungeonBusterPoints: 0,
    objects: new Map([[FLOOR_DOID, CLID.DistributedDungeonFloor]]),
    actors: new Map(),
    allocateDoid: (() => {
      let next = 1100;
      return (clid) => {
        const doid = next++;
        session.objects.set(doid, clid);
        return doid;
      };
    })(),
    send: (frame) => sent.push(frame),
  };

  const built = await buildFloorWorld(session, {
    floor,
    floorDoid: FLOOR_DOID,
    isActive: () => true,
  });

  const frames = sent.map(readFrame);
  const generates = frames.filter((frame) => frame.kind === "generate");
  const npcs = generates
    .filter((frame) => frame.clid === CLID.DistributedNPCGameObject)
    .map((frame) => ({ ...frame, ...readNpc(frame.body) }));

  /** Attaches the constant to each, which is what a test wants to talk about. */
  const nameOf = new Map();
  for (const row of Object.values(gm.raw).flat()) {
    if (row && row.Id && row.CharType && row.Constant) nameOf.set(row.Id, row.Constant);
  }
  for (const npc of npcs) npc.constant = nameOf.get(npc.type) ?? String(npc.type);

  return { built, session, floor, frames, generates, npcs, gm, npcForConstant };
};

/** Every generate of one constant, which is the usual question. */
export const npcsNamed = (world, constant) =>
  world.npcs.filter((npc) => npc.constant === constant);

export { FLOOR_DOID, HERO_DOID };
