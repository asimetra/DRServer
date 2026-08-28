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
