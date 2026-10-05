import { config } from "../config.js";
import { matchHost } from "./match-host.js";
import { info, warn } from "../log.js";
import { CLID } from "./opcodes.js";
import { dungeonSummaryGenerate, objectDisable, playerGenerate } from "./objects.js";
import { membersOf, worldOf } from "./match-world.js";
import { settleDungeonAccount } from "./settle-account.js";
import { awardDungeonCompletion, completionTeamXpBonus } from "./rewards.js";
import { rankable } from "../leaderboard.js";
import { cancelScopedTimer } from "./lifecycle-scope.js";
import { countsAsKill } from "./actor-roles.js";
import { presentSkin } from "../content-packs.js";
import { modeHooks } from "../modes/hooks.js";
import { runRulesOf } from "./run-rules.js";

/**
 * Takes the hero off the floor, once.
 *
 * There are two moments for it and which one applies is the *ending*, not the
 * party. Four captured endings settle it, and the node type separates them
 * cleanly:
 *
 *   50078, 50081, 50025  DUNGEON  hero disabled 1ms before dungeonEnding
 *   50026                BOSS     heroes disabled 52ms after the summary
 *
 * Walking out of an exit is leaving, so the hero goes at once. A boss floor
 * ends with treasure on the ground and the player free to walk to it for the
 * five seconds before the report — which is the whole point of the delay.
 *
 * Sending it twice is the thing to avoid, and what says whether it has already
 * gone is the object table rather than a flag of its own. A flag lived past the
 * end of a run once — it is not in the set leaveDungeon clears — and the next
 * run's report then skipped the hero entirely. That is not a missing packet: it
 * is the client keeping a live HUD over a floor about to be destroyed, and it
 * segfaulted. `session.objects` is rebuilt per dungeon and cannot carry that
 * mistake forward.
 */
export const removeHeroFromFloor = (session) => {
  const world = worldOf(session);
  if (world) {
    const members = [...membersOf(world)];
    const heroes = members.filter((member) => world.objects.has(member.heroDoid));
    if (!heroes.length) return false;
    for (const recipient of members) {
      for (const owner of heroes) {
        recipient.send(objectDisable(owner.heroDoid, recipient === owner));
      }
    }
    for (const owner of heroes) {
      world.objects.delete(owner.heroDoid);
      world.actors.delete(owner.heroDoid);
      owner.objects?.delete(owner.heroDoid);
      stopHeroUpkeep(owner);
    }
    return true;
  }
  const doid = session.heroDoid;
  if (!doid || !session.objects?.has(doid)) return false;
  session.objects.delete(doid);
  session.send(objectDisable(doid, true));
  stopHeroUpkeep(session);
  return true;
};

/**
 * Ends what only exists to keep a standing hero topped up.
 *
 * The floor runs on for five seconds after a party walks out, and Mana kept
 * arriving on its clock for a hero that was no longer there. The official sends
 * a removed hero nothing at all; the other things that used to reach one — a
 * burn's floater, Buster and Mana for what a bomb left behind kills — ask
 * `heroOnFloor` where they are sent.
 */
const stopHeroUpkeep = (member) => {
  member.stopManaRegen?.();
  member.stopManaRegen = null;
};


const equippedWeaponFields = (weapons = []) => {
  const fields = {};
  for (let index = 0; index < 3; index++) {
    const weapon = weapons[index] ?? {};
    const slot = index + 1;
    fields[`weaponLevel${slot}`] = weapon.requiredlevel ?? 0;
    fields[`weaponType${slot}`] = weapon.type ?? 0;
    fields[`modifierType${slot}a`] = weapon.modifier1 ?? 0;
    fields[`modifierType${slot}b`] = weapon.modifier2 ?? 0;
    fields[`legendaryModifierType${slot}`] = weapon.legendarymodifier ?? 0;
    fields[`weaponPower${slot}`] = weapon.power ?? 0;
    fields[`weaponRarity${slot}`] = weapon.rarity ?? 0;
  }
  return fields;
};

/**
 * What a finished run leaves for the boards.
 *
 * Everything but the clock was already being counted for the report screen —
 * `dungeonContribution` accumulates kills and damage on every hit,
 * `dungeonRewards` the gold and experience — so the cost of a run record is one
 * timestamp taken at entry and one row written here.
 *
 * The party size is part of it because a four-player clear is not the same race
 * as a solo one, and the hero because the spread between heroes is wider than
 * the spread between players.
 */
export const runRecordFor = (session, success) => {
  const account = session.dungeonAccount;
  const avatar = session.dungeonAvatar;
  if (!account || !avatar) return null;

  const startedAt = session.dungeonStart?.at ?? null;
  const finishedAt = Date.now();

  return {
    account_id: account.id,
    name: account.name ?? null,
    trophies: account.trophies ?? 0,
    avatar_id: avatar.id,
    hero_id: avatar.avatar_id ?? 0,
    map_node_id: session.mapNodeId ?? 0,
    party_size: [...membersOf(session)].length,
    started_at: startedAt ? new Date(startedAt).toISOString() : null,
    finished_at: new Date(finishedAt).toISOString(),
    duration_ms: startedAt ? finishedAt - startedAt : null,
    success: Boolean(success),
    floors: session.floorCount ?? 1,
    kills: session.dungeonContribution?.kills ?? 0,
    damage: session.dungeonContribution?.damage ?? 0,
    gold: session.dungeonRewards?.gold ?? 0,
    xp: session.dungeonRewards?.xp ?? 0,
    /**
     * What the hero holds after the run — the same figure the report shows and
     * the levels come from. `experience` was paid out across the run by the
     * time the summary is drawn (rewards.js banks it as it lands), so this is
     * the number the hero experience board ranks.
     */
    hero_xp: avatar.experience ?? 0,
    // Written to the history either way; only kept off the boards. A run that
    // had a floor ended by `/complete` was not cleared, however fast it went.
    // Nor is a run whose rules keep it off the boards (run-rules.js) — a ranked
    // race: its dungeon was drawn, not chosen, a win can be the rival leaving,
    // and its clock started in the lobby (docs/ranked.md).
    rankable:
      rankable(session.mapPage?.NodeType) &&
      startedAt !== null &&
      !session.runAssisted &&
      runRulesOf(session).rankable,
  };
};

/** Up to four treasures fit on the report; anything past that is not shown. */
const treasureFields = (treasures = []) => {
  const fields = {};
  for (const [index, treasure] of treasures.slice(0, 4).entries()) {
    fields[`chestType${index + 1}`] = treasure.dooberType;
    fields[`lootType${index + 1}`] = treasure.chestId;
  }
  return fields;
};

/** Builds the local player's first DungeonReport slot from authoritative session state. */
export const buildDungeonReport = (session, success = false) => {
  const account = session.dungeonAccount ?? {};
  const avatar = session.dungeonAvatar ?? {};
  const receivedTrophy = Number(session.receivedTrophy ?? 0);
  const completionXp = success
    ? Number(session.completionXpBonus ?? session.mapPage?.CompletionXPBonus ?? 0)
    : 0;
  const crewXp = success
    ? Number(session.completionTeamXpBonus ?? completionTeamXpBonus(session.mapPage, account))
    : 0;
  const kills = session.dungeonContribution?.kills ??
    [...(session.actors?.values() ?? [])].filter((actor) => countsAsKill(actor) && actor.dead).length;

  return {
    name: account.name ?? "Player",
    // The client animates receivedTrophy by incrementing this baseline.
    trophyCount: Math.max(0, Number(account.trophies ?? 0) - receivedTrophy),
    id: session.playerDoid ?? account.id ?? session.accountId ?? 0,
    type: avatar.avatar_id ?? 101,
    skinType: avatar.skin_type ?? 151,
    kills,
    /**
     * Experience already banked before the completion and crew lines, which is
     * where the bar starts and what those bonuses then tick up from —
     * DistributedDungeonSummary computes its running total as
     * `report.xp + bonusTick`.
     *
     * It is not the baseline the run entered with: a captured defeat reported
     * 366773 while the account went 366408 → 366773 across the same run, so the
     * floor's own experience is inside this figure. A successful report starts
     * immediately before the separately animated completion rewards.
     */
    xp: success && session.completionXpBase !== undefined
      ? session.completionXpBase
      : avatar.experience ?? session.dungeonStart?.experience ?? 0,
    // What the run picked up off the floor.
    xpEarned: session.dungeonRewards?.xp ?? 0,
    /**
     * The node's completion bonus, shown on its own line. The client already
     * prints this column on the world map before you enter — UIMapBattlePopup
     * draws CompletionXPBonus beside "bonus XP" — so the figure a player was
     * promised going in is the one they have to be shown coming out.
     *
     * Only for finishing it. A captured defeat reported both bonuses as zero on
     * a node whose CompletionXPBonus is not, which is the difference between
     * what a run collected — kept either way — and what completing it pays.
     */
    xpBonus: completionXp,
    teamXpBonus: crewXp,
    goldEarned: session.dungeonRewards?.gold ?? 0,
    gemsEarned: session.dungeonRewards?.gems ?? 0,
    boostXp: 1,
    boostGold: 1,
    // Set when the run was this node's first clear; the screen shows a trophy.
    receivedTrophy,
    /**
     * The screen shows both sides of a treasure: what was picked up off the
     * floor (chest_type) and what it turned into (loot_type). A captured run
     * reported a GOLD_CHEST collected as 30102 and its RARE CHEST reward as
     * 60003 — the doober id and the chest id for the same thing.
     */
    ...treasureFields(session.dungeonTreasures),
    valid: 1,
    accountFlags: account.account_flags ?? 0,
    totalAvatarsOwned: account.account_avatars?.length ?? 0,
    consumable1Id: avatar.consumable1_id ?? 0,
    consumable1Count: avatar.consumable1_count ?? 0,
    consumable2Id: avatar.consumable2_id ?? 0,
    consumable2Count: avatar.consumable2_count ?? 0,
    ...equippedWeaponFields(session.heroWeapons),
  };
};

export const projectDungeonReports = (session, recipient, success) => {
  const members = [...membersOf(session)];
  const privileged = worldOf(session)?.match?.privilegedMembers;
  /**
   * The wire vector is length-prefixed, but the native score screen is not:
   * every visible array and animation is backed by stats_a..stats_d. Keep the
   * local member first because slot zero owns its XP, trophy and chest flow,
   * then expose at most three ordinary peers. Privileged members are marked by
   * admission rather than inferred from join order, so ordinary players never
   * see an admin report even when that admin joined before the fifth slot. An
   * admin still receives its own local report first, followed by ordinary
   * peers. Sending the same first four to everybody would make the
   * fifth member operate another player's slot-zero rewards.
   */
  const ordered = [
    recipient,
    ...members.filter(
      (member) => member !== recipient && !privileged?.has(member)
    ),
  ];
  const rows = ordered.slice(0, 4).map((member) =>
    buildDungeonReport(member.world?.contextFor(member) ?? member, success)
  );

  /**
   * A mode may reshape the rows (modes/hooks.js, reportRows): a ranked race
   * puts what it did to the racer's rating after their name, and the rival's
   * row beside theirs. A row for somebody not in this run is `transient`: it
   * is given a player object of its own (transientRowLeaves), since the client
   * reads a row by its player and greys one whose player goes.
   */
  const shaped = modeHooks.reportRows(recipient, rows, { success, reportOf: buildDungeonReport });
  return (Array.isArray(shaped) ? shaped : rows)
    .slice(0, 4)
    .map((row) => ({
      ...row,
      id: row.transient ? session.allocateDoid?.(CLID.PlayerGameObject) : row.id,
      // Each row's skin as this recipient can draw it (content-packs.js).
      skinType: presentSkin(recipient?.contentView, row.skinType),
    }))
    .filter((row) => !(row.transient && !row.id));
};

/** How long a transient row shows before it greys, the report having drawn by then. */
const TRANSIENT_ROW_LEAVES_AFTER_MS = 4000;

/**
 * The client greys a report row whose player object goes away while the report
 * is up (DistributedDungeonSummary.onPlayerExit, listening once its screen is
 * drawn). So a transient row — somebody who was never in this run — is given
 * one: a name and nothing else, as a chat voice is, after the floor's objects
 * are cleared, since that clearing takes player objects with it; and it goes
 * once the report has had time to draw.
 *
 * On a plain timer, not the run's scope: the report quiesces the world, which
 * disposes that scope and every timer in it. A player who leaves first has the
 * object taken by the run's own teardown, and the timer then finds it gone.
 */
const transientRowLeaves = (session, { member, doid, name }) => {
  const send = (frame) => (typeof member.sendDirect === "function" ? member.sendDirect(frame) : member.send(frame));
  session.objects?.set(doid, CLID.PlayerGameObject);
  send(playerGenerate({ doid, parent: session.areaDoid ?? 0, zone: session.dungeonZone ?? 10, screenName: name }));
  const leave = () => {
    if (session.objects?.delete(doid)) send(objectDisable(doid));
  };
  setTimeout(leave, session.transientRowLeavesAfterMs ?? TRANSIENT_ROW_LEAVES_AFTER_MS).unref?.();
};

/**
 * What the area keeps when the report goes up.
 *
 * The area itself has to survive — the summary is generated as its child — and
 * the player object outlives the dungeon entirely, since it carries the
 * currency the town screen reads back. The hero is not here either: it leaves
 * as an *owner* disable, which removeHeroFromFloor already sends.
 */
const KEPT_AT_SUMMARY = new Set([
  CLID.DistributedDungionArea,
  CLID.PlayerGameObject,
  CLID.HeroGameObject,
  CLID.MatchMaker,
  CLID.DistributedDungeonSummary,
]);

/**
 * Takes the floor off the client.
 *
 * The run ending is not the same as leaving, and this is the half that was
 * missing: a captured defeat disables 341 objects — 203 NPCs, 137 doobers and
 * the floor — in the same millisecond as the report, and nothing here did any
 * of it. Only walking out did. So the report went up over a floor that was
 * still alive underneath it, still fighting and still making noise.
 *
 * Children before the floor, because the floor is their parent and the client
 * destroys a parent's view with it.
 *
 * **The hero goes before the floor, and that is not a preference.** Destroying
 * the floor nulls its `mRemoteHeroes`, and the off-screen player HUD reads that
 * map every frame behind a guard that only checks the floor is not null — an
 * emptied floor passes it. The one thing that stops that loop is the hero
 * owner's own destroy, which calls UIHud.detachHero. So a floor disabled while
 * the hero is still up segfaults the client on the next frame, which is exactly
 * what a stale `heroRemoved` produced on the second run of a session. Asked for
 * here rather than left to the caller, because the caller getting it wrong is
 * not a visual glitch.
 *
 * The simulation stops with them. Everything left to move has just been
 * destroyed on the client, so a position update for one is at best ignored.
 */
const clearFloorObjects = (session) => {
  removeHeroFromFloor(session);
  /**
   * A hero is kept only if it is a member's — those have just left as owner
   * disables. Any other hero on the floor is somebody's copy: a ranked rival's
   * ghost, a lobby copy, a speaker's body. Left to the floor, the client
   * destroyed it with the floor's own teardown rather than by its disable,
   * and a copy generated in the run's last instant (a rival's ghost appearing
   * as the winner crossed the line, twice in four races on 2026-10-05) kept
   * drawing after that: its sheet gone with the run, every frame threw, and
   * the thrown frames ran the next run fast. So it goes before the floor, as
   * the heroes do.
   */
  const memberHeroes = new Set([session.heroDoid, ...[...membersOf(session)].map((member) => member.heroDoid)]);
  const doomed = [...(session.objects?.entries() ?? [])]
    .filter(([doid, clid]) => !KEPT_AT_SUMMARY.has(clid) || (clid === CLID.HeroGameObject && !memberHeroes.has(doid)))
    .sort(([doidA, clidA], [doidB, clidB]) => {
      const floorLast = (clid) => (clid === CLID.DistributedDungeonFloor ? 1 : 0);
      return floorLast(clidA) - floorLast(clidB) || doidA - doidB;
    });

  session.stopAi?.();
  session.stopAi = null;
  session.stopTriggers?.();
  session.stopTriggers = null;
  session.stopTrapProjectiles?.();
  session.stopTrapProjectiles = null;

  for (const [doid] of doomed) {
    session.send(objectDisable(doid));
    session.objects.delete(doid);
    session.actors?.delete(doid);
    session.doobers?.delete(doid);
  }
  return doomed.length;
};

/** Emits the summary immediately; exported for deterministic contract tests. */
export const sendDungeonSummary = (session, success) => {
  if (!session.dungeonActive || session.summaryDoid || !session.areaDoid) return false;

  const doid = session.allocateDoid(CLID.DistributedDungeonSummary);
  session.summaryDoid = doid;
  const members = [...membersOf(session)];
  /**
   * Finishing the node is paid here, with the report, and only to whoever is
   * still in the run to receive it — as the original did. Paid at the win
   * banner instead, walking out in the seconds before the report kept the
   * completion and left the party no row to report the leaver from.
   *
   * Before the report is drawn, so it shows what was banked: the award's
   * changes to the account are made before its first wait, and its save is
   * queued ahead of the settlement below.
   */
  if (success) {
    for (const member of members) {
      const target = member.world?.contextFor(member) ?? member;
      const failed = (problem) => warn(`[${target.id}] could not award completion: ${problem.message}`);
      try {
        (target.awardDungeonCompletion ?? awardDungeonCompletion)(target)?.catch?.(failed);
      } catch (problem) {
        failed(problem);
      }
    }
  }
  const transients = [];
  for (const member of members) {
    const reports = projectDungeonReports(session, member, success);
    for (const row of reports) if (row.transient) transients.push({ member, doid: row.id, name: row.name });
    member.send(dungeonSummaryGenerate({
      doid,
      parent: session.areaDoid,
      zone: session.dungeonZone ?? 0,
      mapNodeId: session.mapNodeId ?? 0,
      success,
      reports,
    }));
  }
  /**
   * And the run itself goes to the boards, which is a different store and a
   * different failure.
   *
   * Deliberately not awaited and deliberately not on the account's write path:
   * a leaderboard is not worth failing a run over, and the account save below
   * is already ordered against every other writer. If this throws, the line in
   * the log is the whole consequence.
   */
  matchHost().recordRuns(members.map((member) =>
    runRecordFor(member.world?.contextFor(member) ?? member, success)
  )).catch((problem) => warn(`[${session.id}] run not recorded: ${problem.message}`));

  /**
   * The run is written down here, and this is the last time the server writes
   * a whole account from the session's own copy.
   *
   * The report is where the run's numbers stop moving, and it is also where the
   * client starts handing the player an inventory — opening a chest sends them
   * straight into it, still inside the dungeon, where equipping and dropping go
   * out as JSON-RPC against a freshly read account. A second write on the way
   * out would be a snapshot from before all of that, and would undo it.
   */
  for (const member of members) {
    settleDungeonAccount(member.world?.contextFor(member) ?? member);
  }

  /**
   * And now the hero comes off the floor, if walking out has not already taken
   * it. The captured boss run removes all four heroes 52ms after the summary —
   * they spend the five seconds before it collecting the chest.
   */
  removeHeroFromFloor(session);
  const cleared = clearFloorObjects(session);
  worldOf(session)?.quiesce?.();
  for (const row of transients) transientRowLeaves(session, row);
  info(
    `[${session.id}] generated DungeonSummary doid=${doid} success=${success ? 1 : 0} ` +
      `(${cleared} dungeon object(s) disabled)`
  );
  return true;
};

export const cancelDungeonSummary = (session) => {
  if (!session.summaryTimer) return false;
  cancelScopedTimer(session.runScope, session.summaryTimer, clearTimeout);
  session.summaryTimer = null;
  return true;
};

/** Production waits about five seconds between dungeonEnding and the summary. */
export const scheduleDungeonSummary = (session, success) => {
  cancelDungeonSummary(session);
  /**
   * The moment the run is over is the moment it stops being joinable.
   *
   * Done here rather than when the summary is actually sent, because the five
   * seconds in between are exactly when somebody watching a friend finish would
   * press Join — and the world is already gone by then.
   */
  matchHost().matchFinished(session.dungeonMatch);
  const scope = session.runScope;
  const finish = () => {
    session.summaryTimer = null;
    sendDungeonSummary(session, success);
  };
  const timer = scope
    ? scope.timeout(finish, config.dungeonSummaryDelayMs)
    : setTimeout(finish, config.dungeonSummaryDelayMs);
  if (!scope) timer.unref?.();
  session.summaryTimer = timer;
  return timer;
};
