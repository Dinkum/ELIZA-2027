/**
 * BCD character codes.
 *
 * The 7094 has no bytes. Characters are six bits, six to a word, in the coding
 * the card punches used — so 'A' is 21 octal, not 65, and the digits come
 * first. Two tables were in use and CTSS wants both: the IBSYS coding, and the
 * "alternate" coding that the 7320 drum and the commercial peripherals used,
 * in which the zone bits are swapped around.
 *
 * The emulator's typewriter and tape units translate through here. Note this is
 * a different job from shared/hollerith.js, which exists only so the
 * JavaScript ELIZA can reproduce SLIP's HASH; that one encodes ELIZA's own
 * words, this one encodes what moves across a channel.
 *
 * Source: the tables in Dave Pitts' s709 (include/nativebcd.h), which carry the
 * CTSS-era additions.
 */

/** BCD code to character, IBSYS coding. Index is the six-bit code. */
export const TO_NATIVE = [
  '0', '1', '2', '3', '4', '5', '6', '7',
  '8', '9', ' ', '=', "'", ' ', ' ', ' ',
  '+', 'A', 'B', 'C', 'D', 'E', 'F', 'G',
  'H', 'I', '?', '.', ')', ':', ' ', ' ',
  '-', 'J', 'K', 'L', 'M', 'N', 'O', 'P',
  'Q', 'R', '!', '$', '*', ' ', ' ', ' ',
  ' ', '/', 'S', 'T', 'U', 'V', 'W', 'X',
  'Y', 'Z', ' ', ',', '(', ' ', ' ', ' ',
];

/** BCD code to character, alternate coding. */
export const TO_NATIVE_ALT = [
  ' ', '1', '2', '3', '4', '5', '6', '7',
  '8', '9', '0', '=', "'", ':', '>', '{',
  ' ', '/', 'S', 'T', 'U', 'V', 'W', 'X',
  'Y', 'Z', '|', ',', '(', '~', '\\', '"',
  '-', 'J', 'K', 'L', 'M', 'N', 'O', 'P',
  'Q', 'R', '!', '$', '*', ']', ';', '_',
  '+', 'A', 'B', 'C', 'D', 'E', 'F', 'G',
  'H', 'I', '?', '.', ')', '[', '<', '}',
];

function invert(table) {
  const map = new Map();
  table.forEach((ch, code) => {
    if (!map.has(ch)) map.set(ch, code);
  });
  // A blank is code 60 in the IBSYS table, which comes after several unused
  // codes that also decode to a blank; make sure the canonical one wins.
  return map;
}

const FROM_NATIVE = invert(TO_NATIVE);
const FROM_NATIVE_ALT = invert(TO_NATIVE_ALT);
FROM_NATIVE.set(' ', 0o60);
FROM_NATIVE_ALT.set(' ', 0o00);

/** Character to BCD code. Anything unrecognised becomes a blank. */
export function toBCD(character, alternate = false) {
  const table = alternate ? FROM_NATIVE_ALT : FROM_NATIVE;
  const code = table.get((character || ' ').toUpperCase());
  return code === undefined ? (alternate ? 0o00 : 0o60) : code;
}

/** BCD code to character. */
export function fromBCD(code, alternate = false) {
  return (alternate ? TO_NATIVE_ALT : TO_NATIVE)[code & 0o77];
}

/** Decode a 36-bit word as the six characters it holds. */
export function wordToText(hi, lo, alternate = false) {
  const table = alternate ? TO_NATIVE_ALT : TO_NATIVE;
  return table[(hi >>> 12) & 0o77] + table[(hi >>> 6) & 0o77] + table[hi & 0o77]
    + table[(lo >>> 12) & 0o77] + table[(lo >>> 6) & 0o77] + table[lo & 0o77];
}

/** Encode six characters as a word, padding with blanks. */
export function textToWord(text, alternate = false) {
  const padded = (text + '      ').slice(0, 6);
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < 3; i++) hi = (hi << 6) | toBCD(padded[i], alternate);
  for (let i = 3; i < 6; i++) lo = (lo << 6) | toBCD(padded[i], alternate);
  return [hi, lo];
}
