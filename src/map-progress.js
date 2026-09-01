/**
 * Utf8BitArray stores one byte per character and reads bit `i` from byte
 * `i >> 3`, counting from the top of the byte (`7 - i % 8`). Codes stay under
 * 256 so a byte never splits into two when the mask is serialized again.
 */
export const getMapNodeBit = (mask, bitIndex) =>
  ((mask ?? "").charCodeAt(bitIndex >> 3) & (1 << (7 - (bitIndex % 8)))) !== 0;

export const setMapNodeBit = (mask, bitIndex) => {
  const bytes = Array.from(mask ?? "", (character) => character.charCodeAt(0) & 0xff);
  const index = bitIndex >> 3;
  while (bytes.length <= index) bytes.push(0);
  bytes[index] |= 1 << (7 - (bitIndex % 8));
  return bytes.map((byte) => String.fromCharCode(byte)).join("");
};

/**
 * The bits the boss nodes own, and the trophy count a mask carries.
 *
 * A trophy is the first clear of a boss node, one each, and the map has twelve
 * of them. The honest total is the union of every hero's own clears — one
 * hero's mask, another hero's mask, all of them laid over each other — read
 * off the bits rather than kept as a column a legacy import can leave short.
 */
export const bossNodeBits = (gm) =>
  new Set(
    (gm?.raw?.MapPage ?? [])
      .filter((node) => node.NodeType === "BOSS" && Number.isFinite(Number(node.BitIndex)))
      .map((node) => Number(node.BitIndex))
  );

/** Every mask laid over the others: a bit stands if any hero earned it. */
export const unionMapNodeMasks = (...masks) => {
  const bytes = [];
  for (const mask of masks) {
    Array.from(mask ?? "", (character) => character.charCodeAt(0) & 0xff).forEach(
      (byte, index) => {
        bytes[index] = (bytes[index] ?? 0) | byte;
      }
    );
  }
  return bytes.map((byte) => String.fromCharCode(byte)).join("");
};

export const trophiesFor = (mask, gm) => {
  let total = 0;
  for (const bit of bossNodeBits(gm)) {
    if (getMapNodeBit(mask, bit)) total += 1;
  }
  return total;
};

/** The trophies of an account: every hero's clears, unioned. */
export const accountTrophies = (account, gm) =>
  trophiesFor(
    unionMapNodeMasks(
      account.completed_mapnode_mask,
      ...(account.account_avatars ?? []).map((avatar) => avatar.completed_mapnode_mask)
    ),
    gm
  );
