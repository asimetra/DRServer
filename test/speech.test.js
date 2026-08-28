import assert from "node:assert/strict";
import test from "node:test";

import { PacketReader } from "../src/socket/packet.js";
import { CLID } from "../src/socket/opcodes.js";
import { VOICE_COLOUR, forgetVoices, giveVoice, say, speakerOf } from "../src/socket/speech.js";
import { updateProximityTriggers } from "../src/socket/triggers.js";

const sessionWith = (triggers = []) => {
  const sent = [];
  const announced = [];
  let nextDoid = 8000;
  return {
    id: 9,
    heroDoid: 500,
    playerDoid: 70,
    areaDoid: 400,
    dungeonZone: 10,
    objects: new Map(),
    actors: new Map([[500, { position: { x: 0, y: 0 }, collisionRadius: 20 }]]),
    triggers,
    sent,
    announced,
    allocateDoid: () => ++nextDoid,
    sendDirect: (frame) => sent.push(frame),
    // Who is in the room is everybody's business; what is said to one is not.
    broadcast: (frame) => announced.push(frame),
  };
};

const spoken = (frame) => {
  const reader = new PacketReader(frame.subarray(2));
  reader.u16();
  const doid = reader.u32();
  reader.u16();
  return { doid, text: reader.utf() };
};

/**
 * The point of the seam. A map says a thing can talk and never learns how, so
 * the channel can change — and it may have to. What is available today was
 * measured: an NPC has no name field and nothing routes chat to one, a hero
 * has both but is a hero on screen, and the two cannot be combined because
 * body, effect and nametag share the root that `scale` scales.
 */
test("anything the map gives a voice can be spoken as", () => {
  const session = sessionWith();
  giveVoice(session, { id: "keeper", name: "Tavern Keeper", doid: 901 });

  assert.equal(say(session, "keeper", "Nowhere to be, then."), true);
  assert.equal(spoken(session.sent[0]).text, "Tavern Keeper: Nowhere to be, then.");
});

/**
 * The whole reason a speaker has an object of its own. A line written to the
 * *listener's* player object is attributed to the listener: the client takes
 * the name from its own record of whoever the doid belongs to, and colours the
 * first `name.length + 1` characters as that name. Said on the speaker's own
 * object, the attribution and the colour land where they belong.
 */
test("a line comes from the speaker's own object, not the listener's", () => {
  const session = sessionWith();
  const speaker = giveVoice(session, { id: "keeper", name: "Tavern Keeper" });

  say(session, "keeper", "Sit down.");
  const { doid } = spoken(session.sent[0]);
  assert.equal(doid, speaker.doid);
  assert.notEqual(doid, session.playerDoid, "not the listener's own");
});

test("the room is told who is here; only one person is told what was said", () => {
  const session = sessionWith();
  giveVoice(session, { id: "keeper", name: "Tavern Keeper" });
  assert.equal(session.announced.length, 1, "the speaker is generated for everybody");
  assert.equal(session.sent.length, 0, "and has said nothing yet");

  say(session, "keeper", "Sit down.");
  assert.equal(session.announced.length, 1, "a greeting is not an announcement");
  assert.equal(session.sent.length, 1);
});

test("a speaker is generated once, however often the map names it", () => {
  const session = sessionWith();
  const first = giveVoice(session, { id: "keeper", name: "Tavern Keeper" });
  const again = giveVoice(session, { id: "keeper", name: "Tavern Keeper" });
  assert.equal(again.doid, first.doid);
  assert.equal(session.announced.length, 1);
});

test("retiring a floor takes its speakers off it", () => {
  const session = sessionWith();
  const speaker = giveVoice(session, { id: "keeper", name: "Tavern Keeper" });
  assert.equal(session.objects.get(speaker.doid), CLID.PlayerGameObject);

  forgetVoices(session);
  assert.equal(session.objects.has(speaker.doid), false);
  assert.equal(session.announced.length, 2, "generated, then disabled");
  assert.equal(speakerOf(session, "keeper"), null);
});

/**
 * The reason a speaker would want a body at all: the chat log is closed most of
 * the time, so a line in it is a line nobody reads. A balloon is drawn over a
 * hero, and the hero has to point back at the speaker's player object because
 * that is the key the listener is registered under.
 */
test("a speaker with a body is a hero pointing back at its own voice", () => {
  const session = sessionWith();
  const speaker = giveVoice(session, {
    id: "keeper",
    name: "Tavern Keeper",
    hero: { heroType: 102, skinType: 151 },
    position: { x: 450, y: 300 },
  });

  assert.ok(speaker.heroDoid, "it has a body");
  assert.equal(session.objects.get(speaker.heroDoid), CLID.HeroGameObject);
  assert.equal(session.announced.length, 2, "the player object and the body");

  // The balloon is raised by the hero listening on its own playerID, so the
  // hero must carry the speaker's player doid or the words go nowhere.
  const playerId = Buffer.alloc(4);
  playerId.writeUInt32LE(speaker.doid);
  assert.ok(session.announced[1].includes(playerId), "the body points at the voice");
});

test("and without one it is a voice and nothing else", () => {
  const session = sessionWith();
  const speaker = giveVoice(session, { id: "sign", name: "A Notice" });

  assert.equal(speaker.heroDoid, null);
  assert.equal(session.announced.length, 1);
});

test("a body is retired with its voice", () => {
  const session = sessionWith();
  const speaker = giveVoice(session, {
    id: "keeper",
    name: "Tavern Keeper",
    hero: { heroType: 102, skinType: 151 },
    position: { x: 0, y: 0 },
  });

  forgetVoices(session);
  assert.equal(session.objects.has(speaker.heroDoid), false);
  assert.equal(session.objects.has(speaker.doid), false);
});

/**
 * `PlayerSpecialStatus.getSpecialTextColor` reads the first character of the
 * name and nothing else — a star is green, a bolt is orange. It is the game's
 * own mechanism and it costs a prefix.
 */
test("a name can ask for a colour, because the client reads its first character", () => {
  const session = sessionWith();
  giveVoice(session, { id: "keeper", name: `${VOICE_COLOUR.green}Tavern Keeper` });

  say(session, "keeper", "Sit down.");
  assert.match(spoken(session.sent[0]).text, /^★Tavern Keeper: /);
});

test("and nothing else can", () => {
  const session = sessionWith();
  assert.equal(say(session, "nobody", "hello"), false);
  assert.equal(session.sent.length, 0);
});

test("a voice needs both an id and a name to be one", () => {
  const session = sessionWith();
  giveVoice(session, { id: "mute", name: undefined });
  giveVoice(session, { id: undefined, name: "Nameless" });
  assert.equal(speakerOf(session, "mute"), null);
});

test("voices do not outlive their floor", () => {
  const session = sessionWith();
  giveVoice(session, { id: "keeper", name: "Tavern Keeper" });
  forgetVoices(session);
  assert.equal(speakerOf(session, "keeper"), null);
});

/**
 * A trigger addresses a speaker or the room, and the difference is whether the
 * line is attributed. Both are authored in the tile; neither is a branch in the
 * server.
 */
test("a trigger speaks as the one it names", () => {
  const session = sessionWith([
    { id: "t", constant: "PROXIMITY_TRIGGER", x: 0, y: 0, radius: 150, chatText: "Sit down.", speaker: "keeper" },
  ]);
  giveVoice(session, { id: "keeper", name: "Tavern Keeper" });

  updateProximityTriggers(session, { x: 10, y: 10 });
  assert.equal(spoken(session.sent[0]).text, "Tavern Keeper: Sit down.");
});

test("and as the room when it names nobody", () => {
  const session = sessionWith([
    { id: "t", constant: "PROXIMITY_TRIGGER", x: 0, y: 0, radius: 150, chatText: "The door creaks." },
  ]);

  updateProximityTriggers(session, { x: 10, y: 10 });
  assert.equal(spoken(session.sent[0]).text, "The door creaks.");
});

/**
 * A tile is placed many times over, so every id inside one is prefixed with the
 * instance — and a reference to another placement has to carry that prefix too
 * or it points at nothing. `npcId` already did; `speaker` quietly did not, so
 * a keeper registered as "0:tavern.keeper" while his own greeting asked for
 * "tavern.keeper" and the line came out unattributed.
 */
test("a speaker reference survives being placed", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { config } = await import("../src/config.js");
  const { readPlacements } = await import("../src/socket/floors.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dr-speaker-"));
  // Laid out as a content directory, so `levelsFile` takes the tile library
  // from here and still finds the navigation library in the game's own data.
  fs.mkdirSync(path.join(root, "Resources", "Levels", "t"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "Resources", "Levels", "t", "tiles.json"),
    JSON.stringify({
      LETiles: [
        {
          type: "LETile", id: "ROOM", theme: "CASTLE", exits: [0, 0, 0, 0],
          LEBackground: { type: "LEBackground", constant: "CASTLE_ARENA_FILLER", x: 450, y: 450, id: "bg" },
          LEObjects: [
            { type: "LENPC", constant: "KNIGHT", x: 450, y: 300, voice: "Keeper", id: "who" },
            { type: "LETrigger", constant: "PROXIMITY_TRIGGER", x: 450, y: 380, radius: 150,
              chatText: "Sit down.", speaker: "who", id: "greet" },
          ],
        },
      ],
    })
  );

  const previous = config.contentDir;
  try {
    config.contentDir = root;
    const floor = await readPlacements("Resources/Levels/t/tiles.json", [
      { x: 0, y: 0, tileId: "ROOM" },
      // Placed twice, because one instance cannot show a prefix going wrong.
      { x: 900, y: 0, tileId: "ROOM" },
    ]);

    const npcs = floor.placements.npc;
    const triggers = floor.placements.trigger;
    assert.equal(npcs.length, 2);
    assert.equal(triggers.length, 2);
    assert.notEqual(npcs[0].id, npcs[1].id, "two instances are two placements");

    for (const [index, trigger] of triggers.entries()) {
      assert.equal(trigger.speaker, npcs[index].id, `instance ${index} points at its own keeper`);
    }
    assert.equal(npcs[0].voice, "Keeper", "and the voice comes through");
  } finally {
    config.contentDir = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A speaker that has left the floor is not a reason to lose the line. */
test("naming a speaker that is gone still says it, unattributed", () => {
  const session = sessionWith([
    { id: "t", constant: "PROXIMITY_TRIGGER", x: 0, y: 0, radius: 150, chatText: "Silence.", speaker: "ghost" },
  ]);

  updateProximityTriggers(session, { x: 10, y: 10 });
  assert.equal(spoken(session.sent[0]).text, "Silence.");
});

/**
 * The other way to touch a thing. Walking up to it and hitting it are the same
 * event to whoever authored the tile, so a line should not depend on which one
 * they chose — `announce` is shared and this proves it.
 */
test("hitting something that speaks is also how it speaks", async () => {
  const { reportNpcDamage } = await import("../src/socket/triggers.js");
  const session = sessionWith([
    {
      id: "t", constant: "NPC_DAMAGE_TRIGGER", npcId: "stone",
      chatText: "Ice Caverns.", speaker: "stone",
    },
  ]);
  giveVoice(session, { id: "stone", name: "Standing Stone" });

  reportNpcDamage(session, "stone");
  assert.equal(spoken(session.sent[0]).text, "Standing Stone: Ice Caverns.");
});

/**
 * Authored damage triggers latch: a statue struck once opens what is behind it
 * and a second blow is not a second event. A stone built to be knocked through
 * a list is the opposite, and says so in the tile.
 */
test("a damage trigger latches unless the tile says it repeats", async () => {
  const { reportNpcDamage } = await import("../src/socket/triggers.js");

  const latched = sessionWith([
    { id: "t", constant: "NPC_DAMAGE_TRIGGER", npcId: "statue", chatText: "Once." },
  ]);
  reportNpcDamage(latched, "statue");
  reportNpcDamage(latched, "statue");
  assert.equal(latched.sent.length, 1, "the game's own behaviour is unchanged");

  const knockable = sessionWith([
    { id: "t", constant: "NPC_DAMAGE_TRIGGER", npcId: "stone", chatText: "Again.", repeats: true },
  ]);
  reportNpcDamage(knockable, "stone");
  reportNpcDamage(knockable, "stone");
  reportNpcDamage(knockable, "stone");
  assert.equal(knockable.sent.length, 3);
});

/**
 * Saying "this one" without words. The buff is drawn on the actor — a looping
 * effect and a `colorMatrixFilter` tween at `repeat: -1, yoyo: true`, so the
 * body pulses rather than being flatly painted — and the HUD icon it would
 * otherwise carry is inside an `isOwner` guard, so marking a stone never
 * reaches the player's bar.
 */
test("a trigger can mark its subject as well as speak for it", async () => {
  const { reportNpcDamage } = await import("../src/socket/triggers.js");
  const { CLID } = await import("../src/socket/opcodes.js");

  const session = sessionWith([
    {
      id: "t", constant: "NPC_DAMAGE_TRIGGER", npcId: "stone",
      chatText: "Ice Caverns.", speaker: "stone",
      // One of the game's own, so this runs without our content directory.
      highlight: "CHEF_DEFENSE_BUFF", repeats: true,
    },
  ]);
  session.npcDoids = new Map([["stone", 4242]]);
  session.floorDoid = 400;
  session.activeBuffs = new Map();
  const sent = [];
  session.send = (frame) => sent.push(frame);
  giveVoice(session, { id: "stone", name: "Standing Stone" });

  reportNpcDamage(session, "stone");
  assert.equal(spoken(session.sent[0]).text, "Standing Stone: Ice Caverns.");

  /**
   * grantBuff reads the game master, so the mark lands some ticks later — and
   * how many depends on whether that four-megabyte table is already parsed.
   * Waited on rather than slept through: a fixed delay passes on a warm cache
   * and fails on a cold one, which is a test that reports the weather.
   */
  const marked = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ([...session.objects.values()].includes(CLID.DistributedBuffGameObject)) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };
  assert.ok(await marked(), "a buff object was generated");
  const buff = [...session.objects.entries()].find(([, clid]) => clid === CLID.DistributedBuffGameObject);
  assert.equal([...session.activeBuffs.values()][0].affectedActor, 4242, "on the stone");
  assert.equal(sent.length, 1, "and sent");
});

test("a trigger with nothing to mark marks nothing", async () => {
  const { reportNpcDamage } = await import("../src/socket/triggers.js");
  const session = sessionWith([
    { id: "t", constant: "NPC_DAMAGE_TRIGGER", npcId: "gone", highlight: "HIGHLIGHT_SELECTED" },
  ]);
  // No doid for "gone": the mark is skipped and the event still fires.
  assert.equal(reportNpcDamage(session, "gone"), false);
});
