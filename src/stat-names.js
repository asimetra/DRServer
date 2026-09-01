/**
 * What a stat's constant says to a player.
 *
 * `MELEE_ATK`, `ATK_POWER`, `COOKING` and their friends are row constants; the
 * words a player actually reads come from the client's locale file,
 * `Resources/Locale/GameMasterLocale.default.json` under `strings.STATS_NAME`.
 * This server ships no locale of its own and the training screen has no other
 * name for these, so the table travels here verbatim — the game is frozen
 * data, and a label that drifts from the client's would be a second opinion.
 *
 * Falls back to the constant itself, so a hero added later with a slot naming
 * a stat nobody has labelled still reads as something rather than nothing.
 */

export const STAT_LABELS = {
  HP_BOOST: "Max Health",
  MP_BOOST: "Max Mana",
  MELEE_ATK: "Melee Power",
  SHOOT_ATK: "Shooting Power",
  MAGIC_ATK: "Magic Power",
  MELEE_DEF: "Melee Defense",
  SHOOT_DEF: "Shooting Defense",
  MAGIC_DEF: "Magic Defense",
  MELEE_SPD: "Melee Speed",
  SHOOT_SPD: "Shooting Speed",
  MAGIC_SPD: "Magic Speed",
  HP_REGEN: "Health Regen",
  MP_REGEN: "Mana Regen",
  MOVEMENT: "Movement Speed",
  LUCK: "Luck",
  FURY: "Fury",
  COOKING: "Cooking",
  SPIRIT_POWER: "Spirit Energy",
  ATK_POWER: "Attack Power",
  MANA_BOOST: "Mana Upgrade",
  MASTER_DEFENSE: "Ultimate Defense",
  MAGIC_COOLDOWN: "Clockwork",
  TRAP_POWER: "Trap Power",
};

export const statLabel = (constant) =>
  (constant && STAT_LABELS[constant]) || constant || null;
