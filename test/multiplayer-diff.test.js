import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { diffSemanticTraces, semanticTrace } from "../tools/multiplayer-diff.js";
import {
  heroGenerate,
  heroOwnerGenerate,
  objectDisable,
  playerGenerate,
  playerOwnerGenerate,
} from "../src/socket/objects.js";
import { stateUpdate } from "../src/socket/combat.js";
import { CLID } from "../src/socket/opcodes.js";

const writeCapture = async (file, frames) => {
  const lines = frames.map((frame, index) => {
    const body = frame.subarray(2);
    return JSON.stringify({
      ts: new Date(1_700_000_000_000 + index).toISOString(),
      dir: "in",
      op: body.readUInt16LE(0),
      len: body.length,
      hex: body.toString("hex"),
    });
  });
  await fs.writeFile(file, `${lines.join("\n")}\n`);
};

const partyFrames = ({ ownerPlayer, remotePlayer, ownerHero, remoteHero, includeDown = true }) => {
  const frames = [
    playerOwnerGenerate({ doid: ownerPlayer, zone: 10, screenName: "Owner", basicCurrency: 5 }),
    playerGenerate({ doid: remotePlayer, parent: 0, zone: 10, screenName: "Remote" }),
    heroOwnerGenerate({
      doid: ownerHero,
      parent: 0,
      heroType: 101,
      skinType: 151,
      playerId: ownerPlayer,
      screenName: "Owner",
      hitPoints: 200,
      manaPoints: 100,
      effectiveHitPoints: 200,
      weapons: [],
      consumables: [],
      slotPoints: [],
    }),
    heroGenerate({
      doid: remoteHero,
      parent: 0,
      heroType: 101,
      skinType: 151,
      playerId: remotePlayer,
      screenName: "Remote",
      hitPoints: 200,
      manaPoints: 100,
      effectiveHitPoints: 200,
      weapons: [],
      consumables: [],
      slotPoints: [],
    }),
  ];
  if (includeDown) frames.push(stateUpdate(remoteHero, CLID.HeroGameObject, "down"));
  frames.push(objectDisable(remoteHero));
  return frames;
};

test("semantic multiplayer traces ignore raw doids but preserve owner/remote roles", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dr-semantic-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const official = path.join(directory, "official.jsonl");
  const local = path.join(directory, "local.jsonl");
  await writeCapture(official, partyFrames({
    ownerPlayer: 1001,
    remotePlayer: 1002,
    ownerHero: 1101,
    remoteHero: 1102,
  }));
  await writeCapture(local, partyFrames({
    ownerPlayer: 7001,
    remotePlayer: 7002,
    ownerHero: 7101,
    remoteHero: 7102,
  }));

  const expected = await semanticTrace(official);
  const actual = await semanticTrace(local);
  assert.equal(expected.peakHeroes, 2);
  assert.deepEqual(actual.events.map(({ key }) => key), expected.events.map(({ key }) => key));
  assert.equal(diffSemanticTraces(expected, actual).length, 0);
  assert.ok(expected.events.some(({ key }) => key.includes("owner:hero#1")));
  assert.ok(expected.events.some(({ key }) => key.includes("remote:hero#1")));
});

test("semantic diff names a missing multiplayer state transition", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dr-semantic-missing-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const official = path.join(directory, "official.jsonl");
  const local = path.join(directory, "local.jsonl");
  await writeCapture(official, partyFrames({
    ownerPlayer: 1001,
    remotePlayer: 1002,
    ownerHero: 1101,
    remoteHero: 1102,
  }));
  await writeCapture(local, partyFrames({
    ownerPlayer: 7001,
    remotePlayer: 7002,
    ownerHero: 7101,
    remoteHero: 7102,
    includeDown: false,
  }));

  const diff = diffSemanticTraces(await semanticTrace(official), await semanticTrace(local));
  assert.ok(
    diff.some(({ type, expected }) =>
      type === "missing" && expected.includes("remote:hero#1.state=\"down\"")
    ),
    JSON.stringify(diff, null, 2)
  );
});
