import { PacketWriter } from "./packet.js";
import { OP } from "./opcodes.js";
import { config } from "../config.js";
import { envSetting } from "../env.js";
import { info, warn } from "../log.js";
import {
  clearHazardBeats,
  initialTurretHeading,
  isChoreographed,
  playDeathAttack,
  raiseHazard,
  startTurretAim,
  stopHazardBeat,
} from "./hazards.js";
import { tell } from "./chat.js";
import { say } from "./speech.js";
import { grantBuff } from "./buffs.js";
import { walkThrough } from "./doors.js";
import { collisionPointOf, setNavigationTriggerState } from "./navigation.js";
import { applyDamage } from "./combat.js";

// Re-exported: the dungeon builds and tears traps down through this module.
export {
  clearHazardBeats,
  initialTurretHeading,
  playDeathAttack,
  raiseHazard,
  startTurretAim,
};

/**
 * Triggers.
 *
 * A floor's traps and gates are not self-animating: they sit in whatever state
 * they were told to be in, and something has to toggle them. That something is
 * the wiring in the tile library — a list of trigger/triggerable pairs — driven
 * by trigger objects the client does not act on.
 *
 * Two kinds matter for a first pass:
 *
 *   AUTO_TIMER_TRIGGER    fires on a cycle, which is what makes floor spikes
 *                         rise and fall
 *   PROXIMITY_*           fires when the hero is close enough
 *
 * The state itself travels as `remoteTriggerState` (field 141 on an NPC), the
 * same field that decides whether a monster can be attacked.
 */

const FLID_NPC_REMOTE_TRIGGER_STATE = 141;

const triggerStateUpdate = (doid, on) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(FLID_NPC_REMOTE_TRIGGER_STATE)
    .u8(on ? 1 : 0)
    .frame();

/**
 * Why a triggerable is in the state it is in, written out.
 *
 * The expensive part of a trap bug has never been the fix; it is that a report
 * says "the door does not open" and the server says nothing at all, so the
 * answer has to be guessed from the tile data and confirmed by playing again.
 * This closes that: `DR_TRACE=SOME_CONSTANT` names the triggerables to follow,
 * and the server prints what it is wired to, what each of those is currently
 * saying, and every state it takes afterwards.
 *
 * A door that never opens because one input can never be satisfied looks
 * exactly like a door with a broken gate until you can see the inputs.
 */
export const traced = (session, constant) =>
  Boolean(session.tracePattern && constant && session.tracePattern.test(constant));

export const describeInputs = (session, targetId, depth = 0) => {
  const sources = session.signalIncoming?.get(targetId) ?? [];
  if (!sources.length) return depth ? "(no source)" : "  (no source — rests on)";
  const pad = "  ".repeat(depth + 1);
  return sources
    .map((sourceId) => {
      const gate = session.logicGates?.get(sourceId);
      const trigger = (session.triggers ?? []).find(({ id }) => id === sourceId);
      const value = session.signalValues?.get(sourceId);
      const what = gate?.constant ?? trigger?.constant ?? "(unplaced)";
      const line = `${pad}${what} = ${value === undefined ? "unset" : value}`;
      return gate && depth < 3 ? `${line}\n${describeInputs(session, sourceId, depth + 1)}` : line;
    })
    .join("\n");
};

/**
 * A trigger whose job is to kill something.
 *
 * `NPC_SUICIDE_TRIGGER` is typed `LETrigger` and reads like a source, and is
 * not one: every one of the fifteen on a temple floor is wired *to* and none
 * wires out, and the `npcId` each carries points at an exploding barrel. So it
 * is a sink — signal arrives, the named actor dies, and its `DeathAttack` goes
 * off with it.
 *
 * That is the room whose trigger sets off every barrel in it, and there are 169
 * of them across the nine libraries.
 */
const fireSuicide = (session, trigger) => {
  /**
   * Only once the floor is standing, and only on the way up.
   *
   * A target with no resolvable source rests on, so applying the opening state
   * fired every one of these the moment the world was built: fourteen barrels
   * on the temple's second floor exploded as the player walked in and left
   * nothing behind. What the trigger means is "something just happened", not
   * "this is how the floor starts".
   */
  if (!session.floorSettled) return false;
  session.suicideFired ??= new Set();
  if (session.suicideFired.has(trigger.id)) return false;
  session.suicideFired.add(trigger.id);

  const doid = session.npcDoids?.get(trigger.npcId);
  const actor = doid !== undefined && session.actors?.get(doid);
  if (!actor || actor.dead) return false;
  applyDamage(session, doid, Math.max(1, actor.hitPoints));
  info(`[${session.id}] NPC_SUICIDE_TRIGGER fired — ${trigger.npcId} destroyed`);
  return true;
};

const applyTargetState = (session, targetId, on) => {
  const suicide = (session.triggers ?? []).find(
    (trigger) => trigger.id === targetId && trigger.constant === "NPC_SUICIDE_TRIGGER"
  );
  if (suicide) return on ? fireSuicide(session, suicide) : false;

  setNavigationTriggerState(session.navigation, targetId, on);
  const doid = session.triggerableDoids?.get(targetId);
  if (doid === undefined) return false;

  if (traced(session, session.triggerableNames?.get(targetId))) {
    info(
      `[trace] ${session.triggerableNames.get(targetId)} doid=${doid} -> ` +
        `${on ? "on" : "off"}\n${describeInputs(session, targetId)}`
    );
  }

  const attackType = session.triggerableAttacks?.get(targetId);
  if (attackType !== undefined) {
    // Projectile launchers stay mounted while only their attack timeline
    // cycles. Floor spikes and flame jets use the same input for their on/off
    // renderer as well as choreography, so they must still receive field 141.
    /**
     * A moving trap announces its swing *before* its state goes on.
     *
     * The official pairs them in the same millisecond and in that order, over
     * and over: a cave mace reads `SWING, state->1 ... state->0, SWING,
     * state->1`, never the other way round. Ours sent the state first.
     *
     * Nothing here can show it changes what the client draws — the
     * choreography is a state-machine transition and the renderer is read at
     * paint time, by which point both have arrived — but matching the order
     * costs nothing and the stream is the thing being reconstructed.
     */
    const hazard = session.triggerableHazards?.get(targetId);
    const stateful = session.triggerableStatefulAttacks?.has(targetId);
    const swingFirst = on && stateful && hazard && isChoreographed(hazard);

    if (swingFirst) raiseHazard(session, targetId);
    if (stateful) session.send(triggerStateUpdate(doid, on));
    if (on && !swingFirst) raiseHazard(session, targetId);
    else if (!on) stopHazardBeat(session, targetId);
    return true;
  }

  session.send(triggerStateUpdate(doid, on));
  // DR_DEBUG_TRIGGERS=1 prints every door/trap state that actually reaches the
  // client, which is the only reliable way to tell a door that never moved from
  // one that moved and moved back.
  if (session.debugTriggers) {
    info(`[trigger] ${targetId} doid=${doid} -> ${on ? "open" : "closed"}`);
  }
  return true;
};

/** Applies a state directly; retained for isolated trap tests and callers. */
export const setTargets = (session, trigger, on) => {
  for (const targetId of trigger.targets) {
    applyTargetState(session, targetId, on);
  }
};

const inputValues = (session, targetId) =>
  (session.signalIncoming?.get(targetId) ?? []).map(
    (sourceId) => session.signalValues?.get(sourceId) ?? false
  );

/** Multiple direct inputs behave like a wired OR unless an explicit gate says otherwise. */
export const initialTargetState = (session, targetId) => {
  const values = inputValues(session, targetId);
  return values.length ? values.some(Boolean) : true;
};

/**
 * Whether anything on this floor could ever change what a target is told.
 *
 * Only two kinds of source move on their own: a trigger, which the hero or a
 * timer fires, and a generator, which announces itself as it runs. Logic gates
 * just recompute, so a subtree of nothing but gates holds one value for the
 * whole run and the door hanging off it is furniture.
 *
 * Having *a* source is not the same as having a live one. An exit gate wired
 * `gate <- NOT <- (nothing)` reads as connected and never moves, which is how a
 * laid-out floor ends up with a doorway the player can see through and never
 * pass. Walking to the leaves is what tells the two apart.
 */
export const canEverChange = (session, targetId, seen = new Set()) => {
  if (seen.has(targetId)) return false; // the wiring may loop back through a gate
  seen.add(targetId);
  for (const source of session.signalIncoming?.get(targetId) ?? []) {
    if (session.movableSources?.has(source)) return true;
    if (canEverChange(session, source, seen)) return true;
  }
  return false;
};

/**
 * Two gates that remember, which the boolean ones do not.
 *
 * A `TOGGLE_GATE` flips on each rising input and holds: press a switch and the
 * door opens, step off and it stays open, press again and it closes. That is
 * the puzzle shape a button is for, and the eleven of them in the game were
 * being evaluated as a plain OR — on while you stood there, off when you left.
 *
 * A `COUNTER_GATE` counts rising inputs and opens once its `threshold` is
 * reached; the four in the game ask for eight. `triggerOnce` on one of these
 * means it stays open afterwards.
 *
 * Both need the *edge* rather than the level, so the previous input state is
 * kept per gate.
 */
const risingEdge = (session, gate) => {
  const high = inputValues(session, gate.id).some(Boolean);
  session.gateEdges ??= new Map();
  const was = session.gateEdges.get(gate.id) ?? false;
  session.gateEdges.set(gate.id, high);
  return high && !was;
};

const evaluateGate = (session, gate) => {
  const values = inputValues(session, gate.id);

  switch (gate.constant) {
    case "AND_GATE":
      return values.length > 0 && values.every(Boolean);
    /**
     * Nothing inverted is still nothing.
     *
     * `AND` already asks for `values.length > 0` and `OR` is false without any,
     * so `NOT` was the one gate in the set that powered itself from an empty
     * input list — and the libraries are full of empty ones. 337 of the
     * catacombs' 1020 authored links name an object that is on no tile, so a
     * laid-out floor inherits gates with nothing upstream, and every one of
     * those `NOT`s was holding its branch high for the whole run.
     *
     * The official's own layouts say otherwise. Replaying all 24 floors of the
     * catacombs capture, `CASTLE_CATACOMB_TRAP_SPIKES_SKELETONSTATUE` came out
     * raised by this server 12 times of 191 where the official leaves it flat,
     * and all twelve are wired to exactly one shape: `NOT_GATE(nothing)`.
     *
     * This is not the same question as a *triggerable* with no source at all,
     * which rests on and is right to — `CASTLE_ARENA_GATE_D` is generated open
     * 84 times of 84 on the same dangling data. A target nobody wired is open;
     * a gate nobody powered is off.
     */
    case "NOT_GATE":
      return values.length > 0 && !values.some(Boolean);
    case "OR_GATE":
      return values.some(Boolean);
    case "TOGGLE_GATE": {
      session.gateLatches ??= new Map();
      const held = session.gateLatches.get(gate.id) ?? false;
      const next = risingEdge(session, gate) ? !held : held;
      session.gateLatches.set(gate.id, next);
      return next;
    }
    case "COUNTER_GATE": {
      /**
       * Each input's own rising edge, not the rising edge of their OR.
       *
       * Both counters in the game are eight pressure zones wired to one gate,
       * and 47 of the library's 121 proximity sources author `triggerOnce` — so
       * a zone that has been stood on stays on. Counting the OR meant the first
       * zone raised it and the other seven changed nothing that could ever be
       * counted: a puzzle with no solution.
       *
       * Per input, it also still counts one button pressed eight times, which
       * is the other thing "counts rising inputs" can mean and costs nothing to
       * keep working.
       */
      session.gateCounts ??= new Map();
      session.gateInputEdges ??= new Map();
      const threshold = Math.max(1, Number(gate.threshold ?? 1));
      const previous = session.gateInputEdges.get(gate.id) ?? new Map();
      let counted = session.gateCounts.get(gate.id) ?? 0;
      for (const source of session.signalIncoming?.get(gate.id) ?? []) {
        const high = Boolean(session.signalValues?.get(source));
        if (high && !previous.get(source)) counted += 1;
        previous.set(source, high);
      }
      session.gateInputEdges.set(gate.id, previous);
      session.gateCounts.set(gate.id, counted);
      // The count only grows, so a solved puzzle stays solved when the party
      // steps off it — which is what `triggerOnce` on both of them asks for.
      return counted >= threshold;
    }
    default:
      return values.some(Boolean);
  }
};

/**
 * A one-shot pulse: the gate goes on, and takes itself off again.
 *
 * `startDelay` is how long the pulse waits before it starts, and it was parsed
 * and then thrown away. That matters because these gates are chained: an ice
 * cave's wall emitters hang off a cascade four and five deep, each link holding
 * the signal a fraction of a second, so what the player should see is a wave
 * running along the wall. Firing every link at the same instant collapses the
 * wave into one flat bang — 75 of the caves' 77 reset gates carry a delay.
 *
 * A `resetTime` of zero is not a pulse of no width. 192 of the game's 740 reset
 * gates author zero, and taking it literally scheduled the close on the next
 * turn of the event loop: across this server's captures 3329 trigger pulses
 * lasted between nought and four milliseconds. The official never sends one
 * that short — not one of its 3737 recorded spike pulses is under twenty
 * milliseconds, and the short ones cluster around a tenth of a second: 30 of
 * its 52 sub-400ms pulses fall between 60 and 149, with a median of 117.
 *
 * So zero means "one server tick", and the tick is about 100ms. That is the
 * difference between a spike bed that rises and drops and one the client is
 * told about and never has time to draw — the reported "the spikes come up and
 * vanish instantly".
 */

/** What an authored `resetTime` of zero actually means; see startResetGate. */
const MINIMUM_PULSE_MS = 100;
const startResetGate = (session, gate) => {
  const previous = session.logicGateTimers.get(gate.id);
  if (previous) clearTimeout(previous);

  const startMs = Number.isFinite(gate.startDelay) ? Math.max(0, gate.startDelay * 1000) : 0;
  /**
   * An authored duration is honoured exactly; only an absent or zero one takes
   * the tick. `1e-6` rather than `> 0` because one gate in the game authors
   * 2.78e-17, which is a zero that survived a spreadsheet.
   */
  const authoredResetMs = Number.isFinite(gate.resetTime) ? gate.resetTime * 1000 : 0;
  const resetMs = authoredResetMs > 1e-6 ? authoredResetMs : MINIMUM_PULSE_MS;

  const open = () => {
    emitSignal(session, gate.id, true);
    const close = setTimeout(() => {
      session.logicGateTimers.delete(gate.id);
      emitSignal(session, gate.id, false);
    }, resetMs);
    close.unref?.();
    session.logicGateTimers.set(gate.id, close);
  };

  if (!startMs) return open();

  const waiting = setTimeout(open, startMs);
  waiting.unref?.();
  session.logicGateTimers.set(gate.id, waiting);
};

/**
 * Triggerables that are not objects.
 *
 * Most of a floor's triggerables are real NPC rows — gates, spikes, jails — but
 * a few name an action instead, and looking those up in the NPC table only
 * produces a warning and a missing target. They are how a floor ends and how it
 * talks to the player, so a floor whose completion triggerable never built can
 * be cleared of every enemy and still never finish.
 */
const VIRTUAL_TRIGGERABLES = {
  /**
   * Ends the floor at once. On the last floor that is the dungeon won.
   *
   * Held while a generator that has started still owes spawns or has live ones.
   * A generator pulses its own signal the moment it starts — that pulse is what
   * opens cage doors — and the tutorial's reward chest hangs off a generator
   * whose signal also reaches this triggerable. Without the guard the floor
   * ended as the chest appeared, leaving no time to pick it up; with it, the
   * floor waits for the chest to be broken.
   */
  FLOOR_COMPLETION_IMMEDIATE: (session) => {
    /**
     * No guard here any more. It existed because the reward generator announced
     * itself on start and ended the floor as the chest appeared; that is fixed
     * at the source now, and the time to collect comes from the victory being
     * scheduled rather than sent inline. Holding the floor open until every
     * spawn was dead also meant a live brute could block a win the game had
     * already declared.
     */
    session.completeFloor?.(session, { immediate: true });
    return true;
  },
  /**
   * The same thing under the name most of the game uses.
   *
   * Nine tile libraries name this one and only four name FLOOR_COMPLETION_
   * IMMEDIATE — including nordic/caves/tiles.json, which is behind every
   * generated Icewater floor, and the arena's own library carries both. Not
   * knowing it meant those floors' completion triggerable never built, and they
   * could only end by killing everything or by walking to the exit.
   *
   * Treated the same because nothing distinguishes them. The client names
   * neither, so both are the server's own business, and the two captured
   * endings behave alike: the tutorial's IMMEDIATE and the Prisoner's Keep
   * boss's COMPLETE both ran COLLECT_TREASURE_GO, three seconds, 3_SECONDS_LEFT,
   * four more, then dungeonEnding.
   */
  FLOOR_COMPLETE_TRIGGERABLE: (session) => {
    session.completeFloor?.(session, { immediate: true });
    return true;
  },
  /**
   * The floor is lost. Battleheim is the one map that carries it: the princess
   * is a life trigger, and losing her is not the hero dying, so a floor needs a
   * way to fail that is not a death.
   */
  FLOOR_FAILURE_TRIGGERABLE: (session) => {
    session.reportFloorFailed?.(session);
    return true;
  },
  /**
   * Clears the floor of every living enemy.
   *
   * The Ice Dragon and the Frost Troll both carry one. A boss that dies with
   * its summons still up would otherwise leave the floor uncleared, so the
   * wiring reaches for this rather than asking the player to chase the last
   * imp around an empty room.
   */
  FLOOR_KILL_ALL_NPCS: (session) => {
    session.killAllEnemies?.(session);
    return true;
  },
  /**
   * The floor's own narration, published as DungeonFloor::show_text — the
   * minotaur's introduction on the tutorial's boss floor is one of these.
   */
  FLOOR_MESSAGE_TRIGGERABLE: (session, triggerable) => {
    session.showFloorText?.(session, triggerable);
    return true;
  },
  /**
   * A one-shot sound, named by the same textKey a message uses and published on
   * the floor's own play_sound field.
   */
  PLAY_SOUND_TRIGGERABLE: (session, triggerable) => {
    session.playFloorSound?.(session, triggerable);
    return true;
  },
};

export const isVirtualTriggerable = (constant) =>
  Object.hasOwn(VIRTUAL_TRIGGERABLES, constant);

const runVirtualTriggerable = (session, targetId, on) => {
  const triggerable = session.virtualTriggerables?.get(targetId);
  if (!triggerable) return false;
  // These are edges, not states: they do something when switched on and have
  // nothing to undo when switched off.
  if (on) {
    info(`[${session.id}] ${triggerable.constant} fired`);
    VIRTUAL_TRIGGERABLES[triggerable.constant](session, triggerable);
  }
  return true;
};

const deliverSignal = (session, targetId, on) => {
  if (runVirtualTriggerable(session, targetId, on)) return;

  const gate = session.logicGates?.get(targetId);
  if (gate) {
    if (gate.constant === "RESET_TIMER_GATE") {
      if (on) startResetGate(session, gate);
      return;
    }

    emitSignal(session, gate.id, evaluateGate(session, gate));
    return;
  }

  const startGenerator = session.generatorHandlers?.get(targetId);
  if (startGenerator) {
    if (!initialTargetState(session, targetId)) {
      session.generatorStops?.get(targetId)?.();
      return;
    }
    if (initialTargetState(session, targetId)) {
      try {
        Promise.resolve(startGenerator()).catch((error) =>
          warn(`generator ${targetId}: ${error.stack ?? error.message ?? error}`)
        );
      } catch (error) {
        warn(`generator ${targetId}: ${error.stack ?? error.message ?? error}`);
      }
    }
    return;
  }

  applyTargetState(session, targetId, initialTargetState(session, targetId));
};

/** Publishes a source value through the floor's LETriggers wiring graph. */
export const emitSignal = (session, sourceId, on) => {
  if (!session.signalValues || session.signalValues.get(sourceId) === on) return false;

  session.signalValues.set(sourceId, on);
  for (const targetId of session.signalTargets?.get(sourceId) ?? []) {
    deliverSignal(session, targetId, on);
  }
  return true;
};

/**
 * Announces that a generator is releasing a spawn without lying about whether
 * an all-spawns-dead generator has completed.
 *
 * Ordinary generators are edge sources, so their release remains a full
 * true/false pulse. `LENPCGeneratorWithAllSpawnsDeadTrigger` is a level source:
 * it stays false while any of its wave is alive and becomes true once, when
 * the wave clears. Pulsing that level for every spawn briefly opened every AND
 * and NOT kill gate downstream. In the temple exit room that dropped five
 * raised spike colliders once per monster, letting the player cross a barrier
 * that is authored to remain closed until all four monsters die.
 *
 * Three all-dead generators also drive a RESET_TIMER_GATE directly. That gate
 * is explicitly an edge/latch for a cage door, so it still receives release
 * edges; persistent completion branches do not.
 */
export const emitGeneratorRelease = (session, placement) => {
  if (!placement?.clearsOnAllDead) {
    const raised = emitSignal(session, placement.id, true);
    const lowered = emitSignal(session, placement.id, false);
    return raised || lowered;
  }

  /**
   * Except where the gate is the end of the run rather than a door.
   *
   * The reward generator's timers are the floor's own ending — three seconds
   * to "3 SECONDS LEFT" and seven to the completion, both counted from the
   * chest *clearing*. Poking them as the chest came out started that countdown
   * while the player was still walking towards it, and put "3 SECONDS LEFT" on
   * screen three seconds after the boss fell. The recorded run sends three
   * floor lines in the whole fight and that is not one of them.
   *
   * Told apart by where the signal goes, which is the question
   * `rewardGeneratorIds` already answers: a generator whose wiring reaches a
   * FLOOR_COMPLETION_IMMEDIATE is ending the floor, and a cage door is not.
   */
  if (session.rewardGenerators?.has(placement.id)) return false;

  let delivered = false;
  for (const targetId of session.signalTargets?.get(placement.id) ?? []) {
    const gate = session.logicGates?.get(targetId);
    if (gate?.constant !== "RESET_TIMER_GATE") continue;
    deliverSignal(session, targetId, true);
    delivered = true;
  }
  return delivered;
};

const withinReach = (a, b, radius) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= radius * radius;
};

/**
 * An NPC died. Drops any NPC_LIFE_TRIGGER that named it.
 *
 * The polarity is the important part, and the wiring gives it away: the boss
 * tile's trigger feeds two BRUTE generators *and* a NOT_GATE, and that gate
 * feeds the reward chest. So the signal is "this actor is alive" — the brutes
 * come out alongside the minotaur and stop when it falls, at which point the
 * inverted branch opens and pays out. Read the other way round the brutes would
 * only appear after the boss was already dead.
 *
 * The trigger names its subject by placement id, which matters because the boss
 * tile's trigger sits outside its own radius of the boss it watches.
 */
/**
 * The first time something authored as a damage source is actually hurt.
 *
 * `NPC_DAMAGE_TRIGGER` names its watched object by placement id, exactly as
 * `NPC_LIFE_TRIGGER` does, and the catacombs use it for the two statues that
 * wake a room: one feeding five FODDER generators, the other four BRUISER
 * ones. It was parsed and stored and never published, so both statues were
 * scenery and nine generators never ran.
 *
 * Once per source. A second swing on the same statue changes nothing, which
 * keeps a downstream NOT gate from being released mid-fight; see the note on
 * `onDamage` in dungeon.js for why that is the safe reading rather than a
 * proven one.
 */
export const reportNpcDamage = (session, placementId) => {
  if (!placementId) return false;
  let fired = false;
  for (const trigger of session.triggers ?? []) {
    if (trigger.constant !== "NPC_DAMAGE_TRIGGER" || trigger.npcId !== placementId) continue;
    /**
     * Latched, unless the tile asks otherwise.
     *
     * Every authored one of these wakes something and stays woken — a statue
     * struck once opens the generators behind it, and striking it again is not
     * a second event. But a thing built to be hit *repeatedly* is a different
     * object: a stone you knock to cycle a choice answers every blow. None of
     * the game's tiles carry `repeats`, so nothing authored changes.
     */
    if (trigger.on && !trigger.repeats) continue;
    trigger.on = true;
    announce(session, trigger);
    illuminate(session, trigger);
    fired = emitSignal(session, trigger.id, true) || fired;
    info(`[${session.id}] NPC_DAMAGE_TRIGGER woken — ${placementId} was hit`);
  }
  return fired;
};

export const reportNpcDeath = (session, placementId) => {
  if (!placementId) return false;
  let fired = false;
  for (const trigger of session.triggers ?? []) {
    if (trigger.constant !== "NPC_LIFE_TRIGGER" || trigger.npcId !== placementId) continue;
    trigger.on = false;
    fired = emitSignal(session, trigger.id, false) || fired;
    info(`[${session.id}] NPC_LIFE_TRIGGER dropped — ${placementId} is down`);
  }
  return fired;
};

/**
 * Proximity triggers follow the hero; called from the position stream.
 *
 * Against the hero's **body**, not its feet. An actor's collision circle sits
 * 22 units above its position — the same offset combat already uses — and these
 * radii are small enough for that to be the whole of it: a catacomb button
 * carries a radius of 30 and its trigger sits 28 above the prop you can see.
 * Standing dead centre on the button put the feet 28 away from a 30-unit
 * trigger, so it registered with two units to spare and missed on any other
 * step. Measured from the body it is six away, with twenty-four to spare.
 *
 * Which is what "I press the button and nothing happens, sometimes" is.
 *
 * A point inside the circle, though, and not an overlap of the hero's own body
 * with it. Measured, because an audit proposed the overlap as the reason the
 * original's traps seem to stay up longer: 375 switch-on edges replayed off 109
 * official floors, with the hero read at the moment that caused each one — a
 * round trip earlier, 143ms — and its body compared against the trigger's
 * centre and radius. Of the 149 landing anywhere near the rim rather than on
 * some other source wired to the same trap, the median margin is **-4** and the
 * mass sits between -20 and +10. Counting the hero's 22-unit circle would put
 * that mass at +22, and it is not there.
 *
 * The slight negative is the position stream itself: samples arrive every
 * 208ms, so the hero is usually a little way inside by the time a crossing can
 * be seen at all.
 */
/**
 * What a trigger says when it fires — as a speaker if it names one, and as the
 * room if it does not.
 *
 * Shared by every kind of trigger rather than living inside the proximity loop,
 * because "walk up to it" and "hit it" are the same event to whoever authored
 * the tile, and a line should not depend on which one they chose.
 */
const announce = (session, trigger) => {
  if (!trigger?.chatText) return;
  if (trigger.speaker && say(session, trigger.speaker, trigger.chatText)) return;
  tell(session, trigger.chatText);
};

/**
 * Marks whatever a trigger is about, so the world can say "this one" without
 * words. The subject is the actor it watches, or the one it speaks as.
 *
 * Failing to mark something is never worth losing the event over, so it is
 * fired and forgotten.
 */
const illuminate = (session, trigger) => {
  if (!trigger?.highlight) return;
  const placementId = trigger.npcId ?? trigger.speaker;
  const doid = session.npcDoids?.get(placementId) ?? session.speakers?.get(placementId)?.heroDoid;
  if (!doid) return;
  grantBuff(session, trigger.highlight, { affectedActor: doid }).catch((error) =>
    warn(`[${session.id}] could not mark ${placementId}: ${error.message}`)
  );
};

const applyProximityState = (session, trigger, inside) => {
  if (inside === trigger.on) return false;
  if (trigger.triggerOnce && trigger.fired) return false;

  trigger.on = inside;
  if (inside && trigger.triggerOnce) trigger.fired = true;
  if (inside) {
    // The highlight describes shared world state, so the first party member in
    // is enough. Speech and doorway travel are per-member and handled below.
    illuminate(session, trigger);
  }
  emitSignal(session, trigger.id, inside);
  info(`[${session.id}] trigger ${trigger.constant} ${inside ? "entered" : "left"}`);
  return true;
};

/** Removes one hero from every shared proximity zone immediately. */
export const releaseProximityActor = (session, heroDoid) => {
  if (heroDoid === undefined || heroDoid === null) return 0;
  let changed = 0;
  for (const trigger of session.triggers ?? []) {
    if (!trigger.constant.startsWith("PROXIMITY")) continue;
    trigger.occupants ??= new Set();
    if (!trigger.occupants.delete(heroDoid)) continue;
    if (applyProximityState(session, trigger, trigger.occupants.size > 0)) changed++;
  }
  return changed;
};

export const updateProximityTriggers = (session, position) => {
  const hero = session.actors?.get(session.heroDoid);
  const at = collisionPointOf(hero, position);
  /**
   * A corpse is not standing anywhere.
   *
   * The hero broadcasts its position while it is down, so without this a
   * proximity trigger the hero died inside stays entered for as long as the
   * body lies there — and whatever hangs off it stays switched on, which is the
   * "the wall traps keep going while I am dead" report. Falling out of every
   * radius on death also means reviving walks back into them, which is what
   * makes the state right again on its own.
   */
  const down = Boolean(hero?.dead);

  for (const trigger of session.triggers ?? []) {
    if (!trigger.constant.startsWith("PROXIMITY")) continue;

    trigger.occupants ??= new Set();
    // Disconnects and deaths may happen between position packets. Prune them
    // whenever any party member reports movement so stale occupants cannot
    // hold a switch high.
    for (const occupant of trigger.occupants) {
      if (
        (session.playerActors && !session.playerActors.has(occupant)) ||
        session.actors?.get(occupant)?.dead ||
        !session.actors?.has(occupant)
      ) {
        trigger.occupants.delete(occupant);
      }
    }

    const memberInside = !down && withinReach(at, trigger, trigger.radius);
    const memberEntered = memberInside && !trigger.occupants.has(session.heroDoid);
    const alreadyFired = trigger.triggerOnce && trigger.fired;
    if (memberInside) trigger.occupants.add(session.heroDoid);
    else trigger.occupants.delete(session.heroDoid);
    if (memberEntered && !alreadyFired) {
      // These are addressed to one connection. A second player crossing while
      // the shared signal is already high still needs its own line and its own
      // doorway transition.
      announce(session, trigger);
      if (trigger.destination) {
        walkThrough(session, trigger.destination).catch((problem) =>
          warn(`[${session.id}] door failed: ${problem.message}`)
        );
      }
    }
    applyProximityState(session, trigger, trigger.occupants.size > 0);
  }
};

const seconds = (value, fallbackMs) =>
  Number.isFinite(value) ? Math.max(1, value * 1000) : fallbackMs;

/**
 * How long a self-driving trigger spends switched on and switched off.
 *
 * Two constants author this, and they are not interchangeable. `AUTO_TIMER`
 * carries one `intervalTime` and splits it evenly, so its cycle is twice that.
 * `ASYM_AUTO_TIMER` carries `onTime` and `offTime` instead, because the traps
 * hanging off it hold a pose far longer than they reset — a cave mace swings
 * for 3.5 seconds and is down for half of one.
 *
 * Reading only the symmetric one left every mace, crusher, blade, log and
 * slicer in all nine themes with no source that ever moved: 113 triggers.
 */
const cycleOf = (trigger) => {
  if (trigger.constant === "ASYM_AUTO_TIMER_TRIGGER") {
    return {
      onMs: seconds(trigger.onTime, config.trapCycleMs),
      offMs: seconds(trigger.offTime, config.trapCycleMs),
      // A timer rests on — see trackTriggers — so the wait before the first
      // change is however long it stays that way.
      startMs: seconds(trigger.onTime, config.trapCycleMs),
    };
  }
  const intervalMs = seconds(trigger.intervalTime, config.trapCycleMs);
  return {
    onMs: intervalMs,
    offMs: intervalMs,
    startMs: Number.isFinite(trigger.startDelay)
      ? Math.max(0, trigger.startDelay * 1000)
      : intervalMs,
  };
};

const TIMER_TRIGGERS = new Set(["AUTO_TIMER_TRIGGER", "ASYM_AUTO_TIMER_TRIGGER"]);

/**
 * Starts the timers that drive cycling traps. Returns a stop function so the
 * timers die with the session rather than outliving it.
 */
export const startTimerTriggers = (session) => {
  const stopTimers = [];

  for (const trigger of session.triggers ?? []) {
    if (!TIMER_TRIGGERS.has(trigger.constant)) continue;

    const { onMs, offMs, startMs } = cycleOf(trigger);
    let pending;
    /**
     * Rescheduled each half rather than run on one interval, because the two
     * halves differ. Chaining timeouts also keeps a slow tick from stacking up
     * the way a fixed interval would.
     */
    const tick = () => {
      trigger.on = !trigger.on;
      emitSignal(session, trigger.id, trigger.on);
      pending = setTimeout(tick, trigger.on ? onMs : offMs);
      pending.unref?.();
    };

    pending = setTimeout(tick, startMs);
    pending.unref?.();
    stopTimers.push(() => clearTimeout(pending));
  }

  if (stopTimers.length) info(`[${session.id}] ${stopTimers.length} timer trigger(s) cycling`);
  return () => {
    stopTimers.forEach((stop) => stop());
    for (const timer of session.logicGateTimers?.values() ?? []) clearTimeout(timer);
    session.logicGateTimers?.clear();
  };
};

/** Registers the floor's triggers on the session, wired to their targets. */
export const trackTriggers = (session, floor) => {
  session.signalTargets = floor.wiring;
  session.signalIncoming = new Map();
  session.signalValues = new Map();
  session.logicGates = new Map(
    floor.placements.logicGate.map((gate) => [gate.id, gate])
  );
  session.logicGateTimers = new Map();
  session.generatorHandlers = new Map();
  // The only sources that move by themselves; see canEverChange.
  session.movableSources = new Set([
    ...floor.placements.trigger.map((trigger) => trigger.id),
    ...floor.placements.generator.map((generator) => generator.id),
  ]);

  for (const [sourceId, targets] of floor.wiring) {
    for (const targetId of targets) {
      const sources = session.signalIncoming.get(targetId) ?? [];
      sources.push(sourceId);
      session.signalIncoming.set(targetId, sources);
    }
  }

  // Triggerables that name an action rather than an object, kept aside so the
  // NPC builder does not try to look them up in the monster table.
  session.virtualTriggerables = new Map(
    (floor.placements.triggerable ?? [])
      .filter((triggerable) => isVirtualTriggerable(triggerable.constant))
      .map((triggerable) => [triggerable.id, triggerable])
  );

  // Names for the trace, so a report can be answered without replaying it.
  session.triggerableNames = new Map(
    (floor.placements.triggerable ?? []).map(({ id, constant }) => [id, constant])
  );
  session.tracePattern = envSetting("TRACE") ? new RegExp(envSetting("TRACE")) : null;

  session.triggers = floor.placements.trigger.map((trigger) => ({
    ...trigger,
    targets: floor.wiring.get(trigger.id) ?? [],
    on: false,
    fired: false,
    occupants: new Set(),
  }));
  // Kept on the run so combat/disconnect teardown can release a hero without
  // importing this module back through the doors -> match-runtime cycle.
  session.releaseProximityActor = releaseProximityActor;

  /**
   * What a source is before anything has happened.
   *
   * A life trigger rests *on*: its subject starts the floor alive. So does a
   * timer, and that one was resting off — which put every trap wired straight
   * to one into the floor retracted and harmless until its first tick.
   *
   * The captures say otherwise. Of the traps whose every placement is fed by
   * nothing but an `AUTO_TIMER_TRIGGER`, the official generates **76 raised
   * against 18 retracted**, and the two that are unambiguous are unanimous:
   * `CASTLE_ARENA_TRAP_SPIKES_I` 17 of 17 raised, `NORDIC_CAVE_GARGOYLE_
   * EMITTER_C` 18 of 18. Ours generated all of them retracted.
   *
   * The 18 are the timers whose first tick had already come round by the time
   * the floor was built, which is also why the split is not cleaner: a floor is
   * generated in the first moments of its own clock.
   *
   * Everything else rests off until something fires it.
   */
  for (const trigger of session.triggers) {
    /**
     * A timer rests on only if it is already running.
     *
     * The split above is 76 raised to 18 retracted, and `startDelay` is what
     * separates them. Replaying an ARENA_C floor of the official's own layout
     * and reading the state it opened each trap in:
     *
     *   startDelay 0     ->  on   (3)
     *   startDelay 0.3   ->  off  (5)
     *   startDelay 0.5   ->  off  (4)
     *   startDelay 1.0   ->  off  (12)
     *   startDelay 1.5   ->  off  (6)
     *
     * A timer with a delay has not ticked when the floor is built, so what
     * hangs off it is still waiting; one with no delay is already going. Taking
     * every timer as running opened 26 traps that should have been shut, and
     * the flat rule before that shut 13 that should have been open.
     */
    /**
     * And a timer only runs while whatever feeds it is on.
     *
     * A timer can itself be wired to. Thirteen arena spikes hang off
     * `NOT <- timer(delay 0) <- AND <- three sources the layout never placed`:
     * the AND cannot be satisfied, so the timer is not running, so the NOT that
     * hangs off it is on — which is what the official generates and what we
     * generated backwards while treating every timer as running regardless of
     * its own inputs.
     *
     * A timer with nothing feeding it is always enabled, which is the ordinary
     * case and the one the 76-to-18 split was measured on.
     */
    const timer = TIMER_TRIGGERS.has(trigger.constant);
    // 1.39e-16 is a delay of zero that survived a spreadsheet.
    const delayed = timer && Number(trigger.startDelay ?? 0) > 1e-6;
    const feeds = session.signalIncoming?.get(trigger.id) ?? [];
    const enabled = !feeds.length || feeds.some((id) => session.signalValues.get(id));
    const restsOn =
      trigger.constant === "NPC_LIFE_TRIGGER" || (timer && !delayed && enabled);
    trigger.on = restsOn;
    session.signalValues.set(trigger.id, restsOn);
  }
  for (const generator of floor.placements.generator) {
    session.signalValues.set(generator.id, false);
  }
  for (const gate of floor.placements.logicGate) session.signalValues.set(gate.id, false);

  // Resolve the graph's resting state before objects are generated. This makes
  // NOT-gated jails solid/closed and directly wired buttons inactive from the
  // first frame, without emitting activation events into generators.
  const maxPasses = Math.max(1, floor.placements.logicGate.length * 2);
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    for (const gate of floor.placements.logicGate) {
      if (gate.constant === "RESET_TIMER_GATE") continue;
      const value = evaluateGate(session, gate);
      if (session.signalValues.get(gate.id) === value) continue;
      session.signalValues.set(gate.id, value);
      changed = true;
    }
    if (!changed) break;
  }

  // NPCGameObject swaps navCollisions/navCollisions_off with the same state.
  // Seed the server copy before AI starts so a closed gate blocks immediately.
  for (const triggerable of floor.placements.triggerable ?? []) {
    setNavigationTriggerState(
      session.navigation,
      triggerable.id,
      initialTargetState(session, triggerable.id)
    );
  }
};
