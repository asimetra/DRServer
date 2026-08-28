/**
 * Every trap the captures describe, checked against what this server does.
 *
 * The loop this replaces was: play, notice something, describe it in prose,
 * guess the constant, dig through the captures by hand, maybe fix it. Four
 * things were measured by hand every time — when a trap damages, how much, with
 * which stagger flags, and who it can hit — and all four are already on the
 * wire. So read them off the official once, drive the same trap here, and print
 * the disagreements.
 *
 *   node tools/trap-conformance.js <logdir>/socket-*.jsonl
 *   node tools/trap-conformance.js --verbose <logdir>/socket-*.jsonl
 *
 * Only the official's own sessions belong here; filter by the host in the
 * matching rpc log first. Absence is not failure — a trap the captures never
 * saw is reported as unmeasured, not as wrong.
 */
import fs from "node:fs";
import readline from "node:readline";

import {
  attackColliders,
  attackForConstant,
  loadGameMaster,
  npcForConstant,
  projectileForConstant,
  weaponForConstant,
} from "../src/gamemaster.js";
import { applyDamage, tickTrapProjectiles } from "../src/socket/combat.js";
import { playDeathAttack } from "../src/socket/hazards.js";
import { worldColliders } from "../src/socket/heading.js";
import { clearHazardBeats, raiseHazard } from "../src/socket/hazards.js";
import { loadNavigationLibrary } from "../src/socket/navigation.js";
import { CLID } from "../src/socket/opcodes.js";

const FRAMES_PER_SECOND = 24;
const OP_UPDATE_FIELD = 124;
const OP_GENERATE = new Set([134, 135, 136]);
const FIELD = { state: 141, choreography: 143, npcResult: 144, heroResult: 160 };

/** CombatResult: attacker(4) attackee(4) damage(4) attack(10) when suffer knockback … */
const RESULT = { attacker: 8, damage: 16, attackType: 22, suffer: 31, knockback: 32, size: 45 };

/**
 * What the official does with each trap attack, read once off the captures.
 *
 * Hit offsets are measured from the choreography that opened the swing, which
 * is what makes them comparable with the authored frames; a trap with no
 * choreography reports its offsets from the trigger state instead.
 */
const profileOfficial = async (files) => {
  const gm = await loadGameMaster();
  const npcName = new Map([...gm.npcByConstant.values()].map((npc) => [npc.Id, npc.Constant]));
  const attackName = new Map([...gm.attacksByConstant.values()].map((a) => [a.Id, a.Constant]));
  const profile = new Map();

  const entry = (attack) => {
    if (!profile.has(attack)) {
      profile.set(attack, {
        hits: 0, offsets: [], damage: [], suffer: 0, knockback: 0, hero: 0, npc: 0,
      });
    }
    return profile.get(attack);
  };

  for (const file of files) {
    const owner = new Map();
    const openedAt = new Map();
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

    for await (const line of rl) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row.hex || row.dir !== "in") continue;
      const body = Buffer.from(row.hex, "hex");

      if (OP_GENERATE.has(row.op) && body.length >= 20) {
        for (let at = 16; at + 4 <= Math.min(body.length, 40); at += 1) {
          const name = npcName.get(body.readUInt32LE(at));
          if (name) {
            owner.set(body.readUInt32LE(12), name);
            break;
          }
        }
        continue;
      }
      if (row.op !== OP_UPDATE_FIELD) continue;

      const doid = body.readUInt32LE(2);
      const field = body.readUInt16LE(6);
      const at = Date.parse(row.ts);

      // Both open a window a hit can be timed against; a choreography wins,
      // because a trap that has one damages on its frames.
      if (field === FIELD.choreography && body.length >= 29) openedAt.set(doid, at);
      if (field === FIELD.state && body.length >= 9 && body.readUInt8(8) && !openedAt.has(doid)) {
        openedAt.set(doid, at);
      }
      if (field === FIELD.state && body.length >= 9 && !body.readUInt8(8)) openedAt.delete(doid);

      if (field !== FIELD.heroResult && field !== FIELD.npcResult) continue;
      if (body.length < RESULT.size) continue;
      const attack = attackName.get(body.readUInt32LE(RESULT.attackType));
      if (!attack || !/^TRAP|^SLICER|^FLAME_BURN|BARREL/.test(attack)) continue;

      const found = entry(attack);
      found.hits += 1;
      found.damage.push(body.readInt32LE(RESULT.damage));
      found.suffer += body.readUInt8(RESULT.suffer) ? 1 : 0;
      found.knockback += body.readUInt8(RESULT.knockback) ? 1 : 0;
      if (field === FIELD.heroResult) found.hero += 1;
      else found.npc += 1;

      const opened = openedAt.get(body.readUInt32LE(RESULT.attacker));
      if (opened !== undefined && at - opened >= 0 && at - opened < 8000) {
        found.offsets.push(at - opened);
      }
    }
  }
  return profile;
};

/** Stands a hero in each authored collider in turn and times what it takes. */
const runHere = async (constant) => {
  const npc = await npcForConstant(constant);
  const attack = npc?.Attack1 && (await attackForConstant(npc.Attack1));
  if (!attack || attack.Projectile) return null;

  const at = { x: 5000, y: 5000 };
  const colliders = worldColliders(at, 0, await attackColliders(attack.AttackTimeline));
  if (!colliders.length) return null;

  const spots = [...new Map(colliders.map((c) => [`${Math.round(c.x)},${Math.round(c.y)}`, c])).values()];
  const offsets = [];
  const damage = [];
  const flags = { suffer: 0, knockback: 0, hits: 0 };

  for (const spot of spots) {
    const started = Date.now();
    const hero = { doid: 7001, constant: "RANGER", hitPoints: 60000, maxHitPoints: 60000 };
    const session = {
      id: 1,
      dungeonActive: true,
      heroDoid: 7001,
      heroPosition: { x: spot.x, y: spot.y + 22 },
      objects: new Map([[9101, CLID.DistributedNPCGameObject], [7001, CLID.HeroGameObject]]),
      actors: new Map([[7001, hero], [9101, { doid: 9101, constant, hitPoints: 0, dead: true }]]),
      triggerableDoids: new Map([["t", 9101]]),
      triggerableAttacks: new Map([["t", attack.Id]]),
      triggerableStatefulAttacks: new Set(["t"]),
      triggerableHazards: new Map([
        ["t", {
          attack, npc, position: at, heroOnly: false, combatColliders: colliders,
          weaponPower: (npc.Weapon1 && (await weaponForConstant(npc.Weapon1))?.Power) || 1,
        }],
      ]),
      send: (frame) => {
        const buffer = Buffer.from(frame);
        if (buffer.length < RESULT.size + 2) return;
        if (buffer.readUInt16LE(8) !== FIELD.heroResult) return;
        const body = buffer.subarray(2);
        flags.hits += 1;
        flags.suffer += body.readUInt8(RESULT.suffer) ? 1 : 0;
        flags.knockback += body.readUInt8(RESULT.knockback) ? 1 : 0;
        damage.push(body.readInt32LE(RESULT.damage));
        offsets.push(Date.now() - started);
      },
    };

    raiseHazard(session, "t");
    await new Promise((resolve) => setTimeout(resolve, 4200));
    session.dungeonActive = false;
    clearHazardBeats(session);
  }
  return { offsets, damage, flags, maxHitPoints: 60000 };
};

/**
 * A launcher, measured at the far end of its flight.
 *
 * The rest of the harness stands a hero inside an authored collider and waits.
 * A launcher has no collider — its attack is resolved by tickTrapProjectiles
 * when the shot arrives — so every arrow trap in the game read `unmeasured
 * here`, and that is 522 of the recorded hits, the largest sample in the
 * corpus, including the whole ice-arrow family.
 *
 * The hero stands a known distance straight in front and the projectile clock
 * is turned by hand rather than in real time, which makes the flight
 * deterministic and the run instant.
 *
 * What can honestly be compared is damage and the stagger flags. The elapsed
 * time cannot: the official's offsets are however far away that player happened
 * to be standing, and ours is whatever distance is chosen here. So the flight
 * is reported rather than judged.
 */
const PROJECTILE_RANGE_TEST = 400;

const runProjectile = async (constant) => {
  const npc = await npcForConstant(constant);
  const attack = npc?.Attack1 && (await attackForConstant(npc.Attack1));
  const projectile = attack?.Projectile && (await projectileForConstant(attack.Projectile));
  if (!projectile) return null;

  const at = { x: 5000, y: 5000, heading: 0 };
  const hero = {
    doid: 7001,
    constant: "RANGER",
    hitPoints: 60000,
    maxHitPoints: 60000,
    collisionRadius: 22,
  };
  const damage = [];
  const offsets = [];
  const flags = { suffer: 0, knockback: 0, hits: 0 };
  let clock = 0;

  const session = {
    id: 1,
    dungeonActive: true,
    heroDoid: 7001,
    heroPosition: { x: at.x + PROJECTILE_RANGE_TEST, y: at.y },
    objects: new Map([[9101, CLID.DistributedNPCGameObject], [7001, CLID.HeroGameObject]]),
    actors: new Map([[7001, hero], [9101, { doid: 9101, constant, hitPoints: 0, dead: true }]]),
    triggerableDoids: new Map([["t", 9101]]),
    triggerableAttacks: new Map([["t", attack.Id]]),
    triggerableHazards: new Map([
      ["t", {
        attack,
        npc,
        projectile,
        position: at,
        heroOnly: false,
        combatColliders: [],
        weaponPower: (npc.Weapon1 && (await weaponForConstant(npc.Weapon1))?.Power) || 1,
      }],
    ]),
    send: (frame) => {
      const buffer = Buffer.from(frame);
      if (buffer.length < RESULT.size + 2) return;
      if (buffer.readUInt16LE(8) !== FIELD.heroResult) return;
      const body = buffer.subarray(2);
      flags.hits += 1;
      flags.suffer += body.readUInt8(RESULT.suffer) ? 1 : 0;
      flags.knockback += body.readUInt8(RESULT.knockback) ? 1 : 0;
      damage.push(body.readInt32LE(RESULT.damage));
      offsets.push(Math.round(clock * 1000));
    },
  };

  raiseHazard(session, "t");
  const step = 0.02;
  while (clock < 4 && !flags.hits) {
    await tickTrapProjectiles(session, step);
    clock += step;
  }
  session.dungeonActive = false;
  return { offsets, damage, flags, maxHitPoints: 60000, flight: true };
};

/**
 * A barrel, measured by breaking it.
 *
 * The three EN_EXPLODING_BARREL_DEATH_* attacks were the last unmeasured
 * kinds, and for a reason worth keeping: a death attack is not raised by a
 * trigger, it is what a smashable does on its way out. Nothing in the harness
 * could reach it, so the fix that made the bang come out before the death
 * state — without which the client drops the choreography onto an actor
 * already in mDeadState and plays nothing — had no measurement behind it.
 *
 * Driven through applyDamage rather than by calling the blast directly, so the
 * ordering under test is the real one: hit points, bang, then death.
 */
const runDeath = async (constant) => {
  const npc = await npcForConstant(constant);
  const attack = npc?.DeathAttack && (await attackForConstant(npc.DeathAttack));
  if (!attack) return null;

  const at = { x: 5000, y: 5000, heading: 0 };
  const colliders = worldColliders(at, 0, await attackColliders(attack.AttackTimeline));
  if (!colliders.length) return null;

  const damage = [];
  const offsets = [];
  const flags = { suffer: 0, knockback: 0, hits: 0 };
  const order = [];
  const started = Date.now();

  const hero = { doid: 7001, constant: "RANGER", hitPoints: 60000, maxHitPoints: 60000 };
  const barrel = {
    doid: 9102,
    constant,
    hitPoints: Math.max(1, npc.HP ?? 1),
    maxHitPoints: Math.max(1, npc.HP ?? 1),
    position: at,
    isEnemy: false,
  };
  const session = {
    id: 1,
    dungeonActive: true,
    heroDoid: 7001,
    heroPosition: { x: colliders[0].x, y: colliders[0].y },
    objects: new Map([[9102, CLID.DistributedNPCGameObject], [7001, CLID.HeroGameObject]]),
    actors: new Map([[7001, hero], [9102, barrel]]),
    send: (frame) => {
      const buffer = Buffer.from(frame);
      if (buffer.length < 10) return;
      const field = buffer.readUInt16LE(8);
      if (field === FIELD.choreography || field === 138) order.push(field);
      if (buffer.length < RESULT.size + 2 || field !== FIELD.heroResult) return;
      const body = buffer.subarray(2);
      flags.hits += 1;
      flags.suffer += body.readUInt8(RESULT.suffer) ? 1 : 0;
      flags.knockback += body.readUInt8(RESULT.knockback) ? 1 : 0;
      damage.push(body.readInt32LE(RESULT.damage));
      offsets.push(Date.now() - started);
    },
  };

  // Wired the way buildNpcs wires it, so the hook under test is the real one.
  barrel.onDeathAttack = (doid) =>
    playDeathAttack(session, doid, attack, at, colliders, {
      npc,
      weaponPower: 1,
    }).catch(() => {});

  applyDamage(session, 9102, barrel.hitPoints);
  await new Promise((resolve) => setTimeout(resolve, 2600));
  session.dungeonActive = false;
  /**
   * The order is the finding, not a detail. A choreography that arrives after
   * the death state is dropped by the client — enterChoreographyState only
   * runs from the default macro state — so a barrel told to explode after it
   * was told to die shows nothing. The official is unanimous across 59
   * recorded barrels: hit points, bang, then dead.
   */
  const bangAt = order.indexOf(FIELD.choreography);
  const deadAt = order.indexOf(138);
  return {
    offsets,
    damage,
    flags,
    maxHitPoints: 60000,
    bangBeforeDeath: bangAt !== -1 && (deadAt === -1 || bangAt < deadAt),
  };
};

const near = (a, b, slack) => Math.abs(a - b) <= slack;

const main = async () => {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const files = args.filter((arg) => !arg.startsWith("--"));
  if (!files.length) {
    console.error("usage: node tools/trap-conformance.js [--verbose] <socket-*.jsonl>");
    process.exit(2);
  }

  await loadNavigationLibrary();
  const gm = await loadGameMaster();
  const official = await profileOfficial(files);

  // One NPC per attack is enough: the colliders and the pricing are the
  // attack's, and every row using it shares them.
  const byAttack = new Map();
  const deathAttacks = new Set();
  for (const npc of gm.npcByConstant.values()) {
    if (npc.Attack1 && official.has(npc.Attack1) && !byAttack.has(npc.Attack1)) {
      byAttack.set(npc.Attack1, npc.Constant);
    }
    // A blast is authored as a DeathAttack, not an Attack1, so it never
    // appeared in this map and every barrel read unmeasured.
    if (npc.DeathAttack && official.has(npc.DeathAttack) && !byAttack.has(npc.DeathAttack)) {
      byAttack.set(npc.DeathAttack, npc.Constant);
      deathAttacks.add(npc.DeathAttack);
    }
  }

  console.log(`${official.size} trap attacks measured in ${files.length} capture(s)\n`);
  console.log(
    "  " + "attack".padEnd(28) + "hits".padStart(5) + "  timing".padEnd(30) +
      "damage".padEnd(22) + "stagger"
  );

  const problems = [];
  for (const [attack, seen] of [...official].sort((a, b) => b[1].hits - a[1].hits)) {
    const constant = byAttack.get(attack);
    const row = await attackForConstant(attack);
    const frames = [
      ...new Set(((await attackColliders(row?.AttackTimeline)) ?? []).map((c) => Number(c.frame ?? 0))),
    ].sort((a, b) => a - b);
    const authored = frames.map((f) => Math.round((f / FRAMES_PER_SECOND) * 1000));

    const ours = !constant
      ? null
      : deathAttacks.has(attack)
        ? await runDeath(constant)
        : row?.Projectile
          ? await runProjectile(constant)
          : await runHere(constant);
    let timing = "unmeasured here";
    if (ours?.flight) {
      timing = ours.flight && ours.offsets.length
        ? `${ours.offsets[0]}ms over ${PROJECTILE_RANGE_TEST}`
        : "never arrived";
      if (!ours.offsets.length) problems.push(`${attack}: its shot never reaches a hero 400 in front`);
    } else if (ours) {
      const matched = authored.filter((want) => ours.offsets.some((got) => near(got, want, 120)));
      timing = `${matched.length}/${authored.length} authored frames`;
      if (matched.length < authored.length) problems.push(`${attack}: fires on ${timing}`);
      if (ours.bangBeforeDeath === false) {
        // The frame it lands on stops mattering once the client drops it.
        timing = "AFTER DEATH";
        problems.push(`${attack}: its bang goes out after the death state, so the client drops it`);
      }
    }

    const theirs = [...new Set(seen.damage.filter((d) => d < 0).map((d) => -d))].sort((a, b) => a - b);
    const share = row?.DoPercentHealthDamage ? `${(row.PercentHealthDamageValue * 100).toFixed(0)}% of the bar` : "flat";
    const mine = ours ? [...new Set(ours.damage.map((d) => -d))].sort((a, b) => a - b) : [];
    let damage = `${share}`;
    if (ours && row?.DoPercentHealthDamage && mine.length) {
      const want = Math.round(ours.maxHitPoints * row.PercentHealthDamageValue);
      if (!mine.every((m) => near(m, want, 1))) {
        damage += " MISMATCH";
        problems.push(`${attack}: charges ${mine.join(",")} where its share is ${want}`);
      }
    }

    const wantFlags = seen.hits ? `${Math.round((seen.knockback / seen.hits) * 100)}%` : "-";
    const gotFlags = ours?.flags.hits ? `${Math.round((ours.flags.knockback / ours.flags.hits) * 100)}%` : "-";
    let stagger = `${wantFlags} vs ${gotFlags}`;
    if (ours?.flags.hits && seen.hits) {
      const theyDo = seen.knockback / seen.hits > 0.5;
      const weDo = ours.flags.knockback / ours.flags.hits > 0.5;
      if (theyDo !== weDo) {
        stagger += " MISMATCH";
        problems.push(`${attack}: knocks back ${gotFlags} of the time against their ${wantFlags}`);
      }
    }

    console.log(
      "  " + attack.padEnd(28) + String(seen.hits).padStart(5) + "  " + timing.padEnd(30) +
        damage.padEnd(22) + stagger
    );
    if (verbose) {
      console.log(`      authored ${authored.join(",") || "none"} ms | ours ${ours ? ours.offsets.join(",") : "-"} ms`);
      console.log(`      their damage ${theirs.join(",")} | ours ${mine.join(",") || "-"} | hero ${seen.hero} npc ${seen.npc}`);
    }
  }

  console.log(problems.length ? `\n${problems.length} disagreement(s):` : "\nno disagreements.");
  for (const problem of problems) console.log("  - " + problem);
};

await main();
