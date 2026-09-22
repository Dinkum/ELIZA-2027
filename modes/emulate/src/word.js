/**
 * The 36-bit word.
 *
 * The 7094 word is S,1-35: a sign bit and thirty-five magnitude bits. JavaScript
 * has no 36-bit integer, and its bitwise operators silently truncate to 32 bits,
 * so every word here is carried as two 18-bit halves:
 *
 *     hi   bits S,1-17     (18 bits, sign in bit 17 of the half)
 *     lo   bits 18-35      (18 bits)
 *
 * The split is not arbitrary. It falls on the boundaries the instruction format
 * already uses, so decoding is masking rather than arithmetic:
 *
 *     prefix     S,1,2     hi >> 15
 *     opcode     S,1-11    hi >> 6
 *     decrement  3-17      hi & 077777
 *     flag       12,13     (hi >> 4) & 3
 *     tag        18-20     lo >> 15
 *     address    21-35     lo & 077777
 *
 * The accumulator is the exception: it is 38 bits, S,Q,P,1-35. Its overflow bits
 * Q and P sit immediately above bit 1, so AC is carried as a sign plus a 19-bit
 * high half (Q,P,1-17) and the same 18-bit low half. That makes the logical
 * instructions free: CAL copies a memory word's hi half straight into AC's high
 * half, and the memory sign bit lands exactly on AC bit P, which is what the
 * hardware does.
 *
 * Reference: IBM 7090/7094 Principles of Operation (A22-6703), and the portable
 * 32-bit path of Dave Pitts' s709, which splits the word the same way.
 */

/** Mask for one 18-bit half. */
export const HALF = 0o777777;

/** Sign bit, as it sits inside the high half. */
export const SIGN = 0o400000;

/** Magnitude bits of the high half: bits 1-17. */
export const MAG_HI = 0o377777;

/** Address and decrement fields are both 15 bits. */
export const ADDR = 0o77777;

/** Accumulator bit P, as it sits inside AC's 19-bit high half. */
export const AC_P = 0o400000;

/** Accumulator bit Q, one place above P. */
export const AC_Q = 0o1000000;

/** Q and P together, the two bits above bit 1. */
export const AC_QP = AC_Q | AC_P;

/** Every bit of AC's high half: Q,P,1-17. */
export const AC_HI = 0o1777777;

/** Core is 32768 words. CTSS machines have a second bank, the B core. */
export const CORE_SIZE = 0o100000;

/**
 * Format a word as the twelve octal digits an operator would read off the
 * console lights, sign included as the leading digit.
 */
export function octal(hi, lo) {
  const digits = ((hi >>> 15) & 7).toString(8)
    + (hi & 0o77777).toString(8).padStart(5, '0')
    + lo.toString(8).padStart(6, '0');
  return digits;
}

/** Format a 15-bit address the way CTSS listings do: five octal digits. */
export function octal5(value) {
  return (value & ADDR).toString(8).padStart(5, '0');
}

/**
 * Parse twelve octal digits back into a word. Accepts the leading sign digit
 * that `octal` emits, and shorter strings are right-aligned like a keyed-in
 * console entry.
 */
export function parseOctal(text) {
  const digits = text.trim().replace(/^[+]/, '').padStart(12, '0');
  const value = BigInt('0o' + digits);
  return {
    hi: Number((value >> 18n) & BigInt(HALF)),
    lo: Number(value & BigInt(HALF)),
  };
}

/**
 * True when the word is the arithmetic zero the 7094 tests for. Note that minus
 * zero (sign set, magnitude clear) is a distinct bit pattern but compares equal
 * here, which is what ZET and friends do.
 */
export function isZero(hi, lo) {
  return (hi & MAG_HI) === 0 && lo === 0;
}
