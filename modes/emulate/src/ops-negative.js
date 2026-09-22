/**
 * The negative opcodes: instructions whose sign bit is one.
 *
 * Same shape as ops-positive.js. The CTSS additions live here — TIB, SEA, SEB,
 * IFT, EFT, LPI, SRI, SPI — because the Project MAC engineers assigned them to
 * unused negative opcodes. Between TIA (positive) and TIB (negative) the
 * supervisor moves between the two banks of core, and LPI/LRI arm the memory
 * box that keeps a user program inside its own bounds.
 */

import { HALF, SIGN, MAG_HI, ADDR, AC_HI } from './word.js';
import { multiply, compare } from './arith.js';
import { lgl, lgr, rql } from './shift.js';
import * as fp from './float.js';

const NEG = 0o100000;
const TAG = 0o700000;

/** BIT1 and BIT2 of a word, used by SRI and SPI to report the mode flags. */
const BIT1 = 0o200000;
const BIT2 = 0o100000;

export function executeNegative(cpu) {
  const y = cpu.y;

  switch (cpu.op) {

    // --- Transfers ---------------------------------------------------------
    case 0o100000:   // HTR — halt and transfer
      if (cpu.checkUser()) break;
      cpu.programStop();
      break;

    case 0o100020:   // TRA
      cpu.transfer(y);
      break;

    case 0o100021:   // ESNT — enter storage nullification and transfer.
                     // No storage nullification on this machine, so it is the
                     // no-op s709 makes it; CTSS never depends on more.
      break;

    case 0o100100:   // TNZ — transfer on no zero
      if (cpu.trapMode) cpu.traptrace();
      if (!cpu.acIsZero()) cpu.ic = cpu.trapMode ? 1 : y;
      break;

    case 0o100120:   // TMI — transfer on minus
      if (cpu.trapMode) cpu.traptrace();
      if (cpu.acS !== 0) cpu.ic = cpu.trapMode ? 1 : y;
      break;

    case 0o100140:   // TNO — transfer on no overflow, clearing it either way
      if (cpu.trapMode) cpu.traptrace();
      if (!cpu.acOverflow) cpu.ic = cpu.trapMode ? 1 : y;
      else cpu.acOverflow = false;
      break;

    case 0o100101:   // TIB (CTSS) — transfer into the B core
      if (cpu.checkUser()) break;
      if (cpu.trapMode) cpu.traptrace();
      cpu.bcoreInst = cpu.core.banks > 1 ? 0o100000 : 0;
      // Entering the B core with the memory box armed is what makes the
      // program a user program: from here on it is relocated and bounded.
      if (cpu.protMode || cpu.reloMode) cpu.userMode = true;
      cpu.ic = y;
      cpu.trapInhibit = 2;
      break;

    // --- Sense indicator register, left half -------------------------------
    case 0o100042:   // RIA — reset indicators from AC
      cpu.siHi &= ~(cpu.acHi & HALF) & HALF;
      cpu.siLo &= ~cpu.acLo & HALF;
      break;

    case 0o100046:   // PIA — place indicators in AC
      cpu.acS = 0;
      cpu.acHi = cpu.siHi;
      cpu.acLo = cpu.siLo;
      break;

    // These take the instruction's own tag and address field and apply it to
    // the *left* half of the indicator register.
    case 0o100051:   // IIL — invert indicators, left half
      cpu.siHi ^= cpu.srLo;
      break;
    case 0o100055:   // SIL — set indicators, left half
      cpu.siHi |= cpu.srLo;
      break;
    case 0o100057:   // RIL — reset indicators, left half
      cpu.siHi &= ~cpu.srLo & HALF;
      break;
    case 0o100054:   // LFT — left half indicators off test
      if ((cpu.srLo & cpu.siHi) === 0) cpu.ic = (cpu.ic + 1) & ADDR;
      break;
    case 0o100056:   // LNT — left half indicators on test
      if ((cpu.srLo & cpu.siHi) === cpu.srLo) cpu.ic = (cpu.ic + 1) & ADDR;
      break;

    // --- Arithmetic ---------------------------------------------------------
    case 0o100400:   // SBM — subtract magnitude
      cpu.access(y);
      cpu.srHi |= SIGN;
      cpu.addToAC();
      break;

    case 0o100200:   // MPR — multiply and round
      cpu.access(y);
      multiply(cpu, 0o43);
      if (cpu.mqHi & 0o200000) {       // round on MQ bit 1
        cpu.acLo += 1;
        if (cpu.acLo > HALF) { cpu.acLo = 0; cpu.acHi = (cpu.acHi + 1) & AC_HI; }
      }
      break;

    case 0o100340:   // LAS — logical compare accumulator with storage
      cpu.access(y);
      cpu.ic = (cpu.ic + compare(cpu, true)) & ADDR;
      break;

    // --- Floating point ------------------------------------------------------
    case 0o100300: cpu.access(y); fp.add(cpu, false); break;   // UFA
    case 0o100302: cpu.access(y); cpu.srHi ^= SIGN; fp.add(cpu, false); break;  // UFS
    case 0o100304: cpu.access(y); cpu.srHi &= ~SIGN & HALF; fp.add(cpu, false); break; // UAM
    case 0o100306: cpu.access(y); cpu.srHi |= SIGN; fp.add(cpu, false); break;  // USM
    case 0o100260: cpu.access(y); fp.multiply(cpu, false); break;     // UFM

    case 0o100301:                                                    // DUFA
      cpu.access(y); cpu.access2(y | 1); fp.addDouble(cpu, false); break;
    case 0o100303:                                                    // DUFS
      cpu.access(y); cpu.access2(y | 1); cpu.srHi ^= SIGN;
      fp.addDouble(cpu, false); break;
    case 0o100305:                                                    // DUAM
      cpu.access(y); cpu.access2(y | 1); cpu.srHi &= ~SIGN & HALF;
      fp.addDouble(cpu, false); break;
    case 0o100307:                                                    // DUSM
      cpu.access(y); cpu.access2(y | 1); cpu.srHi |= SIGN;
      fp.addDouble(cpu, false); break;
    case 0o100261:                                                    // DUFM
      cpu.access(y); cpu.access2(y | 1); fp.multiplyDouble(cpu, false); break;
    case 0o100240:                                                    // DFDH
      cpu.access(y); cpu.access2(y | 1); fp.divideDouble(cpu);
      if (cpu.divideCheck && !cpu.checkUser()) cpu.halt();
      break;
    case 0o100241:                                                    // DFDP
      cpu.access(y); cpu.access2(y | 1); fp.divideDouble(cpu); break;

    // --- Logic ---------------------------------------------------------------
    case 0o100320:   // ANA — AND to accumulator; AC sign is cleared
      cpu.access(y);
      cpu.acHi &= cpu.srHi;
      cpu.acLo &= cpu.srLo;
      cpu.acS = 0;
      break;

    case 0o100500:   // CAL — clear and add logical word. The memory sign bit
                     // lands on AC position P, which is where the two halves
                     // already line up, so this is a straight copy.
      cpu.access(y);
      cpu.acS = 0;
      cpu.acHi = cpu.srHi;
      cpu.acLo = cpu.srLo;
      break;

    case 0o100501:   // ORA — or to accumulator
      cpu.access(y);
      cpu.acHi |= cpu.srHi;
      cpu.acLo |= cpu.srLo;
      break;

    case 0o100602:   // ORS — or to storage
      cpu.access(y);
      cpu.store(y, (cpu.acHi & HALF) | cpu.srHi, cpu.acLo | cpu.srLo);
      break;

    case 0o100520:   // NZT — storage not zero test
      cpu.access(y);
      if ((cpu.srHi & MAG_HI) !== 0 || cpu.srLo !== 0) {
        cpu.ic = (cpu.ic + 1) & ADDR;
      }
      break;

    // --- Stores ---------------------------------------------------------------
    case 0o100600:   // STQ — store MQ
      cpu.store(y, cpu.mqHi, cpu.mqLo);
      break;

    case 0o100603:   // DST — double store
      cpu.store(y, cpu.acWordHi(), cpu.acLo);
      cpu.store((y + 1) & ADDR, cpu.mqHi, cpu.mqLo);
      break;

    case 0o100620:   // SLQ — store left half MQ
      cpu.access(y);
      cpu.store(y, cpu.mqHi, cpu.srLo);
      break;

    case 0o100625:   // STL — store instruction location counter
      cpu.access(y);
      cpu.store(y, cpu.srHi, (cpu.srLo & ~ADDR & HALF) | cpu.ic);
      break;

    // --- Index registers --------------------------------------------------------
    case 0o100534:   // LXD — load index from decrement
      cpu.access(cpu.iaddr);
      cpu.setxr(cpu.srHi & ADDR);
      break;

    case 0o100535:   // LDC — load complement of decrement
      cpu.access(cpu.iaddr);
      cpu.setxr(NEG - (cpu.srHi & ADDR));
      break;

    case 0o100634:   // SXD — store index in decrement
      cpu.access(cpu.iaddr);
      cpu.store(cpu.iaddr, (cpu.srHi & ~ADDR & HALF) | cpu.getxr(true), cpu.srLo);
      break;

    case 0o100636: { // SCD — store complement of index in decrement
      const x = cpu.tag === 0 ? 0 : (NEG - cpu.getxr(true)) & ADDR;
      cpu.access(cpu.iaddr);
      cpu.store(cpu.iaddr, (cpu.srHi & ~ADDR & HALF) | x, cpu.srLo);
      break;
    }

    case 0o100734:   // PDX — place decrement in index
      cpu.setxr(cpu.acHi & ADDR);
      break;

    case 0o100737:   // PDC — place complement of decrement in index
      cpu.setxr(NEG - (cpu.acHi & ADDR));
      break;

    case 0o100754:   // PXD — place index in decrement
      cpu.acS = 0;
      cpu.acHi = cpu.tag === 0 ? 0 : cpu.getxr(true);
      cpu.acLo = 0;
      break;

    case 0o100756:   // PCD — place complement of index in decrement
      cpu.acS = 0;
      cpu.acHi = cpu.tag === 0 ? 0 : (NEG - cpu.getxr(true)) & ADDR;
      cpu.acLo = 0;
      break;

    case 0o100774:   // AXC — address to index complemented
      cpu.setxr(NEG - (cpu.srLo & ADDR));
      break;

    // --- Shifts ------------------------------------------------------------------
    case 0o100763: lgl(cpu, y); break;   // LGL
    case 0o100765: lgr(cpu, y); break;   // LGR
    case 0o100773: rql(cpu, y); break;   // RQL

    // --- Exchange and convert ------------------------------------------------------
    case 0o100130: { // XCL — exchange logical AC and MQ
      const hi = cpu.acHi & HALF;
      const lo = cpu.acLo;
      cpu.acS = 0;
      cpu.acHi = cpu.mqHi;
      cpu.acLo = cpu.mqLo;
      cpu.mqHi = hi;
      cpu.mqLo = lo;
      break;
    }

    case 0o100114: case 0o100115: case 0o100116: case 0o100117:
      convertByAddition(cpu);
      break;

    case 0o100154: case 0o100155: case 0o100156: case 0o100157:
      convertByReplacementFromMQ(cpu);
      break;

    // --- CTSS memory box and core select -------------------------------------------
    case 0o100564:   // LPI — load protection information
      if (cpu.checkUser()) break;
      cpu.access(y);
      cpu.progBase = cpu.srLo & 0o77400;
      cpu.progLimit = (cpu.srHi & 0o77400) | 0o377;
      if (!(cpu.srHi & SIGN)) cpu.protMode = true;
      cpu.trapInhibit = 2;
      break;

    case 0o100601:   // SRI — store relocation information
      if (cpu.checkUser()) break;
      cpu.store(y, cpu.reloMode ? BIT1 : 0, cpu.progReloc);
      break;

    case 0o100604:   // SPI — store protection information
      if (cpu.checkUser()) break;
      cpu.store(y,
        (cpu.protMode ? BIT2 : 0) | (cpu.progLimit & 0o77400),
        cpu.progBase);
      break;

    case 0o100761:   // The CTSS core-select group, selected by address
      if (cpu.checkUser()) break;
      switch (y) {
        case 0o41:   // SEA — select the A core for data
          cpu.bcoreData = 0;
          break;
        case 0o42:   // SEB — select the B core for data
          cpu.bcoreData = cpu.core.banks > 1 ? 0o100000 : 0;
          break;
        case 0o43:   // IFT — instruction core test; skip if in the A core
          if (!cpu.bcoreInst) cpu.ic = (cpu.ic + 1) & ADDR;
          break;
        case 0o44:   // EFT — data core test; skip if in the A core
          if (!cpu.bcoreData) cpu.ic = (cpu.ic + 1) & ADDR;
          break;
        default:
          cpu.illegalInstruction();
          return;
      }
      cpu.trapInhibit = 2;
      break;

    // --- Channel and tape control ---------------------------------------------------
    case 0o100540: case 0o100541: case 0o100542: case 0o100543:  // RCH B,D,F,H
      if (cpu.checkUser()) break;
      channelOp(cpu, ((cpu.op & 3) << 1) + 1, 'resetAndLoad');
      break;

    case 0o100544: case 0o100545: case 0o100546: case 0o100547:  // LCH B,D,F,H
      if (cpu.checkUser()) break;
      channelOp(cpu, ((cpu.op & 3) << 1) + 1, 'load');
      break;

    case 0o100640: case 0o100641: case 0o100642: case 0o100643:  // SCH B,D,F,H
      if (cpu.checkUser()) break;
      channelOp(cpu, ((cpu.op & 3) << 1) + 1, 'storeControl');
      break;

    case 0o100644: case 0o100645: case 0o100646: case 0o100647:  // SCD B,D,F,H
      channelOp(cpu, ((cpu.op & 3) << 1) + 1, 'diagnose');
      break;

    case 0o100022: case 0o100024: case 0o100026: case 0o100027: { // TRC B,D,F,H
      if (cpu.checkUser()) break;
      const index = ((cpu.op === 0o100027 ? 0o030 : cpu.op) & 0o77) - 0o21;
      // While the channel's check trap is armed a check arrives by trap
      // instead, and TRC is a no-op — s709's check_cchk returns at once.
      if (!((cpu.enbHi >>> index) & 1))
        transferOnCondition(cpu, index, 'redundancy');
      break;
    }

    case 0o100030: case 0o100031: case 0o100032: case 0o100033: { // TEF B,D,F,H
      if (cpu.checkUser()) break;
      const index = ((cpu.op & 3) << 1) + 1;
      // While the channel's trap is armed an end of file arrives by trap
      // instead, and TEF is a no-op — s709's check_eof returns at once.
      if (!((cpu.enbLo >>> index) & 1))
        transferOnCondition(cpu, index, 'endOfFile');
      break;
    }

    case 0o100060: case 0o100061: case 0o100062: case 0o100063:
    case 0o100064: case 0o100065: case 0o100066: case 0o100067: { // TCN A-H
      if (cpu.checkUser()) break;
      if (cpu.trapMode) cpu.traptrace();
      const channel = cpu.channels[cpu.op & 7];
      if (!channel || !channel.selected) cpu.ic = cpu.trapMode ? 1 : y;
      break;
    }

    case 0o100764: selectDevice(cpu, 'backspaceFile'); break;     // BSF
    case 0o100772: selectDevice(cpu, 'rewindUnload'); break;      // RUN

    default:
      cpu.illegalInstruction();
      break;
  }
}

/**
 * CAQ — convert by addition from the MQ. Six bits at a time come off the top of
 * the MQ, which rotates, and each table entry is added into the accumulator.
 */
function convertByAddition(cpu) {
  let count = cpu.srHi & 0o377;
  cpu.srHi = 0;
  cpu.srLo = cpu.iaddr;
  while (count--) {
    const character = cpu.mqHi >>> 12;
    cpu.access((cpu.srLo + character) & ADDR);
    cpu.mqHi = (((cpu.mqHi << 6) & HALF) | (cpu.mqLo >>> 12)) & HALF;
    cpu.mqLo = ((cpu.mqLo << 6) & HALF) | character;
    // Unsigned add of the table word into AC(Q,P,1-35); the sign is untouched.
    let lo = cpu.acLo + cpu.srLo;
    let hi = cpu.acHi + cpu.srHi + (lo >>> 18);
    cpu.acLo = lo & HALF;
    cpu.acHi = hi & AC_HI;
  }
  cpu.tag &= 1;
  if (cpu.tag) cpu.setxr(cpu.srLo & ADDR);
}

/**
 * CRQ — convert by replacement from the MQ. As CAQ, but the table entry's top
 * character is shifted into the bottom of the MQ instead of added to the AC.
 */
function convertByReplacementFromMQ(cpu) {
  let count = cpu.srHi & 0o377;
  cpu.srHi = 0;
  cpu.srLo = cpu.iaddr;
  while (count--) {
    const character = cpu.mqHi >>> 12;
    cpu.access((cpu.srLo + character) & ADDR);
    cpu.mqHi = (((cpu.mqHi << 6) & HALF) | (cpu.mqLo >>> 12)) & HALF;
    cpu.mqLo = ((cpu.mqLo << 6) & HALF) | (cpu.srHi >>> 12);
  }
  cpu.tag &= 1;
  if (cpu.tag) cpu.setxr(cpu.srLo & ADDR);
}

function channelOp(cpu, index, method) {
  const channel = cpu.channels[index];
  if (!channel) return;
  channel[method](cpu);
}

function transferOnCondition(cpu, index, condition) {
  if (cpu.trapMode) cpu.traptrace();
  const channel = cpu.channels[index];
  if (!channel) return;
  if (channel.testAndClear(condition)) cpu.ic = cpu.trapMode ? 1 : cpu.y;
}

function selectDevice(cpu, operation) {
  if (cpu.checkUser()) return;
  const index = ((cpu.iaddr & 0o17000) >> 9) - 1;
  const channel = cpu.channels[index];
  if (!channel) return;
  channel.select(cpu, operation, cpu.iaddr & 0o777);
}
