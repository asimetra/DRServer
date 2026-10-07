import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../src/config.js";
import { createRankedService } from "../src/modes/ranked/index.js";
import { createRecords } from "../src/modes/ranked/records.js";
import { createSpec, fixedPicker } from "../src/modes/ranked/race-spec.js";
import { placeLine, publicStanding, rankReply, standingsFrom } from "../src/modes/ranked/standing.js";
import { parseLeagues } from "../src/modes/ranked/leagues.js";
import { COMMAND_PREFIX, resetCommands, runCommand } from "../src/socket/commands.js";
import { bookWords } from "../src/socket/ui-effects.js";
import { registerBuiltinCommands } from "../src/socket/command-set.js";

const match = (a, b, winner, state = "finished") => ({ id: `${a}-${b}-${winner}`, state, players: [a, b], winner, decidedAt: 0 });
const LOG = [
  match(1, 2, 1),
  match(1, 3, 1),
  match(2, 3, null),
  match(2, 3, 2, "cancelled"),
  match(1, 3, 3, "void"),
].map((row, i) => ({ ...row, decidedAt: i }));

test("the board read from the log is the one the ranked service keeps", async () => {
  const records = createRecords({ storage: "memory" });
  for (const row of LOG) await records.append(row);
  const service = createRankedService({
    records,
    picker: fixedPicker(createSpec({ mapNodeId: 50006, seed: 1 })),
    rules: { countdownMs: 1, maxDurationMs: 1, forfeitWindowMs: 1, drawWindowMs: 1 },
    start: () => {},
  });
  await service.load();
  const { board } = standingsFrom(await records.all());
  assert.deepEqual(
    board.map(({ league, color, ...row }) => row),
    service.board().map((row) => ({ ...row, accountId: Number(row.accountId) }))
  );
  assert.ok(board.every((row) => row.league && /^#[0-9a-f]{6}$/i.test(row.color)), "each with its league");
});

test("a player's place and record count finished races only", () => {
  const standings = standingsFrom(LOG);
  const two = standings.of(2);
  assert.deepEqual([two.won, two.lost, two.drawn, two.games], [0, 1, 1, 2], "the cancelled and the void are not races");
  assert.equal(two.of, 3);
  assert.equal(standings.of(1).place, 1);
  assert.deepEqual(standings.of(9), { ...standings.of(9), place: null, games: 0, won: 0, lost: 0, drawn: 0 });
  assert.equal(placeLine(standings.of(9), bookWords.part), "Wooden 1000, no place until your first race", "everybody starts in the first league");
});

test("/rank says where the caller stands and who leads, in one message", async () => {
  const standings = standingsFrom(LOG);
  const reply = await rankReply({ standings, accountId: 2, nameOf: async (id) => `P${id}`, part: bookWords.part });
  const [own, top, more] = reply.split("\n");
  assert.match(own, /^Ranked: (Wooden|Silver|Gold|Dragon) \d+, #\d of 3 — 2 races: 0 won, 1 lost, 1 drawn\.$/);
  assert.match(top, /^Top: 1\. P1 \w+ \d+ · 2\. \S+ \w+ \d+ · 3\. \S+ \w+ \d+$/);
  assert.ok(top.includes("you"), "the caller is 'you' on the board, not their name");
  assert.equal(more, undefined, "no placement, so nothing to explain about one");
});

test("/rank is a player's command of the ranked mode: unknown with the mode off", async () => {
  resetCommands();
  registerBuiltinCommands();
  const lines = [];
  const reply = (text) => lines.push(text);
  reply.warn = (text) => lines.push(`! ${text}`);
  const session = { id: 1, accountId: 500, dungeonAccount: { id: 500, name: "Simetra" } };

  // Off: the core defines no /rank, so it is what any unknown command is.
  await runCommand(session, `${COMMAND_PREFIX}rank`, reply);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /unknown|no such|not a command/i, lines[0]);

  // On, with the test run's empty log: no place yet.
  const { installRankedCommands } = await import("../src/modes/ranked/commands.js");
  const { bookWords } = await import("../src/socket/ui-effects.js");
  const uninstall = installRankedCommands({ bookWords, loadExistingAccount: async () => null });
  try {
    lines.length = 0;
    await runCommand(session, `${COMMAND_PREFIX}rank`, reply);
    assert.deepEqual(lines, ["Ranked: Wooden 1000, no place until your first race."]);
  } finally {
    uninstall();
  }
});

test("the top league goes by place on the board, among those in the band under it", () => {
  const leagues = parseLeagues([
    { name: "Wooden", from: 0, color: "#A0703C" },
    { name: "Gold", from: 1010, color: "#E8B830" },
    { name: "Dragon", top: 0.5, color: "#9B59D0" },
  ]);
  // A and C win once each, at 1020; B and D lose, at 980.
  const standings = standingsFrom(
    [
      { state: "finished", players: [1, 2], winner: 1 },
      { state: "finished", players: [3, 4], winner: 3 },
    ],
    { leagues }
  );
  assert.deepEqual(
    standings.board.map((row) => [row.accountId, row.league]),
    [[1, "Dragon"], [3, "Dragon"], [2, "Wooden"], [4, "Wooden"]]
  );
  assert.deepEqual(publicStanding(standings.of(2), leagues).next, { league: "Gold", from: 1010 });
  assert.equal(publicStanding(standings.of(1), leagues).next, null);
});
