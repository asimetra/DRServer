import { config } from "../config.js";
import { dungeonMatches } from "./matches.js";
import { info, warn } from "../log.js";
import { CLID } from "./opcodes.js";
import { dungeonSummaryGenerate, objectDisable } from "./objects.js";
import { membersOf, worldOf } from "./match-world.js";
import { settleDungeonAccount } from "./settle-account.js";
import { rankable, recordRuns } from "../leaderboard.js";

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
    }
    return true;
  }
  const doid = session.heroDoid;
  if (!doid || !session.objects?.has(doid)) return false;
  session.objects.delete(doid);
  session.send(objectDisable(doid, true));
  return true;
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
 * The crew bonus: the share the account's own roster adds to a node's
 * completion bonus.
 *
 * Not the party. The client names it in DBFacebookBragFeedPost, which draws the
 * figure beside a crew icon as `getTotalHeroesOwned() - 2` — so it counts heroes
 * owned, and the first two do not count.
 *
 * Against the captures, a sixteenth of the bonus per hero past the second
 * reproduces two runs to the coin: 4665 and 4975 both on six-hero accounts gave
 * 1166 and 1243, and both come out exactly. A third, on a three-hero account,
 * gave 15 where this says 8 — so something else happens at the bottom of the
 * range that one data point cannot settle. Floored, as those two runs show, and
 * never more than the bonus itself.
 */
const teamXpBonus = (node, account) => {
  const bonus = Number(node?.CompletionXPBonus ?? 0);
  const heroes = (account?.account_avatars ?? []).length;
  const crew = Math.max(0, heroes - 2);
  return Math.max(0, Math.min(bonus, Math.floor((bonus * crew) / 16)));
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
    // Written to the history either way; only kept off the boards.
    rankable: rankable(session.mapPage?.NodeType) && startedAt !== null,
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
  const kills = session.dungeonContribution?.kills ??
    [...(session.actors?.values() ?? [])].filter((actor) => actor.isEnemy && actor.dead).length;

  return {
    name: account.name ?? "Player",
    trophyCount: account.trophies ?? 0,
    id: session.playerDoid ?? account.id ?? session.accountId ?? 0,
    type: avatar.avatar_id ?? 101,
    skinType: avatar.skin_type ?? 151,
    kills,
    /**
     * Experience already banked, which is where the bar starts and what the
     * bonus then ticks up from — DistributedDungeonSummary computes its running
     * total as `report.xp + bonusTick`.
     *
     * It is the amount held *after* the run, not the baseline it entered with.
     * A captured defeat reported 366773 while the account went 366408 → 366773
     * across the same run, so the floor's own gold and experience are inside
     * this figure by the time the report is drawn.
     */
    xp: avatar.experience ?? session.dungeonStart?.experience ?? 0,
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
    xpBonus: success ? Number(session.mapPage?.CompletionXPBonus ?? 0) : 0,
    teamXpBonus: success ? teamXpBonus(session.mapPage, account) : 0,
    goldEarned: session.dungeonRewards?.gold ?? 0,
    gemsEarned: session.dungeonRewards?.gems ?? 0,
    boostXp: 1,
    boostGold: 1,
    // Set when the run was this node's first clear; the screen shows a trophy.
    receivedTrophy: session.receivedTrophy ?? 0,
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
  return ordered.slice(0, 4).map((member) =>
    buildDungeonReport(member.world?.contextFor(member) ?? member, success)
  );
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
  const doomed = [...(session.objects?.entries() ?? [])]
    .filter(([, clid]) => !KEPT_AT_SUMMARY.has(clid))
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
  for (const member of members) {
    member.send(dungeonSummaryGenerate({
      doid,
      parent: session.areaDoid,
      zone: session.dungeonZone ?? 0,
      mapNodeId: session.mapNodeId ?? 0,
      success,
      reports: projectDungeonReports(session, member, success),
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
  recordRuns(members.map((member) =>
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
  info(
    `[${session.id}] generated DungeonSummary doid=${doid} success=${success ? 1 : 0} ` +
      `(${cleared} dungeon object(s) disabled)`
  );
  return true;
};

export const cancelDungeonSummary = (session) => {
  if (!session.summaryTimer) return false;
  clearTimeout(session.summaryTimer);
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
  dungeonMatches.finish(session.dungeonMatch);
  const timer = setTimeout(() => {
    session.summaryTimer = null;
    sendDungeonSummary(session, success);
  }, config.dungeonSummaryDelayMs);
  timer.unref?.();
  session.summaryTimer = timer;
  return timer;
};
