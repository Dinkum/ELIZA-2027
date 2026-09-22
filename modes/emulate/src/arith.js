/**
 * Fixed-point arithmetic.
 *
 * Multiply and divide are written as the hardware's shift-and-add loops rather
 * than as single JavaScript operations. That is not nostalgia: the product of
 * two 35-bit magnitudes is 70 bits, which a double cannot hold exactly, and the
 * variable-length instructions VLM and VDP stop the loop early by design. Doing
 * it a bit at a time gets both right for free, and costs a few dozen integer
 * operations per instruction.
 *
 * Addition lives on the CPU itself (`addToAC`) because so many instructions
 * reach for it.
 */

import { HALF, SIGN, MAG_HI, AC_Q, AC_HI } from './word.js';

/** MQ bit 1, as it sits in the high half. */
const MQ_BIT1 = 0o200000;

/**
 * RND — add one to AC if MQ bit 1 is set. `useAdd` routes through the
 * accumulator adder so the sign and overflow logic apply; the floating point
 * round bypasses it.
 */
export function round(cpu, useAdd) {
  if (!(cpu.mqHi & MQ_BIT1)) return;
  if (useAdd) {
    cpu.srHi = 0;
    cpu.srLo = 1;
    cpu.addToAC();
  } else {
    cpu.acLo += 1;
    if (cpu.acLo > HALF) {
      cpu.acLo = 0;
      cpu.acHi = (cpu.acHi + 1) & AC_HI;
    }
  }
}

/**
 * MPY and its relatives. The multiplier is in MQ, the multiplicand in the
 * storage register; the 70-bit product ends up with its high half in AC(1-35)
 * and its low half in MQ(1-35). `count` is 35 for MPY and MPR, and comes from
 * the address field for VLM.
 */
export function multiply(cpu, count) {
  if (count === 0) return;

  const sign = ((cpu.mqHi & SIGN) ? 1 : 0) ^ ((cpu.srHi & SIGN) ? 1 : 0);
  const bHi = cpu.srHi & MAG_HI;
  const bLo = cpu.srLo;
  let mHi = cpu.mqHi & MAG_HI;
  let mLo = cpu.mqLo;
  let pHi = 0;
  let pLo = 0;

  if ((bHi | bLo) === 0 || (mHi | mLo) === 0) {
    mHi = 0;
    mLo = 0;
  } else {
    for (let i = count; i > 0; i--) {
      if (mLo & 1) {
        pLo += bLo;
        pHi += bHi + (pLo >>> 18);
        pLo &= HALF;
        pHi &= AC_HI;
      }
      // Shift MQ right one place, taking the bit falling out of the partial
      // product into MQ position 1.
      mLo = ((mLo >>> 1) | ((mHi & 1) << 17)) & HALF;
      mHi = ((mHi >>> 1) | ((pLo & 1) << 16)) & MAG_HI;
      pLo = ((pLo >>> 1) | ((pHi & 1) << 17)) & HALF;
      pHi = pHi >>> 1;
    }
  }

  cpu.acS = sign;
  cpu.acHi = pHi;
  cpu.acLo = pLo;
  cpu.mqHi = (sign ? SIGN : 0) | mHi;
  cpu.mqLo = mLo;
}

/**
 * DVH, DVP and the variable-length divides. AC and MQ hold a 72-bit dividend,
 * the storage register the divisor; the quotient lands in MQ and the remainder
 * in AC. A magnitude in AC not smaller than the divisor would overflow the
 * quotient, so the machine refuses and turns on the divide-check indicator.
 *
 * Returns true if the division was performed, false on a divide check — the
 * caller needs to know because DVH halts and DVP does not.
 */
export function divide(cpu, count) {
  cpu.divideCheck = false;
  if (count === 0) return true;

  const acSign = cpu.acS;
  const quotientSign = acSign ^ ((cpu.srHi & SIGN) ? 1 : 0);
  const dHi = cpu.srHi & MAG_HI;
  const dLo = cpu.srLo;

  let aHi = cpu.acHi;
  let aLo = cpu.acLo;
  if (aHi > dHi || (aHi === dHi && aLo >= dLo)) {
    cpu.divideCheck = true;
    return false;
  }

  let qHi = cpu.mqHi & MAG_HI;
  let qLo = cpu.mqLo;

  for (let i = count; i > 0; i--) {
    // Shift the AC/MQ pair left one place.
    aHi = ((aHi << 1) | (aLo >>> 17)) & AC_HI;
    aLo = ((aLo << 1) & HALF) | ((qHi >>> 16) & 1);
    qHi = ((qHi << 1) & MAG_HI) | (qLo >>> 17);
    qLo = (qLo << 1) & HALF;
    if (aHi > dHi || (aHi === dHi && aLo >= dLo)) {
      aLo -= dLo;
      aHi -= dHi;
      if (aLo < 0) { aLo += 0o1000000; aHi -= 1; }
      qLo |= 1;
    }
  }

  cpu.acS = acSign;
  cpu.acHi = aHi;
  cpu.acLo = aLo;
  cpu.mqHi = (quotientSign ? SIGN : 0) | qHi;
  cpu.mqLo = qLo;
  return true;
}

/**
 * ACL — add the storage register to AC as a 36-bit logical quantity, with an
 * end-around carry. The memory sign bit lines up with AC position P, which is
 * exactly how the two halves are arranged, so no repacking is needed. AC's own
 * sign and its Q bit take no part.
 */
export function addLogical(cpu) {
  let lo = cpu.acLo + cpu.srLo;
  let hi = (cpu.acHi & HALF) + cpu.srHi + (lo >>> 18);
  lo &= HALF;
  if (hi & 0o1000000) {                 // carry out of position P comes around
    lo += 1;
    if (lo > HALF) { lo = 0; hi += 1; }
  }
  cpu.acLo = lo & HALF;
  cpu.acHi = (cpu.acHi & AC_Q) | (hi & HALF);
}

/**
 * CAS and LAS: compare and skip. Returns how many instructions to skip — none
 * when the accumulator is the greater, one on equality, two when it is less.
 */
export function compare(cpu, logical) {
  const aHi = cpu.acHi;
  const aLo = cpu.acLo;

  if (logical) {
    // LAS compares AC(Q,P,1-35) against C(Y) with the memory sign treated as
    // just another bit, so the whole thing is an unsigned comparison.
    const bHi = cpu.srHi;
    if (aHi > bHi) return 0;
    if (aHi < bHi) return 2;
    if (aLo > cpu.srLo) return 0;
    if (aLo < cpu.srLo) return 2;
    return 1;
  }

  const bSign = (cpu.srHi & SIGN) ? 1 : 0;
  const bHi = cpu.srHi & MAG_HI;
  const bLo = cpu.srLo;

  if (cpu.acS === 0) {
    if (bSign !== 0) return 0;          // positive beats negative
    if (aHi > bHi) return 0;
    if (aHi < bHi) return 2;
    if (aLo > bLo) return 0;
    if (aLo < bLo) return 2;
    return 1;
  }
  if (bSign === 0) return 2;            // negative loses to positive
  if (aHi > bHi) return 2;              // more negative is less
  if (aHi < bHi) return 0;
  if (aLo > bLo) return 2;
  if (aLo < bLo) return 0;
  return 1;
}
