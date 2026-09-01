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
 * of them — so the honest total is read straight off the mask rather than kept
 * as a column that a legacy import can leave short of it. The account's own
 * mask is the union of its heroes' (rewards.js writes both, the account's
 * never behind), so the account mask alone is the whole answer.
 */
export const bossNodeBits = (gm) =>
  new Set(
    (gm?.raw?.MapPage ?? [])
      .filter((node) => node.NodeType === "BOSS" && Number.isFinite(Number(node.BitIndex)))
      .map((node) => Number(node.BitIndex))
  );

export const trophiesFor = (mask, gm) => {
  let total = 0;
  for (const bit of bossNodeBits(gm)) {
    if (getMapNodeBit(mask, bit)) total += 1;
  }
  return total;
};
