import {
  FRAMES_PER_SECOND,
  loadGameMaster,
} from "../src/gamemaster.js";
import { clearDungeonBuffs } from "../src/socket/buffs.js";
import {
  handleProposeCombatResults,
  noteCast,
  performNpcAttack,
  tickTrapProjectiles,
} from "../src/socket/combat.js";
import { worldColliders } from "../src/socket/heading.js";
import { npcAttackChoices } from "../src/socket/npc-attacks.js";
import { CLID, OP, TEAM } from "../src/socket/opcodes.js";
import { PacketReader, PacketWriter } from "../src/socket/packet.js";

const NPC_ATTACK_SLOTS = ["Attack1", "Attack2", "Attack3", "Attack4", "Attack5", "Attack6"];
const WEAPON_ATTACK_COLUMN = /^(Attack\d|ChargeAttack|HoldingAttack|AltAttack\d?|ComboAttack\d?)$/;
const MOVER_TYPES = new Set(["ENEMY", "BEAST", "PET"]);
const EPSILON_MS = 0.01;

const TEAM_BY_CHAR_TYPE = {
  ENEMY: TEAM.ENEMIES,
  BEAST: TEAM.THIRD,
  PET: TEAM.PLAYERS,
  HERO: TEAM.PLAYERS,
  PROP: TEAM.ENVIRONMENT,
};

const unique = (values) => [...new Set(values)];
const close = (left, right, epsilon = EPSILON_MS) => Math.abs(left - right) <= epsilon;

/** A deterministic replacement for the NPC attack timers used by the matrix. */
export class VirtualCombatClock {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.tasks = [];
    this.delays = [];
  }

  setTimeout(run, delay = 0) {
    const task = {
      id: this.nextId++,
      at: this.now + Math.max(0, Number(delay) || 0),
      run,
      cancelled: false,
    };
    this.tasks.push(task);
    this.delays.push(Math.max(0, Number(delay) || 0));
    return task.id;
  }

  clearTimeout(id) {
    const task = this.tasks.find((candidate) => candidate.id === id);
    if (task) task.cancelled = true;
  }

  async advanceTo(target) {
    const end = Math.max(this.now, Number(target) || 0);
    while (true) {
      this.tasks.sort((left, right) => left.at - right.at || left.id - right.id);
      const task = this.tasks.find((candidate) => !candidate.cancelled && candidate.at <= end);
      if (!task) break;
      this.tasks.splice(this.tasks.indexOf(task), 1);
      this.now = task.at;
      await task.run();
    }
    this.now = end;
  }

  async runAll() {
    while (this.tasks.some((task) => !task.cancelled)) {
      const next = Math.min(
        ...this.tasks.filter((task) => !task.cancelled).map((task) => task.at)
      );
      await this.advanceTo(next);
    }
  }
}

const choreographyFor = (frames, attackType) => {
  for (const frame of frames) {
    if (frame.length < 25) continue;
    const reader = new PacketReader(frame.subarray(2));
    if (reader.u16() !== OP.CLIENT_OBJECT_UPDATE_FIELD) continue;
    reader.u32();
    if (reader.u16() !== 143) continue;
    reader.u8();
    reader.u8();
    if (reader.u32() !== Number(attackType)) continue;
    reader.u32();
    reader.u8();
    return { playSpeed: reader.f32() };
  }
  return null;
};

const differentTeam = (team) => {
  if (team === TEAM.PLAYERS) return TEAM.ENEMIES;
  return TEAM.PLAYERS;
};

const targetTeamFor = (attack, attackerTeam) =>
  attack.Team === "FRIENDLY" ? attackerTeam : differentTeam(attackerTeam);

const clockSettled = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const attackEventFrames = (choice) => {
  if (choice.projectile && choice.projectileLaunches?.length) {
    return unique(choice.projectileLaunches.map((launch) => Number(launch.frame ?? 0))).sort(
      (left, right) => left - right
    );
  }
  if (choice.attackColliders?.length) {
    return unique(choice.attackColliders.map((collider) => Number(collider.frame ?? 0))).sort(
      (left, right) => left - right
    );
  }
  return [0];
};

const attackEventDelays = (choice) =>
  attackEventFrames(choice).map(
    (frame) => (Math.max(0, frame) * 1000) /
      FRAMES_PER_SECOND /
      Math.max(0.01, Number(choice.attackSpeed) || 1)
  );

const colliderTarget = (choice) => {
  const shapes = worldColliders({ x: 0, y: 0 }, 0, choice.attackColliders ?? []);
  const firstFrame = Math.min(...shapes.map((shape) => shape.frame));
  const shape = shapes.find((candidate) => candidate.frame === firstFrame) ?? shapes[0];
  return shape ? { x: shape.x, y: shape.y } : { x: 40, y: 0 };
};

const projectileTarget = (choice) => {
  const launch = choice.projectileLaunches?.[0] ?? {};
  const angle = (Number(launch.headingOffsetAngle ?? 0) * Math.PI) / 180;
  const muzzle = Number(launch.headingOffset ?? 0);
  const origin = {
    x: muzzle * Math.cos(angle) + Number(launch.xOffset ?? 0),
    y: muzzle * Math.sin(angle) + Number(launch.yOffset ?? 0),
  };
  const range = Math.max(1, Number(choice.projectile?.Range ?? choice.range ?? 400));
  const wanted = Math.max(Number(choice.minRange ?? 0) + 20, Math.min(range * 0.5, 250));
  const distance = Math.min(Math.max(20, wanted), Math.max(20, range - 20));
  return {
    x: origin.x + Math.cos(angle) * distance,
    y: origin.y + Math.sin(angle) * distance,
  };
};

const targetPositionFor = (choice) => {
  if (choice.projectile && choice.projectileLaunches?.length) return projectileTarget(choice);
  if (choice.attackColliders?.length) return colliderTarget(choice);
  return { x: Math.max(20, Math.min(80, Number(choice.range) || 80)), y: 0 };
};

const makeNpcSession = ({ npc, attack, targetPosition }) => {
  const heroDoid = 10;
  const attackerDoid = 20;
  const sent = [];
  const clock = new VirtualCombatClock();
  const attackerTeam = TEAM_BY_CHAR_TYPE[npc.CharType] ?? TEAM.ENEMIES;
  const victimTeam = targetTeamFor(attack, attackerTeam);
  let nextDoid = 1000;

  const hero = {
    constant: "RANGER",
    // Hero hit points cross the wire as u16; stay near the ceiling so even a
    // boss can land without making the fixture itself invalid.
    hitPoints: 60_000,
    maxHitPoints: 60_000,
    collisionRadius: 2,
    position: { ...targetPosition },
    stats: new Map(),
    team: victimTeam,
  };
  const attacker = {
    constant: npc.Constant,
    level: Math.max(1, Number(npc.Level ?? 1)),
    partySize: 1,
    hitPoints: 1_000_000,
    maxHitPoints: 1_000_000,
    collisionRadius: 2,
    position: { x: 0, y: 0 },
    heading: 0,
    team: attackerTeam,
    isPet: npc.CharType === "PET",
    isBeast: npc.CharType === "BEAST",
  };
  const objects = new Map([
    [heroDoid, CLID.HeroGameObject],
    [attackerDoid, CLID.DistributedNPCGameObject],
  ]);
  const session = {
    id: `matrix:${npc.Constant}`,
    heroDoid,
    heroPosition: hero.position,
    heroStats: hero.stats,
    playerActors: new Set([heroDoid]),
    floorDoid: 1,
    dungeonZone: 1,
    dungeonActive: true,
    objects,
    actors: new Map([
      [heroDoid, hero],
      [attackerDoid, attacker],
    ]),
    random: () => 0.5,
    combatClock: clock,
    send: (frame) => sent.push(frame),
    allocateDoid: (clid) => {
      const doid = nextDoid++;
      objects.set(doid, clid);
      return doid;
    },
  };

  return { session, clock, sent, hero, heroDoid, attackerDoid };
};

const activeBuffConstants = (session, affectedActor) =>
  new Set(
    [...(session.activeBuffs?.values() ?? [])]
      .filter((active) => active.affectedActor === affectedActor)
      .map((active) => active.buff?.Constant)
      .filter(Boolean)
  );

const stopScenario = (session) => {
  for (const stop of session.hazardBeats?.values() ?? []) stop();
  session.hazardBeats?.clear();
  clearDungeonBuffs(session);
};

const finishProjectileFlight = async (session, choice) => {
  if (!session.activeTrapProjectiles?.length) return;
  const range = Math.max(1, Number(choice.projectile?.Range ?? choice.range ?? 400));
  const speed = Math.max(1, Number(choice.projectile?.ProjSpeed ?? 1));
  await tickTrapProjectiles(session, range / speed + 0.1);
};

const runNpcScenario = async ({ npc, attack, choice, position, moveAway = false }) => {
  const fixture = makeNpcSession({ npc, attack, targetPosition: position });
  const before = fixture.hero.hitPoints;
  try {
    await performNpcAttack(
      fixture.session,
      fixture.attackerDoid,
      choice,
      fixture.heroDoid
    );
    await clockSettled();

    const choreography = choreographyFor(fixture.sent, attack.Id);
    const scheduledDelays = [...fixture.clock.delays];
    if (moveAway) {
      fixture.hero.position = { x: 100_000, y: 100_000 };
      fixture.session.heroPosition = fixture.hero.position;
    }
    await fixture.clock.runAll();
    await clockSettled();
    await finishProjectileFlight(fixture.session, choice);
    await clockSettled();

    return {
      choreography,
      scheduledDelays,
      damage: before - fixture.hero.hitPoints,
      buffs: activeBuffConstants(fixture.session, fixture.heroDoid),
      selfBuffs: activeBuffConstants(fixture.session, fixture.attackerDoid),
    };
  } finally {
    stopScenario(fixture.session);
  }
};

const addFailure = (failures, testCase, check, detail) => {
  failures.push({
    kind: testCase.kind,
    owner: testCase.owner,
    slot: testCase.slot,
    attack: testCase.attack,
    check,
    detail,
  });
};

const validateAttackReferences = (gm, testCase, failures) => {
  const attack = gm.attacksByConstant.get(testCase.attack);
  if (!attack) {
    addFailure(failures, testCase, "attack-reference", "names no Attack row");
    return null;
  }
  if (attack.AttackTimeline && !gm.timelines.has(attack.AttackTimeline)) {
    addFailure(
      failures,
      testCase,
      "timeline-reference",
      `names no timeline ${attack.AttackTimeline}`
    );
  }
  if (attack.Projectile && !gm.projectilesByConstant.has(attack.Projectile)) {
    addFailure(
      failures,
      testCase,
      "projectile-reference",
      `names no projectile ${attack.Projectile}`
    );
  }
  for (const field of ["SelfBuff", "TargetBuff1", "TargetBuff2"]) {
    if (attack[field] && !gm.buffsByConstant.has(attack[field])) {
      addFailure(failures, testCase, "buff-reference", `${field} names no buff ${attack[field]}`);
    }
  }
  return attack;
};

const makeWeaponSession = (weapon) => {
  const heroDoid = 10;
  const targetDoid = 20;
  const objects = new Map([
    [heroDoid, CLID.HeroGameObject],
    [targetDoid, CLID.DistributedNPCGameObject],
  ]);
  let nextDoid = 1000;
  const target = {
    constant: "BRUTE",
    hitPoints: 1_000_000,
    maxHitPoints: 1_000_000,
    collisionRadius: 30,
    position: { x: 20, y: 0 },
    stats: new Map(),
    team: TEAM.ENEMIES,
    isEnemy: true,
  };
  const session = {
    id: `matrix:${weapon.Constant}`,
    heroDoid,
    heroPosition: { x: 0, y: 0 },
    heroStats: new Map([
      ["MELEE_ATK", 10],
      ["SHOOT_ATK", 10],
      ["MAGIC_ATK", 10],
    ]),
    heroWeapons: [{
      type: weapon.Id,
      power: Math.max(1, Number(weapon.Power ?? 1)),
      rarity: 0,
      modifier1: 0,
      modifier2: 0,
    }],
    floorDoid: 1,
    dungeonZone: 1,
    objects,
    actors: new Map([
      [heroDoid, {
        constant: "RANGER",
        hitPoints: 60_000,
        maxHitPoints: 60_000,
        position: { x: 0, y: 0 },
        stats: new Map([
          ["MELEE_ATK", 10],
          ["SHOOT_ATK", 10],
          ["MAGIC_ATK", 10],
        ]),
        team: TEAM.PLAYERS,
      }],
      [targetDoid, target],
    ]),
    random: () => 1,
    send: () => {},
    allocateDoid: (clid) => {
      const doid = nextDoid++;
      objects.set(doid, clid);
      return doid;
    },
  };
  return { session, heroDoid, targetDoid, target };
};

const proposedCombatResult = ({ attacker, attackee, attackType }) =>
  new PacketWriter()
    .u32(attacker)
    .u32(attackee)
    .i32(0)
    .u8(0) // weaponSlot
    .u8(0) // isConsumableWeapon
    .u32(attackType)
    .u32(attackee) // targetActorDoid
    .u8(0) // when
    .u8(0) // suffer
    .u8(0) // knockback
    .u8(0) // blocked
    .u8(0) // criticalHit
    .u8(0) // effectiveness
    .u32(0) // selfDamage
    .f32(1) // scalingMaxPowerMultiplier
    .u8(0) // generation
    .body();

const runWeaponResult = async (weapon, attack) => {
  const fixture = makeWeaponSession(weapon);
  const before = fixture.target.hitPoints;
  try {
    noteCast(fixture.session, attack, 0);
    const result = proposedCombatResult({
      attacker: fixture.heroDoid,
      attackee: fixture.targetDoid,
      attackType: attack.Id,
    });
    await handleProposeCombatResults(
      fixture.session,
      new PacketReader(new PacketWriter().u16(result.length).raw(result).body())
    );
    return {
      damage: before - fixture.target.hitPoints,
      buffs: activeBuffConstants(fixture.session, fixture.targetDoid),
    };
  } finally {
    clearDungeonBuffs(fixture.session);
  }
};

const validateWeaponRuntime = async (gm, testCase, attack, failures) => {
  const hostile = attack.Team === "HOSTILE";
  const dealsDamage = hostile && Number(attack.DamageMod ?? 0) < 0;
  const targetBuffs = unique([attack.TargetBuff1, attack.TargetBuff2].filter(Boolean))
    .filter((constant) => gm.buffsByConstant.get(constant)?.Team === "HOSTILE");
  const shouldProposeResult = dealsDamage || (hostile && targetBuffs.length > 0);
  if (!shouldProposeResult) {
    return { exercised: false, reason: "no hostile combat result" };
  }

  const observed = await runWeaponResult(testCase.weapon, attack);
  if (dealsDamage && observed.damage <= 0) {
    addFailure(failures, testCase, "weapon-damage", "an accepted result dealt no damage");
  }
  for (const constant of targetBuffs) {
    if (!observed.buffs.has(constant)) {
      addFailure(failures, testCase, "weapon-target-buff", `${constant} was not applied on hit`);
    }
  }
  return {
    exercised: true,
    damage: observed.damage,
    buffs: [...observed.buffs],
  };
};

const buildNpcCases = (gm) => {
  const cases = [];
  for (const npc of gm.raw.Npc ?? []) {
    if (!npc.IsMover || !MOVER_TYPES.has(npc.CharType)) continue;
    for (const slot of NPC_ATTACK_SLOTS) {
      if (!npc[slot]) continue;
      cases.push({
        kind: "npc",
        owner: npc.Constant,
        slot,
        attack: npc[slot],
        npc,
      });
    }
  }
  return cases;
};

const buildWeaponCases = (gm) => {
  const cases = [];
  for (const weapon of gm.raw.WeaponItem ?? []) {
    for (const [slot, attack] of Object.entries(weapon)) {
      if (!attack || !WEAPON_ATTACK_COLUMN.test(slot)) continue;
      cases.push({
        kind: "weapon",
        owner: weapon.Constant,
        slot,
        attack,
        weapon,
      });
    }
  }
  return cases;
};

const validateNpcRuntime = async (gm, testCase, attack, failures) => {
  const nativeWeapon = testCase.npc.Weapon1
    ? gm.weaponsByConstant.get(testCase.npc.Weapon1)
    : null;
  const choices = await npcAttackChoices(testCase.npc, nativeWeapon);
  const choice = choices.find((candidate) => candidate.attackType === attack.Id);
  if (!choice) {
    addFailure(failures, testCase, "runtime-choice", "was dropped from npcAttackChoices");
    return null;
  }

  const expectedSpeed = Number(attack.AttackSpd) > 0 ? Number(attack.AttackSpd) : 1;
  if (!close(choice.attackSpeed, expectedSpeed)) {
    addFailure(
      failures,
      testCase,
      "attack-speed",
      `runtime ${choice.attackSpeed}, authored ${expectedSpeed}`
    );
  }

  if (choice.projectile && !choice.projectileLaunches.length) {
    addFailure(
      failures,
      testCase,
      "projectile-launch",
      `${attack.Projectile} has no enabled projectile action`
    );
  }

  const expectedDelays = attackEventDelays(choice).filter((delay) => delay > 0);
  const inside = await runNpcScenario({
    npc: testCase.npc,
    attack,
    choice,
    position: targetPositionFor(choice),
  });

  if (!inside.choreography) {
    addFailure(failures, testCase, "choreography", "runtime sent no field 143");
  } else if (!close(inside.choreography.playSpeed, expectedSpeed, 0.0001)) {
    addFailure(
      failures,
      testCase,
      "play-speed",
      `wire ${inside.choreography.playSpeed}, expected ${expectedSpeed}`
    );
  }

  for (const delay of expectedDelays) {
    if (!inside.scheduledDelays.some((scheduled) => close(scheduled, delay))) {
      addFailure(
        failures,
        testCase,
        "impact-timing",
        `no runtime event at ${delay.toFixed(2)}ms; scheduled ${inside.scheduledDelays
          .map((value) => value.toFixed(2))
          .join(", ") || "none"}`
      );
    }
  }

  const hasSpatialResolution =
    choice.attackColliders.length > 0 ||
    Boolean(choice.projectile && choice.projectileLaunches.length);
  const hostileDamage =
    hasSpatialResolution &&
    attack.Team !== "FRIENDLY" &&
    Number(attack.DamageMod ?? 0) < 0;
  if (hostileDamage && inside.damage <= 0) {
    addFailure(failures, testCase, "inside-hit", "an in-shape target took no damage");
  }

  const directTargetEffect =
    hasSpatialResolution;
  const hostileTargetBuffs = unique([attack.TargetBuff1, attack.TargetBuff2].filter(Boolean))
    .filter((constant) => gm.buffsByConstant.get(constant)?.Team === "HOSTILE");
  for (const constant of directTargetEffect ? hostileTargetBuffs : []) {
    if (!inside.buffs.has(constant)) {
      addFailure(failures, testCase, "target-buff", `${constant} was not applied on hit`);
    }
  }
  if (attack.SelfBuff && !inside.selfBuffs.has(attack.SelfBuff)) {
    addFailure(failures, testCase, "self-buff", `${attack.SelfBuff} was not applied to the caster`);
  }

  if (hasSpatialResolution) {
    const outside = await runNpcScenario({
      npc: testCase.npc,
      attack,
      choice,
      position: { x: 100_000, y: 100_000 },
    });
    if (outside.damage > 0 || outside.buffs.size > 0) {
      addFailure(
        failures,
        testCase,
        "outside-miss",
        `out-of-shape target received ${outside.damage} damage and ${outside.buffs.size} buff(s)`
      );
    }

    if (Math.min(...attackEventDelays(choice)) > 0) {
      const dodged = await runNpcScenario({
        npc: testCase.npc,
        attack,
        choice,
        position: targetPositionFor(choice),
        moveAway: true,
      });
      if (dodged.damage > 0 || dodged.buffs.size > 0) {
        addFailure(
          failures,
          testCase,
          "windup-dodge",
          `target moved before impact but received ${dodged.damage} damage and ` +
            `${dodged.buffs.size} buff(s)`
        );
      }
    }
  }

  const timerMs = Math.max(0, Number(testCase.npc.AttackTimer ?? 1.5) * 1000);
  const randomMs = Math.max(0, Number(testCase.npc.AttackTimeRand ?? 0) * 1000);
  return {
    ...testCase,
    attackId: attack.Id,
    attackSpeed: choice.attackSpeed,
    eventFrames: attackEventFrames(choice),
    expectedCadenceMs: {
      minimum: Math.max(100, timerMs) / expectedSpeed,
      maximum: Math.max(100, timerMs + randomMs) / expectedSpeed,
    },
    resolution: choice.projectile
      ? "projectile"
      : choice.attackColliders.length
        ? "collider"
        : "no-impact",
    targetBuffs: hostileTargetBuffs,
    selfBuff: attack.SelfBuff || null,
    observed: {
      damage: inside.damage,
      buffs: [...inside.buffs],
      selfBuffs: [...inside.selfBuffs],
      playSpeed: inside.choreography?.playSpeed ?? null,
      scheduledDelays: inside.scheduledDelays,
    },
  };
};

/**
 * Generates and executes the combat coverage matrix from GameMaster itself.
 * No constant is hand-listed, so newly added NPCs, weapons and attacks are
 * automatically part of the next run.
 */
export const buildCombatMatrix = async (
  { runtime = true, owner = null, attack = null, muteLogs = false } = {}
) => {
  if (muteLogs) {
    const write = process.stdout.write;
    try {
      process.stdout.write = () => true;
      return await buildCombatMatrix({ runtime, owner, attack, muteLogs: false });
    } finally {
      process.stdout.write = write;
    }
  }

  const gm = await loadGameMaster();
  const failures = [];
  const selected = (testCase) =>
    (!owner || testCase.owner === owner) && (!attack || testCase.attack === attack);
  const npcCases = buildNpcCases(gm).filter(selected);
  const weaponCases = buildWeaponCases(gm).filter(selected);
  const npcResults = [];

  for (const testCase of npcCases) {
    const attack = validateAttackReferences(gm, testCase, failures);
    if (!attack) continue;
    if (runtime) {
      try {
        const result = await validateNpcRuntime(gm, testCase, attack, failures);
        if (result) npcResults.push(result);
      } catch (error) {
        addFailure(failures, testCase, "runtime-error", error.stack ?? error.message ?? String(error));
      }
    }
  }

  const weaponResults = [];
  for (const testCase of weaponCases) {
    const attack = validateAttackReferences(gm, testCase, failures);
    if (!attack) continue;
    const timeline = gm.timelines.get(attack.AttackTimeline);
    const actions = unique(
      (timeline?.frames ?? []).flatMap((frame) =>
        (frame.actions ?? [])
          .map((action) => String(action.type ?? ""))
          .filter((type) => type && !type.startsWith("#"))
      )
    );
    let observed = { exercised: false, reason: "static run" };
    if (runtime) {
      try {
        observed = await validateWeaponRuntime(gm, testCase, attack, failures);
      } catch (error) {
        addFailure(
          failures,
          testCase,
          "weapon-runtime-error",
          error.stack ?? error.message ?? String(error)
        );
        observed = { exercised: false, reason: "runtime error" };
      }
    }
    weaponResults.push({
      ...testCase,
      attackId: attack.Id,
      attackType: attack.AttackType,
      team: attack.Team,
      damageMod: Number(attack.DamageMod ?? 0),
      projectile: attack.Projectile || null,
      targetBuffs: unique([attack.TargetBuff1, attack.TargetBuff2].filter(Boolean)),
      selfBuff: attack.SelfBuff || null,
      timelineActions: actions,
      serverActions: actions.filter((type) =>
        ["projectile", "spawnnpc", "spawnNpcForAttack", "spawndoober"].includes(type)
      ),
      observed,
    });
  }

  const uniqueNpcAttacks = new Set(npcCases.map((testCase) => testCase.attack));
  const uniqueWeaponAttacks = new Set(weaponCases.map((testCase) => testCase.attack));
  return {
    summary: {
      npcRows: new Set(npcCases.map((testCase) => testCase.owner)).size,
      npcAttackReferences: npcCases.length,
      npcUniqueAttacks: uniqueNpcAttacks.size,
      weaponRows: new Set(weaponCases.map((testCase) => testCase.owner)).size,
      weaponAttackReferences: weaponCases.length,
      weaponUniqueAttacks: uniqueWeaponAttacks.size,
      runtimeNpcCases: npcResults.length,
      runtimeWeaponCases: weaponResults.filter((testCase) => testCase.observed.exercised).length,
      projectileNpcCases: npcResults.filter((testCase) => testCase.resolution === "projectile").length,
      colliderNpcCases: npcResults.filter((testCase) => testCase.resolution === "collider").length,
      noImpactNpcCases: npcResults.filter(
        (testCase) => testCase.resolution === "no-impact"
      ).length,
      failures: failures.length,
      failingAttacks: new Set(failures.map((failure) => failure.attack)).size,
    },
    failures,
    npcCases: npcResults.map(({ npc: _npc, ...result }) => result),
    weaponCases: weaponResults.map(({ weapon: _weapon, ...testCase }) => testCase),
  };
};
