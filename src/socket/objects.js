import { PacketWriter } from "./packet.js";
import { config } from "../config.js";
import { isOverridden } from "../content.js";
import { CLID, OP, TEAM } from "./opcodes.js";

/**
 * Distributed-object generate messages.
 *
 * Field order comes straight from DcSocket.Process_CLIENT_CREATE_OBJECT_*:
 *
 *   134 REQUIRED       : u32 parent, u32 zone, u16 clid, u32 doid, <required>
 *   135 REQUIRED_OTHER : u32 parent, u32 zone, u16 clid, u32 doid, <required+other>
 *   136 ..OTHER_OWNER  : u16 clid, u32 doid, u32 parent, u32 zone, <required+other>
 *
 * Note the different field order on 136 — that is the client's, not a typo.
 *
 * After the required fields the client calls recvByIdLoop, which does nothing
 * when the packet is exhausted. So a generate carrying only required fields
 * must end exactly there.
 */

export const generateVisible = ({ clid, doid, parent = 0, zone = 0, fields }) =>
  new PacketWriter(OP.CLIENT_CREATE_OBJECT_REQUIRED_RESP)
    .u32(parent)
    .u32(zone)
    .u16(clid)
    .u32(doid)
    .raw(fields)
    .frame();

export const generateOwner = ({ clid, doid, parent = 0, zone = 0, fields }) =>
  new PacketWriter(OP.CLIENT_CREATE_OBJECT_REQUIRED_OTHER_OWNER_RESP)
    .u16(clid)
    .u32(doid)
    .u32(parent)
    .u32(zone)
    .raw(fields)
    .frame();

/**
 * "Everything in this object's interest has been sent."
 *
 * The one message in the protocol this server never spoke. `DcSocket
 * .Process_CLIENT_INTEREST_CONTEXT` reads a context and a doid and calls
 * `InterestClosure()` on the object, and for a floor that is:
 *
 *   pastInitialLoad = true;
 *   dispatchEvent("FLOOR_INTEREST_CLOSURE");
 *
 * which the loading screen listens for and answers with
 * `AssetLoader.stopTrackingLoads()`. Without it the client never learns that a
 * floor is complete: `pastInitialLoad` stays false for the whole session and
 * the asset tracker is never closed.
 *
 * The corpus is unanimous about the shape — 184 of them, every one carrying
 * context 1802 to a `DistributedDungeonFloor`, sent immediately after the
 * floor's last child and never at any other time.
 */
export const FLOOR_INTEREST_CONTEXT = 1802;

export const interestClosure = (doid, context = FLOOR_INTEREST_CONTEXT) =>
  new PacketWriter(OP.CLIENT_INTEREST_CONTEXT).u16(context).u32(doid).frame();

/** Destroys a distributed object on the client before leaving its interest. */
export const objectDisable = (doid, owner = false) =>
  new PacketWriter(
    owner ? OP.CLIENT_OBJECT_DISABLE_OWNER_RESP : OP.CLIENT_OBJECT_DISABLE_RESP
  )
    .u32(doid)
    .frame();

/** DistributedBuffGameObject (clid 41): type, affected actor and source actor. */
export const buffGenerate = ({
  doid,
  parent = 0,
  zone = 0,
  buffType,
  affectedActor,
  attackerActor,
}) => {
  const fields = new PacketWriter()
    .u32(buffType)
    .u32(affectedActor)
    .u32(attackerActor)
    .body();
  return generateVisible({
    clid: CLID.DistributedBuffGameObject,
    doid,
    parent,
    zone,
    fields,
  });
};

/**
 * MatchMaker (clid 42). Its only required field is InfiniteDetails, encoded as
 * a u16 byte-length followed by that many bytes of InfiniteMapNodeDetail
 * entries — zero for "no infinite dungeon data".
 *
 * This single packet is what flips the client's last loading flag:
 * MatchMakerNetworkComponent.netFactory -> MatchMaker.postGenerate ->
 * MatchMakerLoadedEvent -> LoadingState.mMatchMakerLoaded = true.
 */
export const matchMakerGenerate = (doid) => {
  const fields = new PacketWriter().u16(0).body();
  return generateVisible({ clid: CLID.MatchMaker, doid, fields });
};

/**
 * PlayerGameObjectOwner (clid 29). Production uses the account id as this
 * object's doid; DungeonReport.id points back to it on the summary screen.
 */
const playerFields = ({ screenName, basicCurrency = 0 }) =>
  new PacketWriter().utf(screenName ?? "Player").u32(basicCurrency).body();
const remotePlayerFields = ({ screenName }) =>
  new PacketWriter().utf(screenName ?? "Player").body();

export const playerOwnerGenerate = ({
  doid,
  parent = 0,
  zone = 10,
  screenName,
  basicCurrency,
}) => {
  const fields = playerFields({ screenName, basicCurrency });
  return generateOwner({ clid: CLID.PlayerGameObject, doid, parent, zone, fields });
};

/** The same player as seen by another member of the dungeon. */
export const playerGenerate = ({
  doid,
  parent = 0,
  zone = 10,
  screenName,
  basicCurrency = 0,
}) =>
  generateVisible({
    clid: CLID.PlayerGameObject,
    doid,
    parent,
    zone,
    // The non-owner component generates only screenName. basicCurrency is the
    // owner's field 181 and trailing it here desynchronises recvByIdLoop.
    fields: remotePlayerFields({ screenName }),
  });

/**
 * Puts a hero somewhere, rather than being told where it is.
 *
 * Field 147 is the one the client writes constantly to report its own position,
 * and it is easy to read as outbound-only. It is not: the generated
 * `HeroGameObjectNetworkComponent.recvById` dispatches 147 to `recv_position`
 * like any other field, and `HeroGameObjectOwner.set_position` forwards it
 * straight to the base setter without checking whether the hero is its own. So
 * the same field the client claims with, the server can decide with.
 */
export const heroPositionUpdate = (doid, { x, y }) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(147)
    .f32(x)
    .f32(y)
    .frame();

/**
 * A length-prefixed list. The client reads `u16 byteLength` and then keeps
 * decoding entries until it has consumed that many **bytes** — the count is a
 * byte total, not an element count.
 */
const byteList = (entries, writeEntry) => {
  const inner = new PacketWriter();
  for (const entry of entries) writeEntry(inner, entry);
  const payload = inner.body();
  return new PacketWriter().u16(payload.length).raw(payload).body();
};

/** DungeonTileUsage.readFromPacket: i32 x, i32 y, utf tileId. */
const writeTile = (writer, tile) =>
  writer.i32(tile.x).i32(tile.y).utf(tile.tileId);

/**
 * DistributedDungeonFloor (clid 32). Required fields, in the order
 * DistributedDungeonFloorNetworkComponent.generate() reads them.
 */
const FLID_FLOOR = { tiles: 195, baseLining: 196 };
const FLID_AREA_FLOOR_ENDING = 215;

/**
 * Floor numbers are not 1, 2, 3.
 *
 * Captured runs — one in Ice Caverns, one in the tutorial — both number their
 * first floor 2000 and their second 2001. Sending 1 puts a number in the field
 * that the game never produces.
 */
export const FIRST_FLOOR_NUMBER = 2000;

export const dungeonFloorGenerate = ({
  doid,
  parent = 0,
  mapNodeId,
  floor,
  floorNumber = FIRST_FLOOR_NUMBER,
  tierConstant = "",
  tiles = floor.tiles,
}) => {
  const fields = new PacketWriter()
    .u32(mapNodeId)
    // MapPage.TierRank — CASTLE_TIER1 for the tutorial, ICE_CAVES_B for Ice
    // Caverns 1-3. Empty here is another value the real server never sends.
    .utf(tierConstant)
    .utf(clientAssetPath(floor.tileLibrary))
    /**
     * Only the first floor carries its tiles in the generate. Every floor after
     * it is generated with an empty list and gets its layout as a `tiles` field
     * update immediately afterwards, which is what the capture shows.
     */
    .raw(byteList(tiles, writeTile))
    .u8(0) // baseLining
    .utf("") // introMovieSwfFilePath
    .utf("") // introMovieAssetClassName
    .u16(floorNumber)
    .raw(byteList([], () => {})) // activeDungeonModifiers
    .body();

  return generateVisible({ clid: CLID.DistributedDungeonFloor, doid, parent, fields });
};

/**
 * Field updates a floor gets after it is generated.
 *
 * The generate already carries the tile list, but production sends it again as
 * a field update on every floor after the first, followed by baseLining. The
 * client dedupes tiles by (x, y) — DistributedDungeonFloor.tiles only builds
 * placements it has not seen — so repeating it is harmless and keeps us on the
 * sequence a captured run shows.
 */
export const floorTilesUpdate = (doid, tiles) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(FLID_FLOOR.tiles)
    .raw(byteList(tiles, writeTile))
    .frame();

export const floorBaseLining = (doid, value = 1) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(doid)
    .u16(FLID_FLOOR.baseLining)
    .u8(value)
    .frame();

/**
 * DistributedDungionArea.floorEnding — one floor is over, another is coming.
 *
 * Distinct from dungeonEnding, which finishes the run. The payload is a single
 * short: how many seconds until the swap. FloorEndingGui.floorEnding returns
 * without drawing anything when it is zero, and otherwise puts the number on
 * screen and ticks it down once a second.
 *
 * What decides it is how many players are still on the floor. Three captured
 * transitions:
 *
 *   nobody else on the floor  -> 0, next floor 33ms and 44ms later
 *   three others on the floor -> 5, next floor 5.054s later
 *
 * So the countdown is there to let the rest of the party catch up, and the
 * server waits exactly as long as it told the client to. A solo run has nobody
 * to wait for, which is why every transition we send is zero — not because the
 * field is unused.
 */
export const buildFloorEnding = (areaDoid, transitionTime = 0) =>
  new PacketWriter(OP.CLIENT_OBJECT_UPDATE_FIELD)
    .u32(areaDoid)
    .u16(FLID_AREA_FLOOR_ENDING)
    .u16(transitionTime)
    .frame();

/**
 * An asset path as the client should resolve it.
 *
 * The client builds every asset URL as `download_root + path`, so a path that
 * leaves here unchanged is one it looks for on the player's own disk. That is
 * the right default and should stay the common case: overriding everything
 * would mean shipping the game twice.
 *
 * `contentBaseUrl` names the exception. When it is set, paths this server holds
 * a copy of are rewritten to absolute URLs at it, and the client fetches those
 * — and only those — over HTTP. Which paths those are is decided by whoever
 * fills the content directory; nothing here knows or needs to.
 *
 * Rewritten at the wire and nowhere else. The same string is a filename to this
 * server, which reads the library to work out what a floor contains, and
 * rewriting it any earlier would send it looking for a URL on disk.
 *
 * Requires the client's `download_root` to be "" — the shipped default is "./",
 * which would make this "./https://…".
 */
const clientAssetPath = (path) =>
  config.contentBaseUrl && path && !/^https?:\/\//i.test(path) && isOverridden(path)
    ? `${config.contentBaseUrl.replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`
    : path;

/** Swrapper is just a filename string. */
const writeSwrapper = (writer, fileName) => writer.utf(clientAssetPath(fileName));

/**
 * DistributedDungionArea (clid 36) — required before the floor.
 *
 * Its postGenerate fires the client's cache-load request, which preloads the
 * tile library JSONs and then calls AssetLoader.stopTrackingLoads(). Two things
 * depend on that: DungeonFloorFactory looks the tile library up from the cache
 * (a miss there is a hard crash), and the loading screen cannot finish until
 * load tracking stops.
 *
 * All three fields are byte-length-prefixed lists.
 */
export const dungeonAreaGenerate = ({ doid, parent = 0, tileLibraries, cacheNpcs = [], cacheSwfs = [] }) => {
  const fields = new PacketWriter()
    .raw(byteList(tileLibraries, writeSwrapper))
    .raw(byteList(cacheNpcs, (writer, npcId) => writer.u32(npcId)))
    .raw(byteList(cacheSwfs, writeSwrapper))
    .body();

  return generateVisible({ clid: CLID.DistributedDungionArea, doid, parent, fields });
};

const REPORT_U32_BEFORE_BOOST = [
  "trophyCount",
  "id",
  "type",
  "skinType",
  "kills",
  "xp",
  "xpEarned",
  "xpBonus",
  "teamXpBonus",
  "goldEarned",
  "gemsEarned",
];

const REPORT_U32_AFTER_TROPHY = [
  "dungeonModifier1",
  "dungeonModifier2",
  "dungeonModifier3",
  "dungeonModifier4",
  "lootType1",
  "lootType2",
  "lootType3",
  "lootType4",
  "weaponLevel1",
  "weaponLevel2",
  "weaponLevel3",
  "weaponType1",
  "weaponType2",
  "weaponType3",
  "modifierType1a",
  "modifierType1b",
  "legendaryModifierType1",
  "modifierType2a",
  "modifierType2b",
  "legendaryModifierType2",
  "modifierType3a",
  "modifierType3b",
  "legendaryModifierType3",
  "weaponPower1",
  "weaponPower2",
  "weaponPower3",
  "weaponRarity1",
  "weaponRarity2",
  "weaponRarity3",
  "chestType1",
  "chestType2",
  "chestType3",
  "chestType4",
];

/** DungeonReport.writeToPacket, kept flat so every generated field is auditable. */
const writeDungeonReport = (writer, report = {}) => {
  writer.utf(report.name ?? "");
  for (const field of REPORT_U32_BEFORE_BOOST) writer.u32(report[field] ?? 0);
  writer
    .f32(report.boostXp ?? 0)
    .f32(report.boostGold ?? 0)
    .u8(report.receivedTrophy ?? 0);
  for (const field of REPORT_U32_AFTER_TROPHY) writer.u32(report[field] ?? 0);
  writer
    .u8(report.valid ?? 0)
    .u32(report.accountFlags ?? 0)
    .u32(report.totalAvatarsOwned ?? 0)
    .u32(report.consumable1Id ?? 0)
    .u32(report.consumable1Count ?? 0)
    .u32(report.consumable2Id ?? 0)
    .u32(report.consumable2Count ?? 0);
};

/**
 * DistributedDungeonSummary (clid 38).
 *
 * Production always sends four DungeonReport slots: the local player followed
 * by empty/invalid party slots. The report vector is byte-length-prefixed.
 */
export const dungeonSummaryGenerate = ({
  doid,
  parent = 0,
  zone = 0,
  mapNodeId,
  reports = [],
  dungeonName = "",
  success = false,
  dungeonModifiers = [],
}) => {
  const slots = Array.from({ length: 4 }, (_, index) => reports[index] ?? {});
  const fields = new PacketWriter()
    .u32(mapNodeId)
    .raw(byteList(slots, writeDungeonReport))
    .utf(dungeonName)
    .u8(success ? 1 : 0);

  for (let index = 0; index < 4; index++) fields.u32(dungeonModifiers[index] ?? 0);

  return generateVisible({
    clid: CLID.DistributedDungeonSummary,
    doid,
    parent,
    zone,
    fields: fields.body(),
  });
};

/**
 * WeaponDetails: u32 type, u16 power, u8 requiredlevel, u8 rarity, 3×u32 modifiers.
 *
 * An empty slot is still a filled struct, and the official fills it with ones
 * rather than zeroes: every actor in the corpus carries
 * `[0, 0, 1, 1, 0, 0, 0]` in each slot it is not using. `setupWeapons` skips a
 * slot whose type is zero, so nothing reads them — but `requiredlevel` doubles
 * as the weapon's level everywhere it *is* read, aesthetic ranges start at 1,
 * and a zero there is what makes the client log "Unable to find Weapon
 * Aesthetic". Matching costs nothing and leaves one less universal difference
 * standing between this server and the recordings.
 */
const writeWeapon = (writer, weapon) =>
  writer
    .u32(weapon.type ?? 0)
    .u16(weapon.power ?? 0)
    .u8(weapon.requiredlevel ?? 1)
    .u8(weapon.rarity ?? 1)
    .u32(weapon.modifier1 ?? 0)
    .u32(weapon.modifier2 ?? 0)
    .u32(weapon.legendarymodifier ?? 0);

/** ConsumableDetails: u32 type, u16 count. */
const writeConsumable = (writer, consumable) =>
  writer.u32(consumable.type ?? 0).u16(consumable.count ?? 0);

const EMPTY_WEAPON = {};
const EMPTY_CONSUMABLE = {};

/**
 * HeroGameObjectOwner (clid 28, owner view). Field order mirrors
 * HeroGameObjectOwnerNetworkComponent.generate().
 *
 * Three of the lists are **fixed length** with no prefix at all: exactly four
 * weapons, two consumables and four slot-point shorts. Writing a count would
 * desynchronise everything after them.
 *
 * Generating this fires HERO_OWNER_READY on the client. The floor must exist
 * first — ActorGameObject.set_weaponDetails only builds weapons when the
 * dungeon floor is already present.
 */
const heroFields = ({
  heroType,
  skinType,
  playerId,
  screenName,
  position = { x: 0, y: 0 },
  hitPoints = 100,
  manaPoints = 100,
  experiencePoints = 0,
  dungeonBusterPoints = 0,
  weapons = [EMPTY_WEAPON, EMPTY_WEAPON, EMPTY_WEAPON, EMPTY_WEAPON],
  consumables = [EMPTY_CONSUMABLE, EMPTY_CONSUMABLE],
  slotPoints = [0, 0, 0, 0],
  team = TEAM.PLAYERS,
  /**
   * The size the client draws *and collides* the hero at.
   *
   * Every hero row authors `Scale` 1.176 against a `CollisionSize` of 22, and
   * the official sends the product on the wire: 217 of its 221 hero generates
   * carry 1.176, and so do the 111 it sends for other players. This server sent
   * a flat 1, which is a hero 44 units across where the game's is 51.7.
   *
   * Eight units decides real things. The ice caves author 195 pairs of
   * neighbouring spike beds whose navigation boxes leave a gap between 44 and
   * 68 units — every one of those in the 44 to 51 band is a slot our hero fits
   * through and the game's does not. That is the reported "we squeeze between
   * the traps and take damage, and on the original you simply cannot".
   */
  scale = 1,
}) => {
  const fields = new PacketWriter()
    .u32(heroType)
    .f32(position.x)
    .f32(position.y)
    .f32(0) // heading
    .f32(scale)
    .u8(0) // flip
    .u16(hitPoints);

  for (let i = 0; i < 4; i++) writeWeapon(fields, weapons[i] ?? EMPTY_WEAPON);
  for (let i = 0; i < 2; i++) writeConsumable(fields, consumables[i] ?? EMPTY_CONSUMABLE);

  fields
    .u8(0) // healthBombsUsed
    .u8(0) // partyBombsUsed
    .u32(playerId)
    .utf("") // state — empty leaves the actor state machine at its default
    .u8(team)
    .u32(skinType)
    .utf(screenName)
    .u16(manaPoints)
    .u32(experiencePoints);

  for (let i = 0; i < 4; i++) fields.u16(slotPoints[i] ?? 0);

  fields
    .u32(dungeonBusterPoints)
    .u8(0); // setAFK

  return fields.body();
};

export const heroOwnerGenerate = ({ doid, parent = 0, zone = 10, ...hero }) =>
  generateOwner({
    clid: CLID.HeroGameObject,
    doid,
    parent,
    zone,
    fields: heroFields(hero),
  });

/** HeroGameObject (non-owner) uses the identical required-field body. */
export const heroGenerate = ({ doid, parent = 0, zone = 10, ...hero }) =>
  generateVisible({
    clid: CLID.HeroGameObject,
    doid,
    parent,
    zone,
    fields: heroFields(hero),
  });

/**
 * DistributedNPCGameObject (clid 27). Field order from
 * DistributedNPCGameObjectNetworkComponent.generate().
 *
 * `masterId` associates pets with their owning hero. NPC attacks are still
 * server-driven through ReceiveAttackChoreography updates.
 *
 * Note hitPoints is a u32 here, unlike the hero's u16.
 */
/**
 * Scene-graph layers, from SceneGraphManager.getLayerFromName.
 *
 * `sorted` is the one that depth-sorts against the hero; `background` draws
 * under it — every floor spike and pressure plate — `ground` under even those,
 * and `foreground` over the top, which is what a wall trap needs so its own
 * muzzle does not end up behind the flame it emits.
 *
 * An unknown name is the client's own fallback to sorted, with an error logged.
 */
export const LAYER_SORTED = 20;

/**
 * The scene has a ground plane; an actor is never on it.
 *
 * `ground` is 5 in the scene graph and tiles do author it — 4 of the 85
 * `JURASSIC_DINO_TRAP_SPIKES` placements say so, and a handful elsewhere. But
 * across 30 270 npc generates the official emits layer 10, 20 and 30 and
 * nothing else, and each of those four spike beds arrives on 20. Ours put them
 * on 5, which is under the floor the hero walks on.
 *
 * So the name is honoured for everything that can carry an actor and mapped to
 * the sorted plane where it cannot, rather than being dropped from the table —
 * a missing key would read as "unknown layer" and hide the reason.
 */
const LAYER_BY_NAME = {
  ground: LAYER_SORTED,
  background: 10,
  sorted: LAYER_SORTED,
  foreground: 30,
  overfade: 46,
  ui: 50,
};

/**
 * The layer an object is drawn on: the tile's, or sorted.
 *
 * Two sources name one and only the **placement** is consulted. `DefaultLayer`
 * on the NPC row looks like a fallback and is not one — the official never
 * reads it.
 *
 * Falling back to the row instead of to sorted is invisible almost everywhere,
 * because the two agree. Exactly two constants in the whole of the game's tile
 * data disagree: `NORDIC_CAVE_EMITTER` and `CASTLE_ARENA_TRAP_SPIKES_A`, whose
 * rows say `background` while none of their placements names a layer. The
 * corpus generates the first 72 times and the second once, and every one of
 * those 73 arrives on layer 20.
 *
 * So a trap authored without a layer belongs in the sorted plane with the hero,
 * and reading the row put those two under the floor — one spike bed in the
 * arena and every ice-caves emitter.
 */
export const layerFor = (row, placedLayer) =>
  LAYER_BY_NAME[placedLayer] ?? LAYER_SORTED;

export const npcGenerate = ({
  doid,
  parent = 0,
  npcType,
  masterId,
  position,
  level = 1,
  heading = 0,
  scale = 1,
  flip = 0,
  hitPoints = 100,
  weapons = [EMPTY_WEAPON, EMPTY_WEAPON, EMPTY_WEAPON, EMPTY_WEAPON],
  team = TEAM.ENEMIES,
  /**
   * Scene-graph layer. Zero is rejected outright — FloorView.addToStage logs
   * "Tried to addToStage with layer == 0" and never adds the view, so the NPC
   * exists but is invisible. Actors default to 20 (ActorGameObject).
   *
   * Not every actor belongs there, and sending 20 for all of them is what drew
   * floor spikes and pressure plates *over* the hero standing on them — see
   * LAYER_BY_NAME.
   */
  layer = LAYER_SORTED,
  /**
   * Whether the NPC is "switched on". NPCGameObject derives
   * `triggerState = remoteTriggerState > 0`, and `isAttackable` is
   * `IsAttackable && triggerState` — so a zero here leaves monsters visible
   * and solid but impossible to target or hit.
   *
   * Trigger-gated spawns (ambushes behind a gate) are the reason this exists;
   * until gates are implemented, everything starts active.
   */
  triggerState = 1,
}) => {
  const fields = new PacketWriter()
    .u32(npcType)
    .u8(level)
    .f32(position.x)
    .f32(position.y)
    .f32(heading)
    .f32(scale)
    .u8(flip)
    .u32(hitPoints);

  for (let i = 0; i < 4; i++) writeWeapon(fields, weapons[i] ?? EMPTY_WEAPON);

  fields
    .utf("") // state
    .u8(team)
    .u8(layer)
    .u8(triggerState)
    .u32(masterId);

  return generateVisible({
    clid: CLID.DistributedNPCGameObject,
    doid,
    parent,
    fields: fields.body(),
  });
};

/**
 * DistributedDooberGameObject (clid 40) — the pickups scattered around a floor
 * (gold, food, crowd). Required fields: u32 type, f32 x, f32 y, i8 layer.
 */
export const dooberGenerate = ({
  doid,
  parent = 0,
  zone = 0,
  dooberType,
  position,
  layer = 20,
}) => {
  const fields = new PacketWriter()
    .u32(dooberType)
    .f32(position.x)
    .f32(position.y)
    .u8(layer)
    .body();

  return generateVisible({ clid: CLID.DistributedDooberGameObject, doid, parent, zone, fields });
};

/** Server-initiated disconnect with a reason the client logs. */
export const logoutResponse = (code, text) =>
  new PacketWriter(OP.CLIENT_LOGOUT_RESP).i16(code).utf(text).frame();

/** Heartbeat carries the client's own timestamp string, echoed back. */
export const heartbeat = (timestamp) =>
  new PacketWriter(OP.CLIENT_HEART_BEAT).utf(timestamp).frame();
