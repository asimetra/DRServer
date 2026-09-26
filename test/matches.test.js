import test from "node:test";
import assert from "node:assert/strict";

import { loadGameMaster } from "../src/gamemaster.js";
import { setMapNodeBit } from "../src/map-progress.js";
import { heroLevel } from "../src/progression.js";
import {
  activeAvatarMayEnter,
  avatarCompletedAllNormalNodes,
  avatarCompletedNode,
  DungeonMatchRegistry,
  hasDungeonAdminOverride,
  MAX_DUNGEON_PLAYERS,
} from "../src/socket/matches.js";
import { nearestPartyHeroPosition } from "../src/socket/dungeon.js";

const player = (accountId) => ({ accountId });

test("shared floor planning chooses the nearest live party hero, not the context owner", () => {
  const session = {
    heroDoid: 1,
    heroPosition: { x: 5000, y: 5000 },
    playerActors: new Set([1, 2, 3]),
    actors: new Map([
      [1, { position: { x: 5000, y: 5000 }, dead: false }],
      [2, { position: { x: 120, y: 100 }, dead: false }],
      [3, { position: { x: 105, y: 100 }, dead: true }],
      // Prepared for late-join replay, but absent from active playerActors.
      [4, { position: { x: 101, y: 100 }, dead: false }],
    ]),
  };

  assert.deepEqual(nearestPartyHeroPosition(session, { x: 100, y: 100 }), {
    x: 120,
    y: 100,
  });
});

test("only server-stored admin flag bit zero enables the dungeon override", () => {
  assert.equal(hasDungeonAdminOverride({ admin_flags: 0 }), false);
  assert.equal(hasDungeonAdminOverride({ admin_flags: 1 }), true);
  assert.equal(hasDungeonAdminOverride({ admin_flags: 2 }), false);
  assert.equal(hasDungeonAdminOverride({ admin_flags: 3 }), true);
  assert.equal(hasDungeonAdminOverride({ admin_flags: "1" }), true);
  assert.equal(hasDungeonAdminOverride({ admin_flags: -1 }), false);
  assert.equal(hasDungeonAdminOverride({ admin_flags: "not-a-number" }), false);
});

test("public matchmaking fills one dungeon to four, then creates another", () => {
  const registry = new DungeonMatchRegistry();
  const firstFour = Array.from({ length: MAX_DUNGEON_PLAYERS }, (_, index) =>
    registry.resolve({ session: player(100 + index), mapNodeId: 50082 })
  );
  assert.equal(new Set(firstFour.map((result) => result.match.id)).size, 1);
  assert.equal(firstFour[0].match.members.size, 4);
  assert.equal(firstFour[0].created, true);
  assert.equal(firstFour[1].created, false);

  const fifth = registry.resolve({ session: player(200), mapNodeId: 50082 });
  assert.notEqual(fifth.match.id, firstFour[0].match.id);
  assert.equal(fifth.created, true);
  assert.equal(fifth.match.members.size, 1);
});

test("public matchmaking does not fill an instance after floor zero", () => {
  const registry = new DungeonMatchRegistry();
  const first = registry.resolve({ session: player(1), mapNodeId: 50082 });
  first.match.floorIndex = 1;

  const next = registry.resolve({ session: player(2), mapNodeId: 50082 });
  assert.notEqual(next.match.id, first.match.id);
  assert.equal(next.match.mapNodeId, first.match.mapNodeId);
});

test("friend id resolves the friend's match, not a dungeon id", () => {
  const registry = new DungeonMatchRegistry();
  const host = player(20);
  const hostResult = registry.resolve({ session: host, mapNodeId: 50082 });

  const joiner = player(21);
  const joined = registry.resolve({
    session: joiner,
    friendId: host.accountId,
    eligibleForExplicitJoin: true,
  });
  assert.equal(joined.match, hostResult.match);
  assert.equal(joined.source, "friend");
  assert.equal(joined.created, false);
});

test("an eligible friend may join a normal dungeon after floor zero", () => {
  const registry = new DungeonMatchRegistry();
  const host = player(10);
  const original = registry.resolve({ session: host, mapNodeId: 50047 }).match;
  original.floorIndex = 2;

  const joined = registry.resolve({
    session: player(11),
    friendId: host.accountId,
    eligibleForExplicitJoin: true,
  });
  assert.equal(joined.match, original);
  assert.equal(joined.match.mapNodeId, original.mapNodeId);
  assert.equal(joined.created, false);
});

test("a full friend dungeon reports that the friend cannot be joined", () => {
  const registry = new DungeonMatchRegistry();
  const host = player(10);
  const original = registry.resolve({ session: host, mapNodeId: 50047 }).match;
  for (let accountId = 11; accountId < 10 + MAX_DUNGEON_PLAYERS; accountId++) {
    registry.resolve({
      session: player(accountId),
      friendId: host.accountId,
      eligibleForExplicitJoin: true,
    });
  }

  const joined = registry.resolve({
    session: player(99),
    friendId: host.accountId,
    eligibleForExplicitJoin: true,
  });
  assert.equal(joined.match, null);
  assert.equal(joined.error, "friend_full");
  assert.equal(original.members.size, MAX_DUNGEON_PLAYERS);
});

test("one server-authorized admin may occupy the fifth slot", () => {
  const registry = new DungeonMatchRegistry();
  const host = player(10);
  const original = registry.resolve({ session: host, mapNodeId: 50047 }).match;
  original.floorIndex = 3;
  for (let accountId = 11; accountId < 10 + MAX_DUNGEON_PLAYERS; accountId++) {
    registry.resolve({
      session: player(accountId),
      friendId: host.accountId,
      eligibleForExplicitJoin: true,
    });
  }
  assert.equal(original.members.size, 4);

  const adminMember = player(99);
  const admin = registry.resolve({
    session: adminMember,
    friendId: host.accountId,
    adminOverride: true,
  });
  assert.equal(admin.match, original);
  assert.equal(admin.created, false);
  assert.equal(original.members.size, 5);
  assert.equal(original.privilegedMembers.has(adminMember), true);

  const sixth = registry.resolve({
    session: player(100),
    friendId: host.accountId,
    adminOverride: true,
  });
  assert.equal(sixth.match, null);
  assert.equal(sixth.error, "friend_full");
  assert.equal(original.members.size, 5);
});

test("a privileged member never consumes one of the four ordinary player slots", () => {
  const registry = new DungeonMatchRegistry();
  const admin = player(150);
  const original = registry.resolve({
    session: admin,
    mapNodeId: 50047,
    adminOverride: true,
  }).match;

  const ordinary = Array.from({ length: MAX_DUNGEON_PLAYERS }, (_, index) =>
    registry.resolve({ session: player(151 + index), mapNodeId: 50047 })
  );

  assert.ok(ordinary.every(({ match }) => match === original));
  assert.equal(original.members.size, MAX_DUNGEON_PLAYERS + 1);
  assert.equal(original.privilegedMembers.size, 1);

  const overflow = registry.resolve({ session: player(199), mapNodeId: 50047 });
  assert.notEqual(overflow.match, original, "a fifth ordinary player starts another room");
});

test("an admin public search may fill an advanced floor as the fifth member", () => {
  const registry = new DungeonMatchRegistry();
  const original = registry.resolve({ session: player(10), mapNodeId: 50047 }).match;
  original.floorIndex = 4;
  for (let accountId = 11; accountId < 10 + MAX_DUNGEON_PLAYERS; accountId++) {
    registry.resolve({
      session: player(accountId),
      mapId: original.id,
      eligibleForExplicitJoin: true,
    });
  }

  const joined = registry.resolve({
    session: player(99),
    mapNodeId: 50047,
    adminOverride: true,
  });
  assert.equal(joined.match, original);
  assert.equal(joined.created, false);
  assert.equal(original.members.size, 5);
});

test("private requests never enter the public pool", () => {
  const registry = new DungeonMatchRegistry();
  const privateMatch = registry.resolve({
    session: player(1),
    mapNodeId: 50002,
    friendOnly: true,
  }).match;
  const publicMatch = registry.resolve({ session: player(2), mapNodeId: 50002 }).match;
  assert.notEqual(publicMatch, privateMatch);

  const invited = registry.resolve({
    session: player(3),
    friendId: 1,
    friendOnly: true,
    eligibleForExplicitJoin: true,
  });
  assert.equal(invited.match, privateMatch, "an explicit friend may still join it");
});

test("a full private friend target remains full rather than creating a copy", () => {
  const registry = new DungeonMatchRegistry();
  const host = player(1);
  const target = registry.resolve({
    session: host,
    mapNodeId: 50002,
    friendOnly: true,
  }).match;
  for (let accountId = 2; accountId <= MAX_DUNGEON_PLAYERS; accountId++) {
    registry.resolve({
      session: player(accountId),
      friendId: host.accountId,
      eligibleForExplicitJoin: true,
    });
  }

  const overflow = registry.resolve({
    session: player(99),
    friendId: host.accountId,
    eligibleForExplicitJoin: true,
  });
  assert.equal(overflow.match, null);
  assert.equal(overflow.error, "friend_full");
  assert.equal(registry.publicMatch({ mapNodeId: 50002 }), undefined);
});

test("an eligible explicit instance id may join after floor zero", () => {
  const registry = new DungeonMatchRegistry();
  const match = registry.resolve({ session: player(1), mapNodeId: 50055 }).match;
  assert.equal(
    registry.resolve({
      session: player(2),
      mapId: match.id,
      eligibleForExplicitJoin: true,
    }).match,
    match
  );
  match.floorIndex = 1;
  const joined = registry.resolve({
    session: player(3),
    mapId: match.id,
    eligibleForExplicitJoin: true,
  });
  assert.equal(joined.match, match);
  assert.equal(joined.created, false);
});

test("explicit joins fail closed when the active avatar has not completed the node", () => {
  const registry = new DungeonMatchRegistry();
  const host = player(1);
  const match = registry.resolve({ session: host, mapNodeId: 50055 }).match;

  const denied = registry.resolve({ session: player(2), friendId: 1 });
  assert.equal(denied.match, null);
  assert.equal(denied.error, "content_not_completed");
  assert.equal(match.members.size, 1);
});

test("explicit target identity cannot fall back to a forged map node", () => {
  const registry = new DungeonMatchRegistry();
  const result = registry.resolve({
    session: player(2),
    friendId: 999,
    mapNodeId: 50055,
    eligibleForExplicitJoin: true,
  });
  assert.equal(result.match, null);
  assert.equal(result.error, "target_not_found");
  assert.equal(registry.matches.size, 0);
});

test("completion is read from the active avatar only", () => {
  const completedMask = String.fromCharCode(0x20);
  const gate = { Id: 1, Constant: "GATE", NodeType: "DUNGEON", BitIndex: 7, ChildNode1: "NODE" };
  const normalNode = { Id: 2, Constant: "NODE", NodeType: "DUNGEON", BitIndex: 2 };
  const gameMaster = { raw: { MapPage: [gate, normalNode] } };
  const account = {
    active_avatar: 20,
    completed_mapnode_mask: completedMask,
    account_avatars: [
      { id: 10, completed_mapnode_mask: completedMask },
      { id: 20, completed_mapnode_mask: "" },
    ],
  };

  assert.equal(avatarCompletedNode(account.account_avatars[0], normalNode), true);
  assert.equal(activeAvatarMayEnter(account, normalNode, gameMaster), false);
  account.account_avatars[1].completed_mapnode_mask = completedMask;
  assert.equal(activeAvatarMayEnter(account, normalNode, gameMaster), true);
});

/**
 * The client's own answer to "can this hero go there", ported line for line
 * from DBInventoryInfo.get_mapnodes1 (NODE_RULES 0) and
 * GameMaster.fixupMapNodeParents, so the server's rule is checked against the
 * screen the player is looking at rather than against itself.
 */
const clientAccessibleNodeIds = (gameMaster, account) => {
  const avatar = account.account_avatars.find((row) => row.id === account.active_avatar);
  if (!avatar) return new Set();
  const nodes = gameMaster.raw.MapPage.map((row) => ({
    row,
    Id: row.Id,
    Constant: row.Constant,
    LevelRequirement: Number(row.LevelReq ?? 0),
    TrophyRequirement: Number(row.TrophyReq ?? 0),
    ChildNodes: [row.ChildNode1, row.ChildNode2, row.ChildNode3],
    PrefixupParentNode: row.ParentNode,
    ParentNodes: [],
  }));
  const byConstant = new Map(nodes.map((node) => [node.Constant, node]));
  for (const node of nodes) {
    if (node.PrefixupParentNode) byConstant.get(node.PrefixupParentNode).ChildNodes.push(node.Constant);
  }
  for (const node of nodes) {
    for (const child of node.ChildNodes) byConstant.get(child)?.ParentNodes.push(node);
  }
  const level = heroLevel(
    gameMaster,
    gameMaster.heroById.get(avatar.avatar_id),
    Number(avatar.experience ?? 0)
  );
  const trophies = Number(account.trophies ?? 0);
  const avatarNodeIds = new Set(
    nodes.filter((node) => avatarCompletedNode(avatar, node.row)).map((node) => node.Id)
  );
  const accessible = new Set(avatarNodeIds);
  for (const node of nodes) {
    if (avatarNodeIds.has(node.Id)) continue;
    if (node.LevelRequirement > level || node.TrophyRequirement > trophies) continue;
    if (
      node.ParentNodes.length === 0 ||
      node.ParentNodes.some((parent) => avatarNodeIds.has(parent.Id))
    ) {
      accessible.add(node.Id);
    }
  }
  return accessible;
};

test("a hero may enter exactly the nodes its own map shows as completed or open", async () => {
  const gameMaster = await loadGameMaster();
  const nodes = gameMaster.raw.MapPage.filter((node) => node.NodeType !== "INFINITE");
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const masks = [
    "",
    setMapNodeBit("", 0),
    nodes.reduce((mask, node) => setMapNodeBit(mask, node.BitIndex), ""),
  ];
  for (let sample = 0; sample < 24; sample++) {
    masks.push(
      nodes.filter(() => random() < 0.3).reduce((mask, node) => setMapNodeBit(mask, node.BitIndex), "")
    );
  }
  let open = 0;
  let locked = 0;
  for (const avatarId of [101, 104]) {
    for (const experience of [0, 3_000, 60_000, 400_000, 10_000_000]) {
      for (const mask of masks) {
        const account = {
          active_avatar: 7,
          trophies: 3,
          account_avatars: [{ id: 7, avatar_id: avatarId, experience, completed_mapnode_mask: mask }],
        };
        const client = clientAccessibleNodeIds(gameMaster, account);
        for (const node of nodes) {
          const allowed = activeAvatarMayEnter(account, node, gameMaster);
          assert.equal(
            allowed,
            client.has(node.Id),
            `${node.Constant} for hero ${avatarId} at ${experience} xp`
          );
          if (allowed && !avatarCompletedNode(account.account_avatars[0], node)) open++;
          if (!allowed) locked++;
        }
      }
    }
  }
  assert.ok(open > 0 && locked > 0, "both answers were exercised");
});

test("two friends who cleared a node may take the next one together", async () => {
  const gameMaster = await loadGameMaster();
  const node = (constant) => gameMaster.raw.MapPage.find((row) => row.Constant === constant);
  const tutorial = node("TUTORIAL");
  const firstArena = node("ARENA_1");
  const secondArena = node("ARENA_2");
  const clearedFirst = [tutorial, firstArena].reduce(
    (mask, row) => setMapNodeBit(mask, row.BitIndex),
    ""
  );
  const friend = {
    active_avatar: 7,
    account_avatars: [{ id: 7, avatar_id: 101, experience: 0, completed_mapnode_mask: clearedFirst }],
  };
  assert.equal(activeAvatarMayEnter(friend, secondArena, gameMaster), true, "open, not yet cleared");
  assert.equal(
    activeAvatarMayEnter(friend, node("ARENA_BOSS"), gameMaster),
    false,
    "two steps ahead is still locked"
  );
});

test("a node is open through the parent its own row names", () => {
  const root = { Id: 1, Constant: "ROOT", NodeType: "DUNGEON", BitIndex: 0 };
  const side = { Id: 2, Constant: "SIDE", NodeType: "DUNGEON", BitIndex: 1, ParentNode: "ROOT" };
  const gameMaster = { raw: { MapPage: [root, side] } };
  const account = (mask) => ({
    active_avatar: 7,
    account_avatars: [{ id: 7, completed_mapnode_mask: mask }],
  });
  assert.equal(activeAvatarMayEnter(account(""), side, gameMaster), false);
  assert.equal(activeAvatarMayEnter(account(setMapNodeBit("", 0)), side, gameMaster), true);
});

test("an open node still waits for the hero's level and the account's trophies", async () => {
  const gameMaster = await loadGameMaster();
  const root = { Id: 1, Constant: "ROOT", NodeType: "DUNGEON", BitIndex: 0, ChildNode1: "HIGH" };
  const high = { Id: 2, Constant: "HIGH", NodeType: "DUNGEON", BitIndex: 1, LevelReq: 5, TrophyReq: 2 };
  const catalogue = { ...gameMaster, raw: { ...gameMaster.raw, MapPage: [root, high] } };
  const account = (experience, trophies) => ({
    active_avatar: 7,
    trophies,
    account_avatars: [
      { id: 7, avatar_id: 101, experience, completed_mapnode_mask: setMapNodeBit("", 0) },
    ],
  });
  const levelFive = gameMaster.raw.Leveling.slice(0, 4).reduce((sum, row) => sum + row.BERSERKER, 0);
  assert.equal(heroLevel(gameMaster, gameMaster.heroById.get(101), levelFive), 5);
  assert.equal(activeAvatarMayEnter(account(levelFive - 1, 2), high, catalogue), false, "level four");
  assert.equal(activeAvatarMayEnter(account(levelFive, 1), high, catalogue), false, "one trophy short");
  assert.equal(activeAvatarMayEnter(account(levelFive, 2), high, catalogue), true);
  assert.equal(
    activeAvatarMayEnter({ ...account(levelFive, 2), account_avatars: [{ id: 7, avatar_id: 999 }] }, high, catalogue),
    false,
    "a hero the catalogue does not know has no level to meet a requirement with"
  );
});

test("Ultimate requires every normal dungeon and boss on the active avatar", () => {
  const normalNodes = [
    { NodeType: "BOSS", BitIndex: 0 },
    { NodeType: "DUNGEON", BitIndex: 1 },
    { NodeType: "DUNGEON", BitIndex: 96 },
  ];
  const ultimateNode = { NodeType: "INFINITE", BitIndex: 100 };
  const completeMask = normalNodes.reduce(
    (mask, node) => setMapNodeBit(mask, node.BitIndex),
    ""
  );
  const account = {
    active_avatar: 20,
    completed_mapnode_mask: completeMask,
    account_avatars: [
      { id: 10, completed_mapnode_mask: completeMask },
      { id: 20, completed_mapnode_mask: setMapNodeBit("", 96) },
    ],
  };
  const catalogue = [...normalNodes, ultimateNode];

  assert.equal(
    activeAvatarMayEnter(account, ultimateNode, { raw: { MapPage: catalogue } }),
    false,
    "account-wide and another avatar's clears do not qualify"
  );
  account.account_avatars[1].completed_mapnode_mask = completeMask;
  assert.equal(avatarCompletedAllNormalNodes(account.account_avatars[1], catalogue), true);
  assert.equal(activeAvatarMayEnter(account, ultimateNode, { raw: { MapPage: catalogue } }), true);
  assert.equal(
    avatarCompletedNode(account.account_avatars[1], ultimateNode),
    false,
    "the Ultimate itself need not have been completed before first entry"
  );
});

test("Ultimate eligibility fails closed without a normal-node catalogue", () => {
  const account = {
    active_avatar: 20,
    account_avatars: [{ id: 20, completed_mapnode_mask: String.fromCharCode(0xff) }],
  };
  assert.equal(
    activeAvatarMayEnter(account, { NodeType: "INFINITE", BitIndex: 100 }, { raw: { MapPage: [] } }),
    false
  );
});

test("the shipped Ultimate gate covers all 97 normal combat nodes", async () => {
  const gameMaster = await loadGameMaster();
  const mapNodes = gameMaster.raw.MapPage;
  const required = mapNodes.filter(
    (node) => node.NodeType === "DUNGEON" || node.NodeType === "BOSS"
  );
  const ultimate = mapNodes.find((node) => node.NodeType === "INFINITE");
  assert.equal(required.length, 97);

  const completeMask = required.reduce(
    (mask, node) => setMapNodeBit(mask, node.BitIndex),
    ""
  );
  const account = {
    active_avatar: 20,
    account_avatars: [{ id: 20, completed_mapnode_mask: completeMask }],
  };
  assert.equal(activeAvatarMayEnter(account, ultimate, gameMaster), true);

  // Removing any one ordinary bit is enough to close every Ultimate entry.
  const missing = required[42];
  const bytes = Array.from(completeMask, (character) => character.charCodeAt(0));
  bytes[missing.BitIndex >> 3] &= ~(1 << (7 - (missing.BitIndex % 8)));
  account.account_avatars[0].completed_mapnode_mask = bytes
    .map((byte) => String.fromCharCode(byte))
    .join("");
  assert.equal(activeAvatarMayEnter(account, ultimate, gameMaster), false);
});

test("leaving removes membership and an empty match is closed", () => {
  const registry = new DungeonMatchRegistry();
  const member = player(1);
  const match = registry.resolve({ session: member, mapNodeId: 50002 }).match;
  registry.remove(member);
  assert.equal(match.state, "closed");
  assert.equal(registry.matches.has(match.id), false);
  assert.equal(member.dungeonMatch, undefined);
});

test("privileged membership follows the admitted session and is cleared on leave", () => {
  const registry = new DungeonMatchRegistry();
  const admin = player(801);
  const match = registry.resolve({
    session: admin,
    mapNodeId: 50002,
    adminOverride: true,
  }).match;

  assert.equal(match.privilegedMembers.has(admin), true);
  registry.remove(admin);
  assert.equal(match.privilegedMembers.has(admin), false);
  assert.equal(match.state, "closed");
});

test("a second session for one account cannot orphan the first account's match", () => {
  const registry = new DungeonMatchRegistry();
  const first = player(700);
  const original = registry.resolve({ session: first, mapNodeId: 50002 }).match;
  const duplicate = player(700);

  const refused = registry.resolve({ session: duplicate, mapNodeId: 50055 });

  assert.equal(refused.match, null);
  assert.equal(refused.error, "game_not_enterable");
  assert.equal(registry.matches.size, 1, "the rejected empty candidate room was closed");
  assert.equal(original.members.size, 1);
  assert.equal(original.members.has(first), true);
  assert.equal(original.members.has(duplicate), false);
  assert.equal(registry.matchByAccount.get(first.accountId), original);
  assert.equal(first.dungeonMatch, original);
  assert.equal(duplicate.dungeonMatch, undefined);
});

/**
 * A run that has ended is not a game anyone can join.
 *
 * Its players stay in it while they read the report, so nothing closes the
 * match — and it went on advertising itself as joinable. A friend admitted to
 * it waited on a loading screen for a floor that was never going to arrive.
 */
test("a finished run refuses a join instead of hanging it", async () => {
  const { entryErrorCodeFor, ENTRY_ERROR } = await import("../src/socket/matchmaker.js");

  const registry = new DungeonMatchRegistry();
  const host = player(1);
  const joiner = player(2);
  const joinRequest = {
    session: joiner,
    mapNodeId: 50082,
    friendId: 1,
    eligibleForExplicitJoin: true,
  };

  const opened = registry.resolve({ session: host, mapNodeId: 50082 });
  assert.ok(opened.match, "the host is in a match");
  assert.ok(registry.resolve(joinRequest).match, "which a friend can join while it runs");
  registry.remove(joiner);

  assert.equal(registry.finish(opened.match), true);

  const refused = registry.resolve(joinRequest);
  assert.equal(refused.match, null, "the join is refused rather than admitted");
  assert.equal(refused.error, "run_finished", "and not called full, which it is not");
  assert.equal(
    entryErrorCodeFor(refused),
    ENTRY_ERROR.MAP_NOT_FOUND,
    "which the client's loading screen calls WARNING_FRIEND_GAME_NOT_FOUND"
  );

  // And whoever is reading the report is still in it.
  assert.equal(opened.match.members.size, 1);
});

test("a finished match is evicted after its bounded report-screen TTL", async () => {
  const registry = new DungeonMatchRegistry({ finishedMatchTtlMs: 5 });
  const host = player(901);
  host.dungeonActive = true;
  const opened = registry.resolve({ session: host, mapNodeId: 50082 });

  registry.finish(opened.match);
  assert.equal(opened.match.state, "finished");
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(opened.match.state, "closed");
  assert.equal(registry.matches.size, 0);
  assert.equal(registry.matchByAccount.size, 0);
  assert.equal(registry.publicByKey.size, 0);
  assert.equal(host.dungeonMatch, undefined);
  assert.equal(host.dungeonActive, false, "the session may enter another dungeon after TTL");
});
