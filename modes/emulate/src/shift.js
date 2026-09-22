/**
 * The shift instructions.
 *
 * The 7094 shifts a 37-bit accumulator (Q,P,1-35) and, for the long shifts, a
 * 72-bit AC/MQ pair. Both sit awkwardly across the two 18-bit halves the rest of
 * the emulator uses, so the short shifts are done arithmetically — 37 bits fit
 * exactly in a double, and `(v mod 2^(37-n)) * 2^n` keeps the product inside the
 * 53-bit range without ever losing a bit — while the long shifts run the
 * hardware's one-place-at-a-time loop. The loop is not just simpler for 72 bits:
 * LLS sets AC overflow each time a one arrives in P, which a bulk shift cannot
 * observe.
 *
 * Shift counts come from the low eight bits of the effective address. All of
 * these instructions ignore the indirect-address flag bits, which is why the CPU
 * keeps them out of indirection (see NEVER_INDIRECT in cpu.js).
 */

import { HALF, SIGN, MAG_HI, AC_P, AC_HI } from './word.js';

const HALF_SCALE = 0o1000000;   // 2^18, the weight of the high half
const P2 = [];
for (let i = 0; i <= 72; i++) P2[i] = Math.pow(2, i);

/** AC's Q,P,1-35 as one exact 37-bit number. */
function acValue(cpu) {
  return cpu.acHi * HALF_SCALE + cpu.acLo;
}

/** Put a 37-bit value back into AC's two halves. */
function setAC(cpu, value) {
  cpu.acHi = Math.floor(value / HALF_SCALE) & AC_HI;
  cpu.acLo = value % HALF_SCALE;
}

/** ALS — shift AC(Q,P,1-35) left. Sign untouched. */
export function als(cpu, count) {
  const n = count & 0o377;
  if (n === 0) return;
  const mag = (cpu.acHi & MAG_HI) * HALF_SCALE + cpu.acLo;
  // Overflow when a one is shifted into or through position P.
  if (n >= 35 ? mag !== 0 : Math.floor(mag / P2[35 - n]) !== 0) {
    cpu.acOverflow = true;
  }
  if (n >= 37) {
    cpu.acHi = 0;
    cpu.acLo = 0;
    return;
  }
  setAC(cpu, (acValue(cpu) % P2[37 - n]) * P2[n]);
}

/** ARS — shift AC(Q,P,1-35) right. Sign untouched, bits fall off the end. */
export function ars(cpu, count) {
  const n = count & 0o377;
  if (n === 0) return;
  if (n >= 37) {
    cpu.acHi = 0;
    cpu.acLo = 0;
    return;
  }
  setAC(cpu, Math.floor(acValue(cpu) / P2[n]));
}

/**
 * LLS — long left shift of AC(Q,P,1-35) and MQ(1-35) as one 72-bit register.
 * Zeros enter MQ position 35; AC's sign is replaced by the MQ's.
 */
export function lls(cpu, count) {
  let n = count & 0o377;
  while (n--) {
    cpu.acHi = ((cpu.acHi << 1) | (cpu.acLo >>> 17)) & AC_HI;
    cpu.acLo = ((cpu.acLo << 1) & HALF) | ((cpu.mqHi >>> 16) & 1);
    cpu.mqHi = (cpu.mqHi & SIGN) | (((cpu.mqHi << 1) & MAG_HI) | (cpu.mqLo >>> 17));
    cpu.mqLo = (cpu.mqLo << 1) & HALF;
    if (cpu.acHi & AC_P) cpu.acOverflow = true;
  }
  cpu.acS = (cpu.mqHi & SIGN) ? 1 : 0;
}

/**
 * LRS — long right shift of AC(Q,P,1-35) and MQ(1-35). Bits leaving MQ position
 * 35 are lost; the MQ's sign is replaced by the AC's.
 */
export function lrs(cpu, count) {
  let n = count & 0o377;
  while (n--) {
    cpu.mqLo = ((cpu.mqLo >>> 1) | ((cpu.mqHi & 1) << 17)) & HALF;
    cpu.mqHi = (cpu.mqHi & SIGN) | (((cpu.mqHi & MAG_HI) >>> 1) | ((cpu.acLo & 1) << 16));
    cpu.acLo = ((cpu.acLo >>> 1) | ((cpu.acHi & 1) << 17)) & HALF;
    cpu.acHi = cpu.acHi >>> 1;
  }
  cpu.mqHi = (cpu.acS ? SIGN : 0) | (cpu.mqHi & MAG_HI);
}

/**
 * LGL — logical left shift. Like LLS but the MQ sign takes part in the shift
 * rather than being copied, so bits travel from MQ sign into AC position 35.
 */
export function lgl(cpu, count) {
  let n = count & 0o377;
  while (n--) {
    cpu.acHi = ((cpu.acHi << 1) | (cpu.acLo >>> 17)) & AC_HI;
    cpu.acLo = ((cpu.acLo << 1) & HALF) | ((cpu.mqHi >>> 17) & 1);
    cpu.mqHi = ((cpu.mqHi << 1) & HALF) | (cpu.mqLo >>> 17);
    cpu.mqLo = (cpu.mqLo << 1) & HALF;
    if (cpu.acHi & AC_P) cpu.acOverflow = true;
  }
}

/** LGR — logical right shift of AC(Q,P,1-35) and the whole 36-bit MQ. */
export function lgr(cpu, count) {
  let n = count & 0o377;
  while (n--) {
    cpu.mqLo = ((cpu.mqLo >>> 1) | ((cpu.mqHi & 1) << 17)) & HALF;
    cpu.mqHi = ((cpu.mqHi >>> 1) | ((cpu.acLo & 1) << 17)) & HALF;
    cpu.acLo = ((cpu.acLo >>> 1) | ((cpu.acHi & 1) << 17)) & HALF;
    cpu.acHi = cpu.acHi >>> 1;
  }
}

/** RQL — rotate the 36-bit MQ left, sign position included. */
export function rql(cpu, count) {
  let n = count & 0o377;
  while (n--) {
    const carry = (cpu.mqHi >>> 17) & 1;
    cpu.mqHi = ((cpu.mqHi << 1) & HALF) | (cpu.mqLo >>> 17);
    cpu.mqLo = ((cpu.mqLo << 1) & HALF) | carry;
  }
}
