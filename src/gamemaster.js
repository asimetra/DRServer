import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { info, warn } from "./log.js";

/**
 * DB_GameMaster.json is the client's game-data dictionary and the server reads
 * the very same file, so the two can never disagree about ids, drop tables or
 * stats. It is ~6 MB, so it is parsed once and kept in memory.
 */
let gameMaster = null;

const shippedGameMasterFile = () =>
  path.join(config.resourcesDir, "Levels", "DB_GameMaster.json");

const gameMasterFile = () => {
  if (config.contentDir) {
    const ours = path.join(config.contentDir, "Resources", "Levels", "DB_GameMaster.json");
    if (existsSync(ours)) return ours;
  }
  return shippedGameMasterFile();
};



const load = async () => {
  if (gameMaster) return gameMaster;

  /**
   * Ours before theirs, for the same reason the tile libraries are: this table
   * is the rules, and the client reads it too. A row we add for a tavern
   * keeper — a knight's artwork with a knight's behaviour taken off it — has to
   * be the same row on both sides, or this server spawns something the client
   * does not know or draws it with rules this server never applied.
   *
   * The comment above still holds; it just has one more place to look first.
   */
  const file = gameMasterFile();
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  if (file !== shippedGameMasterFile()) info(`gamemaster: reading ${file}`);

  const npcByConstant = new Map(parsed.Npc.map((npc) => [npc.Constant, npc]));
  const heroById = new Map(parsed.Hero.map((hero) => [hero.Id, hero]));
  const dooberByConstant = new Map(parsed.Doobers.map((d) => [d.Constant, d]));
  const dooberById = new Map(parsed.Doobers.map((doober) => [doober.Id, doober]));
  const categoryProbById = new Map(parsed.CategoryProb.map((row) => [row.Id, row]));
  const rarityProbById = new Map(parsed.RarityProb.map((row) => [row.Id, row]));
  const dooberDropsByNpcConstant = new Map();
  for (const row of parsed.DooberDrop) {
    const doober = dooberById.get(row.Id);
    if (!doober) continue;
    for (const [constant, enabled] of Object.entries(row)) {
      if (enabled !== true || !npcByConstant.has(constant)) continue;
      const candidates = dooberDropsByNpcConstant.get(constant) ?? [];
      candidates.push(doober);
      dooberDropsByNpcConstant.set(constant, candidates);
    }
  }
  const mapNodeById = new Map(parsed.MapPage.map((node) => [node.Id, node]));
  const coliseumTierByConstant = new Map(
    (parsed.ColiseumTiers ?? []).map((tier) => [tier.Constant, tier])
  );
  const raritySpawnByConstant = new Map(
    (parsed.RaritySpawn ?? []).map((row) => [row.Constant, row])
  );
  const propByConstant = new Map((parsed.Prop ?? []).map((prop) => [prop.Constant, prop]));
  const stackableById = new Map((parsed.Stackables ?? []).map((row) => [row.Id, row]));
  const timelineFile = path.join(config.resourcesDir, "Combat", "AttackTimeline.json");
  const timelines = new Map(
    JSON.parse(await fs.readFile(timelineFile, "utf8")).attacks.map((row) => [row.attackName, row])
  );
  const customMapByConstant = new Map(
    (parsed.CustomMaps ?? []).map((custom) => [custom.Constant, custom])
  );
  const enemiesByTier = new Map(parsed.DungeonEnemy.map((row) => [row.Constant, row]));
  const attacksById = new Map(parsed.Attack.map((attack) => [attack.Id, attack]));
  const attacksByConstant = new Map(parsed.Attack.map((attack) => [attack.Constant, attack]));
  const modifiersById = new Map(parsed.Modifiers.map((modifier) => [modifier.Id, modifier]));
  const projectilesByConstant = new Map(
    parsed.Projectile.map((projectile) => [projectile.Constant, projectile])
  );
  const buffsByConstant = new Map(parsed.Buff.map((buff) => [buff.Constant, buff]));
  // Keyed by Description because that is the only thing tying this table to a
  // buff: the six rows are named Poison, Fire, Cold, Blood, Bacon and Ethereal,
  // which are the values Buff.Ability1 carries.
  const buffColorTypeByName = new Map(
    (parsed.BuffColorType ?? []).map((row) => [String(row.Description).toUpperCase(), row])
  );
  const weaponsByConstant = new Map(
    parsed.WeaponItem.map((weapon) => [weapon.Constant, weapon])
  );

  gameMaster = {
    raw: parsed,
    npcByConstant,
    heroById,
    dooberByConstant,
    dooberById,
    doobers: parsed.Doobers,
    categoryProbById,
    rarityProbById,
    dooberDropsByNpcConstant,
    mapNodeById,
    coliseumTierByConstant,
    raritySpawnByConstant,
    customMapByConstant,
    propByConstant,
    stackableById,
    timelines,
    enemiesByTier,
    attacksById,
    attacksByConstant,
    modifiersById,
    projectilesByConstant,
    buffsByConstant,
    buffColorTypeByName,
    weaponsByConstant,
  };
  info(`gamemaster: loaded ${parsed.Npc.length} NPCs, ${parsed.Hero.length} heroes`);
  return gameMaster;
};

/**
 * Tile placements name NPCs by constant (e.g. CASTLE_ARENA_SMASH_BARREL) while
 * the wire format wants the numeric id.
 */
export const npcForConstant = async (constant) => {
  const { npcByConstant } = await load();
  const npc = npcByConstant.get(constant);
  if (!npc) {
    warn(`gamemaster: no NPC named "${constant}"`);
    return null;
  }
  return npc;
};

/**
 * LECollectable usually names a concrete row. Some actions instead name a
 * DooberType (`FOOD`, `FOOD_BUFF`), which the original server resolves to one
 * of that category's concrete rows before it creates the distributed object.
 */
export const dooberForConstant = async (constant, random = Math.random) => {
  const { dooberByConstant, doobers } = await load();
  const concrete = dooberByConstant.get(constant);
  if (concrete) return concrete;

  const candidates = doobers.filter((doober) => doober.DooberType === constant);
  if (!candidates.length) return null;
  const roll = Math.min(1 - Number.EPSILON, Math.max(0, random()));
  return candidates[Math.floor(roll * candidates.length)];
};

/** GameMaster inputs used to roll the visible doobers emitted on NPC death. */
export const deathRewardDataForNpc = async (npc) => {
  const {
    doobers,
    categoryProbById,
    rarityProbById,
    dooberDropsByNpcConstant,
  } = await load();
  return {
    allDoobers: doobers,
    candidates: dooberDropsByNpcConstant.get(npc.Constant) ?? [],
    categoryProb: categoryProbById.get(npc.CharType) ?? {},
    rarityProb: rarityProbById.get("DOOBER") ?? {},
  };
};

/** A doober row by its numeric id — how map rewards name their payout. */
export const dooberById = async (id) => {
  const loaded = await load();
  return loaded.dooberById?.get(Number(id)) ?? null;
};

/**
 * The `spawndoober` action on an attack's timeline, if it has one.
 *
 * Resources/Combat/AttackTimeline.json is the choreography the client plays,
 * and the spawn actions in it are the ones ScriptTimeline deliberately builds
 * nothing for — `spawndoober` and `spawnnpc` share an empty case with
 * `attemptRevive`, which is the client saying these are the server's. But it
 * still carries every parameter, so what a Battle Chef's pot leaves, where it
 * lands and how long it lies there are all authored rather than ours:
 *
 *   TM_COOK_FOOD_COOLDOWN  FOOD_COOK  offset 120  spread 250/100  ttl 15
 *   TM_COOK_BUFF_COOLDOWN  FOOD_BUFF  offset 170  spread 250/100  ttl 15
 *   TM_COOK_FOOD           FOOD       offset 170  spread  50/50   ttl 30
 *
 * The frame it sits on is the delay: fourteen of fifteen at 24fps for the pots.
 */
/**
 * Every pickup an attack drops, not the first one.
 *
 * This returned as soon as it found one, on the assumption that a timeline
 * carries at most a single `spawndoober` — and the comment below `spawnNpcActions`
 * still says so. Three carry more: the Battle Chef's Dungeon Buster authors
 * twelve hamburgers, each with its own `offset` and `headingOffsetAngle` across
 * two frames, so the shower scatters a ring of them. Reading the first gave one,
 * in one place, and threw away the arrangement that makes it a shower.
 */
export const spawnDooberActions = async (attackTimeline) => {
  if (!attackTimeline) return [];
  const { timelines } = await load();
  const timeline = timelines.get(attackTimeline);
  if (!timeline) return [];

  const actions = [];
  for (const frame of timeline.frames ?? []) {
    for (const action of frame.actions ?? []) {
      if (action.type !== "spawndoober") continue;
      actions.push({ ...action, frame: Number(frame.frame ?? 0), totalFrames: timeline.totalFrames });
    }
  }
  return actions;
};

/** The first of them, which is all the ownership check needs to know. */
export const spawnDooberAction = async (attackTimeline) =>
  (await spawnDooberActions(attackTimeline))[0] ?? null;

/**
 * How long an attack keeps its performer untouchable, in milliseconds.
 *
 * A timeline says so itself: `invulnerable` with `isInvulnerable` true opens the
 * window and the same action with false closes it. Twenty-two carry one, and
 * every hero's Dungeon Buster is among them — all six open at frame zero and
 * run nearly the whole animation, from the Vampire Hunter's 1625ms to the
 * Sorcerer's 2917.
 *
 * That is the whole of why an ultimate is safe to use. Without it a player is
 * standing still, locked in an animation he cannot cancel, in the middle of
 * whatever he just dived into.
 */
export const invulnerableForMs = async (attackTimeline) => {
  if (!attackTimeline) return 0;
  const { timelines } = await load();
  const timeline = timelines.get(attackTimeline);
  if (!timeline) return 0;

  let opens = null;
  let closes = null;
  for (const frame of timeline.frames ?? []) {
    for (const action of frame.actions ?? []) {
      if (String(action.type ?? "").toLowerCase() !== "invulnerable") continue;
      if (action.isInvulnerable) opens ??= Number(frame.frame ?? 0);
      else closes = Number(frame.frame ?? 0);
    }
  }
  if (opens === null) return 0;
  // An unclosed window runs to the end of the animation, which is where the
  // client's own timeline stops playing it.
  const until = closes ?? Number(timeline.totalFrames ?? opens);
  return Math.max(0, ((until - opens) / FRAMES_PER_SECOND) * 1000);
};

/** The client plays timelines at 24fps, so a frame number is a delay. */
export const FRAMES_PER_SECOND = 24;

/**
 * Every NPC an attack leaves standing on the floor.
 *
 * The same action under two spellings — `spawnnpc` and `spawnNpcForAttack` —
 * and the client builds nothing for either: ScriptTimeline.parseAction shares
 * an empty case between `spawnnpc` and `spawndoober`, while `spawnNpcForAttack`
 * is not in its switch at all and falls through to a "No handle for" debug line.
 * Both are the server's, and until now neither was anyone's, which is why the
 * poison pot cost Mana and did nothing.
 *
 * Unlike `spawndoober` a timeline may carry several: the Ghost Samurai's Iron
 * Legion places three clones on three frames, each with its own angle. A `#`
 * prefix is the data's own way of disabling an action — the client skips those
 * without even logging — so those are not ours either.
 */
export const spawnNpcActions = async (attackTimeline) => {
  if (!attackTimeline) return [];
  const { timelines } = await load();
  const timeline = timelines.get(attackTimeline);
  if (!timeline) return [];

  const actions = [];
  for (const frame of timeline.frames ?? []) {
    for (const action of frame.actions ?? []) {
      const type = String(action.type ?? "").toLowerCase();
      if (type !== "spawnnpc" && type !== "spawnnpcforattack") continue;
      actions.push({ ...action, frame: Number(frame.frame ?? 0) });
    }
  }
  return actions;
};

/**
 * When an attack kills whatever performed it, and how long the death waits.
 *
 * The explosion timelines end with a `suicide` action, and the frame it sits on
 * is the pause the client needs to play the blast before its actor is taken
 * away — twenty-three frames for the garlic and mine, forty-eight for the
 * firebomb. The captured garlic trap detonated and died 1.1 seconds later,
 * which is those twenty-three frames at 24fps.
 *
 * Returns null when the attack does not end its performer, which is how the
 * poison cloud goes on standing after it hits.
 */
export const suicideDelayMs = async (attackTimeline) => {
  if (!attackTimeline) return null;
  const { timelines } = await load();
  const timeline = timelines.get(attackTimeline);
  if (!timeline) return null;

  for (const frame of timeline.frames ?? []) {
    for (const action of frame.actions ?? []) {
      if (String(action.type ?? "").toLowerCase() !== "suicide") continue;
      return (Number(frame.frame ?? 0) / FRAMES_PER_SECOND) * 1000;
    }
  }
  return null;
};

/**
 * How long a given placeable is authored to stand, taken from wherever it is
 * placed. A thrown trap arrives by projectile and the Projectile row says only
 * *what* appears, not for how long — but the same NPC is also placed directly
 * by a timeline that does say, and it is the same trap either way.
 */
export const spawnLifetimeFor = async (spawnName) => {
  if (!spawnName) return 0;
  const { timelines } = await load();
  for (const timeline of timelines.values()) {
    for (const frame of timeline.frames ?? []) {
      for (const action of frame.actions ?? []) {
        if (action.spawnname !== spawnName) continue;
        const life = Number(action.timetolive ?? 0);
        if (life > 0) return life;
      }
    }
  }
  return 0;
};

/**
 * The shape an attack actually hits with, from its own timeline.
 *
 * Not `Attack.Range`, which is how close the AI has to be before it starts the
 * swing: every placeable attack in the game shares a flat 200 there while their
 * real reaches are 50, 100, 140 and 300. The hit shape is authored as collider
 * actions on the timeline, which is also where the client reads it —
 * ScriptTimeline lists `circleCollider` and `rectangleCollider` among the
 * actions it builds.
 *
 *   TM_TRAP_50_RADIUS_HIT      circle r50           the poison cloud, flame
 *   TM_TRAP_GARLICTRAP         circle r100          garlic
 *   TM_TRAP_TRIPMINE           circle r140          mines
 *   TM_CONSUMABLE_*_DEATH      circle r300          the thrown bombs
 *   TM_FISSURE_SMASH_ATTACK    r40 at 150..500      a crack racing outward
 *
 * `xOffset` is along the actor's facing, which is what makes the fissure a
 * sweep rather than a ring.
 */
export const attackColliders = async (attackTimeline) => {
  if (!attackTimeline) return [];
  const { timelines } = await load();
  const timeline = timelines.get(attackTimeline);
  if (!timeline) return [];

  const colliders = [];
  for (const frame of timeline.frames ?? []) {
    for (const action of frame.actions ?? []) {
      const type = String(action.type ?? "").toLowerCase();
      if (type !== "circlecollider" && type !== "rectanglecollider") continue;
      colliders.push({ ...action, frame: Number(frame.frame ?? 0) });
    }
  }
  return colliders;
};

/**
 * How long a timeline runs, in frames.
 *
 * The tail matters as much as the hits: an explosion's colliders are all on its
 * first frames and `TM_TRAP_TRIPMINE` runs for twenty-five, which is the fire
 * and smoke after the bang. A trap torn down before that has gone off without
 * anything to show for it.
 */
export const attackTimelineFrames = async (attackTimeline) => {
  if (!attackTimeline) return 0;
  const { timelines } = await load();
  return Number(timelines.get(attackTimeline)?.totalFrames ?? 0);
};

/**
 * Where a timeline's shot actually leaves from.
 *
 * `ProjectileAttackTimelineAction` does not fire from the actor's position. It
 * starts at `worldCenter`, adds the actor's `projectileLaunchOffset`, and then
 * adds the offsets the timeline itself carries — and Loki's carries
 * `yOffset: -180`, which is a fireball leaving the statue's raised hands rather
 * than its feet.
 *
 * This server simulated the flight from the placement position, so the damage
 * ran along a line 180 units from the one the client drew. That is a fireball
 * passing beside a player who takes the hit anyway: two parallel paths, one
 * visible and one not, and no amount of correcting *when* the aim is sent can
 * close a gap that is in *where* the shot starts.
 */
/**
 * Every shot a timeline looses, in the client's own terms.
 *
 * `ProjectileAttackTimelineAction.execute` keeps four things apart that are
 * easy to collapse into one, and collapsing them is visible in play:
 *
 *   headingOffsetAngle   degrees added to the actor's heading — the direction
 *   headingRandomnessAngle  spread added to that angle, per shot
 *   headingOffset        a *distance* along that direction — the muzzle
 *   xOffset / yOffset    added in world axes, not rotated by the heading
 *
 * so the shot leaves from
 *
 *   worldCenter + headingOffset x (cos, sin)(heading + angle) + (xOffset, yOffset)
 *
 * and travels along `heading + angle`. Reading `headingOffset` as an angle
 * turns `TM_GATLING_ARROW` — which authors 40 with an angle of zero — into six
 * arrows fired forty degrees away from the ones the client draws.
 *
 * Returned as a list because a timeline may loose more than one: the gatling
 * statue fires six, a specter's triple cast three. Taking only the first left
 * the rest of the burst undamaging and invisible to the server.
 */
export const projectileLaunches = async (attackTimeline) => {
  if (!attackTimeline) return [];
  const { timelines } = await load();
  const timeline = timelines.get(attackTimeline);
  if (!timeline) return [];

  const launches = [];
  for (const frame of timeline.frames ?? []) {
    for (const action of frame.actions ?? []) {
      if (String(action.type ?? "").toLowerCase() !== "projectile") continue;
      launches.push({
        frame: Number(frame.index ?? frame.frame ?? 0),
        xOffset: Number(action.xOffset ?? 0),
        yOffset: Number(action.yOffset ?? 0),
        headingOffset: Number(action.headingOffset ?? 0),
        headingOffsetAngle: Number(action.headingOffsetAngle ?? 0),
        headingRandomnessAngle: Number(action.headingRandomnessAngle ?? 0),
      });
    }
  }
  return launches;
};

/**
 * The first of them, for the callers that only ever wanted a muzzle: a trap
 * fires one shot per activation and Loki's fireball leaves one pair of hands.
 */
export const projectileLaunch = async (attackTimeline) => {
  const [first] = await projectileLaunches(attackTimeline);
  return (
    first ?? {
      xOffset: 0,
      yOffset: 0,
      headingOffset: 0,
      headingOffsetAngle: 0,
      headingRandomnessAngle: 0,
      frame: 0,
    }
  );
};

/**
 * A stackable by id — how the two powerup slots name what they hold. The row
 * carries `UsageAttack`, which is the whole of what using one does.
 */
export const stackableById = async (id) => {
  const loaded = await load();
  return loaded.stackableById?.get(Number(id)) ?? null;
};

/**
 * The tier a map node sits in, which is where a generated dungeon gets its
 * shape: which tile library, how big a floor is, how many floors there are.
 */
export const coliseumTier = async (constant) => {
  const loaded = await load();
  return loaded.coliseumTierByConstant?.get(constant) ?? null;
};

/**
 * What a reward spot on a floor of this tier pays out.
 *
 * `RaritySpawn` carries one row per tier rank, spreading `TOTALS` 1 across five
 * chest rarities and the two item boxes. It is the authored answer to both
 * questions a reward spot asks — which rarity, and whether a chest arrives at
 * all — and reading only the first is what left the boxes undropped.
 *
 * `LEGENDARY_CHEST` and `UBER_CHEST` are zero on all 55 rows, which is why no
 * capture has ever shown a dragon chest off a tier roll. The one legendary in
 * the game comes from a single node's `BossRewardTreasureId`.
 */
export const treasureForTier = async (tierRank, random = Math.random) => {
  if (!tierRank) return null;
  const { raritySpawnByConstant } = await load();
  const row = raritySpawnByConstant?.get(tierRank);
  if (!row) return null;

  const weights = Object.entries(row).filter(
    ([column, weight]) => column.endsWith("_CHEST") || column.endsWith("_BOX")
  ).filter(([, weight]) => typeof weight === "number" && weight > 0);
  if (!weights.length) return null;

  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = Math.min(1 - Number.EPSILON, Math.max(0, random())) * total;
  for (const [category, weight] of weights) {
    roll -= weight;
    if (roll <= 0) return treasureForCategory(category);
  }
  return treasureForCategory(weights.at(-1)[0]);
};

/**
 * The chest a reward category pays.
 *
 * Six doobers carry DooberType TREASURE and each names a RewardCategory:
 * WOODEN_CHEST is COMMON_CHEST, SILVER_CHEST UNCOMMON_CHEST, GOLD_CHEST
 * RARE_CHEST, DRAGON_CHEST LEGENDARY_CHEST. A tier's `Treasure` column and a
 * CustomMaps row's are categories, not constants, which is what makes them
 * look unresolvable when read as doober names.
 */
export const treasureForCategory = async (category) => {
  if (!category) return null;
  const { doobers } = await load();
  return (
    doobers.find(
      (doober) => doober.DooberType === "TREASURE" && doober.RewardCategory === category
    ) ?? null
  );
};

/**
 * Scenery, as opposed to a monster. The two tables do not overlap — 968 props
 * and 563 NPCs, no constant in both — so which one a placement names says
 * plainly who owns it.
 */
export const propForConstant = async (constant) => {
  const loaded = await load();
  return loaded.propByConstant?.get(constant) ?? null;
};

export const mapNode = async (mapNodeId) => {
  const { mapNodeById } = await load();
  return mapNodeById.get(mapNodeId) ?? null;
};

/**
 * The authored-map catalogue — twelve rows, keyed the way MapPage names them.
 *
 * `MapPage.CustomTileset` is a CustomMaps `Constant`, and that row carries the
 * rest: `NumFloors` with `Floor1..FloorN` naming the floor files, and the
 * `TileSet` they were drawn from. Everything a hand-written catalogue would say
 * is already in the data.
 */
export const customMap = async (constant) => {
  const loaded = await load();
  return loaded.customMapByConstant?.get(constant) ?? null;
};

/** Role letters used by the DungeonEnemy table. */
const ROLE_LETTERS = { FODDER: "F", BRUISER: "B", MINIBOSS: "M" };

/**
 * Resolves a generator's `spawnConstant` to a concrete NPC.
 *
 * Most generators name an NPC outright (KNIGHT, LION…). The rest carry a role
 * — FODDER, BRUISER or MINIBOSS — which means "whatever fills that role in this
 * dungeon". That mapping lives in the DungeonEnemy table: the row whose
 * Constant matches the map node's TierRank has one column per NPC, valued F, B
 * or M. The indirection is what lets one tile layout be reused across themes.
 */
export const resolveSpawnConstant = async (spawnConstant, mapNodeId) => {
  const { npcByConstant, enemiesByTier } = await load();

  if (npcByConstant.has(spawnConstant)) return spawnConstant;

  const letter = ROLE_LETTERS[spawnConstant];
  if (!letter) return null;

  const node = await mapNode(mapNodeId);
  const row = node && enemiesByTier.get(node.TierRank);
  if (!row) {
    warn(`gamemaster: no DungeonEnemy row for tier "${node?.TierRank}" (map node ${mapNodeId})`);
    return null;
  }

  const candidates = Object.entries(row)
    .filter(([key, value]) => value === letter && npcByConstant.has(key))
    .map(([key]) => key);

  if (!candidates.length) {
    warn(`gamemaster: tier "${node.TierRank}" defines no ${spawnConstant} (${letter})`);
    return null;
  }
  return candidates[0];
};

export const heroById = async (id) => {
  const { heroById: heroes } = await load();
  return heroes.get(id) ?? null;
};

export const attackById = async (id) => {
  const { attacksById } = await load();
  return attacksById.get(id) ?? null;
};

export const attackForConstant = async (constant) => {
  const { attacksByConstant } = await load();
  return attacksByConstant.get(constant) ?? null;
};

export const projectileForConstant = async (constant) => {
  const { projectilesByConstant } = await load();
  return projectilesByConstant.get(constant) ?? null;
};

export const buffForConstant = async (constant) => {
  const { buffsByConstant } = await load();
  return buffsByConstant.get(constant) ?? null;
};

export const buffColorTypeNamed = async (name) => {
  const { buffColorTypeByName } = await load();
  return buffColorTypeByName.get(String(name ?? "").toUpperCase()) ?? null;
};

export const weaponForConstant = async (constant) => {
  const { weaponsByConstant } = await load();
  return weaponsByConstant.get(constant) ?? null;
};

export const loadGameMaster = load;
