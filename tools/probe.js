/**
 * Protocol probe — a tiny stand-in for the game client.
 *
 * Speaks just enough DcSocket to exercise the server without launching the
 * real game (which needs a display and a ten-minute build). Useful for
 * verifying a new message end to end, and as a regression check afterwards.
 *
 *   node tools/probe.js                 # log in, print what comes back
 *   node tools/probe.js request-entry   # ...then ask to enter the tutorial dungeon
 *   node tools/probe.js pickup          # ...then walk onto a doober and check pickup
 *   node tools/probe.js trap            # ...then verify an arrow trap fires
 *   node tools/probe.js arrow-flight    # ...then verify arrow damage waits for contact
 *   node tools/probe.js spikes          # ...then verify floor spikes appear and retract
 *   node tools/probe.js cage            # ...then step on the final-room cage trigger
 *   node tools/probe.js ai              # ...then verify a knight chases and damages the hero
 *   node tools/probe.js drop            # ...then kill a knight and collect its XP drop
 *   node tools/probe.js buster          # ...then collect a CROWD doober and verify the bar
 *   node tools/probe.js buster-use      # ...then fill and consume the hero's Buster meter
 *   node tools/probe.js mana-charge     # ...then use a charged skill and verify Mana spend
 *   node tools/probe.js poison-pot      # ...then place a poison cloud and verify it damages
 *   node tools/probe.js food            # ...then take damage and verify a food heal
 *   node tools/probe.js revive          # ...then down and revive the hero through field 174
 *   node tools/probe.js next-floor      # ...then walk onto the exit and check the floor advances
 *   node tools/probe.js boss            # ...then kill the minotaur and check the reward and ending
 *   node tools/probe.js exit            # ...then leave early and verify ClientExitComplete
 */
import fs from "node:fs";
import net from "node:net";
import { PacketWriter, PacketReader, drainFrames } from "../src/socket/packet.js";
import { OP, CLID, DC_HASH, opcodeName } from "../src/socket/opcodes.js";
import { FLID } from "../src/socket/matchmaker.js";
import { loadGameMaster } from "../src/gamemaster.js";

const HOST = process.env.DR_PUBLIC_HOST ?? "127.0.0.1";
const PORT = Number(process.env.DR_SOCKET_PORT ?? 7198);
const ACCOUNT_ID = Number(process.env.DR_ACCOUNT_ID ?? 1000000005);
const TOKEN = process.env.DR_TOKEN ?? "probe-token";
/** 50002 is the tutorial dungeon — the same floor the real client enters. */
const MAP_NODE = Number(process.env.DR_MAP_NODE ?? 50002);

const readI32 = (reader) => {
  const value = reader.buf.readInt32LE(reader.pos);
  reader.pos += 4;
  return value;
};

const mode = process.argv[2] ?? "login";
const expectedByMode = {
  login: ["connected", "matchmaker", "heartbeat"],
  "request-entry": ["connected", "matchmaker", "area", "floor", "player", "hero"],
  pickup: [
    "connected",
    "matchmaker",
    "area",
    "floor",
    "player",
    "hero",
    "doober",
    "currency",
    "pickup",
  ],
  trap: ["connected", "matchmaker", "area", "floor", "player", "hero", "arrow", "trap-attack"],
  /**
   * Walks onto the floor's exit trigger and checks the dungeon moves on rather
   * than ending. Clearing a floor only opens the gate; reaching the exit behind
   * it is what advances, and the client never says so — the server watches the
   * position stream.
   */
  /**
   * Kills the tutorial's minotaur and checks its death starts the chain the
   * tile data describes. None of it used to happen: the chain hangs off an
   * NPC_LIFE_TRIGGER naming the boss, and it ends at a completion triggerable
   * the server was looking for in the monster table.
   */
  boss: [
    "connected",
    "matchmaker",
    "area",
    "floor",
    "player",
    "hero",
    "walked-to-exit",
    "second-floor",
    "boss-seen",
    "brutes-with-boss",
    "boss-killed",
    "reward-chest",
    "chest-taken",
    // Not the ending: the jail brutes are still alive and correctly hold the
    // floor open. Clearing twenty of them is a fight, not a probe.
  ],
  "next-floor": [
    "connected",
    "matchmaker",
    "area",
    "floor",
    "player",
    "hero",
    "walked-to-exit",
    "floor-ending",
    "second-floor",
    "second-hero",
  ],
  "arrow-flight": [
    "connected",
    "matchmaker",
    "area",
    "floor",
    "player",
    "hero",
    "arrow",
    "arrow-positioned",
    "trap-attack",
    "arrow-hit",
    "arrow-damage",
  ],
  spikes: [
    "connected",
    "matchmaker",
    "area",
    "floor",
    "player",
    "hero",
    "spikes",
    "spikes-on",
    "spikes-hit",
    "spikes-damage",
    "spikes-off",
  ],
  cage: [
    "connected",
    "matchmaker",
    "area",
    "floor",
    "player",
    "hero",
    "cages",
    "button",
    "cages-open",
    "button-pressed",
    "cage-wave",
  ],
  /**
   * Walks the floor and stands next to every trap on it.
   *
   * Not an assertion: a tour is how a capture gets coverage. `wire-diff`
   * compares this server's stream with the official's, and it can only speak
   * about traps both sides actually exercised — so a run whose hero stood where
   * it spawned reported far more about where the probe went than about what
   * this server does.
   */
  tour: ["connected", "matchmaker", "area", "floor", "player", "hero", "toured"],
  ai: [
    "connected",
    "matchmaker",
    "area",
    "floor",
    "player",
    "hero",
    "ai-knight",
    "ai-move",
    "ai-attack",
    "ai-damage",
  ],
  drop: [
    "connected",
    "matchmaker",
    "area",
    "floor",
    "player",
    "hero",
    "drop-target",
    "drop-spawn",
    "drop-collected",
    "xp",
  ],
  buster: [
    "connected",
    "matchmaker",
    "area",
    "floor",
    "player",
    "hero",
    "buster-doober",
    "buster-points",
    "buster-collected",
  ],
  "buster-use": [
    "connected",
    "matchmaker",
    "area",
    "floor",
    "player",
    "hero",
    "buster-ready",
    "buster-consumed",
  ],
  "mana-charge": [
    "connected",
    "matchmaker",
    "area",
    "floor",
    "player",
    "hero",
    "mana-spent",
  ],
  /**
   * The other half of an attack's timeline: what it leaves standing. The poison
   * pot is the case that had nothing on either side of the wire building it.
   */
  "poison-pot": [
    "connected",
    "matchmaker",
    "area",
    "floor",
    "player",
    "hero",
    "placeable-target",
    "placeable-spawned",
    "placeable-attack",
    "placeable-damage",
    "placeable-gone",
  ],
  food: [
    "connected",
    "matchmaker",
    "area",
    "floor",
    "player",
    "hero",
    "food-doober",
    "food-damaged",
    "food-healed",
    "food-collected",
  ],
  revive: [
    "connected",
    "matchmaker",
    "area",
    "floor",
    "player",
    "hero",
    "revive-down",
    "revive-response",
    "bomb-used",
    "revive-hp",
    "revive-state",
  ],
  exit: [
    "connected",
    "matchmaker",
    "area",
    "floor",
    "player",
    "hero",
    "hero-disabled",
    "floor-disabled",
    "area-disabled",
    "player-disabled",
    "exit-complete",
  ],
};

if (!expectedByMode[mode]) {
  console.error(
    `unknown probe mode "${mode}"; use login, request-entry, pickup, trap, arrow-flight, spikes, cage, ai, drop, buster, buster-use, mana-charge, poison-pot, food, revive, next-floor, boss or exit`
  );
  process.exit(2);
}

/**
 * The two attack scenarios propose a real attack id, and which id that is
 * depends on the account's active avatar. Rather than name one hero's attack
 * and demand that hero, they read the same dictionary the server reads and ask
 * what the avatar that turned up can actually do. Six megabytes of JSON is not
 * worth parsing for the modes that never ask.
 */
const gameMaster = [
  "buster-use",
  "mana-charge",
  "poison-pot",
  "ai",
  "drop",
  // Which pickups are food, and how deep a wound each is worth taking for.
  "food",
  // And the tour, which needs to know which of the things on the floor are
  // traps before it can go and stand next to them.
  "tour",
].includes(mode)
  ? await loadGameMaster()
  : null;
const weaponItemsById = new Map(
  (gameMaster?.raw.WeaponItem ?? []).map((item) => [Number(item.Id), item])
);
/** NPC rows by the id the wire carries, which is not how GameMaster keys them. */
const npcsById = new Map((gameMaster?.raw.Npc ?? []).map((npc) => [Number(npc.Id), npc]));

const STAT_ATTACK_TYPES = new Set(["MELEE", "SHOOTING", "MAGIC"]);

/**
 * Mirrors buster.js attackManaCost. A stat attack's authored cost is scaled by
 * the equipped weapon's MP_COST modifiers, and Mana is a UInt on the client, so
 * a fractional price consumes the next whole point.
 */
const manaCostOf = (attack, weapon) => {
  const baseCost = Math.max(0, Number(attack.ManaCost ?? 0));
  if (!baseCost || !STAT_ATTACK_TYPES.has(attack.AttackType)) return Math.ceil(baseCost);

  let multiplier = 1;
  for (const modifierId of [weapon.modifier1, weapon.modifier2]) {
    if (!modifierId) continue;
    multiplier *= Math.max(0, Number(gameMaster.modifiersById.get(modifierId)?.MP_COST ?? 1));
  }
  return Math.ceil(baseCost * multiplier);
};

/**
 * The first equipped weapon that can spend Mana, with the slot it sits in —
 * the proposal carries that slot, and the modifiers on that weapon are what
 * price the attack.
 *
 * A charged attack is what this scenario is named for and is tried first; the
 * weapon's ordinary attack is the fallback for the weapons that have no charge.
 * Both live on the WeaponItem row as constants, and only the Attack row they
 * name carries the id and the cost.
 */
const findManaAttack = (weapons) => {
  for (const [slot, weapon] of weapons.entries()) {
    const item = weaponItemsById.get(Number(weapon?.type));
    if (!item) continue;
    for (const constant of [item.ChargeAttack, item.Attack1]) {
      const attack = constant ? gameMaster.attacksByConstant.get(constant) : null;
      if (!attack) continue;
      const cost = manaCostOf(attack, weapon);
      if (cost > 0) return { slot, attack, cost };
    }
  }
  return null;
};

/**
 * The ordinary swing of the first equipped weapon that has one.
 *
 * A hit has to have a cast behind it. The server records an accepted
 * `ProposeAttackChoreography` and then only honours results naming the same
 * attack and the same slot within its window — so a proposal for
 * `EN_SWORD_SLASH`, which is a *knight's* attack and no weapon of ours grants,
 * is refused as unowned and every result behind it counts as a violation. Forty
 * of those in a row is what was terminating the connection mid-scenario.
 *
 * So the probe swings what it is actually holding, the same way the Mana and
 * placeable searches ask the avatar that turned up rather than requiring a
 * particular hero.
 */
const findBasicAttack = (weapons) => {
  for (const [slot, weapon] of weapons.entries()) {
    const item = weaponItemsById.get(Number(weapon?.type));
    if (!item?.Attack1) continue;
    const attack = gameMaster.attacksByConstant.get(item.Attack1);
    if (attack?.Id) return { slot, attack };
  }
  return null;
};

/**
 * The first equipped weapon whose attack leaves something standing on the
 * floor, with the NPC it places.
 *
 * Same shape as the Mana search and for the same reason: which hero is active
 * is the account's business, so the scenario asks the avatar that turned up
 * what it can do rather than requiring the Battle Chef. `spawnnpc` and
 * `spawnNpcForAttack` are one action under two spellings, and a `#` prefix is
 * the data disabling itself.
 */
const findPlaceableAttack = (weapons) => {
  for (const [slot, weapon] of weapons.entries()) {
    const item = weaponItemsById.get(Number(weapon?.type));
    if (!item) continue;
    for (const constant of [item.Attack1, item.ChargeAttack]) {
      const attack = constant ? gameMaster.attacksByConstant.get(constant) : null;
      const timeline = attack && gameMaster.timelines.get(attack.AttackTimeline);
      if (!timeline) continue;
      for (const frame of timeline.frames ?? []) {
        for (const action of frame.actions ?? []) {
          const type = String(action.type ?? "").toLowerCase();
          if (type !== "spawnnpc" && type !== "spawnnpcforattack") continue;
          const npc = gameMaster.npcByConstant.get(action.spawnname);
          if (!npc) continue;
          // Whichever of the two the row carries is the one whose shape decides
          // where a target has to stand.
          const attackOnSpawn =
            (npc.Attack1 && gameMaster.attacksByConstant.get(npc.Attack1)) ??
            (npc.DeathAttack && gameMaster.attacksByConstant.get(npc.DeathAttack)) ??
            null;
          // How far in front of itself it reaches, from the authored colliders.
          const shape = gameMaster.timelines.get(attackOnSpawn?.AttackTimeline);
          const offsets = (shape?.frames ?? []).flatMap((frame) =>
            (frame.actions ?? [])
              .filter((entry) => /collider$/i.test(String(entry.type ?? "")))
              .map((entry) => Number(entry.xOffset ?? 0))
          );
          const reach = offsets.length ? Math.max(...offsets) : 0;
          return { slot, attack, action, npc, attackOnSpawn, reach };
        }
      }
    }
  }
  return null;
};

/**
 * The Crowd meter belongs to the hero rather than to a weapon: every Attack row
 * that charges CrowdCost is some hero's DBuster1 (or a party bomb), never a
 * weapon's own attack. The server sizes the meter from that same row, so the
 * buster to propose is whatever the active avatar's Hero row names.
 */
const findDungeonBuster = (heroType) => {
  const hero = gameMaster.heroById.get(Number(heroType));
  const attack = hero?.DBuster1 ? gameMaster.attacksByConstant.get(hero.DBuster1) : null;
  if (!attack) return null;
  return { attack, cost: Math.max(0, Math.trunc(attack.CrowdCost ?? 0)) };
};

const state = {
  matchMakerDoid: null,
  areaDoid: null,
  floorDoid: null,
  playerDoid: null,
  basicCurrency: null,
  heroDoid: null,
  experiencePoints: null,
  dungeonBusterPoints: null,
  doober: null,
  doobersByDoid: new Map(),
  boss: null,
  rewardChest: null,
  deathDoobers: new Map(),
  experienceDrop: null,
  busterDoober: null,
  busterQueue: [],
  floorCrowd: 0,
  currentBusterDoober: null,
  foodDoober: null,
  foodRestores: 0,
  arrowDoids: new Set(),
  arrowFlightTrap: null,
  arrowFiredAt: null,
  spikeDoid: null,
  finalCageDoids: new Set(),
  buttonDoid: null,
  tutorialFodders: 0,
  cageWaveBaseline: null,
  openCageDoids: new Set(),
  aiKnight: null,
  heroHitPoints: null,
  lowestHeroHitPoints: null,
  seen: new Set(),
  finished: false,
};

let deadline;
let socket;

const dungeonBuster = () => (state.dungeonBuster ??= findDungeonBuster(state.heroType));

const missingExpectations = () =>
  expectedByMode[mode].filter((expectation) => !state.seen.has(expectation));

/**
 * How long to stay connected after the scenario has passed, in seconds.
 *
 * A scenario ends the moment it has seen what it came for, which is right for a
 * smoke test and wrong for watching anything periodic: a reset gate pulses on
 * its own clock, and a probe that hangs up on the first floor records nothing
 * of it. `--hold 20` keeps the session open so the capture covers several
 * cycles of whatever the floor is doing by itself.
 */
const holdSeconds = (() => {
  const at = process.argv.indexOf("--hold");
  return at === -1 ? 0 : Math.max(0, Number(process.argv[at + 1] ?? 0));
})();

const finish = (ok, message) => {
  if (state.finished) return;
  state.finished = true;
  clearTimeout(deadline);
  process.exitCode = ok ? 0 : 1;
  console[ok ? "log" : "error"](`${ok ? "probe OK" : "probe FAILED"}: ${message}`);

  const hangUp = () => {
    if (socket.destroyed) return;
    if (ok) socket.end();
    else socket.destroy();
  };
  if (ok && holdSeconds > 0) {
    console.log(`holding the session open for ${holdSeconds}s`);
    setTimeout(hangUp, holdSeconds * 1000);
    return;
  }
  hangUp();
};

const fail = (message) => finish(false, message);

const finishWhenSatisfied = () => {
  const missing = missingExpectations();
  if (!missing.length) finish(true, `${mode} (${expectedByMode[mode].join(", ")})`);
};

const loginPacket = () =>
  new PacketWriter(OP.CLIENT_LOGIN_DUNGEONBUSTER)
    .utf(TOKEN)
    .utf("development")
    .u32(DC_HASH)
    .u32(4)
    .u32(ACCOUNT_ID)
    .u32(3) // networkId
    .u32(0) // nodeRules
    .frame();

const requestEntryPacket = (doid) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(FLID.ClientRequestEntry)
    .utf("{}") // demographics
    .u32(0) // sCode
    .u32(MAP_NODE) // mapNodeId
    .u32(0) // friendId
    // A world-map request names only the node. Non-zero mapId means an explicit
    // existing match and cannot be combined with mapNodeId in the real client.
    .u32(0) // mapId
    .raw(Buffer.from([0])) // friendOnly — a single byte
    .utf("") // matchMakerGroup
    .frame();

const requestExitPacket = (doid) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(FLID.RequestExit)
    .u32(0)
    .frame();

/** MatchMaker's only required field is a byte-length-prefixed detail list. */
const decodeMatchMaker = (reader) => {
  const detailBytes = reader.u16();
  reader.pos += detailBytes;
  return `matchmaker details=${detailBytes} bytes`;
};

/**
 * Mirrors DistributedDungeonFloorNetworkComponent.generate() field for field.
 * If our encoder and the client's reader agree, the packet ends exactly here —
 * so a non-zero number of leftover bytes means the layout is wrong.
 */
const decodeFloor = (reader) => {
  const mapNodeId = reader.u32();
  reader.utf(); // coliseumTierConstant
  const tileLibrary = reader.utf();

  const tileBytes = reader.u16();
  const tileEnd = reader.pos + tileBytes;
  // Kept, not counted: with the library above, this is the whole floor, and it
  // is what lets the probe raise the same geometry the server judges its
  // movement against. See buildNavigation.
  const placedTiles = [];
  while (reader.pos < tileEnd) {
    const x = reader.u32();
    const y = reader.u32();
    placedTiles.push({ x, y, tileId: reader.utf() });
  }
  const tiles = placedTiles.length;
  state.floorLibrary = tileLibrary;
  state.floorTiles = placedTiles;
  state.navigation = null;

  reader.u8(); // baseLining
  reader.utf(); // introMovieSwfFilePath
  reader.utf(); // introMovieAssetClassName
  reader.u16(); // currentFloorNum
  const modifierBytes = reader.u16();
  reader.pos += modifierBytes;

  return `floor mapNode=${mapNodeId} tiles=${tiles} library=${tileLibrary}`;
};

/** Mirrors HeroGameObjectOwnerNetworkComponent.generate(). */
const decodeHeroOwner = (reader, owner = true) => {
  const heroType = reader.u32();
  const x = reader.f32();
  const y = reader.f32();
  if (owner) {
    state.heroType = heroType;
    state.heroPosition = { x, y };
  }
  reader.f32(); // heading
  reader.f32(); // scale
  reader.u8(); // flip
  const hitPoints = reader.u16();
  if (owner) {
    state.heroHitPoints = hitPoints;
    state.lowestHeroHitPoints = hitPoints;
  }

  /**
   * The four weapon slots. What the avatar has equipped is what it can attack
   * with, so the scenarios that propose an attack read the slots rather than
   * assume a hero — and the modifiers are half of what a charged skill costs.
   */
  const weapons = [];
  for (let i = 0; i < 4; i++) {
    weapons.push({
      type: reader.u32(),
      power: reader.u16(),
      requiredLevel: reader.u8(),
      rarity: reader.u8(),
      modifier1: reader.u32(),
      modifier2: reader.u32(),
      legendaryModifier: reader.u32(),
    });
  }
  if (owner) state.heroWeapons = weapons;
  /**
   * The two powerup slots. HeroGameObject.set_consumableDetails reads index 0
   * and 1 and hands them to setupConsumables, which is what builds the
   * ConsumableWeaponGameObjects — so an empty pair is a dungeon entered with
   * no potions, however many the player equipped in town.
   */
  const consumables = [];
  for (let i = 0; i < 2; i++) consumables.push({ type: reader.u32(), count: reader.u16() });
  if (owner) state.heroConsumables = consumables;

  reader.u8(); // healthBombsUsed
  reader.u8(); // partyBombsUsed
  const playerId = reader.u32();
  reader.utf(); // state
  reader.u8(); // team
  const skinType = reader.u32();
  const screenName = reader.utf();
  const manaPoints = reader.u16();
  const experiencePoints = reader.u32();
  for (let i = 0; i < 4; i++) reader.u16(); // slotPoints
  const dungeonBusterPoints = reader.u32();
  if (owner) {
    state.manaPoints = manaPoints;
    state.experiencePoints = experiencePoints;
    state.dungeonBusterPoints = dungeonBusterPoints;
  }
  reader.u8(); // setAFK

  return (
    `hero type=${heroType} skin=${skinType} hp=${hitPoints} mana=${manaPoints} xp=${experiencePoints} ` +
    `buster=${dungeonBusterPoints} player=${playerId} name="${screenName}" ` +
    `powerups=[${consumables.map((c) => `${c.type}x${c.count}`).join(" ")}]`
  );
};

/** Mirrors PlayerGameObjectOwnerNetworkComponent.generate(). */
const decodePlayerOwner = (reader, doid) => {
  const screenName = reader.utf();
  const basicCurrency = reader.u32();
  state.playerDoid = doid;
  state.basicCurrency = basicCurrency;
  return `player name="${screenName}" currency=${basicCurrency}`;
};

/** DistributedDooberGameObject: u32 type, f32 x, f32 y, i8 layer. */
const decodeDoober = (reader, doid) => {
  const type = reader.u32();
  const x = reader.f32();
  const y = reader.f32();
  reader.u8();
  const doober = { doid, type, x, y };
  state.doobersByDoid.set(doid, doober);
  state.doober ??= doober;
  if (mode === "drop" && state.sentKill) state.deathDoobers.set(doid, doober);
  if (mode === "buster" && type >= 30010 && type <= 30012 && !state.busterDoober) {
    state.busterDoober = doober;
    state.seen.add("buster-doober");
  }
  if (mode === "buster-use" && type >= 30010 && type <= 30012) {
    state.busterQueue.push(doober);
    // What the floor is laying out is the whole of the meter's supply, so it is
    // also what says whether this hero's meter can be filled here at all.
    state.floorCrowd += Math.max(0, Number(gameMaster.dooberById.get(type)?.Crowd ?? 0));
  }
  /**
   * Food is anything that restores health, asked of the row rather than of a
   * list of ids — and the row also says how deep a wound it takes before the
   * server will let the hero have it, since a pickup is refused while most of
   * what it offers would be wasted.
   *
   * The smallest piece on the floor is the one to aim for: a sausage at a fifth
   * of the bar wants a scratch, a bacon at three fifths wants half the hero
   * gone, and waiting for that on a spike bed kills the probe before it eats.
   */
  if (mode === "food") {
    const restores = Number(gameMaster.dooberById.get(type)?.HP_PERCENTAGE ?? 0);
    if (restores > 0 && (!state.foodDoober || restores < state.foodRestores)) {
      state.foodDoober = doober;
      state.foodRestores = restores;
      state.seen.add("food-doober");
    }
  }
  return `doober type=${type} at ${Math.round(x)},${Math.round(y)}`;
};

const MINOTAUR_TYPE = 328;
const BRUTE_TYPE = 301;
const REWARD_CHEST_TYPE = 490;
const ARROW_TRAP_TYPES = new Set([2000502, 2000506]);
const SPIKE_TRAP_TYPE = 2000606;
const JAIL_TYPE = 2000801;
const TRIGGER_BUTTON_TYPE = 2000301;
const TUTORIAL_FODDER_TYPE = 318;

/** Mirrors DistributedNPCGameObjectNetworkComponent.generate(). */
const decodeNpc = (reader, doid) => {
  const type = reader.u32();
  reader.u8(); // level
  const x = reader.f32();
  const y = reader.f32();
  const heading = reader.f32();
  const scale = reader.f32();
  const flip = reader.u8();
  const hitPoints = reader.u32();

  let firstWeapon = 0;
  for (let i = 0; i < 4; i++) {
    const weapon = reader.u32();
    if (i === 0) firstWeapon = weapon;
    reader.u16(); // power
    reader.u8(); // requiredLevel
    reader.u8(); // rarity
    reader.u32();
    reader.u32();
    reader.u32(); // modifiers
  }

  reader.utf(); // state
  reader.u8(); // team
  reader.u8(); // layer
  const triggerState = reader.u8();
  reader.u32(); // masterId

  /**
   * Every trap on the floor, with somewhere to stand next to it.
   *
   * The tour walks these. Which ones a run covers used to be whatever the hero
   * happened to spawn beside, and a comparison against the official is only as
   * good as what both sides actually exercised — a trap nobody went near reads
   * exactly like a trap we never drive.
   */
  const row = npcsById.get(Number(type));
  if (row && /TRAP|SPIKE|FLAME|EMITTER|GARGOYLE|STATUE|BARREL|LAVA|CAGE|JAIL/.test(row.Constant)) {
    state.floorTraps ??= [];
    state.floorTraps.push({ doid, constant: row.Constant, x, y });
  }

  if (type === JAIL_TYPE && Math.abs(y - 3045) < 2) {
    if (triggerState !== 1) fail(`final cage ${doid} started in state ${triggerState}, expected closed=1`);
    state.finalCageDoids.add(doid);
    if (state.finalCageDoids.size === 2) state.seen.add("cages");
  } else if (type === TRIGGER_BUTTON_TYPE && Math.abs(y - 3150) < 2) {
    if (triggerState !== 0) fail(`final trigger button ${doid} started in state ${triggerState}`);
    state.buttonDoid = doid;
    state.seen.add("button");
  }

  if (type === TUTORIAL_FODDER_TYPE) state.tutorialFodders++;
  if (mode === "boss" && type === MINOTAUR_TYPE && !state.boss) {
    state.boss = { doid, x, y };
    state.seen.add("boss-seen");
  }
  if (mode === "boss" && type === REWARD_CHEST_TYPE) {
    state.rewardChest = { doid, x, y };
    state.seen.add("reward-chest");
  }
  // The brutes fight alongside the minotaur, so they are out before it dies.
  if (mode === "boss" && type === BRUTE_TYPE) state.seen.add("brutes-with-boss");
  /**
   * Something that will come for the hero, on whatever floor this is.
   *
   * This asked for KNIGHT_TUTORIAL by id, which made three scenarios a test of
   * the tutorial rather than of the server: the same chase and the same drops
   * happen in the ice caves, and none of it could be checked there. The rule the
   * server itself uses is the one to ask by — CharType ENEMY with IsMover set is
   * exactly what spawnNpc gives an AI to.
   */
  const chases = () => {
    const row = npcsById.get(Number(type));
    return row?.CharType === "ENEMY" && Boolean(row.IsMover);
  };
  if (
    (mode === "ai" || mode === "drop" || mode === "poison-pot") &&
    state.aiKnight === null &&
    chases()
  ) {
    const row = npcsById.get(Number(type));
    state.aiKnight = {
      doid,
      x,
      y,
      hitPoints,
      constant: row?.Constant,
      // Its own Attack1 is what spawnNpc hands the AI, so it is what the
      // choreography must name — a knight swings a sword, a shaman does not.
      attackId: row?.Attack1 ? gameMaster.attacksByConstant.get(row.Attack1)?.Id : undefined,
    };
    state.knightHitPoints = hitPoints;
    state.seen.add(
      mode === "drop" ? "drop-target" : mode === "poison-pot" ? "placeable-target" : "ai-knight"
    );
  }
  // The cloud arrives as an ordinary NPC generate, so it is recognised by the
  // type its own timeline named rather than by anything the probe asked for.
  if (mode === "poison-pot" && state.placeable && type === state.placeable.npc.Id) {
    state.placeableDoid = doid;
    state.seen.add("placeable-spawned");
    console.log(`<- ${state.placeable.npc.Constant} placed at ${Math.round(x)},${Math.round(y)}`);
  }

  if (type === SPIKE_TRAP_TYPE) {
    /**
     * A spike bed starts the floor either way, and mostly starts up: the
     * official generates them raised 1598 times against 738 retracted, because
     * a timer rests on and a floor is built in the first moments of its own
     * clock. Requiring a retracted one asserted the opposite of the game.
     */
    state.spikeDoid = doid;
    state.spikePosition = { x, y };
    state.spikeStartedUp = triggerState === 1;
    state.seen.add("spikes");
    if (state.spikeStartedUp) state.seen.add("spikes-on");
  }

  /**
   * The tutorial's own arrow traps, and only those.
   *
   * These headings are the tutorial floor's; the same trap is mounted facing
   * every direction elsewhere, so asserting them anywhere else fails on a
   * correctly placed trap. The tour visits other floors.
   */
  if (ARROW_TRAP_TYPES.has(type) && mode !== "tour") {
    const expectedHeading = type === 2000502 ? 90 : 270;
    if (heading !== expectedHeading || firstWeapon !== 27045) {
      fail(
        `arrow trap ${doid} transform/weapon mismatch: ` +
          `heading=${heading}, weapon=${firstWeapon}`
      );
    }
    state.arrowDoids.add(doid);
    if (mode === "arrow-flight" && type === 2000506) {
      state.arrowFlightTrap = { doid, x, y, heading };
    }
    state.seen.add("arrow");
    return (
      `arrow trap type=${type} at ${Math.round(x)},${Math.round(y)} ` +
      `heading=${heading} scale=${scale.toFixed(2)} flip=${flip} weapon=${firstWeapon}`
    );
  }

  return `npc type=${type}`;
};

const decodeRemotePlayer = (reader) => `remote player name="${reader.utf()}"`;

const decodeGenerateFields = (clid, doid, reader, owner = false) => {
  let summary;
  if (clid === CLID.MatchMaker) summary = decodeMatchMaker(reader);
  else if (clid === CLID.DistributedDungeonFloor) summary = decodeFloor(reader);
  else if (clid === CLID.PlayerGameObject) {
    summary = owner ? decodePlayerOwner(reader, doid) : decodeRemotePlayer(reader);
  }
  else if (clid === CLID.HeroGameObject) summary = decodeHeroOwner(reader, owner);
  else if (clid === CLID.DistributedDooberGameObject) summary = decodeDoober(reader, doid);
  else if (clid === CLID.DistributedNPCGameObject) summary = decodeNpc(reader, doid);
  else return "";

  const leftover = reader.remaining;
  const verdict = leftover === 0 ? "OK" : `MISALIGNED (${leftover} bytes left)`;
  if (leftover !== 0) fail(`clid ${clid} field layout left ${leftover} unread bytes`);
  return `\n     ${summary}\n     field layout: ${verdict}`;
};

/** send_position on HeroGameObjectOwner: field 147, two floats. */
const positionPacket = (doid, x, y) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD).u32(doid).u16(147).f32(x).f32(y).frame();

/**
 * The floor's geometry, raised from what the generate told us.
 *
 * The server refuses a claimed step that ends inside a wall or crosses one, and
 * it is right to — a client that can walk through geometry can stand anywhere.
 * The probe was walking straight lines, so it kept being refused and its hero
 * never arrived, which is what left the cage, spikes and revive scenarios
 * timing out with nothing to show.
 *
 * Built lazily on the first walk of a floor, and thrown away with the floor.
 */
const buildNavigation = async () => {
  if (state.navigation) return state.navigation;
  if (!state.floorLibrary || !state.floorTiles?.length) return null;
  try {
    const { readPlacements } = await import("../src/socket/floors.js");
    const { createNavigationState } = await import("../src/socket/navigation.js");
    const floor = await readPlacements(state.floorLibrary, state.floorTiles);
    state.navigation = createNavigationState(floor.navigation);
  } catch (problem) {
    console.log(`-> could not raise the floor's geometry: ${problem.message}`);
    state.navigation = null;
  }
  return state.navigation;
};

/**
 * Walks there around the walls, in steps the movement budget allows.
 *
 * The route is asked of the same pathfinder the server's own NPCs use, so the
 * hero goes where a hero could go. Without a route — no geometry yet, or
 * nowhere to stand — it falls back to the straight line, which is what this
 * always did.
 */
/**
 * Whether to walk at all.
 *
 * Walking is the faithful thing and it is what the trap work needs, because a
 * hero that appears on a trap never crosses the ground in front of it. But the
 * scenarios were written when a hero could be put where it was wanted, and a
 * walk takes long enough to change what else happens on the way — knights
 * engage, timers turn over. So the old behaviour stays available for the runs
 * that only care about the packet at the end, paired with
 * `DR_MOVEMENT_MODE=audit` on the server, which reports the claim and accepts
 * it. Both halves are needed: the flag alone leaves the walking, and the walking
 * alone is refused.
 */
const TELEPORT = process.env.DR_PROBE_TELEPORT === "1";

const walkHeroTo = (target, options, onArrive) => {
  if (TELEPORT) {
    state.heroPosition = { x: target.x, y: target.y };
    socket.write(positionPacket(state.heroDoid, target.x, target.y));
    onArrive?.();
    return;
  }
  // A second walk started while the first is still claiming steps leaves two
  // of them advancing from the same stale position, and one of the two claims
  // a jump. The newest walk wins and the older one stops where it is.
  const token = (state.walkToken = (state.walkToken ?? 0) + 1);
  buildNavigation().then(async (navigation) => {
    if (state.walkToken !== token) return;
    let waypoints = [target];
    if (navigation && state.heroPosition) {
      try {
        const { findPath } = await import("../src/socket/navigation.js");
        const route = findPath(navigation, state.heroPosition, target, 35);
        if (route?.length) waypoints = route;
      } catch {
        // Straight line it is.
      }
    }
    walkHeroLine(waypoints, options, onArrive, token, target);
  });
};

/**
 * Whether the server would refuse to stand a hero here.
 *
 * Asked with the same collision point and radius the server uses, because a
 * claim it refuses is worse than a step not taken: the refusal leaves the two
 * sides disagreeing about where the hero is.
 */
const stepIsWalkable = (from, to) => {
  if (!state.navigation) return true;
  try {
    if (isPositionBlockedFor(state.navigation, to, 35)) return false;
    // The server also refuses a step whose *path* crosses geometry, even when
    // both ends are clear, so the sweep is checked too.
    return !from || hasLineOfSightFor(state.navigation, from, to, 35);
  } catch {
    return true;
  }
};

let isPositionBlockedFor = () => false;
let hasLineOfSightFor = () => true;
import("../src/socket/navigation.js")
  .then((navigation) => {
    isPositionBlockedFor = navigation.isPositionBlocked;
    hasLineOfSightFor = navigation.hasLineOfSight;
  })
  .catch(() => {});

/** Claims one leg after another, which is what a walk looks like on the wire. */
const walkHeroLine = (waypoints, options, onArrive, token, goal) => {
  if (token !== undefined && state.walkToken !== token) return;
  const [next, ...rest] = waypoints;
  if (!next) return onArrive?.();
  walkHeroStraight(
    next,
    options,
    () => walkHeroLine(rest, options, onArrive, token, goal),
    token,
    /**
     * Blocked mid-leg. The route was good when it was asked for, but a leg of
     * it can still run through a wall — the path is a line between open
     * points, not a promise about what lies between them. Asking again from
     * where the hero actually is turns that into a detour instead of a stop,
     * which is the difference between arriving late and never arriving.
     */
    async () => {
      if (!goal || !state.navigation || !state.heroPosition) return onArrive?.();
      try {
        const { findPath } = await import("../src/socket/navigation.js");
        const detour = findPath(state.navigation, state.heroPosition, goal, 35);
        if (detour?.length) return walkHeroLine(detour, options, onArrive, token, goal);
      } catch {
        // Nothing left to try.
      }
      onArrive?.();
    }
  );
};

const walkHeroStraight = (
  target,
  { step = 400, intervalMs = 500 } = {},
  onArrive,
  token,
  onBlocked
) => {
  let position = { ...(state.heroPosition ?? target) };
  const advance = () => {
    if (token !== undefined && state.walkToken !== token) return;
    /**
     * A refused claim does not move the hero, and the probe used to advance
     * anyway. The server holds its last accepted position, the probe walks on
     * from an imagined one, and the gap between them grows until a claim
     * crosses the step ceiling and the session is terminated for it — three
     * deterministic violations and the connection closes. Which is what was
     * killing the cage run halfway through.
     *
     * So a step is only claimed if it is somewhere a hero could stand, and the
     * probe's idea of where it is only advances with the claim.
     */
    const dx = target.x - position.x;
    const dy = target.y - position.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= step) position = { ...target };
    else {
      position = {
        x: position.x + (dx / distance) * step,
        y: position.y + (dy / distance) * step,
      };
    }
    if (state.navigation && !stepIsWalkable(state.heroPosition, position)) {
      // Refused if claimed, so ask for another way round instead.
      return (onBlocked ?? onArrive)?.();
    }
    state.heroPosition = position;
    socket.write(positionPacket(state.heroDoid, position.x, position.y));
    if (position.x !== target.x || position.y !== target.y) setTimeout(advance, intervalMs);
    else onArrive?.();
  };
  advance();
};

const walkHeroPath = (waypoints, options) => {
  const [next, ...rest] = waypoints;
  if (!next) return;
  walkHeroTo(next, options, () => walkHeroPath(rest, options));
};

const attackProposalPacket = (doid, attackType, weaponSlot = 0) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(172)
    .u8(weaponSlot)
    .u8(0)
    .u32(attackType)
    .u32(0)
    .u8(0)
    .f32(1)
    .f32(1)
    .u16(0)
    .frame();

const selfDamagePacket = (doid, hitCount) => {
  const results = new PacketWriter();
  for (let i = 0; i < hitCount; i++) {
    results
      .u32(doid) // attacker
      .u32(doid) // attackee
      .i32(0) // server computes damage
      .u8(0) // weapon slot
      .u8(0) // consumable
      .u32(920050) // sword slash
      .u32(doid) // target
      .u8(0) // when
      .u8(0) // suffer
      .u8(0) // knockback
      .u8(0) // blocked
      .u8(0) // critical
      .u8(0) // effectiveness
      .i32(0) // self damage
      .f32(1) // scaling
      .u8(0); // generation
  }
  const bytes = results.body();
  return new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(171) // ProposeCombatResults
    .u16(bytes.length)
    .raw(bytes)
    .frame();
};

/**
 * Enough valid self-hits to down the probe hero whatever level it is. Damage
 * scales with the attacker, so this was forty when the avatar was level one and
 * one would do at a hundred; forty still works at both ends.
 *
 * Sent as forty packets rather than one packet of forty, which is the only
 * shape the client ever uses and the only one the server accepts.
 */
const downHero = (socket, doid, hits = 40) => {
  for (let hit = 0; hit < hits; hit += 1) socket.write(selfDamagePacket(doid, 1));
};

/** Sends enough valid starter-weapon hits to kill one selected dungeon NPC. */
/**
 * One swing, as the real client sends it.
 *
 * This used to pack forty results into one packet to fell something in a single
 * write, and the server is right to refuse that: across every capture the client
 * sends `ProposeCombatResults` **5398 times and always with exactly one
 * result**. Batching was a probe convenience that no client does, and the
 * malformed-proposal rule caught it — so the probe swings repeatedly instead.
 */
const killNpcPacket = (heroDoid, npcDoid, attackType = 920050, weaponSlot = 0) => {
  const results = new PacketWriter();
  {
    results
      .u32(heroDoid)
      .u32(npcDoid)
      .i32(0)
      .u8(weaponSlot)
      .u8(0)
      .u32(attackType)
      .u32(npcDoid)
      .u8(0)
      .u8(0)
      .u8(0)
      .u8(0)
      .u8(0)
      .u8(0)
      .i32(0)
      .f32(1)
      .u8(0);
  }
  const bytes = results.body();
  return new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(heroDoid)
    .u16(171)
    .u16(bytes.length)
    .raw(bytes)
    .frame();
};

/**
 * Walks the floor and stands next to the traps on it.
 *
 * Coverage is the whole point: `wire-diff` can only speak about traps both
 * sides exercised, so a run whose hero stood where it spawned said more about
 * where the probe went than about what this server does.
 *
 * Bounded by kind and by count, because a floor can hold a hundred spike beds
 * and what is wanted is the kinds on it. Each stop has a watchdog, because
 * somewhere on every floor there is a trap with nowhere to stand beside it, and
 * a walk that cannot finish must not stall the run.
 */
const beginTour = () => {
  const perKind = Number(process.env.DR_TOUR_PER_KIND ?? 2);
  const counted = new Map();
  const stops = (state.floorTraps ?? []).filter((trap) => {
    const seen = counted.get(trap.constant) ?? 0;
    counted.set(trap.constant, seen + 1);
    return seen < perKind;
  });
  stops.length = Math.min(stops.length, Number(process.env.DR_TOUR_STOPS ?? 14));
  const seconds = Number(process.env.DR_TOUR_DWELL ?? 3);
  console.log(
    `-> touring ${stops.length} of ${state.floorTraps?.length ?? 0} trap(s), ${seconds}s at each`
  );

  const visit = () => {
    const from = state.heroPosition ?? { x: 0, y: 0 };
    stops.sort(
      (a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y)
    );
    const next = stops.shift();
    if (!next) {
      // Only now: the marker is what ends the run, and ending it on the first
      // stop is a tour of one.
      state.seen.add("toured");
      console.log("-> tour complete");
      return;
    }

    let moved = false;
    const onwards = () => {
      if (moved) return;
      moved = true;
      console.log(`-> toured ${next.constant}, ${stops.length} left`);
      setTimeout(visit, seconds * 1000).unref?.();
    };
    setTimeout(onwards, 12000).unref?.();
    walkHeroTo({ x: next.x, y: next.y }, undefined, onwards);
  };
  visit();
};

/**
 * Swings until it falls: a cast, then the hit it answers for, and again.
 *
 * Both halves matter. The server records an accepted choreography and only
 * honours results naming the same attack and slot inside its window, so a hit
 * with nothing behind it is a violation — and it refuses to record a cast for
 * an attack no equipped weapon grants, which is what proposing a knight's
 * `EN_SWORD_SLASH` was. Forty of those in a row is a pattern the sanctions
 * terminate the connection over, which is how the cage scenario was dying
 * halfway through.
 *
 * One result per packet, because that is what the client does: 5398 recorded
 * `ProposeCombatResults` and every one of them a single result.
 */
const killNpc = (socket, heroDoid, npcDoid, swings = 40) => {
  const swing = findBasicAttack(state.heroWeapons ?? []);
  if (!swing) {
    console.log("-> no equipped weapon grants an attack; cannot swing");
    return;
  }
  for (let i = 0; i < swings; i += 1) {
    socket.write(attackProposalPacket(heroDoid, swing.attack.Id, swing.slot));
    socket.write(killNpcPacket(heroDoid, npcDoid, swing.attack.Id, swing.slot));
  }
};

const selfRevivePacket = (doid) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(174) // ProposeSelfRevive
    .u8(0) // health bomb, not party bomb
    .frame();

const describeIncoming = (body) => {
  const reader = new PacketReader(body);
  const opcode = reader.u16();

  if (opcode === OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP) {
    const parent = reader.u32();
    const zone = reader.u32();
    const clid = reader.u16();
    const doid = reader.u32();
    if (clid === CLID.MatchMaker) {
      state.matchMakerDoid ??= doid;
      state.seen.add("matchmaker");
    } else if (clid === CLID.DistributedDungionArea) {
      state.areaDoid = doid;
      state.seen.add("area");
    } else if (clid === CLID.DistributedDungeonFloor) {
      if (state.floorDoid && doid !== state.floorDoid) state.seen.add("second-floor");
      state.floorDoid = doid;
      state.seen.add("floor");
    } else if (clid === CLID.DistributedDooberGameObject) {
      state.seen.add("doober");
    }
    return (
      `generate clid=${clid} doid=${doid} parent=${parent} zone=${zone}` +
      decodeGenerateFields(clid, doid, reader, false)
    );
  }

  if (opcode === OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP) {
    const clid = reader.u16();
    const doid = reader.u32();
    const parent = reader.u32();
    const zone = reader.u32();
    if (clid === CLID.HeroGameObject) {
      // The hero keeps its doid across a floor change; only its parent moves.
      if (state.heroFloorParent && parent !== state.heroFloorParent) {
        state.seen.add("second-hero");
      }
      state.heroFloorParent = parent;
      state.heroDoid = doid;
      state.seen.add("hero");
    } else if (clid === CLID.PlayerGameObject) {
      state.seen.add("player");
    }
    return (
      `generate(owner) clid=${clid} doid=${doid} parent=${parent} zone=${zone}` +
      decodeGenerateFields(clid, doid, reader, true)
    );
  }

  if (
    opcode === OP.CLIENT_OBJECT_DISABLE_RESP ||
    opcode === OP.CLIENT_OBJECT_DISABLE_OWNER_RESP
  ) {
    const doid = reader.u32();
    // A cloud that never goes away is a cloud that poisons the whole floor.
    if (mode === "poison-pot" && doid === state.placeableDoid) {
      state.seen.add("placeable-gone");
    }
    if (mode === "exit") {
      if (doid === state.heroDoid && opcode === OP.CLIENT_OBJECT_DISABLE_OWNER_RESP) {
        state.seen.add("hero-disabled");
      }
      if (doid === state.floorDoid && opcode === OP.CLIENT_OBJECT_DISABLE_RESP) {
        state.seen.add("floor-disabled");
      }
      if (doid === state.areaDoid && opcode === OP.CLIENT_OBJECT_DISABLE_RESP) {
        state.seen.add("area-disabled");
      }
      if (doid === state.playerDoid && opcode === OP.CLIENT_OBJECT_DISABLE_OWNER_RESP) {
        state.seen.add("player-disabled");
      }
    }
    return `${opcodeName(opcode)} doid=${doid}`;
  }

  if (opcode === OP.CLIENT_OBJECT_UPDATE_FIELD) {
    const doid = reader.u32();
    const fieldId = reader.u16();
    if (fieldId === 216) {
      const transition = reader.u16();
      const victory = reader.u8();
      state.seen.add("dungeon-ending");
      return `dungeonEnding doid=${doid} transition=${transition} victory=${victory}`;
    }

    // DistributedDungionArea::floorEnding — one floor down, another coming.
    if (fieldId === 215) {
      const transition = reader.u16();
      state.seen.add("floor-ending");
      return `floorEnding doid=${doid} transition=${transition}`;
    }

    if (fieldId === FLID.ClientRequestEntryResponce) {
      const errorCode = reader.u16();
      const value = reader.u32();
      return `entry response doid=${doid} error=${errorCode} value=${value}`;
    }
    if (fieldId === FLID.ClientExitComplete) {
      const value = reader.u16();
      if (mode === "exit" && value !== 1) fail(`exit completion value was ${value}`);
      if (mode === "exit") {
        for (const expectation of [
          "hero-disabled",
          "floor-disabled",
          "area-disabled",
          "player-disabled",
        ]) {
          if (!state.seen.has(expectation)) {
            fail(`ClientExitComplete arrived before ${expectation}`);
          }
        }
        state.seen.add("exit-complete");
      }
      return `exit complete doid=${doid} value=${value}`;
    }
    if (mode === "pickup" && doid === state.playerDoid && fieldId === 181) {
      const basicCurrency = reader.u32();
      if (basicCurrency <= state.basicCurrency) {
        fail(`pickup currency did not increase: ${state.basicCurrency} -> ${basicCurrency}`);
      }
      state.basicCurrency = basicCurrency;
      state.seen.add("currency");
      return `basic currency=${basicCurrency}`;
    }
    if (mode === "drop" && doid === state.heroDoid && fieldId === 164) {
      const experiencePoints = reader.u32();
      if (experiencePoints <= state.experiencePoints) {
        fail(`XP did not increase: ${state.experiencePoints} -> ${experiencePoints}`);
      }
      state.experiencePoints = experiencePoints;
      state.seen.add("xp");
      return `hero xp=${experiencePoints}`;
    }
    if (mode === "buster" && doid === state.heroDoid && fieldId === 166) {
      const dungeonBusterPoints = reader.u32();
      if (dungeonBusterPoints <= state.dungeonBusterPoints) {
        fail(
          `Dungeon Buster points did not increase: ` +
            `${state.dungeonBusterPoints} -> ${dungeonBusterPoints}`
        );
      }
      state.dungeonBusterPoints = dungeonBusterPoints;
      state.seen.add("buster-points");
      return `dungeon buster points=${dungeonBusterPoints}`;
    }
    if (mode === "buster-use" && doid === state.heroDoid && fieldId === 166) {
      const dungeonBusterPoints = reader.u32();
      state.dungeonBusterPoints = dungeonBusterPoints;
      const buster = dungeonBuster();
      if (!buster) {
        fail(`hero type ${state.heroType} names no Dungeon Buster attack`);
      } else if (dungeonBusterPoints >= buster.cost && !state.sentBusterAttack) {
        state.sentBusterAttack = true;
        state.busterPointsBeforeUse = dungeonBusterPoints;
        state.seen.add("buster-ready");
        console.log(
          `-> using ${buster.attack.Constant} (${buster.cost} Crowd) ` +
            `with ${dungeonBusterPoints} points`
        );
        socket.write(attackProposalPacket(state.heroDoid, buster.attack.Id));
      } else if (
        state.sentBusterAttack &&
        dungeonBusterPoints === state.busterPointsBeforeUse - buster.cost
      ) {
        state.seen.add("buster-consumed");
      }
      return `dungeon buster points=${dungeonBusterPoints}`;
    }
    if (mode === "mana-charge" && doid === state.heroDoid && fieldId === 163 && state.manaAttack) {
      const manaPoints = reader.u16();
      const expected = state.manaPoints - state.manaAttack.cost;
      if (manaPoints !== expected) {
        fail(`charged-skill Mana mismatch: expected ${expected}, got ${manaPoints}`);
      }
      state.manaPoints = manaPoints;
      state.seen.add("mana-spent");
      return `charged skill mana=${manaPoints}`;
    }
    if (mode === "drop" && fieldId === 290 && state.deathDoobers.has(doid)) {
      const originX = reader.f32();
      const originY = reader.f32();
      const doober = state.deathDoobers.get(doid);
      state.seen.add("drop-spawn");
      if (doober.type >= 30004 && doober.type <= 30006 && !state.experienceDrop) {
        state.experienceDrop = doober;
        console.log(`-> walking hero ${state.heroDoid} onto XP drop ${doid}`);
        walkHeroTo({ x: doober.x, y: doober.y });
      }
      return `doober ${doid} spawned from ${originX.toFixed(1)},${originY.toFixed(1)}`;
    }
    if (mode === "poison-pot" && doid === state.placeableDoid && fieldId === 143) {
      reader.u8(); // weaponSlot
      reader.u8(); // isConsumableWeapon
      const attackType = reader.u32();
      /**
       * Either of the two the row may carry: Attack1 while it stands, or
       * DeathAttack as it goes. A fissure has only the second, which is why
       * asking for Attack1 alone rejected a correct swing.
       */
      const expected = [state.placeable.npc.Attack1, state.placeable.npc.DeathAttack].filter(
        Boolean
      );
      const attack = gameMaster.attacksById.get(attackType);
      if (!expected.includes(attack?.Constant)) {
        fail(
          `cloud attacked with ${attack?.Constant ?? attackType}, ` +
            `expected one of ${expected.join(", ") || "(none authored)"}`
        );
      }
      state.seen.add("placeable-attack");
      return `cloud attack ${attack?.Constant ?? attackType}`;
    }
    if (
      mode === "poison-pot" &&
      doid === state.aiKnight?.doid &&
      fieldId === 136 &&
      state.seen.has("placeable-spawned")
    ) {
      const hitPoints = reader.u32();
      if (hitPoints >= state.knightHitPoints) {
        fail(`cloud did not reduce knight HP: ${state.knightHitPoints} -> ${hitPoints}`);
      }
      state.knightHitPoints = hitPoints;
      state.seen.add("placeable-damage");
      return `knight hp=${hitPoints}`;
    }
    if (fieldId === 143 && state.arrowDoids.has(doid)) {
      reader.u8(); // weaponSlot
      reader.u8(); // isConsumableWeapon
      const attackType = reader.u32();
      reader.u32(); // targetActorDoid
      reader.u8(); // loop
      reader.f32(); // playSpeed
      const projectileMultiplier = reader.f32();
      const combatResultBytes = reader.u16();
      reader.pos += combatResultBytes;
      if (attackType !== 922000 || projectileMultiplier !== 1 || reader.remaining !== 0) {
        fail(
          `arrow choreography mismatch: attack=${attackType}, ` +
            `projectiles=${projectileMultiplier}, remaining=${reader.remaining}`
        );
      }
      if (mode === "trap" || doid === state.arrowFlightTrap?.doid) {
        state.seen.add("trap-attack");
      }
      if (mode === "arrow-flight" && doid === state.arrowFlightTrap?.doid) {
        state.arrowFiredAt = Date.now();
      }
      return `arrow attack doid=${doid} attack=${attackType} projectiles=${projectileMultiplier}`;
    }
    if (mode === "arrow-flight" && doid === state.heroDoid && fieldId === 160) {
      const attacker = reader.u32();
      const attackee = reader.u32();
      const damage = readI32(reader);
      reader.u8(); // weaponSlot
      reader.u8(); // isConsumableWeapon
      const attackType = reader.u32();
      reader.u32(); // targetActorDoid
      reader.u8(); // when
      const suffer = reader.u8();
      const knockback = reader.u8();
      reader.u8(); // blocked
      reader.u8(); // criticalHit
      reader.u8(); // effectiveness
      readI32(reader); // selfDamage
      reader.f32(); // scalingMaxPowerMultiplier
      reader.u8(); // generation
      if (attacker !== state.arrowFlightTrap?.doid || attackType !== 922000) {
        return `unrelated hero reaction attacker=${attacker} attack=${attackType}`;
      }
      const delay = Date.now() - state.arrowFiredAt;
      if (
        attackee !== state.heroDoid ||
        damage >= 0 ||
        suffer !== 1 ||
        knockback !== 1 ||
        delay < 250 ||
        delay > 900 ||
        reader.remaining !== 0
      ) {
        fail(
          `arrow flight mismatch: delay=${delay}ms attackee=${attackee} ` +
            `damage=${damage} suffer=${suffer} knockback=${knockback}`
        );
      }
      state.seen.add("arrow-hit");
      return `arrow contact after ${delay}ms damage=${damage}`;
    }
    if (mode === "arrow-flight" && doid === state.heroDoid && fieldId === 151) {
      const hitPoints = reader.u16();
      if (state.seen.has("arrow-hit")) {
        if (hitPoints >= state.heroHitPoints) {
          fail(`arrow contact did not reduce hero HP: ${state.heroHitPoints} -> ${hitPoints}`);
        }
        state.seen.add("arrow-damage");
      }
      return `arrow damage hp ${state.heroHitPoints} -> ${hitPoints}`;
    }
    /**
     * A spike bed never animates.
     *
     * NPCView keeps a separate "off" and "on" body renderer and swaps them on
     * the trigger state, so the spikes rising *is* the state change — and the
     * captures bear it out flatly: 1313 state updates on
     * CASTLE_ARENA_TRAP_SPIKES and not one choreography. This used to require
     * the choreography, which is why the server was sending one.
     */
    if (mode === "spikes" && doid === state.spikeDoid && fieldId === 143) {
      fail("a spike bed choreographed an attack; its trigger state is its animation");
    }
    if (mode === "spikes" && doid === state.spikeDoid && fieldId === 141) {
      const triggerState = reader.u8();
      if (triggerState === 1) state.seen.add("spikes-on");
      if (triggerState === 0) state.seen.add("spikes-off");
      return `spike state doid=${doid} state=${triggerState}`;
    }
    if (mode === "spikes" && doid === state.heroDoid && fieldId === 160) {
      const attacker = reader.u32();
      const attackee = reader.u32();
      const damage = readI32(reader);
      reader.u8(); // weaponSlot
      reader.u8(); // isConsumableWeapon
      const attackType = reader.u32();
      reader.u32(); // targetActorDoid
      reader.u8(); // when
      const suffer = reader.u8();
      const knockback = reader.u8();
      reader.u8(); // blocked
      reader.u8(); // criticalHit
      reader.u8(); // effectiveness
      readI32(reader); // selfDamage
      reader.f32(); // scalingMaxPowerMultiplier
      reader.u8(); // generation
      /**
       * Somebody else's hit is not this scenario's business.
       *
       * The hero walks to the spikes now rather than appearing on them, which
       * takes long enough that the knights engage it on the way — and their
       * results arrive first. Failing on the first result that is not the
       * spike's turned "a knight hit me" into "the spike is broken".
       */
      if (attacker !== state.spikeDoid || attackType !== 922010) return "";

      if (
        attackee !== state.heroDoid ||
        damage >= 0 ||
        suffer !== 1 ||
        knockback !== 1 ||
        reader.remaining !== 0
      ) {
        fail(
          `spike reaction mismatch: attacker=${attacker} attackee=${attackee} ` +
            `attack=${attackType} damage=${damage} suffer=${suffer} knockback=${knockback}`
        );
      }
      state.seen.add("spikes-hit");
      return `spike reaction damage=${damage} suffer=${suffer} knockback=${knockback}`;
    }
    if (mode === "spikes" && doid === state.heroDoid && fieldId === 151) {
      const hitPoints = reader.u16();
      if (state.seen.has("spikes-hit")) {
        if (hitPoints >= state.heroHitPoints) {
          fail(`spike trap did not reduce hero HP: ${state.heroHitPoints} -> ${hitPoints}`);
        }
        state.seen.add("spikes-damage");
      }
      return `spike damage hp ${state.heroHitPoints} -> ${hitPoints}`;
    }
    if (mode === "cage" && fieldId === 141) {
      const triggerState = reader.u8();
      if (state.finalCageDoids.has(doid) && triggerState === 0) {
        state.openCageDoids.add(doid);
        if (state.openCageDoids.size === 2) state.seen.add("cages-open");
      }
      if (doid === state.buttonDoid && triggerState === 1) state.seen.add("button-pressed");
      return `trigger state doid=${doid} state=${triggerState}`;
    }
    if (mode === "ai" && doid === state.aiKnight?.doid && fieldId === 132) {
      const x = reader.f32();
      const y = reader.f32();
      const before = Math.hypot(
        state.aiTarget.x - state.aiKnight.x,
        state.aiTarget.y - state.aiKnight.y
      );
      const after = Math.hypot(state.aiTarget.x - x, state.aiTarget.y - y);
      /**
       * Closing in is the claim, and one step of it is not. A pursuer routing
       * around geometry legitimately moves away first, so this asked for
       * something the server never promised — what it promises is that the gap
       * shrinks, which the timeout still catches if it never does.
       */
      state.closestApproach = Math.min(state.closestApproach ?? before, after);
      if (state.closestApproach < before) state.seen.add("ai-move");
      return `AI move doid=${doid} at ${x.toFixed(1)},${y.toFixed(1)}`;
    }
    /**
     * Any of them, not the one that was picked.
     *
     * The scenario chose a knight and waited for that knight to swing. Which
     * one engages is the floor's business — its neighbours are just as close to
     * a hero standing between them, and the log shows three others hitting
     * while the chosen one never moved. What is being tested is that an NPC
     * attacks at all and that its choreography carries a damaging result for
     * the hero, so that is what this now watches for.
     */
    if (mode === "ai" && doid !== state.heroDoid && fieldId === 143 && state.aiKnight) {
      reader.u8(); // weaponSlot
      reader.u8(); // isConsumableWeapon
      const attackType = reader.u32();
      const targetDoid = reader.u32();
      reader.u8(); // loop
      reader.f32(); // playSpeed
      reader.f32(); // projectileMultiplier
      const resultBytes = reader.u16();
      // Somebody else's business, or a swing at nobody.
      if (targetDoid !== state.heroDoid) return "";

      /**
       * The swing is announced on its own and the damage follows separately.
       *
       * This used to read the hit out of the choreography's own result bytes,
       * and there are none: `ReceiveAttackChoreography` restarts the animation
       * from frame zero, so a result riding along on a second one would cut the
       * swing in half. The server says so where it sends them, and it sends the
       * result by itself when the swing connects — which is also what a trap
       * does. So the announcement is what proves the AI attacked, and the
       * damage is checked where it actually arrives.
       */
      if (resultBytes !== 0) {
        fail(`AI choreography carried ${resultBytes} result bytes; it should carry none`);
      }
      state.seen.add("ai-attack");
      return `AI attack doid=${doid} target=${targetDoid} attack=${attackType}`;
    }
    if (mode === "ai" && doid === state.heroDoid && fieldId === 151) {
      const hitPoints = reader.u16();
      if (hitPoints >= state.heroHitPoints) fail(`AI did not reduce hero HP: ${hitPoints}`);
      state.seen.add("ai-damage");
      return `hero hp ${state.heroHitPoints} -> ${hitPoints}`;
    }
    if (mode === "food" && doid === state.heroDoid && fieldId === 151) {
      const hitPoints = reader.u16();
      if (hitPoints < state.lowestHeroHitPoints) {
        state.lowestHeroHitPoints = hitPoints;
        state.seen.add("food-damaged");
        /**
         * A deepening wound is progress, so the clock restarts on it.
         *
         * How long this scenario needs depends on what the floor laid out: a
         * sausage wants a sixth of the bar gone and a bacon nearly half, and a
         * spike takes an eighth of it a second. Timing out mid-wound failed the
         * server for the floor's choice of groceries.
         */
        clearTimeout(deadline);
        deadline = setTimeout(onDeadline, timeoutMs);
      } else if (state.walked && hitPoints > state.lowestHeroHitPoints) {
        state.seen.add("food-healed");
      }
      return `food check hero hp=${hitPoints}`;
    }
    if (mode === "revive" && doid === state.heroDoid && fieldId === 151) {
      const hitPoints = reader.u16();
      if (hitPoints === 0) state.seen.add("revive-zero");
      // A health bomb gives back a share, not the bar: HEALTH_BOMB_REVIVE_SHARE
      // is 0.4, so an 880 hero stands up on 352. This expected the whole bar.
      const revivedTo = Math.round(state.heroHitPoints * 0.4);
      if (state.seen.has("revive-response") && hitPoints === revivedTo) {
        state.seen.add("revive-hp");
      }
      return `revive hero hp=${hitPoints}`;
    }
    if (mode === "revive" && doid === state.heroDoid && fieldId === 157) {
      const heroState = reader.utf();
      if (heroState === "down" && state.seen.has("revive-zero")) state.seen.add("revive-down");
      if (heroState === "" && state.seen.has("revive-response")) state.seen.add("revive-state");
      return `revive hero state="${heroState}"`;
    }
    if (mode === "revive" && doid === state.heroDoid && fieldId === 175) {
      const success = reader.u8();
      const reviveAll = reader.u8();
      if (success !== 1 || reviveAll !== 0) {
        fail(`self-revive response mismatch: success=${success} reviveAll=${reviveAll}`);
      }
      state.seen.add("revive-response");
      return `self-revive response success=${success} reviveAll=${reviveAll}`;
    }
    if (mode === "revive" && doid === state.heroDoid && fieldId === 154) {
      const uses = reader.u8();
      if (uses !== 1) fail(`health bomb usage mismatch: ${uses}`);
      state.seen.add("bomb-used");
      return `health bombs used=${uses}`;
    }
    if (mode === "revive" && fieldId === 216) {
      fail("dungeon defeat arrived before the self-revive choice");
    }
    if (fieldId === 291 && doid === state.doober?.doid) state.seen.add("pickup");
    if (mode === "drop" && fieldId === 291 && doid === state.experienceDrop?.doid) {
      state.seen.add("drop-collected");
    }
    if (mode === "buster" && fieldId === 291 && doid === state.busterDoober?.doid) {
      state.seen.add("buster-collected");
    }
    if (
      mode === "buster-use" &&
      fieldId === 291 &&
      doid === state.currentBusterDoober?.doid
    ) {
      state.currentBusterDoober = null;
    }
    if (mode === "food" && fieldId === 291 && doid === state.foodDoober?.doid) {
      state.seen.add("food-collected");
    }
    return `field update doid=${doid} field=${fieldId}`;
  }

  if (opcode === OP.CLIENT_HEART_BEAT) {
    state.seen.add("heartbeat");
    return `heartbeat "${reader.utf()}"`;
  }

  return `${opcodeName(opcode)} (${body.length} bytes)`;
};

socket = net.createConnection({ host: HOST, port: PORT }, () => {
  state.seen.add("connected");
  console.log(`connected to ${HOST}:${PORT}`);
  socket.write(loginPacket());
  socket.write(new PacketWriter(OP.CLIENT_HEART_BEAT).utf(String(Date.now())).frame());
});

let buffered = Buffer.alloc(0);

/**
 * Writes what this server sends in the same shape the client's capture uses, so
 * every tool written against the official's logs reads ours unchanged.
 *
 * It closes an asymmetry that cost a lot: their side was measured off the wire
 * and ours only ever by calling functions directly, which cannot show a
 * difference that lives between them. `DR_CAPTURE=<path>` and the two streams
 * become comparable.
 */
const capturePath = process.env.DR_CAPTURE;
const captureFile = capturePath ? fs.openSync(capturePath, "w") : null;
const capture = (body) => {
  if (captureFile === null) return;
  fs.writeSync(
    captureFile,
    JSON.stringify({
      ts: new Date().toISOString().slice(0, 23),
      dir: "in",
      op: body.length >= 2 ? body.readUInt16LE(0) : -1,
      len: body.length,
      hex: body.toString("hex").toUpperCase(),
    }) + "\n"
  );
};

socket.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  const { packets, rest } = drainFrames(buffered);
  buffered = rest;

  for (const body of packets) {
    capture(body);
    console.log(`<- ${describeIncoming(body)}`);
    if (mode === "tour" && state.heroDoid && !state.touring && state.floorTraps?.length) {
      state.touring = true;
      /**
       * After the floor has finished arriving, not on the first trap that does.
       *
       * Generates land over a second or so, and starting on the first one meant
       * touring a floor of one — everything else was still on its way.
       */
      setTimeout(beginTour, 2500).unref?.();
    }


    if (state.finished) break;

    if (mode === "boss" && state.heroDoid && !state.walked) {
      state.walked = true;
      const exit = { x: 5850, y: 2760 };
      console.log(`-> walking hero ${state.heroDoid} onto the exit at ${exit.x},${exit.y}`);
      walkHeroTo({ x: exit.x, y: exit.y });
      state.seen.add("walked-to-exit");
    }

    // Smashing the chest is what reports the reward generator clear, and that
    // is what finishes the floor. Until it happens the dungeon must stay open.
    if (mode === "boss" && state.rewardChest && !state.tookChest) {
      state.tookChest = true;
      console.log(`-> smashing the reward chest ${state.rewardChest.doid}`);
      killNpc(socket, state.heroDoid, state.rewardChest.doid);
      state.seen.add("chest-taken");
    }

    if (mode === "boss" && state.heroDoid && state.boss && !state.sentKill) {
      state.sentKill = true;
      console.log(`-> killing the minotaur ${state.boss.doid}`);
      killNpc(socket, state.heroDoid, state.boss.doid);
      state.seen.add("boss-killed");
    }

    if (mode === "next-floor" && state.heroDoid && !state.walked) {
      state.walked = true;
      // The exit trigger on TUTORIAL_LEVEL_1's EXIT_TILE, in world coordinates.
      const exit = { x: 5850, y: 2760 };
      console.log(`-> walking hero ${state.heroDoid} onto the exit at ${exit.x},${exit.y}`);
      // Adjacent authored tile centres. A straight diagonal crosses absent
      // tiles and correctly trips movement containment before reaching the exit.
      walkHeroPath([
        { x: 2250, y: 6750 },
        { x: 3150, y: 5850 },
        { x: 3150, y: 4950 },
        { x: 3150, y: 4050 },
        { x: 4050, y: 4050 },
        { x: 4950, y: 4050 },
        { x: 5850, y: 4050 },
        { x: 5850, y: 3150 },
        exit,
      ]);
      state.seen.add("walked-to-exit");
    }

    if (mode === "pickup" && state.heroDoid && state.doober && !state.walked) {
      state.walked = true;
      console.log(`-> walking hero ${state.heroDoid} onto a doober`);
      walkHeroTo({ x: state.doober.x, y: state.doober.y });
    }

    if (
      mode === "ai" &&
      state.heroDoid &&
      state.aiKnight &&
      !state.walked
    ) {
      state.walked = true;
      state.aiTarget = { x: state.aiKnight.x + 200, y: state.aiKnight.y };
      console.log(
        `-> placing hero ${state.heroDoid} near knight ${state.aiKnight.doid} ` +
          `at ${state.aiTarget.x},${state.aiTarget.y}`
      );
      walkHeroTo({ x: state.aiTarget.x, y: state.aiTarget.y });
    }

    if (mode === "drop" && state.heroDoid && state.aiKnight && !state.sentKill) {
      state.sentKill = true;
      console.log(`-> killing NPC ${state.aiKnight.doid} to verify death drops`);
      killNpc(socket, state.heroDoid, state.aiKnight.doid);
    }

    if (mode === "buster" && state.heroDoid && state.busterDoober && !state.walked) {
      state.walked = true;
      console.log(`-> walking hero ${state.heroDoid} onto CROWD doober ${state.busterDoober.doid}`);
      walkHeroTo({ x: state.busterDoober.x, y: state.busterDoober.y });
    }

    if (
      mode === "buster-use" &&
      state.heroDoid &&
      !state.currentBusterDoober &&
      state.busterQueue.length &&
      !state.sentBusterAttack
    ) {
      state.currentBusterDoober = state.busterQueue.shift();
      console.log(
        `-> collecting CROWD doober ${state.currentBusterDoober.doid} for Buster use`
      );
      walkHeroTo({ x: state.currentBusterDoober.x, y: state.currentBusterDoober.y });
    }

    if (mode === "spikes" && state.heroDoid && state.spikePosition && !state.walked) {
      state.walked = true;
      console.log(`-> walking hero ${state.heroDoid} onto active spike area`);
      walkHeroTo({ x: state.spikePosition.x, y: state.spikePosition.y });
    }

    if (
      mode === "arrow-flight" &&
      state.heroDoid &&
      state.arrowFlightTrap &&
      !state.walked
    ) {
      state.walked = true;
      const radians = (state.arrowFlightTrap.heading * Math.PI) / 180;
      const target = {
        x: state.arrowFlightTrap.x + Math.cos(radians) * 350,
        y: state.arrowFlightTrap.y + Math.sin(radians) * 350,
      };
      console.log(
        `-> placing hero ${state.heroDoid} 350 units in front of arrow trap ` +
          `${state.arrowFlightTrap.doid}`
      );
      walkHeroTo({ x: target.x, y: target.y });
      state.seen.add("arrow-positioned");
    }

    /**
     * The wound comes from a floor trap, not from the hero hitting itself.
     * Self-damage scales with the attacker, so on a levelled probe avatar one
     * swing is 1351 against 420 hit points and the hero is down before it can
     * eat anything. A spike does three.
     */
    if (
      mode === "food" &&
      state.heroDoid &&
      state.foodDoober &&
      state.spikePosition &&
      !state.sentDamage
    ) {
      state.sentDamage = true;
      console.log(`-> walking hero ${state.heroDoid} onto spikes to take a wound`);
      walkHeroTo({ x: state.spikePosition.x, y: state.spikePosition.y });
    }

    /**
     * Stay in the spikes until the wound is deep enough to be worth the food.
     *
     * Leaving at the first tick of damage tested nothing: one spike costs about
     * a tenth of the bar and the smallest food on the floor restores a fifth,
     * so the server refused it — correctly — and the probe called that a
     * failure. What the rule needs is four fifths of the offer usable.
     */
    if (
      mode === "food" &&
      state.seen.has("food-damaged") &&
      !state.walked &&
      state.heroHitPoints - state.lowestHeroHitPoints >=
        state.heroHitPoints * state.foodRestores * 0.8
    ) {
      state.walked = true;
      console.log(`-> walking hero ${state.heroDoid} onto food ${state.foodDoober.doid}`);
      walkHeroTo({ x: state.foodDoober.x, y: state.foodDoober.y });
    }

    if (
      mode === "poison-pot" &&
      state.heroDoid &&
      state.aiKnight &&
      !state.walked
    ) {
      state.walked = true;
      /**
       * The cloud lands the action's offset in front of the hero, and heading
       * is zero until the client sends one — so standing that offset to the
       * knight's west drops it on top of him.
       */
      state.placeable = findPlaceableAttack(state.heroWeapons ?? []);
      if (!state.placeable) {
        fail(
          `hero type ${state.heroType} has no equipped weapon that places anything; ` +
            `equip the Poison Cooking Pot on the active avatar in data/${ACCOUNT_ID}.json`
        );
      } else {
        /**
         * Far enough back that the knight stands where the attack actually
         * lands. A cloud hits what is underneath it, but a fissure is a crack
         * that starts a hundred and fifty units out and would pass a target at
         * its own feet — so the reach comes from the authored colliders rather
         * than from the spawn offset alone.
         */
        const offset = Number(state.placeable.action.offset ?? 0);
        const reach = state.placeable.reach;
        console.log(
          `-> standing ${offset + reach} west of knight ${state.aiKnight.doid} to place ` +
            `${state.placeable.npc.Constant}`
        );
        walkHeroTo({ x: state.aiKnight.x - offset - reach, y: state.aiKnight.y });
        /**
         * Some of these are authored to stand for a minute — the garlic, mine
         * and firebomb traps all say sixty seconds — so the deadline follows
         * the data rather than the other way round.
         */
        const lifeMs = Math.max(0, Number(state.placeable.action.timetolive ?? 0) * 1000);
        if (lifeMs + 5000 > timeoutMs) {
          clearTimeout(deadline);
          deadline = setTimeout(onDeadline, lifeMs + 5000);
          console.log(`-> waiting ${Math.round((lifeMs + 5000) / 1000)}s for it to expire`);
        }
        console.log(
          `-> using ${state.placeable.attack.Constant} from slot ${state.placeable.slot}`
        );
        socket.write(
          attackProposalPacket(
            state.heroDoid,
            state.placeable.attack.Id,
            state.placeable.slot
          )
        );
      }
    }

    /**
     * A hero arrives on a floor with two seconds of SPAWN_INVULNERBILITY, which
     * the official grants every time it puts one down — 12 hero generates and
     * 12 of those buffs in one session. Nothing can hurt it until that expires,
     * so downing it has to wait for the shield the same way a player would.
     */
    if (mode === "revive" && state.heroDoid && !state.sentDown) {
      state.sentDown = true;
      const SPAWN_SHIELD_MS = 2000;
      console.log(`-> waiting out the spawn shield, then downing hero ${state.heroDoid}`);
      setTimeout(() => {
        console.log(`-> applying enough combat results to down hero ${state.heroDoid}`);
        downHero(socket, state.heroDoid);
      }, SPAWN_SHIELD_MS + 250);
    }

    if (mode === "mana-charge" && state.heroDoid && !state.sentManaAttack) {
      const manaAttack = findManaAttack(state.heroWeapons ?? []);
      if (!manaAttack) {
        fail(
          `hero type ${state.heroType} has no equipped weapon whose attack costs Mana; ` +
            `equip one on the active avatar in data/${ACCOUNT_ID}.json`
        );
      } else if (state.manaPoints < manaAttack.cost) {
        fail(
          `${manaAttack.attack.Constant} costs ${manaAttack.cost} Mana, ` +
            `hero type ${state.heroType} entered with ${state.manaPoints}`
        );
      } else {
        state.sentManaAttack = true;
        state.manaAttack = manaAttack;
        console.log(
          `-> using ${manaAttack.attack.Constant} from slot ${manaAttack.slot} ` +
            `(${manaAttack.cost} Mana) with ${state.manaPoints} Mana`
        );
        socket.write(
          attackProposalPacket(state.heroDoid, manaAttack.attack.Id, manaAttack.slot)
        );
      }
    }

    if (mode === "revive" && state.seen.has("revive-down") && !state.sentRevive) {
      state.sentRevive = true;
      console.log(`-> ProposeSelfRevive on hero ${state.heroDoid}`);
      socket.write(selfRevivePacket(state.heroDoid));
    }

    if (mode === "exit" && state.heroDoid && !state.sentExit) {
      state.sentExit = true;
      console.log(`-> RequestExit on matchmaker ${state.matchMakerDoid}`);
      socket.write(requestExitPacket(state.matchMakerDoid));
    }

    if (
      mode === "cage" &&
      state.heroDoid &&
      state.finalCageDoids.size === 2 &&
      state.buttonDoid !== null &&
      !state.walked
    ) {
      state.walked = true;
      state.cageWaveBaseline = state.tutorialFodders;
      console.log(`-> walking hero ${state.heroDoid} onto final cage trigger`);
      walkHeroTo({ x: 5850, y: 3120 });
    }

    if (
      mode === "cage" &&
      state.cageWaveBaseline !== null &&
      state.tutorialFodders >= state.cageWaveBaseline + 8
    ) {
      state.seen.add("cage-wave");
    }

    if (
      (mode === "request-entry" ||
        mode === "pickup" ||
        mode === "trap" ||
        mode === "arrow-flight" ||
        mode === "spikes" ||
        mode === "cage" ||
        mode === "ai" ||
        mode === "drop" ||
        mode === "buster" ||
        mode === "buster-use" ||
        mode === "mana-charge" ||
        mode === "poison-pot" ||
        mode === "food" ||
        mode === "revive" ||
        mode === "tour" ||
        mode === "next-floor" ||
        mode === "boss" ||
        mode === "exit") &&
      state.matchMakerDoid !== null &&
      !state.sentEntry
    ) {
      state.sentEntry = true;
      console.log(`-> ClientRequestEntry on doid ${state.matchMakerDoid}`);
      socket.write(requestEntryPacket(state.matchMakerDoid));
    }

    finishWhenSatisfied();
  }
});

socket.on("error", (err) => fail(`socket error: ${err.message}`));
socket.on("close", () => {
  if (!state.finished) fail(`connection closed; missing ${missingExpectations().join(", ")}`);
  console.log("disconnected");
});

// The boss floor announces its win seven seconds after the chest breaks, so
// this one has to outlast the loot countdown.
const timeoutMs =
  mode === "login"
    ? 3000
    : // A tour is as long as the walking it does, and the walking is the point.
      mode === "tour"
      ? Number(process.env.DR_TOUR_STOPS ?? 14) * 12000
      : mode === "revive"
        ? 15000
        : mode === "boss" || mode === "poison-pot" || mode === "next-floor"
          ? 20000
          : 10000;
function onDeadline() {
  /**
   * A meter that never filled is worth saying properly. Crowd points come from
   * CROWD doobers and from nothing else — Npc.CrowdPts is authored but not yet
   * awarded — and the meter caps at the hero's own Buster price, so a floor that
   * lays out less Crowd than the price is a ceiling the probe cannot argue with.
   */
  const buster = mode === "buster-use" ? dungeonBuster() : null;
  if (buster && !state.seen.has("buster-ready") && state.floorCrowd < buster.cost) {
    fail(
      `map node ${MAP_NODE} lays out ${state.floorCrowd} Crowd and ` +
        `${buster.attack.Constant} costs ${buster.cost}, so hero type ${state.heroType} ` +
        `cannot fill its meter here`
    );
    return;
  }
  fail(`timed out; missing ${missingExpectations().join(", ")}`);
}
deadline = setTimeout(onDeadline, timeoutMs);
