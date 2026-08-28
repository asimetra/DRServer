/**
 * Shared dungeon state for a live match.
 *
 * This is intentionally small: it provides one world object plus member
 * contexts that can later be handed to existing dungeon code without changing
 * every call site at once.
 */

import { CLID, OP } from "./opcodes.js";

const MATCH_WORLD = Symbol("match-world");

const SPECIAL_FIELDS = new Set([
  "member",
  "world",
  "send",
  "sendDirect",
  "broadcast",
  "allocateDoid",
]);

/**
 * Shared state copied out of the seed member because it belongs to the run or
 * floor rather than to any one player.
 *
 * Account rows, hero identity, movement, rewards and anti-cheat ledgers stay
 * on the individual member session.
 */
export const MATCH_WORLD_SHARED_FIELDS = new Set([
  "objects",
  "actors",
  "doobers",
  "dungeonActive",
  "dungeonEpoch",
  "dungeonZone",
  "mapNodeId",
  "floorPlan",
  "currentFloor",
  "floorCount",
  "floorIndex",
  "npcLevel",
  "floorGenerated",
  "npcDepthBonus",
  "tierConstant",
  "mapPage",
  "areaDoid",
  "floorDoid",
  "navigation",
  "npcDoids",
  "generators",
  "generatorStops",
  "armedTraps",
  "inertTraps",
  "stuckArmed",
  "signalTargets",
  "signalIncoming",
  "signalValues",
  "logicGates",
  "logicGateTimers",
  "generatorHandlers",
  "gateCounts",
  "gateEdges",
  "gateInputEdges",
  "gateLatches",
  "movableSources",
  "virtualTriggerables",
  "triggerableNames",
  "triggerableDoids",
  "triggerableHazards",
  "triggerableAttacks",
  "triggerableStatefulAttacks",
  "trapNames",
  "tracePattern",
  "triggers",
  "turretAims",
  "hazardBeats",
  "floorFailingTimer",
  "floorFinished",
  "floorSettled",
  "victoryTimer",
  "victoryDelayMs",
  "floorCleared",
  "rewardGenerators",
  "floorExits",
  "floorTransition",
  "debugTriggers",
  "debugAi",
  "suicideFired",
  "playerActors",
  "activeBuffs",
  "buffTimers",
  "damageOverTimeTimers",
  "invulnerableUntil",
  "placeables",
  "placeableSpawnTimers",
  "powerupSpawnTimers",
  "powerupCooldownUntil",
  "dooberTimers",
  "activeTrapProjectiles",
  "stopTrapProjectiles",
  "stopTriggers",
  "stopAi",
  "completeFloor",
  "showFloorText",
  "playFloorSound",
  "reportFloorFailed",
  "killAllEnemies",
  "advanceFloor",
]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isSharedField = (key) => typeof key === "string" && MATCH_WORLD_SHARED_FIELDS.has(key);
const isMatchWorld = (value) => Boolean(value?.[MATCH_WORLD]);

const activeMembersOf = (match) => {
  if (match?.members instanceof Set) return match.members;
  const members = new Set();
  if (match) match.members = members;
  return members;
};

const attachMember = (world, member) => {
  if (!member) return member;
  if (world.destroyed) throw new Error("cannot attach a member to a destroyed match world");
  if (shouldSkipMember(member, null)) throw new Error("cannot attach a closed match member");
  activeMembersOf(world.match).add(member);
  world.liveMembers.add(member);
  member.world = world;
  return member;
};

const directSendOf = (member) =>
  typeof member?.send === "function" ? member.send.bind(member) : undefined;

const bodyOf = (frame) =>
  Buffer.isBuffer(frame) && frame.length >= 4 ? frame.subarray(2) : null;

const updateKey = (doid, fieldId) => `${doid}:${fieldId}`;

/** DistributedNPCGameObject::state(String). */
const NPC_STATE_FIELD = 138;

const isNpcDeathState = (body, clid, fieldId) => {
  if (clid !== CLID.DistributedNPCGameObject || fieldId !== NPC_STATE_FIELD) return false;
  if (body.length < 10) return false;
  const length = body.readUInt16LE(8);
  return body.length >= 10 + length && body.toString("utf8", 10, 10 + length) === "dead";
};

const isMemberClass = (clid) =>
  clid === CLID.PlayerGameObject || clid === CLID.HeroGameObject;

const shouldSkipMember = (member, except) =>
  !member ||
  member === except ||
  member.closed === true ||
  member.destroyed === true ||
  member.socket?.destroyed === true;

const forgetSnapshotObject = (world, doid) => {
  const pending = [doid];
  const forgotten = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (forgotten.has(current)) continue;
    forgotten.add(current);
    for (const entry of world.snapshotCreates.values()) {
      if (entry.parent === current) pending.push(entry.doid);
    }
  }

  for (const current of forgotten) world.snapshotCreates.delete(current);
  for (const [key, update] of world.snapshotUpdates) {
    if (forgotten.has(update.doid)) world.snapshotUpdates.delete(key);
  }
  return forgotten.size;
};

const snapshotSharedState = (world, seedSession) => {
  world.objects = new Map(
    [...(seedSession?.objects ?? [])].filter(
      ([doid]) =>
        doid !== seedSession?.matchMakerDoid &&
        doid !== seedSession?.presenceDoid
    )
  );
  world.actors = new Map(seedSession?.actors);
  world.doobers = new Map(seedSession?.doobers);
  for (const key of MATCH_WORLD_SHARED_FIELDS) {
    if (key === "objects" || key === "actors" || key === "doobers") continue;
    if (hasOwn(seedSession ?? {}, key) && seedSession[key] !== undefined) {
      world[key] = seedSession[key];
    }
  }
};

const proxyHandlerFor = (world, member) => ({
  get(_target, key) {
    if (key === "member") return member;
    if (key === "world") return world;
    if (key === "send") return (frame) => world.publish(member, frame);
    if (key === "sendDirect") return (frame) => world.sendDirect(member, frame);
    if (key === "broadcast") return (frame, options) => world.broadcast(frame, options);
    if (key === "allocateDoid") return world.allocateDoid.bind(world);

    const owner = isSharedField(key) ? world : member;
    const value = owner?.[key];
    return typeof value === "function" ? value.bind(owner) : value;
  },
  set(_target, key, value) {
    if (key === "member" || key === "world") return false;
    const owner = isSharedField(key) ? world : member;
    owner[key] = value;
    if (key === "floorIndex" && world.match) world.match.floorIndex = value;
    return true;
  },
  deleteProperty(_target, key) {
    if (key === "member" || key === "world") return false;
    const owner = isSharedField(key) ? world : member;
    return delete owner[key];
  },
  has(_target, key) {
    if (SPECIAL_FIELDS.has(String(key))) return true;
    const owner = isSharedField(key) ? world : member;
    return key in owner;
  },
  ownKeys() {
    return [...new Set([...Reflect.ownKeys(member), ...Reflect.ownKeys(world), ...SPECIAL_FIELDS])];
  },
  getOwnPropertyDescriptor(_target, key) {
    if (SPECIAL_FIELDS.has(String(key))) {
      return { configurable: true, enumerable: false };
    }
    const owner = isSharedField(key) ? world : member;
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    return descriptor ? { ...descriptor, configurable: true } : undefined;
  },
});

export const createMatchWorld = (match, seedSession) => {
  if (isMatchWorld(match?.world)) return match.world;
  if (!match) throw new Error("createMatchWorld needs a match");
  if (!seedSession?.allocateDoid) throw new Error("createMatchWorld needs a seed session allocator");

  let settleReady;
  const readyPromise = new Promise((resolve) => {
    settleReady = resolve;
  });
  const world = {
    [MATCH_WORLD]: true,
    match,
    active: true,
    destroyed: false,
    ready: false,
    readyPromise,
    contexts: new WeakMap(),
    liveMembers: new Set(),
    snapshotCreates: new Map(),
    snapshotUpdates: new Map(),
    snapshotClosure: null,
    allocateDoid(clid) {
      return seedSession.allocateDoid.call(this, clid);
    },
    observe(frame) {
      const body = bodyOf(frame);
      if (!body) return false;
      const opcode = body.readUInt16LE(0);

      if (
        opcode === OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP ||
        opcode === OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_RESP
      ) {
        if (body.length < 16) return false;
        const parent = body.readUInt32LE(2);
        const zone = body.readUInt32LE(6);
        const clid = body.readUInt16LE(10);
        const doid = body.readUInt32LE(12);
        if (isMemberClass(clid)) return false;
        this.snapshotCreates.set(doid, { frame: Buffer.from(frame), doid, clid, parent, zone });
        return true;
      }

      if (opcode === OP.CLIENT_OBJECT_UPDATE_FIELD) {
        if (body.length < 8) return false;
        const doid = body.readUInt32LE(2);
        const fieldId = body.readUInt16LE(6);
        const clid = this.objects.get(doid);
        // Current members must see the death animation, but a future member
        // must not recreate the corpse and immediately replay that animation.
        // Forget at the terminal state rather than waiting for a later disable:
        // some corpses remain on the live floor until its final teardown.
        if (isNpcDeathState(body, clid, fieldId)) {
          forgetSnapshotObject(this, doid);
          return true;
        }
        if (!clid || isMemberClass(clid) || !this.snapshotCreates.has(doid)) return false;
        this.snapshotUpdates.set(updateKey(doid, fieldId), {
          frame: Buffer.from(frame),
          doid,
          fieldId,
        });
        return true;
      }

      if (
        opcode === OP.CLIENT_OBJECT_DISABLE_RESP ||
        opcode === OP.CLIENT_OBJECT_DELETE_RESP
      ) {
        if (body.length < 6) return false;
        const doid = body.readUInt32LE(2);
        forgetSnapshotObject(this, doid);
        return true;
      }

      if (opcode === OP.CLIENT_INTEREST_CONTEXT) {
        this.snapshotClosure = Buffer.from(frame);
        return true;
      }
      return false;
    },
    sendDirect(member, frame) {
      const send = directSendOf(member);
      if (!send || shouldSkipMember(member, null)) return false;
      send(frame);
      return true;
    },
    publish(member, frame) {
      const body = bodyOf(frame);
      if (!body) return this.sendDirect(member, frame);
      const opcode = body.readUInt16LE(0);
      this.observe(frame);

      // Owner creates and disables are meaningful only to that socket. Remote
      // member objects are generated explicitly by the join runtime with the
      // visible opcode and the correct (sometimes shorter) field body.
      if (
        opcode === OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP ||
        opcode === OP.CLIENT_OBJECT_DISABLE_OWNER_RESP
      ) {
        return this.sendDirect(member, frame);
      }

      if (opcode === OP.CLIENT_OBJECT_UPDATE_FIELD && body.length >= 8) {
        const doid = body.readUInt32LE(2);
        const clid = this.objects.get(doid);
        // Remote PlayerGameObject has no owner basicCurrency field. Player
        // updates therefore remain direct; hero/shared-object state is visible.
        if (!clid || clid === CLID.PlayerGameObject) return this.sendDirect(member, frame);
      }

      return broadcastWorld(this, frame);
    },
    broadcast(frame, options = {}) {
      this.observe(frame);
      return broadcastWorld(this, frame, options);
    },
    snapshotFrames(phase = "all") {
      const infrastructureDoids = new Set();
      const frames = [];
      for (const entry of this.snapshotCreates.values()) {
        const area = entry.clid === CLID.DistributedDungionArea;
        const floor = entry.clid === CLID.DistributedDungeonFloor;
        const infrastructure = area || floor;
        if (infrastructure) infrastructureDoids.add(entry.doid);
        if (
          phase === "all" ||
          (phase === "area" && area) ||
          (phase === "floor" && floor) ||
          (phase === "foundation" && infrastructure) ||
          (phase === "children" && !infrastructure)
        ) {
          frames.push(entry.frame);
        }
      }
      for (const update of this.snapshotUpdates.values()) {
        const entry = this.snapshotCreates.get(update.doid);
        const area = entry?.clid === CLID.DistributedDungionArea;
        const floor = entry?.clid === CLID.DistributedDungeonFloor;
        const infrastructure = infrastructureDoids.has(update.doid);
        if (
          phase === "all" ||
          (phase === "area" && area) ||
          (phase === "floor" && floor) ||
          (phase === "foundation" && infrastructure) ||
          (phase === "children" && !infrastructure)
        ) {
          frames.push(update.frame);
        }
      }
      if ((phase === "all" || phase === "children") && this.snapshotClosure) {
        frames.push(this.snapshotClosure);
      }
      return frames;
    },
    sendSnapshot(member, phase = "all") {
      let sent = 0;
      const send = directSendOf(member);
      if (!send || shouldSkipMember(member, null)) return sent;
      for (const frame of this.snapshotFrames(phase)) {
        send(frame);
        sent++;
      }
      return sent;
    },
    beginFloorSnapshot() {
      const keep = new Set();
      for (const [doid, entry] of this.snapshotCreates) {
        if (entry.clid === CLID.DistributedDungionArea) keep.add(doid);
        else this.snapshotCreates.delete(doid);
      }
      for (const [key, update] of this.snapshotUpdates) {
        if (!keep.has(update.doid)) this.snapshotUpdates.delete(key);
      }
      this.snapshotClosure = null;
    },
    forgetObject(doid) {
      return forgetSnapshotObject(this, doid);
    },
    markReady() {
      if (this.destroyed || this.ready) return false;
      this.ready = true;
      settleReady(true);
      return true;
    },
    contextFor(member) {
      if (this.destroyed) throw new Error("cannot create a context for a destroyed match world");
      attachMember(this, member);
      const cached = this.contexts.get(member);
      if (cached) return cached;
      const context = new Proxy({}, proxyHandlerFor(this, member));
      this.contexts.set(member, context);
      return context;
    },
    detachMember(member) {
      if (!member) return false;
      this.contexts.delete(member);
      this.liveMembers.delete(member);
      if (this.match?.members instanceof Set) this.match.members.delete(member);
      if (member.world === this) member.world = null;
      return true;
    },
    destroy() {
      if (this.destroyed) return false;
      this.destroyed = true;
      this.active = false;
      this.dungeonActive = false;
      this.dungeonEpoch = (this.dungeonEpoch ?? 0) + 1;
      if (!this.ready) settleReady(false);
      if (this.match?.world === this) this.match.world = null;
      for (const stop of [
        this.stopTriggers,
        this.stopAi,
        this.stopTrapProjectiles,
      ]) {
        if (typeof stop === "function") stop();
      }
      for (const stop of this.generatorStops?.values?.() ?? []) stop?.();
      this.generatorStops?.clear?.();
      for (const member of activeMembersOf(this.match)) {
        this.contexts.delete(member);
        if (member.world === this) member.world = null;
      }
      this.liveMembers.clear();
      this.snapshotCreates.clear();
      this.snapshotUpdates.clear();
      this.snapshotClosure = null;
      return true;
    },
  };

  snapshotSharedState(world, seedSession);
  attachMember(world, seedSession);
  match.world = world;
  return world;
};

export const worldOf = (value) => {
  if (isMatchWorld(value)) return value;
  if (value && hasOwn(value, "world")) return isMatchWorld(value.world) ? value.world : null;
  if (value?.member && hasOwn(value.member, "world")) {
    return isMatchWorld(value.member.world) ? value.member.world : null;
  }
  if (isMatchWorld(value?.dungeonMatch?.world)) return value.dungeonMatch.world;
  return null;
};

export const membersOf = (value) => {
  const world = worldOf(value);
  if (world) return world.liveMembers;
  const member = value?.member ?? value;
  return member ? new Set([member]) : new Set();
};

export const heroMembersOf = (value) => {
  const heroes = new Map();
  for (const member of membersOf(value)) {
    if (member?.heroDoid !== undefined && member.heroDoid !== null) {
      heroes.set(member.heroDoid, member);
    }
  }
  return heroes;
};

export const memberForHero = (value, doid) => heroMembersOf(value).get(doid) ?? null;

export const broadcastWorld = (value, frame, { except } = {}) => {
  const world = worldOf(value);
  if (world && world.active === false) return 0;

  const excluded = except?.member ?? except ?? null;
  let sent = 0;
  for (const member of membersOf(value)) {
    if (shouldSkipMember(member, excluded)) continue;
    const send = directSendOf(member);
    if (!send) continue;
    send(frame);
    sent += 1;
  }
  return sent;
};
