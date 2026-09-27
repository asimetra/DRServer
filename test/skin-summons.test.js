import assert from "node:assert/strict";
import test from "node:test";

import { buildRegistry, installContentPacks } from "../src/content-packs.js";
import { loadGameMaster } from "../src/gamemaster.js";
import { summonForSkin } from "../src/socket/placeables.js";

const BRAVESCAR = 161; // BRAVEHEART_BERSERKER
const DEFAULT_SAMURAI = 156;
const VARIANT = "GHOST_SAMURAI_CLONE__BRAVEHEART_BERSERKER";

/** The game's own tables plus one variant row, as a GameMaster carrying a pack would. */
const withVariant = async (changes = {}) => {
  const gm = await loadGameMaster();
  const clone = gm.npcByConstant.get("GHOST_SAMURAI_CLONE");
  return { raw: { ...gm.raw, Npc: [...gm.raw.Npc, { ...clone, Id: 990001, Constant: VARIANT, ...changes }] } };
};

const PACK = { packs: { bravescar: { version: 1, skins: ["BRAVEHEART_BERSERKER"] } } };

test("a summon keeps the timeline's NPC when the skin has no row of its own", async (t) => {
  t.after(() => installContentPacks(null));
  installContentPacks(buildRegistry(await withVariant(), PACK));
  assert.equal(await summonForSkin("GHOST_SAMURAI_CLONE", DEFAULT_SAMURAI), "GHOST_SAMURAI_CLONE");
});

test("a skin's own row replaces the summon for heroes wearing it", async (t) => {
  t.after(() => installContentPacks(null));
  installContentPacks(buildRegistry(await withVariant(), PACK));
  assert.equal(await summonForSkin("GHOST_SAMURAI_CLONE", BRAVESCAR), VARIANT);
  assert.equal(await summonForSkin("GHOST_SAMURAI_CLONE", DEFAULT_SAMURAI), "GHOST_SAMURAI_CLONE");
});

/**
 * Only through a pack. A variant no pack owns would go out unchanged to a client
 * whose GameMaster lacks it, and the real client does not survive that; one
 * that plays differently would be a different monster to each client.
 */
test("a variant no pack owns, or one that plays differently, is not used", async (t) => {
  t.after(() => installContentPacks(null));
  installContentPacks(buildRegistry(await withVariant(), {}));
  assert.equal(await summonForSkin("GHOST_SAMURAI_CLONE", BRAVESCAR), "GHOST_SAMURAI_CLONE");

  const stronger = buildRegistry(await withVariant({ HP: 999999 }), PACK);
  installContentPacks(stronger);
  assert.equal(await summonForSkin("GHOST_SAMURAI_CLONE", BRAVESCAR), "GHOST_SAMURAI_CLONE");
  assert.ok(stronger.problems.some((problem) => problem.includes("plays differently") && problem.includes("HP")));
});

test("an unknown or missing skin changes nothing", async () => {
  assert.equal(await summonForSkin("GHOST_SAMURAI_CLONE", 999999), "GHOST_SAMURAI_CLONE");
  assert.equal(await summonForSkin("GHOST_SAMURAI_CLONE", undefined), "GHOST_SAMURAI_CLONE");
});
