/**
 * Floating point.
 *
 * A 7094 float is a sign, an eight-bit characteristic in excess-128, and a
 * 27-bit fraction: ±0.f × 2^(c-128). Double precision pairs two such words and
 * carries a 54-bit fraction. Every operation here works in that 54-bit domain,
 * single precision simply leaving the low 27 bits zero — which is how the
 * hardware does it too, and why FAD leaves a low-order remainder in the MQ.
 *
 * The fractions are BigInt. A 54-bit product is 108 bits, well past what a
 * double holds exactly, and a wrong bit in a characteristic is the kind of fault
 * that shows up as a MAD program printing plausible nonsense a thousand
 * instructions later. Floating point is not in ELIZA's inner loop — SLIP is
 * integer list work — so the allocation cost buys correctness cheaply. The
 * integer paths in arith.js stay on plain numbers.
 *
 * Structure follows s709's arith.c, which in turn follows Bob Supnik's SIMH
 * routines; the odd corners (AC bit P forcing a negative sign on a swap, the
 * early-outs in double add) are the hardware's, not embellishments.
 */

import { HALF, SIGN, AC_HI } from './word.js';

const FRACSHIFT = 27n;
const FRACMASK = (1n << 27n) - 1n;       // one word's fraction
const DFRACMASK = (1n << 54n) - 1n;      // the double-length fraction
const DNRMMASK = 1n << 53n;              // top bit: set when normalised
const DCRYMASK = 1n << 54n;              // carry out of the fraction
/**
 * Word bit 9 — the top bit of a fraction, and the bit the round instructions
 * test. Bits 9-17 live in the high half, so it is 0o400 there.
 */
const NRMBIT = 0o400;
const HIADD = 1n << 27n;                 // one in the low word's top place

/** Spill flags, examined by the CPU after each instruction. */
export const SPILL = { MQ: 1, AC: 2, OVERFLOW: 4, SINGLE: 8, DIVIDE: 16, ODD: 32 };

/**
 * Build the 54-bit fraction from a high word and an optional low word. Word
 * bits 9-17 sit in the high half, bits 18-35 in the low half.
 */
function fraction(hi, lo, hi2, lo2) {
  const high = (BigInt(hi & 0o777) << 18n) | BigInt(lo);
  const low = (BigInt(hi2 & 0o777) << 18n) | BigInt(lo2);
  return (high << FRACSHIFT) | low;
}

/** Unpack an ordinary word: sign, eight-bit characteristic, fraction. */
function unpackWord(hi, lo, hi2 = 0, lo2 = 0) {
  return {
    sign: (hi & SIGN) ? 1 : 0,
    exp: (hi & 0o377000) >>> 9,
    frac: fraction(hi, lo, hi2, lo2),
  };
}

/**
 * Unpack the accumulator. Its characteristic is ten bits, Q,P,1-8, because Q
 * and P catch the overflow a floating point operation can produce — which is
 * what lets the range check in `packAC` see it at all.
 */
function unpackAC(cpu, withMQ) {
  return {
    sign: cpu.acS,
    exp: cpu.acHi >>> 9,
    frac: fraction(cpu.acHi, cpu.acLo,
      withMQ ? cpu.mqHi : 0, withMQ ? cpu.mqLo : 0),
  };
}

/** Unpack the storage register, optionally with its second word. */
function unpackSR(cpu, withSecond) {
  return unpackWord(cpu.srHi, cpu.srLo,
    withSecond ? cpu.sr2Hi : 0, withSecond ? cpu.sr2Lo : 0);
}

/** Normalise: shift the fraction up until its top bit is set. */
function normalize(op) {
  op.frac &= DFRACMASK;
  if (op.frac === 0n) return;
  while ((op.frac & DNRMMASK) === 0n) {
    op.frac <<= 1n;
    op.exp -= 1;
  }
}

/** Divide a 54-bit fraction by the high half of another. */
function fracdiv(dividend, divisor) {
  const d = divisor >> FRACSHIFT;
  return { quotient: dividend / d, remainder: dividend % d };
}

/**
 * Store a result into AC and, when `mqExp` is given, MQ. `test` asks for the
 * characteristic to be range-checked, which is what raises the spill the CPU
 * turns into a floating point trap.
 */
function packAC(cpu, op, toMQ, mqSign, mqExp, test) {
  cpu.acS = op.sign ? 1 : 0;
  cpu.acHi = (((op.exp << 9) & 0o1777000) | Number((op.frac >> 45n) & 0o777n))
    & AC_HI;
  cpu.acLo = Number((op.frac >> FRACSHIFT) & 0o777777n);

  if (toMQ) {
    cpu.mqHi = (mqSign ? SIGN : 0) | ((mqExp << 9) & 0o377000)
      | Number((op.frac >> 18n) & 0o777n);
    cpu.mqLo = Number(op.frac & 0o777777n);
  }

  if (test) {
    let spill = 0;
    if (op.exp > 0o377) spill = SPILL.AC | SPILL.OVERFLOW;
    else if (op.exp < 0) spill = SPILL.AC;
    if (toMQ) {
      if (mqExp > 0o377) spill |= SPILL.MQ | SPILL.OVERFLOW;
      else if (mqExp < 0) spill |= SPILL.MQ;
    }
    cpu.spill = spill;
  }
}

/** Pack into the sense indicator register, where the double routines park a
 *  spare operand exactly as the hardware does. */
function packSI(cpu, op) {
  cpu.siHi = (op.sign ? SIGN : 0) | ((op.exp << 9) & 0o377000)
    | Number((op.frac >> 45n) & 0o777n);
  cpu.siLo = Number((op.frac >> FRACSHIFT) & 0o777777n);
}

/** FAD, FSB, FAM, FSM and their unnormalised counterparts UFA, UFS, UAM, USM. */
export function add(cpu, nrm) {
  let op1 = unpackAC(cpu, false);
  let op2 = unpackSR(cpu, false);
  cpu.mqHi = 0;
  cpu.mqLo = 0;
  // AC bit P forces the accumulator operand negative when the operands swap.
  const acP = (cpu.acHi & 0o400000) ? 1 : 0;

  if (op1.exp > op2.exp) {
    if (acP) op1.sign = 1;
    const t = op1; op1 = op2; op2 = t;
    op2.exp &= 0o377;
  }

  const diff = op2.exp - op1.exp;
  if (diff) {
    if (diff < 0 || diff > 0o77) op1.frac = 0n;
    else op1.frac >>= BigInt(diff);
  }

  if (op1.sign ^ op2.sign) {
    if (op1.frac >= op2.frac) {
      op2.frac = op1.frac - op2.frac;
      op2.sign = op1.sign;
    } else {
      op2.frac -= op1.frac;
    }
  } else {
    op2.frac += op1.frac;
    if (op2.frac & DCRYMASK) {
      op2.frac >>= 1n;
      op2.exp += 1;
    }
  }

  let mqExp;
  if (nrm) {
    if (op2.frac) {
      normalize(op2);
      mqExp = op2.exp - 27;
    } else {
      op2.exp = 0;
      mqExp = 0;
    }
  } else {
    mqExp = op2.exp - 27;
  }

  packAC(cpu, op2, true, op2.sign, mqExp, true);
}

/** FRN — round the accumulator on the MQ's high fraction bit. */
export function floatingRound(cpu) {
  const op = unpackAC(cpu, false);
  const roundBit = cpu.mqHi & NRMBIT;
  cpu.spill = 0;
  if (!roundBit) return;
  op.frac += HIADD;
  if (op.frac & DCRYMASK) {
    op.frac >>= 1n;
    op.exp += 1;
  }
  packAC(cpu, op, false, 0, 0, false);
}

/** FMP and UFM. The multiplier comes from the MQ, not the accumulator. */
export function multiply(cpu, nrm) {
  const op1 = unpackWord(cpu.mqHi, cpu.mqLo);
  const op2 = unpackSR(cpu, false);

  op1.sign ^= op2.sign;
  if (op2.exp === 0 && op2.frac === 0n) {
    cpu.acS = op1.sign; cpu.acHi = 0; cpu.acLo = 0;
    cpu.mqHi = op1.sign ? SIGN : 0; cpu.mqLo = 0;
    return;
  }

  const f1 = (op1.frac >> FRACSHIFT) & FRACMASK;
  const f2 = (op2.frac >> FRACSHIFT) & FRACMASK;
  op1.frac = f1 * f2;
  op1.exp = (op1.exp & 0o377) + op2.exp - 0o200;

  let mqExp;
  if (nrm) {
    if (!(op1.frac & DNRMMASK)) {
      op1.frac <<= 1n;
      op1.exp -= 1;
    }
    if ((op1.frac >> FRACSHIFT) & FRACMASK) mqExp = op1.exp - 27;
    else { op1.exp = 0; mqExp = 0; }
  } else {
    mqExp = op1.exp - 27;
  }

  packAC(cpu, op1, true, op1.sign, mqExp, true);
}

/** FDP and FDH. Quotient to the MQ, remainder to the AC. */
export function divide(cpu) {
  cpu.divideCheck = false;
  const op1 = unpackAC(cpu, false);
  const op2 = unpackSR(cpu, false);
  const sign = op1.sign ^ op2.sign;

  if (op1.frac >= 2n * op2.frac) {
    cpu.mqHi = sign ? SIGN : 0;
    cpu.mqLo = 0;
    cpu.divideCheck = true;
    return;
  }
  if (op1.frac === 0n) {
    cpu.mqHi = sign ? SIGN : 0;
    cpu.mqLo = 0;
    cpu.acS = 0; cpu.acHi = 0; cpu.acLo = 0;
    return;
  }

  op1.exp &= 0o377;
  if (op1.frac >= op2.frac) {
    op1.frac >>= 1n;
    op1.exp += 1;
  }
  const { quotient, remainder } = fracdiv(op1.frac, op2.frac);
  op1.frac = quotient | (remainder << FRACSHIFT);
  const mqExp = op1.exp - op2.exp + 0o200;
  op1.exp -= 27;

  packAC(cpu, op1, true, sign, mqExp, true);
  if (cpu.spill) cpu.spill |= SPILL.SINGLE;
}

/** DFAD, DFSB, DFAM, DFSM and the unnormalised DUFA, DUFS, DUAM, DUSM. */
export function addDouble(cpu, nrm) {
  let op1 = unpackAC(cpu, true);
  let op2 = unpackSR(cpu, true);
  const acP = (cpu.acHi & 0o400000) ? 1 : 0;
  const acBit9 = (cpu.acHi & NRMBIT) !== 0;
  const srBit9 = (cpu.srHi & NRMBIT) !== 0;

  if (op1.exp > op2.exp) {
    // The hardware skips parking the operand when it is about to be shifted
    // entirely away; the sense indicator keeps whatever was there.
    if (!((op1.exp - op2.exp) > 0o100 && acBit9)) packSI(cpu, op1);
    if (acP) op1.sign = 1;
    const t = op1; op1 = op2; op2 = t;
    op2.exp &= 0o377;
  } else if ((op2.exp - op1.exp) > 0o77 && srBit9) {
    packSI(cpu, {
      sign: op2.sign,
      exp: op2.exp,
      frac: (BigInt(cpu.mqHi & 0o777) << 18n | BigInt(cpu.mqLo)) << FRACSHIFT,
    });
  } else {
    packSI(cpu, op2);
  }

  const diff = op2.exp - op1.exp;
  if (diff) {
    if (diff < 0 || diff > 0o77) op1.frac = 0n;
    else op1.frac >>= BigInt(diff);
  }

  if (op1.sign ^ op2.sign) {
    if (op1.frac >= op2.frac) {
      op2.frac = op1.frac - op2.frac;
      op2.sign = op1.sign;
    } else {
      op2.frac -= op1.frac;
    }
  } else {
    op2.frac += op1.frac;
    if (op2.frac & DCRYMASK) {
      op2.frac >>= 1n;
      op2.exp += 1;
    }
  }

  let mqExp;
  if (nrm) {
    if (op2.frac) { normalize(op2); mqExp = op2.exp - 27; }
    else { op2.exp = 0; mqExp = 0; }
  } else {
    mqExp = op2.exp - 27;
  }

  packAC(cpu, op2, true, op2.sign, mqExp, true);
}

/** DFMP and DUFM. */
export function multiplyDouble(cpu, nrm) {
  const op1 = unpackAC(cpu, true);
  const op2 = unpackSR(cpu, true);

  op1.sign ^= op2.sign;
  const f1h = (op1.frac >> FRACSHIFT) & FRACMASK;
  const f1l = op1.frac & FRACMASK;
  const f2h = (op2.frac >> FRACSHIFT) & FRACMASK;
  const f2l = op2.frac & FRACMASK;

  if ((op1.exp === 0 && op1.frac === 0n)
    || (op2.exp === 0 && op2.frac === 0n)
    || (f1h === 0n && f2h === 0n)) {
    cpu.acS = op1.sign; cpu.acHi = 0; cpu.acLo = 0;
    cpu.mqHi = op1.sign ? SIGN : 0; cpu.mqLo = 0;
    cpu.siHi = cpu.srHi; cpu.siLo = cpu.srLo;
    return;
  }

  op1.exp = (op1.exp & 0o377) + op2.exp - 0o200;
  if (op1.frac) {
    const cross = f1l * f2h;
    op1.frac = f1h * f2h + ((f1h * f2l) >> FRACSHIFT) + (cross >> FRACSHIFT);
    const tx = cross >> FRACSHIFT;
    cpu.siHi = Number((tx >> 18n) & BigInt(HALF));
    cpu.siLo = Number(tx & BigInt(HALF));
  } else if (nrm) {
    cpu.siHi = cpu.srHi;
    cpu.siLo = cpu.srLo;
  } else {
    packSI(cpu, { sign: op2.sign, exp: op2.exp, frac: 0n });
  }

  let mqExp;
  if (nrm) {
    if (!(op1.frac & DNRMMASK)) { op1.frac <<= 1n; op1.exp -= 1; }
    if ((op1.frac >> FRACSHIFT) & FRACMASK) mqExp = op1.exp - 27;
    else { op1.exp = 0; mqExp = 0; }
  } else {
    mqExp = op1.exp - 27;
  }

  packAC(cpu, op1, true, op1.sign, mqExp, true);
}

/** DFDP and DFDH. */
export function divideDouble(cpu) {
  cpu.divideCheck = false;
  const op1 = unpackAC(cpu, true);
  const op2 = unpackSR(cpu, false);
  const sr2frac = (BigInt(cpu.sr2Hi & 0o777) << 18n) | BigInt(cpu.sr2Lo);

  const acSign = op1.sign;
  op1.sign ^= op2.sign;
  const f1h = (op1.frac >> FRACSHIFT) & FRACMASK;
  const f2h = (op2.frac >> FRACSHIFT) & FRACMASK;

  if (f1h >= 2n * f2h) {
    cpu.siHi = 0; cpu.siLo = 0;
    cpu.divideCheck = true;
    return;
  }
  if (f1h === 0n) {
    cpu.siHi = cpu.mqHi = op1.sign ? SIGN : 0;
    cpu.siLo = cpu.mqLo = 0;
    cpu.acS = op1.sign; cpu.acHi = 0; cpu.acLo = 0;
    return;
  }

  op1.exp &= 0o377;
  if (f1h >= f2h) { op1.frac >>= 1n; op1.exp += 1; }
  op1.exp = op1.exp - op2.exp + 0o200;

  const first = fracdiv(op1.frac, op2.frac);
  const tq1 = first.quotient;
  const tr = first.remainder << FRACSHIFT;
  const tq1d = (tq1 * sr2frac) & ~FRACMASK;
  const borrowed = tr < tq1d;
  const trmq1d = borrowed ? tq1d - tr : tr - tq1d;

  packSI(cpu, { sign: op1.sign, exp: op1.exp, frac: tq1 << FRACSHIFT });

  if (trmq1d >= 2n * op2.frac) {
    const sign = borrowed ^ acSign;
    packAC(cpu, { sign, exp: 0, frac: trmq1d }, false, 0, 0, false);
    cpu.mqHi = sign ? SIGN : 0;
    cpu.mqLo = 0;
    cpu.spill = 0;
    cpu.divideCheck = true;
    return;
  }

  let tq2 = fracdiv(trmq1d, op2.frac).quotient;
  if (trmq1d >= op2.frac) tq2 &= ~1n;
  op1.frac = tq1 << FRACSHIFT;
  op1.frac = borrowed ? op1.frac - tq2 : op1.frac + tq2;
  normalize(op1);

  let mqExp;
  if (op1.frac) mqExp = op1.exp - 27;
  else { op1.exp = 0; mqExp = 0; }

  packAC(cpu, op1, true, op1.sign, mqExp, true);
}
