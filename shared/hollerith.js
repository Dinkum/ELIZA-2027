/**
 * Hollerith (BCD) encoding and the SLIP mid-square HASH.
 *
 * Machine facts about the IBM 7094, shared by every mode rather than owned by
 * one: the character codes and the hash are properties of the hardware and of
 * SLIP, not of any particular reading of ELIZA.
 *
 * ELIZA picks which of the four MEMORY transformations to use by hashing the
 * last cell of the input sentence:
 *
 *     I=HASH.(BOT.(INPUT),2)+1                                        001230
 *
 * Reproducing that choice needs the 7094's 6-bit character codes and SLIP's
 * HASH, so both are kept here rather than being replaced by a modern hash.
 * Everything else in this engine is ordinary JavaScript.
 *
 * Sources: the recovered MAD listing (references/1965b-MIT-original-printout.pdf)
 * and the original FAP SLIP HASH (references/1960s-MIT-FAP-original.pdf, p. 15).
 * The searchable HASH transcription is in
 * references/1965b-CTSS-reconstruction/eliza/src/SLIP/SLIP-fap/hash.fap.
 */

// IBM 7090 BCD, code -> character. Code 14 (octal) is a prime, not a quote.
const BCD_CHARS = [
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '', '=', "'", '', '', '',
  '+', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', '', '.', ')', '', '', '',
  '-', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', '', '$', '*', '', '', '',
  ' ', '/', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', '', ',', '(', '', '', '',
];

const TO_BCD = new Map();
BCD_CHARS.forEach((ch, code) => {
  if (ch) TO_BCD.set(ch, code);
});

/** True if the character exists in the 7090 Hollerith set. */
export function isHollerith(ch) {
  return TO_BCD.has(ch);
}

/**
 * Encode the last SLIP cell of a word as a 36-bit BCD datum.
 * SLIP packed six characters per cell, so a word longer than six characters
 * spilled into further cells and only the final chunk is hashed.
 */
export function lastChunkAsBcd(word) {
  const chunk = word.slice(Math.floor(Math.max(word.length - 1, 0) / 6) * 6);
  const padded = (chunk + '      ').slice(0, 6);
  let result = 0n;
  for (const ch of padded) {
    const code = TO_BCD.has(ch) ? TO_BCD.get(ch) : ch.charCodeAt(0) & 0x3f;
    result = (result << 6n) | BigInt(code);
  }
  return result;
}

/**
 * SLIP HASH: the middle n bits of d squared.
 * The 7094 is sign-magnitude, so only the low 35 bits take part in the square.
 */
export function hash(d, n) {
  let value = BigInt(d) & 0x7ffffffffn;
  value *= value;
  value >>= BigInt(35 - Math.floor(n / 2));
  return Number(value & ((1n << BigInt(n)) - 1n));
}

/** hash(lastChunkAsBcd(word), n) — the form ELIZA actually calls. */
export function hashWord(word, n) {
  return hash(lastChunkAsBcd(word), n);
}
