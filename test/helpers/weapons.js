/**
 * A weapon that really has this attack, for a hero in a test to hold.
 *
 * A hit is only taken from the weapon in the slot it names, and only if that
 * weapon's row grants the attack (buster.js slotGrantsAttack) — so a session
 * literal with `heroWeapons: [{ power: 500 }]` holds nothing that swings at
 * all. This finds a row that grants the attack, by id or constant, and keeps
 * whatever else the test wants on the weapon (power, modifiers).
 */
export const weaponWith = async (attack, rest = {}) => {
  // Imported when asked, not with this file: a test sets its data directory
  // before it imports the server, and config.js reads it as it is evaluated.
  const { loadGameMaster } = await import("../../src/gamemaster.js");
  const { raw } = await loadGameMaster();
  const constant =
    typeof attack === "string" ? attack : raw.Attack.find((row) => row.Id === Number(attack))?.Constant;
  const columns = /^(Attack\d|ChargeAttack|HoldingAttack|AltAttack\d?|ComboAttack\d?)$/;
  const row = raw.WeaponItem.find((item) =>
    Object.entries(item).some(([column, value]) => value === constant && columns.test(column))
  );
  if (!row) throw new Error(`no weapon grants ${constant ?? attack}`);
  return { type: row.Id, ...rest };
};
