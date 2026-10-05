import { layerFor, LAYER_SORTED } from "./objects.js";
import { npcForConstant, propForConstant, resolveSpawnConstant, weaponForConstant, attackForConstant, attackColliders, projectileLaunch, attackTimelineFrames, projectileForConstant } from "../gamemaster.js";
import { npcStats } from "../combat-damage.js";
import { TEAM } from "./opcodes.js";
import { initialTargetState, initialTurretHeading, canEverChange, isVirtualTriggerable, raiseHazard, startTurretAim, traced, describeInputs } from "./triggers.js";
import { worldColliders } from "./heading.js";
import { classifyHazard } from "./hazards.js";
import { info } from "../log.js";
import { TEAM_BY_CHAR_TYPE, spawnNpc } from "./npc-spawn.js";
import { headingFor } from "./dungeon.js";

/**
 * Triggerables as they are built — traps, levers, bombs, turrets and the rest:
 * their resting state, what is inert, the hazard shapes, and
 * `buildTriggerables`.
 */

/**
 * Gates, jails and traps. They are NPC rows with CharType PROP, so the normal
 * spawn path handles them; they simply were never collected before.
 */
/**
 * Whether a placement should be left in its resting state and never driven.
 *
 * Only on a laid-out floor. An authored one was built with its wiring, so a
 * gate of its own that no trigger reaches is deliberate — the ones behind a
 * starting point are there to stop the player walking off the map.
 *
 * Unwired is included deliberately, and the captures are why. Of 473 cave spike
 * beds the official generates, 218 are never sent a trigger state at all, and
 * **not one of them ever deals damage**. A spike bed with nothing to raise it
 * stays down, so silencing it here is right rather than merely safe.
 *
 * The tar pit is the exception that proves it is the trap and not the wiring:
 * it is never sent a state either and hurts the hero anyway, forty recorded
 * times about a second apart. It is an `AREAOFEFFECT_AI` prop with
 * `InstantAttack`, which is a different mechanism from a triggered hazard —
 * see trap-findings.md. Nothing here reaches it, and nothing here should
 * pretend to.
 */
export const isInert = (session, placementId) =>
  Boolean(session.floorGenerated) && !canEverChange(session, placementId);

/**
 * Whether being stuck on would actually cost the player something.
 *
 * A tenth of the triggerables on a laid-out floor can never be switched by
 * anything standing on it, and not because the layout broke their wiring: the
 * libraries carry 961 links of 8051 whose other end names an object that is on
 * no tile at all. The wiring never crosses tiles — 7090 of the links are
 * within one and none spans two — so the official runs on exactly the same
 * dangling data, and it generates those objects *on*: `CASTLE_ARENA_GATE_D`
 * 84 times of 84, `CASTLE_ARENA_TRAP_JAIL` 162 of 165.
 *
 * Only one kind of stranding is worth being wrong about: a shut exit gate that
 * nothing can open and nobody can break — and most exit gates author
 * `IsAttackable` 0 — ends the run where it stands.
 *
 * Hazards were on this list too, on the reasoning that a spike bed stuck raised
 * is a wall that also hurts. The evidence does not support it. The official
 * generates `NORDIC_TEMPLE_TRAP_SPIKE` raised 730 times against 193 retracted
 * and `NORDIC_CAVE_SPIKETRAP` 441 against 119, on the same dangling data this
 * server has — a floor whose spikes are stranded is a floor whose spikes are
 * *up*, and it is played that way. Forcing them down instead turned a temple
 * room of thirty into flat plates: the trap is drawn, walked over and harmless,
 * which is the reported "they should be on and stay on".
 *
 * Named rather than columned for the exit gates, because the data has no
 * column for "the floor is behind this" — the same compromise, and the same
 * caveat, as `togglingLauncher`.
 */
const strandingCosts = (npc) => /EXIT_?GATE/.test(String(npc?.Constant ?? ""));

/**
 * The state a triggerable is put on the floor in.
 *
 * Four rules in a fixed order, and the order is the whole of it: a fire is
 * unlit whatever its wiring says, a launcher stays mounted whatever its wiring
 * says, a stranded exit gate opens against its wiring, and everything else is
 * generated where its signal graph rests.
 *
 * Exported because it is the one decision this server makes that a packet
 * census cannot see — both servers send field 141 on the same object and only
 * the value differs — so `tools/resting-state.js` compares it against the
 * official's rates per constant. It has to be the same code the builder runs or
 * the comparison measures the copy instead of the server.
 */
export const restingTriggerState = ({ npc, attack, projectile, inert, wired, hasInput = false }) => {
  const { togglesRenderer, restsUnlit, contactBomb } = classifyHazard({ npc, attack, projectile });
  if (restsUnlit) return 0;
  /**
   * A bomb with a wire waits on it. The official's Frostgaard boss floor
   * generates its two mines and two firebombs at 0, raises them to 1 when the
   * hero crosses the pad in front of the troll (an AND of the pad and the
   * troll's life), and lowers the one still lying there when the troll dies
   * (socket-20261005-172249: +53.44 generated, +58.98 raised, +85.62 lowered).
   * One without a wire is armed on arrival, as every bomb was.
   */
  if (contactBomb && hasInput) return wired ? 1 : 0;
  if (attack && !togglesRenderer) return 1;
  if (inert && strandingCosts(npc)) return 0;
  return wired ? 1 : 0;
};

export const buildTriggerables = async (context, placements) => {
  context.session.armedTraps = 0;
  context.session.inertTraps = new Map();
  context.session.stuckArmed = new Map();
  const { session } = context;
  session.triggerableDoids ??= new Map();
  session.triggerableAttacks ??= new Map();
  session.triggerableStatefulAttacks ??= new Set();
  session.triggerableHazards ??= new Map();
  let built = 0;

  for (const placement of placements) {
    if (!context.isActive()) break;
    // A few triggerables name an action instead of an object — ending the floor,
    // showing its text — and have no NPC row to build. They count as built,
    // because they are wired up and will fire.
    if (isVirtualTriggerable(placement.constant)) {
      built++;
      continue;
    }
    /**
     * Some triggerables name scenery rather than a monster — the cave's own
     * walls are placed this way. Those live in the Prop table, which shares no
     * constant with the NPC table, so the name alone settles who owns it: the
     * client draws it, and its collision is already registered by
     * readPlacements. Looking one up as an NPC only produced a warning per wall
     * per floor.
     */
    if (await propForConstant(placement.constant)) {
      built++;
      continue;
    }
    const npc = await npcForConstant(placement.constant);
    const attack = npc?.Attack1 && (await attackForConstant(npc.Attack1));
    // A floor that may hurt nobody (a quiet one, floors.js) keeps its gates and
    // drops what attacks: a trap is the triggerable with an attack of its own.
    if (session.currentFloor?.harmless && attack) continue;
    const projectile = attack?.Projectile
      ? await projectileForConstant(attack.Projectile)
      : null;
    if (!context.isActive()) break;
    /**
     * Whether the trap's own artwork switches on and off with its trigger.
     *
     * A spike bed and a flame jet *are* the effect: field 141 drives the
     * renderer as well as the choreography, so they have to receive it. A
     * launcher does not — it stays mounted on the wall while its timeline
     * cycles, and toggling it makes the launcher itself blink in and out.
     *
     * The question is whether the attack fires a projectile, not what it is
     * called. Naming TRAP_ARROWS here covered Arena's arrows and missed every
     * sibling: the Nordic caves shoot TRAP_ICEARROWS from gargoyle emitters,
     * the villages and temples the same, and Loki's statue throws a fireball.
     * All of them were being blinked on and off.
     */
    const {
      alwaysLive,
      burnsOnContact,
      togglingLauncher,
      togglesRenderer,
      contactBomb,
      restsUnlit,
    } = classifyHazard({ npc, attack, projectile });
    // Arrow launchers stay visible; stateful traps and ordinary actuators are
    // generated in the signal graph's resting state.
    /**
     * A door nothing can open is a wall.
     *
     * The wiring comes from the whole tile library, so a laid-out floor inherits
     * triggerables whose openers live in tiles that were never placed. Left in
     * its resting state such a gate stays shut for good, and the player walks up
     * to a doorway they can see through and cannot pass.
     *
     * The test is whether a live source reaches it, not whether any source does.
     * Measured over ten runs each: one exit gate in twenty-two on Icewater
     * Caverns 1-3 and ten in twenty-six on node 50004 were wired to a subtree of
     * pure logic that could never move, so "has a source" called them fine and
     * they stayed shut all run.
     *
     * A trap nobody can trigger goes quiet for the same reason, and the reason
     * is stronger than it looks: a raised trap is a *wall*, because
     * NPCGameObject switches its navigation colliders on with its trigger
     * state. One stuck raised is a permanent block that also does permanent
     * damage, and two of them close together is a pocket the player cannot walk
     * out of — reported, and the only way out was to die.
     *
     * This used to exclude hazards, which left them armed for ever and was the
     * opposite of what the paragraph above says.
     */
    /**
     * Only on a laid-out floor. An authored one was built with its wiring, so a
     * gate of its own that no trigger reaches is deliberate — the ones behind a
     * starting point are there to stop the player walking off the map, and
     * opening them was exactly that.
     *
     * Asked of this floor rather than the run, because a run mixes the two: a
     * boss node lays out its approach and then loads the authored map.
     */
    const inert = isInert(session, placement.id);

    /**
     * Computed once, because being drawn raised and biting have to be the same
     * decision. They were not: the generate asked `restingTriggerState` while
     * the arming below asked `!inert && initialTargetState`, and a stranded
     * spike bed satisfies the first and fails the second. That is a picture of
     * a trap standing in the floor that does nothing at all to whoever walks
     * through it — reported from a catacombs room full of raised spikes the
     * player could stroll across.
     *
     * It is a crack this session opened. Narrowing `strandingCosts` to exit
     * gates was right and is what the corpus says, but it left the two halves
     * disagreeing: before it, a stranded bed was generated flat and unarmed,
     * which at least agreed with itself.
     */
    const hasInput = (session.signalIncoming?.get(placement.id)?.length ?? 0) > 0;
    const resting = restingTriggerState({
      npc,
      attack,
      projectile,
      inert,
      wired: initialTargetState(session, placement.id),
      hasInput,
    });

    const launch = attack ? await projectileLaunch(attack.AttackTimeline) : null;
    const aimedHeading = initialTurretHeading({
      attack,
      projectile,
      position: placement,
      launch,
      hero: session.heroPosition,
      heroes: [...(session.playerActors ?? [])]
        .map((doid) => session.actors?.get(doid))
        .filter((actor) => actor && !actor.dead && actor.position)
        .map((actor) => actor.position),
    });

    const doid = await spawnNpc(context, placement.constant, placement, placement.scale, {
      triggerState: resting,
      returnDoid: true,
      heading: aimedHeading ?? undefined,
    });
    if (!doid) continue;

    session.triggerableDoids.set(placement.id, doid);
    /**
     * What to call this doid in a log line. A trap with no hit points is not in
     * `session.actors`, so nothing else knows its name — and "trap 1437 hit
     * hero" is a report nobody can act on. See dealTrapHit.
     */
    session.trapNames ??= new Map();
    session.trapNames.set(doid, {
      constant: placement.constant,
      x: placement.x,
      y: placement.y,
      /**
       * Zero-HP traps are protocol objects rather than damageable actors, so
       * they never enter session.actors. Their flat-damage attacks still use
       * the NPC's offence stat: the boss lava has weapon power 1 but a
       * level-19 MELEE_ATK of 30.2. Keeping the vector here lets priceHit use
       * the same formula as any other NPC instead of falling back to one.
       */
      stats: npcStats(context.gm, npc, session.npcLevel ?? 1),
    });
    if (attack) {
      session.triggerableAttacks.set(placement.id, attack.Id);
      session.triggerableHazards.set(placement.id, {
        attack,
        /**
         * The direction it shoots, which is the direction it faces.
         *
         * `launchTrapProjectile` reads `hazard.heading` and fell through to
         * zero, because nothing ever set it and the placement's own field is
         * `rotation` rather than `heading`. Every projectile trap in the game
         * therefore fired due east whatever its tile said — the gargoyles, the
         * arrow traps, the temple emitters — and only Loki's statue escaped it
         * by overwriting the field as it aims. See headingFor.
         */
        heading: aimedHeading ?? headingFor(npc, placement),
        /**
         * Where the client draws the shot leaving from.
         *
         * The timeline's `projectile` action carries it, and Loki's says
         * `yOffset: -180` — out of the statue's raised hands. Both the aim and
         * the flight are taken from there, because the client aims the actor
         * and then launches from the offset point: matching only one of the two
         * leaves the damage on a line parallel to the flame instead of under it.
         */
        launch,
        // Which side the trap is on, so its blast cannot take its neighbours
        // with it — see teamAllowsHit.
        team: TEAM_BY_CHAR_TYPE[npc.CharType] ?? TEAM.ENVIRONMENT,
        /**
         * How long its own animation runs, which is how long a spent bomb has
         * to stay on the floor before it may be taken away. See retireSpentBomb.
         */
        timelineFrames: await attackTimelineFrames(attack.AttackTimeline),
        // Spent by its first bite; see holdZone.
        contactBomb,
        projectile,
        // Carried for AttackTimer: how often a raised trap hits what stands in
        // it, which is authored on the NPC and not on the attack.
        npc,
        position: placement,
        /**
         * The trap's own weapon. Only the six flat-damage traps read it — the
         * five slicers and the burning ground — but every trap row carries one,
         * and without it a disk that should carve you took a single point.
         */
        weaponPower: (npc.Weapon1 && (await weaponForConstant(npc.Weapon1))?.Power) || 1,
        combatColliders: await hazardShape(npc, attack, placement),
        /**
         * A trap that comes out of the floor hurts the player and nobody else.
         * Every one of 25 recorded TRAP_SPIKES results named the hero, while
         * the mace, blade, flame jet, arrows and Thor's hammer all cut through
         * imps, knights and yetis. Monsters cross a spike bed and are only
         * shoved aside — which they are anyway, since a raised trap is a
         * navigation obstacle.
         *
         * Being drawn under the hero and coming out of the ground are the same
         * fact, so the layer is the test: every hero-only trap in the capture
         * is `background`, every one that hurts monsters is `sorted`.
         */
        heroOnly: layerFor(npc, placement.layer) < LAYER_SORTED,
      });
    }
    // A wired bomb is told its state, as the official tells its mines (0, then 1, then 0).
    if (togglesRenderer || (contactBomb && hasInput)) session.triggerableStatefulAttacks.add(placement.id);

    if (attack && inert) {
      session.inertTraps?.set(
        placement.constant,
        (session.inertTraps.get(placement.constant) ?? 0) + 1
      );
    }

    if (traced(session, placement.constant)) {
      info(
        `[trace] ${placement.constant} doid=${doid} at ${Math.round(placement.x)},` +
          `${Math.round(placement.y)} starts ${initialTargetState(session, placement.id) ? "on" : "off"}` +
          `${inert ? " (inert — nothing can ever change it)" : ""}` +
          `${attack ? ` attack=${attack.Constant}` : ""}\n` +
          describeInputs(session, placement.id)
      );
    }
    /**
     * A trap that comes up already raised has to start beating on its own.
     *
     * Every hazard beat until now was started by a signal *arriving*, and a
     * trap whose source can never move never receives one — so it stood up at
     * generation and was scenery for the rest of the run. On a laid-out floor
     * that is not the rare case: 181 of the ice caves' 527 spike beds hang off
     * a NOT gate, and a laid-out floor inherits gates whose inputs live in
     * tiles that were never placed.
     */
    /**
     * A statue shoots whether or not anything switched it on.
     *
     * Four of the six Loki statues in the temple capture are sent no trigger
     * packet at all and fire twenty-eight rounds between them anyway; the other
     * two get a single `remoteTriggerState = 1` a fifth of a second before
     * their first shot and never another. Waiting for `initialTargetState` left
     * ours silent on any floor whose wiring did not resolve, which is most of
     * them — the same way spike beds stood still before `burnsOnContact`.
     *
     * Armed on arrival, still switchable: the corpus has 26 switch-ons and 21
     * switch-offs across fourteen statues, so the toggling is real and stays.
     */
    if (
      attack &&
      (alwaysLive ||
        burnsOnContact ||
        // A bomb without a wire is armed on arrival; one with a wire waits on
        // it, and comes up armed only where its graph already rests high.
        (contactBomb && (!hasInput || resting)) ||
        (togglingLauncher && !inert) ||
        // Exactly what was drawn: a bed standing up bites, a flat one does not.
        (togglesRenderer && resting))
    ) {
      raiseHazard(session, placement.id);
      // A raised trap is also a wall — NPCGameObject turns its navigation
      // colliders on with its trigger state — so how much of a floor arrives
      // armed is worth being able to see.
      session.armedTraps = (session.armedTraps ?? 0) + 1;
      /**
       * Armed, and nothing on this floor can ever switch it off again.
       *
       * On a laid-out floor `isInert` has already silenced these. An authored
       * one keeps them deliberately, so nothing reported them at all — and a
       * hazard in this state is the shape of "it played once when the map
       * loaded and then the picture went, but walking through it still burns
       * me": the client draws one activation, while a sustained trap goes on
       * testing contact for the rest of the floor.
       *
       * Whether that is right is a question about the trap, so this names them
       * rather than changing anything.
       */
      if (!canEverChange(session, placement.id)) {
        session.stuckArmed?.set(
          placement.constant,
          (session.stuckArmed.get(placement.constant) ?? 0) + 1
        );
      }
    }

    // A turret turns whether or not its fire timer has come round, so this does
    // not hang off the arming above. Loki's statue is never sent a trigger
    // state at all in the captures, and turns for the whole floor.
    if (attack) startTurretAim(session, placement.id);
    built++;
  }
  return built;
};

/**
 * What a trap hits with.
 *
 * Two sources author a shape and most traps have only one. `library_server`
 * carries a `combatCollisions` shape for the traps that *are* their own effect
 * — a spike bed, a flame jet — placed and transformed with the tile. The moving
 * ones carry none at all: a mace and a crusher have navigation collisions and
 * nothing else, so asking only the library gave them an empty shape, and an
 * empty shape catches nobody. That is the whole of "the swinging traps do not
 * damage".
 *
 * Their shape is on the attack's own timeline instead, as the frames of the
 * swing — six for a cave mace, tracking the head from one side to the other.
 * Taking all of them at once makes the damage zone the whole arc for as long as
 * the trap is up, which is coarser than the animation: the real thing is only
 * dangerous where the head is *now*. Following the frames needs the trap's
 * animation clock, which nothing here has yet.
 */
/**
 * Where a trap can hurt you, from whichever of its two shapes is the truth.
 *
 * A triggerable carries an authored shape in `library_server` and its attack
 * carries a timeline, and they are good at different things. For a trap that
 * stands still the library wins: it is the real extent, nine boxes for the nine
 * spikes of `CASTLE_ARENA_TRAP_SPIKES_A` where the timeline has one generic
 * square.
 *
 * For a trap that moves the library cannot say anything at all, because its
 * boxes carry no frame. Preferring it flattened every flame jet — eighteen rows
 * whose timeline is three beats at 0, 500 and 958ms — into one static box, and
 * a flattened trap takes the sustained branch: no choreography is ever sent, so
 * the client never plays the flame, and damage lands on 100ms contact ticks
 * instead of on the authored beats. Which is exactly what our own stream showed
 * next to theirs: two hits 199ms apart and not one animation, against their one
 * animation per activation.
 *
 * So the timeline wins whenever it has something to say about motion, and the
 * library wins otherwise.
 */
const hazardShape = async (npc, attack, placement) => {
  const timeline = await attackColliders(attack.AttackTimeline);
  const moves = new Set(timeline.map((collider) => Number(collider.frame ?? 0))).size > 1;
  if (!moves && placement.combatColliders?.length) return placement.combatColliders;
  /**
   * The same heading the actor was generated at, or a flipped trap fires the
   * way it is not facing — an arrow emitter on the right-hand wall of a temple
   * drew itself pointing left and shot to the right, because the picture came
   * from `rotation` and the shot still came from `DefaultHeading`.
   */
  return worldColliders(placement, headingFor(npc ?? {}, placement), timeline);
};

/** A generator's spawn as this dungeon's monster — what the build resolves it to. */
export const spawnResolverFor = async (session, floor) => {
  const resolved = new Map();
  const generators = [
    ...(floor?.placements?.generator ?? []),
    ...(floor?.secrets ?? []).flatMap((room) => room.placements?.generator ?? []),
  ];
  for (const { spawnConstant } of generators) {
    if (!resolved.has(spawnConstant)) {
      resolved.set(spawnConstant, await resolveSpawnConstant(spawnConstant, session.mapNodeId));
    }
  }
  return (constant) => resolved.get(constant);
};
