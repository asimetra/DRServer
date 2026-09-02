import { PacketWriter } from "./packet.js";
import { OP } from "./opcodes.js";
import { config } from "../config.js";
import { info, warn } from "../log.js";
import { scheduleDungeonSummary } from "./summary.js";
import { awardDungeonCompletion } from "./rewards.js";
import { membersOf } from "./match-world.js";
import { dungeonMatches } from "./matches.js";

/**
 * Floor outcome.
 *
 * Finishing a dungeon is announced on the *area*, not the floor:
 * DistributedDungionArea.dungeonEnding forwards to its active floor's
 * victory() or defeat(). That only works if the floor was generated as a child
 * of the area, since Area.mActiveFloor is set by newNetworkChild.
 */

const FLID_AREA = {
  dungeonEnding: 216,
  floorFailing: 217,
};

/**
 * `dungeonEnding(seconds, success)` — the run is over.
 *
 * The short is how long until the report, and the server is the one that
 * honours it: DistributedDungionArea.dungeonEnding only reads the flag and
 * calls victory() or defeat(). Four captured endings all sent `05 00 01` and
 * the DungeonSummary followed at 5.040, 5.007, 5.016 and 5.000 seconds — so
 * the number on the wire and the wait are the same number, and are taken from
 * one place here rather than written down twice.
 */
export const buildDungeonEnding = (areaDoid, victory) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(areaDoid)
    .u16(FLID_AREA.dungeonEnding)
    .u16(Math.round(config.dungeonSummaryDelayMs / 1000))
    .u8(victory ? 1 : 0)
    .frame();

/**
 * `floorfailing(seconds)` — the party is down and this is how long it has.
 *
 * FloorEndingGui reads it as a switch rather than a number: anything above zero
 * puts a countdown on screen, and zero calls stopDefeatCounterIfRunning. So the
 * run is not lost when the last hero drops, it is lost when this expires, and a
 * revive in time cancels it.
 *
 * The length is a property of the map node. Every captured Infinite run sent
 * ten; the one captured ordinary dungeon sent sixty. One session settles that
 * it tracks the node and not the day: three Icewater runs, then an entry to
 * Infinite Prison, then ten, then back to Icewater.
 */
export const buildFloorFailing = (areaDoid, seconds) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(areaDoid)
    .u16(FLID_AREA.floorFailing)
    .u16(seconds)
    .frame();

const DEFEAT_COUNTDOWN_SECONDS = 60;
const INFINITE_DEFEAT_COUNTDOWN_SECONDS = 10;

const defeatCountdownSeconds = (session) =>
  session.mapPage?.NodeType === "INFINITE"
    ? INFINITE_DEFEAT_COUNTDOWN_SECONDS
    : DEFEAT_COUNTDOWN_SECONDS;

/**
 * Whether there is anybody left standing.
 *
 * The countdown is not one hero's death — a party fights on while one of its
 * members is down, and only starts failing when the last one falls. Solo makes
 * that condition invisible, since the one hero is the whole party, so it is
 * written against the set of players rather than against `heroDoid`: when party
 * play arrives the set grows and this needs no thought.
 */
const everyPlayerDown = (session) => {
  const players = session.playerActors ?? [session.heroDoid];
  for (const doid of players) {
    const actor = session.actors?.get(doid);
    if (actor && !actor.dead) return false;
  }
  return true;
};

/**
 * Whether there is a party here at all.
 *
 * `everyPlayerDown` answers true for a party of nobody, which is right for the
 * question it is asked and wrong as a reason to start a countdown. The last
 * member leaving takes the world with it, and a timer started on the way out
 * would fire into the wreckage.
 */
const anyPlayerPresent = (session) => {
  const players = session.playerActors ?? [session.heroDoid];
  for (const doid of players) {
    if (session.actors?.get(doid)) return true;
  }
  return false;
};

/**
 * How long the number on screen actually takes to run out.
 *
 * Not the number itself. FloorEndingGui shows a start clip and tweens it away
 * over two seconds before the first tick, then ticks once a second — and it
 * decrements *before* rendering, so a 60 renders 59 first and needs 61 ticks to
 * pass zero. Sixty on the wire is sixty-three on the clock.
 *
 * The official server waits exactly that long: a captured floorfailing of 60
 * was followed by dungeonEnding 62.986 seconds later, with nothing from the
 * client in between — the countdown finishing dispatches a local event that
 * only hides the revive panel, so the wait is the server's to get right.
 *
 * Waiting the bare sixty is what ended the run with five still showing.
 */
const COUNTDOWN_LEAD_IN_MS = 2000;
const countdownDurationMs = (seconds) => COUNTDOWN_LEAD_IN_MS + (seconds + 1) * 1000;

/**
 * A hero has dropped. Starts the countdown if that was the last one up.
 *
 * Idempotent: a second death while the counter runs must not restart it, or a
 * party would be unkillable as long as its members took turns falling.
 */
export const beginFloorFailing = (session) => {
  if (session.floorFailingTimer || session.floorCleared || !session.areaDoid) return;
  if (!everyPlayerDown(session)) return;

  const seconds = defeatCountdownSeconds(session);
  session.send(buildFloorFailing(session.areaDoid, seconds));
  const timer = setTimeout(() => {
    session.floorFailingTimer = null;
    (session.reportFloorFailed ?? reportFloorFailed)(session);
  }, countdownDurationMs(seconds));
  timer.unref?.();
  session.floorFailingTimer = timer;
  info(`[${session.id}] every player down — ${seconds}s to revive`);
};

/** Somebody got back up: stop the counter on the client too. */
export const cancelFloorFailing = (session) => {
  if (!session.floorFailingTimer) return;
  clearFloorFailing(session);
  if (session.areaDoid) session.send(buildFloorFailing(session.areaDoid, 0));
};

/**
 * Restores the one rule this file has: the countdown runs exactly while
 * nobody is up.
 *
 * Written as an invariant rather than as a list of events, because the list
 * kept being wrong. Death started it and a revive stopped it; then joining had
 * to stop it too, since a joiner arrives standing; and leaving had to be able
 * to *start* it, since the last player on their feet walking out leaves a floor
 * of corpses that nothing else would ever fail. Three events, one question, and
 * every new way to change the party was another chance to forget one.
 *
 * So this asks the question instead of trusting the caller to know the answer,
 * and it moves in both directions. Anything that changes who is in the party or
 * whether they are standing can call it, including twice, including when
 * nothing changed.
 */
export const refreshFloorFailing = (session) => {
  const down = everyPlayerDown(session);

  if (session.floorFailingTimer) {
    if (down) return;
    cancelFloorFailing(session);
    info(`[${session.id}] somebody is up again — defeat countdown stopped`);
    return;
  }

  if (!down || !anyPlayerPresent(session)) return;
  beginFloorFailing(session);
};

/** Drops the timer without telling a client that may already be gone. */
export const clearFloorFailing = (session) => {
  if (!session.floorFailingTimer) return;
  clearTimeout(session.floorFailingTimer);
  session.floorFailingTimer = null;
};

const FLID_FLOOR_SHOW_TEXT = 201;
const FLID_FLOOR_PLAY_SOUND = 202;

/**
 * The two lines the floor says while the run is ending, and when.
 *
 * The seven seconds were already right and silent — the delay was implemented
 * and the narration that fills it was not, so a player watched the loot settle
 * and then nothing at all until the screen changed. Six recorded chest endings
 * put the same two lines in the same places, to within a twentieth of a second:
 *
 *   COLLECT_TREASURE_GO   as the shower ends
 *   3_SECONDS_LEFT        3.00, 3.00, 2.99, 3.01, 3.04, 3.06 later
 *   dungeonEnding         4.01, 3.99, 4.00, 4.02, 4.05, 4.06 after that
 *
 * `3_SECONDS_LEFT` names what remains after it, which is the four above and not
 * three; the string is the client's and is left as the game spells it.
 */
const VICTORY_TEXTS = [
  { key: "COLLECT_TREASURE_GO", at: 0 },
  { key: "3_SECONDS_LEFT", at: 3000 },
];

/**
 * How long after a floor completes the win is announced, in milliseconds.
 * Measured from a captured run: three seconds of countdown and four more before
 * dungeonEnding.
 */
const VICTORY_DELAY_MS = 7000;

/**
 * DistributedDungeonFloor::show_text — the floor's own narration, keyed by a
 * locale string. The tutorial's boss floor sends TUTORIAL_MINOTAUR_INTRO on
 * arrival and COLLECT_TREASURE_GO once the minotaur is down.
 */
export const buildShowText = (floorDoid, textKey) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(floorDoid)
    .u16(FLID_FLOOR_SHOW_TEXT)
    .utf(textKey)
    .frame();

export const showFloorText = (session, triggerable) => {
  if (!triggerable?.textKey || !session.floorDoid) return false;
  session.send(buildShowText(session.floorDoid, triggerable.textKey));
  info(`[${session.id}] floor text "${triggerable.textKey}"`);
  return true;
};

/**
 * DistributedDungeonFloor::play_sound — a one-shot from soundEffects.swf,
 * named by the triggerable's own textKey exactly as show_text is.
 *
 * The Lava Golem's floor carries fourteen of these, which is why it built nine
 * triggerables out of twenty-three: PLAY_SOUND_TRIGGERABLE has no NPC row, so
 * the builder went looking for a monster and warned instead.
 */
export const buildPlaySound = (floorDoid, soundKey) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(floorDoid)
    .u16(FLID_FLOOR_PLAY_SOUND)
    .utf(soundKey)
    .frame();

export const playFloorSound = (session, triggerable) => {
  if (!triggerable?.textKey || !session.floorDoid) return false;
  session.send(buildPlaySound(session.floorDoid, triggerable.textKey));
  info(`[${session.id}] floor sound "${triggerable.textKey}"`);
  return true;
};

/**
 * The floor is over.
 *
 * This is the single place that decides what that means, and it is reached two
 * ways: the FLOOR_COMPLETION_IMMEDIATE triggerable at the end of a floor's
 * trigger graph, and the hero walking into the exit — which in the tile data is
 * the same thing, since JASONS_DUNGEON_EXIT is wired straight to a completion
 * triggerable.
 *
 * A floor with somewhere to go hands over to the next one; the last floor wins
 * the dungeon.
 */
export const completeFloor = (session) => {
  if (session.floorFinished) return false;
  session.floorFinished = true;

  // How many floors a run has comes from its plan now — a node is either a
  // list of authored files or a tier that says how many to lay out.
  if ((session.floorIndex ?? 0) + 1 < (session.floorCount ?? 1)) {
    session.advanceFloor?.(session);
    return true;
  }

  // Clearing the final floor is the admission boundary. The loot/victory
  // delay remains playable for current members, but nobody new may enter it
  // and be included in the completion-award loop below.
  const match = session.dungeonMatch ?? session.world?.match;
  if (match) dungeonMatches.finish(match);

  /**
   * The win is announced late, not at once. A captured tutorial run spaces it
   * out: the chest breaks and COLLECT_TREASURE_GO goes out, three seconds later
   * 3_SECONDS_LEFT, and four seconds after that dungeonEnding — with the
   * summary a further five behind it. Firing the victory the moment the last
   * object dies takes the loot off the floor before the player can reach it.
   */
  /**
   * The countdown starts once the floor has stopped dropping things.
   *
   * A chest completes the floor the instant it breaks, and then spends the next
   * six seconds throwing its contents across the room — so a countdown begun at
   * the break runs underneath the shower it is meant to follow. The captures put
   * COLLECT_TREASURE_GO at the end of the drop, and chest-death to dungeonEnding
   * at 13.37, 13.41 and 13.45 seconds against the 13.29 that the timeline's 6.29
   * plus this seven produce.
   *
   * Read from the loot rather than from the chest, so a floor that ends without
   * dropping anything still ends immediately — `lootSettlesAt` is only ever set
   * by something that scheduled a shower.
   */
  const settling = Math.max(0, (session.lootSettlesAt ?? 0) - Date.now());
  const delayMs = (session.victoryDelayMs ?? VICTORY_DELAY_MS) + settling;
  info(
    `[${session.id}] final floor complete — victory in ${delayMs}ms` +
      (settling ? ` (${settling}ms of it waiting on loot)` : "")
  );

  /**
   * The narration that fills that wait. Held on the same set the victory timer
   * is cancelled through, so leaving early takes the countdown with it rather
   * than announcing treasure into an empty floor.
   */
  session.victoryTextTimers ??= new Set();
  for (const { key, at } of VICTORY_TEXTS) {
    if (at >= delayMs) continue;
    const textTimer = setTimeout(() => {
      session.victoryTextTimers?.delete(textTimer);
      if (!session.dungeonActive || !session.floorDoid) return;
      session.send(buildShowText(session.floorDoid, key));
    }, at);
    textTimer.unref?.();
    session.victoryTextTimers.add(textTimer);
  }

  const timer = setTimeout(async () => {
    session.victoryTimer = null;
    if (!session.dungeonActive) return;
    // Paid before the announcement so the summary reports what was banked.
    for (const member of membersOf(session)) {
      const target = member.world?.contextFor(member) ?? member;
      await (target.awardDungeonCompletion ?? awardDungeonCompletion)(target).catch((error) =>
        warn(`[${target.id}] could not award completion: ${error.message}`)
      );
    }
    if (!session.dungeonActive) return;
    /**
     * The hero stays. A boss floor ends with treasure on the ground and the
     * player still able to walk to it — removing them here took the loot away
     * with them. removeHeroFromFloor is what the summary calls when the run is
     * really over; the only ending that takes the hero early is walking out.
     */
    session.send(buildDungeonEnding(session.areaDoid, true));
    (session.scheduleDungeonSummary ?? scheduleDungeonSummary)(session, true);
    info(`[${session.id}] victory sent`);
  }, delayMs);
  timer.unref?.();
  session.victoryTimer = timer;
  return true;
};

/**
 * Cancels a pending victory, so leaving a dungeon does not announce one later.
 *
 * The countdown lines go with it. They are scheduled independently of the
 * victory timer, so cancelling only that one left a floor nobody was on still
 * being told to collect its treasure.
 */
export const cancelVictory = (session) => {
  for (const timer of session.victoryTextTimers ?? []) clearTimeout(timer);
  session.victoryTextTimers?.clear();
  if (!session.victoryTimer) return;
  clearTimeout(session.victoryTimer);
  session.victoryTimer = null;
};

/**
 * The two triggerables that end a floor on their own terms.
 *
 * Both are the floor saying "I decide when this is over" — a chest to break, a
 * switch to reach — and a floor carrying either does not want the last kill to
 * decide for it.
 */
const COMPLETION_TRIGGERABLES = new Set([
  "FLOOR_COMPLETION_IMMEDIATE",
  "FLOOR_COMPLETE_TRIGGERABLE",
]);

const authorsItsOwnEnding = (session) => {
  for (const constant of session.triggerableNames?.values() ?? []) {
    if (COMPLETION_TRIGGERABLES.has(constant)) return true;
  }
  return false;
};

/**
 * Called after something dies. A floor is cleared when no enemy is left alive —
 * props and scenery do not count, or smashing the last barrel would end the
 * dungeon.
 */
export const checkFloorCleared = (session) => {
  if (session.floorCleared || !session.areaDoid) return false;

  // A proximity-gated cage is still part of the encounter even before its
  // actors exist. Otherwise killing the room's front line can end the floor
  // before the player steps on the button that releases the remaining waves.
  if ([...(session.generators?.values() ?? [])].some((generator) => !generator.completed)) {
    return false;
  }

  let enemies = 0;
  let alive = 0;
  for (const actor of session.actors.values()) {
    if (!actor.isEnemy) continue;
    enemies++;
    if (!actor.dead) alive++;
  }

  /**
   * A floor with no enemies at all is not a cleared floor, or smashing the
   * last barrel in an empty room would end the dungeon. That used to be read
   * off the floor, which worked only while corpses stayed on it; they are
   * dropped as they die now, so the floor is asked what it once held.
   * `enemies` remains the answer for anything that never spawned through the
   * generators, such as a hand-built floor in a test.
   */
  if (!(session.enemiesSeen || enemies) || alive > 0) return false;

  session.floorCleared = true;
  // A burning mob can die after the hero has dropped, which wins the floor with
  // the defeat counter still on screen. Expiry is already harmless — it checks
  // floorCleared — but the client keeps counting until it is told not to.
  cancelFloorFailing(session);

  /**
   * Clearing a floor is not the same as finishing a dungeon. When there is
   * another floor, clearing only opens the gate in front of the exit and the
   * run continues once the hero walks through it — see checkFloorExit. The
   * dungeon ends only on the last floor, which is the one with no exit.
   */
  if (session.floorExits?.length) {
    info(`[${session.id}] floor cleared — ${enemies} enemies down, exit is open`);
    return true;
  }

  /**
   * A last floor with no completion triggerable of its own still has to end,
   * so killing everything remains the fallback.
   *
   * Where the floor does carry one it is not a fallback, and this used to run
   * anyway on the assumption that the triggerable "fires first and this is a
   * no-op". It does not, on the ending the game is best known for: the reward
   * chest is `CharType: PROP`, so it is not one of the enemies counted above,
   * and the floor was therefore finished the moment the boss fell — before the
   * chest had been broken, and about six seconds before the drop it exists to
   * make. The player watched the run end and the treasure appear together.
   *
   * So a floor that authors its own ending is left to author it. That is the
   * chest's `FLOOR_COMPLETION_IMMEDIATE`, or the `FLOOR_COMPLETE_TRIGGERABLE`
   * that nine tile libraries name instead — see triggers.js, which treats the
   * two alike because nothing distinguishes them.
   */
  if (authorsItsOwnEnding(session)) {
    info(`[${session.id}] final floor cleared — ${enemies} enemies down, ending is the floor's`);
    return true;
  }

  info(`[${session.id}] final floor cleared — ${enemies} enemies down`);
  completeFloor(session);
  return true;
};

/**
 * The run is lost. Reached two ways: the defeat countdown running out, and
 * Battleheim's princess dying, which fails a floor without anyone being down.
 */
export const reportFloorFailed = (session) => {
  if (session.floorCleared || !session.areaDoid) return;

  clearFloorFailing(session);
  session.floorCleared = true;
  session.send(buildDungeonEnding(session.areaDoid, false));
  (session.scheduleDungeonSummary ?? scheduleDungeonSummary)(session, false);
  info(`[${session.id}] floor failed — defeat sent`);
};
