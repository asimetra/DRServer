import test from "node:test";
import assert from "node:assert/strict";

import { resolveMatchEntry } from "../src/socket/match-entry.js";
import { DungeonMatchRegistry } from "../src/socket/matches.js";
import { loadGameMaster } from "../src/gamemaster.js";
import { setMapNodeBit } from "../src/map-progress.js";

const player = (accountId) => ({ accountId });
const request = (overrides = {}) => ({
  mapNodeId: 0,
  friendId: 0,
  mapId: 0,
  friendOnly: false,
  matchMakerGroup: "",
  ...overrides,
});

/** 50055 behind 50054: open only to a hero who has cleared the gate. */
const gatedCatalogue = () => {
  const gate = { Id: 50054, Constant: "GATE", NodeType: "DUNGEON", BitIndex: 1, ChildNode1: "GATED" };
  const node = { Id: 50055, Constant: "GATED", NodeType: "DUNGEON", BitIndex: 2 };
  return {
    node,
    gameMaster: {
      raw: { MapPage: [gate, node] },
      mapNodeById: new Map([gate, node].map((row) => [row.Id, row])),
    },
  };
};

test("direct entry reads the active hero's progression on every request", async () => {
  const registry = new DungeonMatchRegistry();
  const session = player(1);
  const node = { Id: 50002, Constant: "TUTORIAL", NodeType: "BOSS", BitIndex: 0 };
  const account = { admin_flags: 0, active_avatar: 7, account_avatars: [{ id: 7 }] };
  const gameMaster = {
    raw: { MapPage: [node] },
    mapNodeById: new Map([[node.Id, node]]),
  };
  let accountLoads = 0;
  const dependencies = {
    registry,
    loadAccountById: async () => {
      accountLoads++;
      return account;
    },
    loadGameMasterData: async () => gameMaster,
  };
  const result = await resolveMatchEntry(session, request({ mapNodeId: 50002 }), dependencies);

  assert.equal(result.match.mapNodeId, 50002);
  assert.equal(result.source, "public");
  assert.equal(
    result.account,
    undefined,
    "an unlocked admission snapshot must not escape into dungeon setup"
  );
  const repeated = await resolveMatchEntry(session, request({ mapNodeId: 50002 }), dependencies);
  assert.equal(repeated.match, result.match);
  assert.equal(accountLoads, 2);
});

test("direct entry to a node the active hero has not opened is refused", async () => {
  const registry = new DungeonMatchRegistry();
  const { gameMaster } = gatedCatalogue();
  const account = {
    active_avatar: 20,
    account_avatars: [{ id: 20, completed_mapnode_mask: "" }],
  };
  const dependencies = {
    registry,
    loadAccountById: async () => account,
    loadGameMasterData: async () => gameMaster,
  };

  for (const friendOnly of [false, true]) {
    const denied = await resolveMatchEntry(player(2), request({ mapNodeId: 50055, friendOnly }), dependencies);
    assert.equal(denied.match, null);
    assert.equal(denied.error, "content_not_completed");
    assert.equal(denied.source, friendOnly ? "private" : "public");
  }
  assert.equal(registry.matches.size, 0);

  account.account_avatars[0].completed_mapnode_mask = setMapNodeBit("", 1);
  const opened = await resolveMatchEntry(player(2), request({ mapNodeId: 50055 }), dependencies);
  assert.equal(opened.match.mapNodeId, 50055, "open once the gate is cleared, before the node itself");
});

test("direct/public Ultimate entry cannot bypass the endgame gate", async () => {
  const registry = new DungeonMatchRegistry();
  const normalNodes = [
    { Id: 50002, NodeType: "BOSS", BitIndex: 0 },
    { Id: 50099, NodeType: "DUNGEON", BitIndex: 1 },
  ];
  const ultimateNode = { Id: 50158, NodeType: "INFINITE", BitIndex: 100 };
  const mapNodes = [...normalNodes, ultimateNode];
  const gameMaster = {
    raw: { MapPage: mapNodes },
    mapNodeById: new Map(mapNodes.map((node) => [node.Id, node])),
  };
  const account = {
    active_avatar: 20,
    account_avatars: [{ id: 20, completed_mapnode_mask: String.fromCharCode(0x80) }],
  };

  const denied = await resolveMatchEntry(player(2), request({ mapNodeId: 50158 }), {
    registry,
    loadAccountById: async () => account,
    loadGameMasterData: async () => gameMaster,
  });
  assert.equal(denied.error, "content_not_completed");
  assert.equal(registry.matches.size, 0);

  account.account_avatars[0].completed_mapnode_mask = String.fromCharCode(0xc0);
  const allowed = await resolveMatchEntry(player(2), request({ mapNodeId: 50158 }), {
    registry,
    loadAccountById: async () => account,
    loadGameMasterData: async () => gameMaster,
  });
  assert.equal(allowed.match.mapNodeId, 50158);
  assert.equal(allowed.source, "public");
});

test("server-owned admin_flags bypass progression, floor and the normal four-player cap", async () => {
  const registry = new DungeonMatchRegistry();
  const host = player(1);
  const target = registry.resolve({ session: host, mapNodeId: 50055 }).match;
  target.floorIndex = 5;
  for (let accountId = 2; accountId <= 4; accountId++) {
    registry.resolve({
      session: player(accountId),
      mapId: target.id,
      eligibleForExplicitJoin: true,
    });
  }
  const node = { Id: 50055, NodeType: "DUNGEON", BitIndex: 2 };
  const gameMaster = {
    raw: { MapPage: [node] },
    mapNodeById: new Map([[node.Id, node]]),
  };

  const joined = await resolveMatchEntry(player(99), request({ friendId: 1 }), {
    registry,
    loadAccountById: async () => ({
      admin_flags: 1,
      active_avatar: 20,
      account_avatars: [{ id: 20, completed_mapnode_mask: "" }],
    }),
    loadGameMasterData: async () => gameMaster,
  });
  assert.equal(joined.match, target);
  assert.equal(joined.created, false);
  assert.equal(target.members.size, 5);
});

test("a client-supplied admin-shaped field grants no override", async () => {
  const registry = new DungeonMatchRegistry();
  const host = player(1);
  const target = registry.resolve({ session: host, mapNodeId: 50055 }).match;
  const { gameMaster } = gatedCatalogue();

  const denied = await resolveMatchEntry(
    player(2),
    request({ friendId: 1, adminOverride: true, admin_flags: 1 }),
    {
      registry,
      loadAccountById: async () => ({
        admin_flags: 0,
        active_avatar: 20,
        account_avatars: [{ id: 20, completed_mapnode_mask: "" }],
      }),
      loadGameMasterData: async () => gameMaster,
    }
  );

  assert.equal(denied.error, "content_not_completed");
  assert.equal(target.members.size, 1);
});

test("server-authorized admin may enter Ultimate without progression", async () => {
  const registry = new DungeonMatchRegistry();
  const ultimate = { Id: 50158, NodeType: "INFINITE", BitIndex: 100 };
  const result = await resolveMatchEntry(player(99), request({ mapNodeId: 50158 }), {
    registry,
    loadAccountById: async () => ({
      admin_flags: 1,
      active_avatar: 20,
      account_avatars: [{ id: 20, completed_mapnode_mask: "" }],
    }),
    loadGameMasterData: async () => ({
      raw: { MapPage: [ultimate] },
      mapNodeById: new Map([[ultimate.Id, ultimate]]),
    }),
  });

  assert.equal(result.match.mapNodeId, 50158);
  assert.equal(result.source, "public");
});


test("friends who cleared a node together may both go into the next one", async () => {
  const gameMaster = await loadGameMaster();
  const registry = new DungeonMatchRegistry();
  const row = (constant) => gameMaster.raw.MapPage.find((node) => node.Constant === constant);
  const cleared = (...constants) =>
    constants.reduce((mask, constant) => setMapNodeBit(mask, row(constant).BitIndex), "");
  const accounts = new Map([
    [1, { active_avatar: 11, account_avatars: [{ id: 11, avatar_id: 101, completed_mapnode_mask: cleared("TUTORIAL", "ARENA_1") }] }],
    [2, { active_avatar: 12, account_avatars: [{ id: 12, avatar_id: 102, completed_mapnode_mask: cleared("TUTORIAL", "ARENA_1") }] }],
    [3, { active_avatar: 13, account_avatars: [{ id: 13, avatar_id: 103, completed_mapnode_mask: cleared("TUTORIAL") }] }],
  ]);
  const dependencies = {
    registry,
    loadAccountById: async (accountId) => accounts.get(accountId),
    loadGameMasterData: async () => gameMaster,
  };

  const hosted = await resolveMatchEntry(player(1), request({ mapNodeId: row("ARENA_2").Id }), dependencies);
  assert.ok(hosted.match, "the host picks the node that opened");
  const joined = await resolveMatchEntry(player(2), request({ friendId: 1 }), dependencies);
  assert.equal(joined.match, hosted.match, "and the friend follows onto it");

  const boosted = await resolveMatchEntry(player(3), request({ friendId: 1 }), dependencies);
  assert.equal(boosted.error, "content_not_completed", "somebody a node behind is not carried forward");
  assert.equal(hosted.match.members.size, 2);
});

test("normal explicit join reads completion from the joining active avatar", async () => {
  const registry = new DungeonMatchRegistry();
  const host = player(1);
  const target = registry.resolve({ session: host, mapNodeId: 50055 }).match;
  const { gameMaster } = gatedCatalogue();
  const account = {
    active_avatar: 20,
    completed_mapnode_mask: String.fromCharCode(0x20),
    account_avatars: [
      { id: 10, completed_mapnode_mask: String.fromCharCode(0x20) },
      { id: 20, completed_mapnode_mask: "" },
    ],
  };

  const denied = await resolveMatchEntry(player(2), request({ friendId: 1 }), {
    registry,
    loadAccountById: async () => account,
    loadGameMasterData: async () => gameMaster,
  });
  assert.equal(denied.error, "content_not_completed");
  assert.equal(target.members.size, 1);

  account.account_avatars[1].completed_mapnode_mask = String.fromCharCode(0x20);
  const allowed = await resolveMatchEntry(player(2), request({ friendId: 1 }), {
    registry,
    loadAccountById: async () => account,
    loadGameMasterData: async () => gameMaster,
  });
  assert.equal(allowed.match, target);
  assert.equal(allowed.error, undefined);
});

test("Ultimate explicit join refuses arrivals after floor one has begun", async () => {
  const registry = new DungeonMatchRegistry();
  const host = player(1);
  const target = registry.resolve({ session: host, mapNodeId: 50158 }).match;
  target.floorIndex = 8;
  const normalNodes = [
    { Id: 50002, NodeType: "BOSS", BitIndex: 0 },
    { Id: 50099, NodeType: "DUNGEON", BitIndex: 96 },
  ];
  const ultimateNode = { Id: 50158, NodeType: "INFINITE", BitIndex: 106 };
  const mapNodes = [...normalNodes, ultimateNode];
  const gameMaster = {
    raw: { MapPage: mapNodes },
    mapNodeById: new Map(mapNodes.map((node) => [node.Id, node])),
  };
  const account = {
    active_avatar: 20,
    account_avatars: [{ id: 20, completed_mapnode_mask: String.fromCharCode(0x80) }],
  };

  const denied = await resolveMatchEntry(player(2), request({ friendId: 1 }), {
    registry,
    loadAccountById: async () => account,
    loadGameMasterData: async () => gameMaster,
  });
  assert.equal(denied.error, "content_not_completed");
  assert.equal(target.members.size, 1);

  const mask = Array.from({ length: 13 }, () => String.fromCharCode(0));
  mask[0] = String.fromCharCode(0x80);
  mask[12] = String.fromCharCode(0x80);
  account.account_avatars[0].completed_mapnode_mask = mask.join("");
  const joined = await resolveMatchEntry(player(2), request({ friendId: 1 }), {
    registry,
    loadAccountById: async () => account,
    loadGameMasterData: async () => gameMaster,
  });
  assert.equal(joined.match, null);
  assert.equal(joined.error, "ultimate_in_progress");
});

test("an unknown map node is rejected before dungeon construction", async () => {
  const registry = new DungeonMatchRegistry();
  const result = await resolveMatchEntry(player(2), request({ mapNodeId: 59999 }), {
    registry,
    loadAccountById: async () => ({ admin_flags: 0 }),
    loadGameMasterData: async () => ({
      raw: { MapPage: [] },
      mapNodeById: new Map(),
    }),
  });

  assert.equal(result.match, null);
  assert.equal(result.error, "bad_map_node");
  assert.equal(registry.matches.size, 0);
});

test("an unknown explicit target is rejected without loading unrelated content", async () => {
  const registry = new DungeonMatchRegistry();
  const result = await resolveMatchEntry(
    player(2),
    request({ friendId: 999, mapNodeId: 50055 }),
    {
      registry,
      loadAccountById: () => assert.fail("missing target loaded an account"),
      loadGameMasterData: () => assert.fail("missing target loaded GameMaster data"),
    }
  );

  assert.equal(result.error, "target_not_found");
  assert.equal(registry.matches.size, 0);
});
