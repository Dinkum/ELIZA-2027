/**
 * The positive opcodes: instructions whose sign bit is zero.
 *
 * Grouped as the manual groups them — transfers, indicators, arithmetic,
 * loads, stores, index, shifts, I/O — and dispatched from one switch, which is
 * what V8 turns into a jump table. Instructions that touch the storage
 * register read it after `access`, which is also where relocation and
 * protection get applied, so a protection violation simply leaves the
 * instruction half-done and the CPU re-enters at the trap cell.
 *
 * Fields used below:
 *   y      effective address, after indexing and any indirection
 *   iaddr  the raw address field, used by the instructions that must not index
 *   sr     storage register: the instruction word itself until `access` runs
 */

import { HALF, SIGN, MAG_HI, ADDR } from './word.js';
import { multiply, divide, addLogical, compare } from './arith.js';
import { als, ars, lls, lrs } from './shift.js';
import * as fp from './float.js';

/** Fifteen-bit two's complement, the form the index instructions want. */
const NEG = 0o100000;

/** Prefix field mask, shared by the word's S,1,2 and the accumulator's P,1,2. */
const PREFIX = 0o700000;

/** Tag field mask, inside the low half. */
const TAG = 0o700000;

export function executePositive(cpu) {
  const y = cpu.y;

  switch (cpu.op) {

    // --- Transfers ------------------------------------------------------
    case 0o0000:   // HTR — halt and transfer
      if (cpu.checkUser()) break;
      cpu.programStop();
      break;

    case 0o0020:   // TRA — transfer
      cpu.transfer(y);
      break;

    case 0o0021:   // TTR — trap transfer; ignores trapping mode, which is how
                   // a program under CTSS gets out of a trap handler
      cpu.ic = y;
      break;

    case 0o0040: { // TLQ — transfer on AC low than MQ
      if (cpu.trapMode) cpu.traptrace();
      const mqSign = (cpu.mqHi & SIGN) ? 1 : 0;
      const mHi = cpu.mqHi & MAG_HI;
      let take;
      if (cpu.acS === 0) {
        take = mqSign !== 0
          || cpu.acHi > mHi
          || (cpu.acHi === mHi && cpu.acLo > cpu.mqLo);
      } else {
        take = mqSign !== 0
          && (cpu.acHi < mHi || (cpu.acHi === mHi && cpu.acLo < cpu.mqLo));
      }
      if (take) cpu.ic = cpu.trapMode ? 1 : y;
      break;
    }

    case 0o0074:   // TSX — transfer and set index with this location's negative
      cpu.setxr(NEG - (cpu.progStop ? cpu.ic : cpu.ic - 1));
      if (cpu.trapMode) {
        cpu.traptrace();
        cpu.ic = 1;
      } else {
        cpu.ic = cpu.iaddr;
      }
      break;

    case 0o0100:   // TZE — transfer on zero
      if (cpu.trapMode) cpu.traptrace();
      if (cpu.acIsZero()) cpu.ic = cpu.trapMode ? 1 : y;
      break;

    case 0o0120:   // TPL — transfer on plus
      if (cpu.trapMode) cpu.traptrace();
      if (cpu.acS === 0) cpu.ic = cpu.trapMode ? 1 : y;
      break;

    case 0o0140:   // TOV — transfer on AC overflow, and clear it
      if (cpu.trapMode) cpu.traptrace();
      if (cpu.acOverflow) {
        cpu.ic = cpu.trapMode ? 1 : y;
        cpu.acOverflow = false;
      }
      break;

    case 0o0161:   // TQO — transfer on MQ overflow; inert while FP traps are on
      if (!cpu.fpTrap) {
        if (cpu.trapMode) cpu.traptrace();
        if (cpu.mqOverflow) {
          cpu.ic = cpu.trapMode ? 1 : y;
          cpu.mqOverflow = false;
        }
      }
      break;

    case 0o0162:   // TQP — transfer on MQ plus
      if (cpu.trapMode) cpu.traptrace();
      if ((cpu.mqHi & SIGN) === 0) cpu.ic = cpu.trapMode ? 1 : y;
      break;

    case 0o0101:   // TIA (CTSS) — transfer into the A core
      if (cpu.checkUser()) break;
      if (cpu.trapMode) cpu.traptrace();
      cpu.bcoreInst = 0;
      cpu.ic = y;
      cpu.trapInhibit = 2;
      break;

    // --- Sense indicator register ---------------------------------------
    case 0o0041:   // IIA — invert indicators from AC
      cpu.siHi ^= cpu.acHi & HALF;
      cpu.siLo ^= cpu.acLo;
      break;

    case 0o0043:   // OAI — or AC into indicators
      cpu.siHi |= cpu.acHi & HALF;
      cpu.siLo |= cpu.acLo;
      break;

    case 0o0044:   // PAI — place AC in indicators
      cpu.siHi = cpu.acHi & HALF;
      cpu.siLo = cpu.acLo;
      break;

    case 0o0042:   // TIO — transfer when indicators are on
      if (cpu.trapMode) cpu.traptrace();
      if ((cpu.acHi & HALF & cpu.siHi) === (cpu.acHi & HALF)
        && (cpu.acLo & cpu.siLo) === cpu.acLo) {
        cpu.ic = cpu.trapMode ? 1 : y;
      }
      break;

    case 0o0046:   // TIF — transfer when indicators are off
      if (cpu.trapMode) cpu.traptrace();
      if ((cpu.acHi & HALF & cpu.siHi) === 0 && (cpu.acLo & cpu.siLo) === 0) {
        cpu.ic = cpu.trapMode ? 1 : y;
      }
      break;

    // The right-half indicator group works on the instruction's own tag and
    // address field rather than on a word from core.
    case 0o0051:   // IIR — invert indicators, right half
      cpu.siLo ^= cpu.srLo;
      break;
    case 0o0055:   // SIR — set indicators, right half
      cpu.siLo |= cpu.srLo;
      break;
    case 0o0057:   // RIR — reset indicators, right half
      cpu.siLo &= ~cpu.srLo & HALF;
      break;
    case 0o0054:   // RFT — right half indicators off test
      if ((cpu.srLo & cpu.siLo) === 0) cpu.ic = (cpu.ic + 1) & ADDR;
      break;
    case 0o0056:   // RNT — right half indicators on test
      if ((cpu.srLo & cpu.siLo) === cpu.srLo) cpu.ic = (cpu.ic + 1) & ADDR;
      break;

    case 0o0440:   // IIS — invert indicators from storage
      cpu.access(y);
      cpu.siHi ^= cpu.srHi;
      cpu.siLo ^= cpu.srLo;
      break;
    case 0o0441:   // LDI — load indicators
      cpu.access(y);
      cpu.siHi = cpu.srHi;
      cpu.siLo = cpu.srLo;
      break;
    case 0o0442:   // OSI — or storage into indicators
      cpu.access(y);
      cpu.siHi |= cpu.srHi;
      cpu.siLo |= cpu.srLo;
      break;
    case 0o0445:   // RIS — reset indicators from storage
      cpu.access(y);
      cpu.siHi &= ~cpu.srHi & HALF;
      cpu.siLo &= ~cpu.srLo & HALF;
      break;
    case 0o0444:   // OFT — off test for indicators
      cpu.access(y);
      if ((cpu.srHi & cpu.siHi) === 0 && (cpu.srLo & cpu.siLo) === 0) {
        cpu.ic = (cpu.ic + 1) & ADDR;
      }
      break;
    case 0o0446:   // ONT — on test for indicators
      cpu.access(y);
      if ((cpu.srHi & cpu.siHi) === cpu.srHi
        && (cpu.srLo & cpu.siLo) === cpu.srLo) {
        cpu.ic = (cpu.ic + 1) & ADDR;
      }
      break;
    case 0o0604:   // STI — store indicators
      cpu.store(y, cpu.siHi, cpu.siLo);
      break;

    // --- Fixed point arithmetic -----------------------------------------
    case 0o0400:   // ADD
      cpu.access(y);
      cpu.addToAC();
      break;

    case 0o0401:   // ADM — add magnitude
      cpu.access(y);
      cpu.srHi &= ~SIGN & HALF;
      cpu.addToAC();
      break;

    case 0o0402:   // SUB
      cpu.access(y);
      cpu.srHi ^= SIGN;
      cpu.addToAC();
      break;

    case 0o0361:   // ACL — add and carry logical word
      cpu.access(y);
      addLogical(cpu);
      break;

    case 0o0340: { // CAS — compare accumulator with storage
      cpu.access(y);
      cpu.ic = (cpu.ic + compare(cpu, false)) & ADDR;
      break;
    }

    case 0o0200:   // MPY
      cpu.access(y);
      multiply(cpu, 0o43);
      break;

    case 0o0204:
    case 0o0205: { // VLM — variable length multiply
      const count = (cpu.srHi >>> 0) & 0o77;   // count comes from bits 10-17
      cpu.access(y);
      if (count) multiply(cpu, count);
      break;
    }

    case 0o0220:   // DVH — divide or halt
      cpu.access(y);
      divide(cpu, 0o43);
      if (cpu.divideCheck && !cpu.checkUser()) cpu.halt();
      break;

    case 0o0221:   // DVP — divide or proceed
      cpu.access(y);
      divide(cpu, 0o43);
      break;

    case 0o0224: { // VDH — variable length divide or halt
      const count = cpu.srHi & 0o77;
      cpu.access(y);
      if (count) {
        divide(cpu, count);
        if (cpu.divideCheck && !cpu.checkUser()) cpu.halt();
      }
      break;
    }

    case 0o0225:
    case 0o0227: { // VDP — variable length divide or proceed
      const count = cpu.srHi & 0o77;
      cpu.access(y);
      if (count) divide(cpu, count);
      break;
    }

    // --- Floating point --------------------------------------------------
    case 0o0300: cpu.access(y); fp.add(cpu, true); break;    // FAD
    case 0o0302: cpu.access(y); cpu.srHi ^= SIGN; fp.add(cpu, true); break;   // FSB
    case 0o0304: cpu.access(y); cpu.srHi &= ~SIGN & HALF; fp.add(cpu, true); break; // FAM
    case 0o0306: cpu.access(y); cpu.srHi |= SIGN; fp.add(cpu, true); break;   // FSM
    case 0o0260: cpu.access(y); fp.multiply(cpu, true); break;      // FMP
    case 0o0240:                                                    // FDH
      cpu.access(y);
      fp.divide(cpu);
      if (cpu.divideCheck && !cpu.checkUser()) cpu.halt();
      break;
    case 0o0241: cpu.access(y); fp.divide(cpu); break;              // FDP

    case 0o0301:                                                    // DFAD
      cpu.access(y); cpu.access2(y | 1); fp.addDouble(cpu, true); break;
    case 0o0303:                                                    // DFSB
      cpu.access(y); cpu.access2(y | 1); cpu.srHi ^= SIGN;
      fp.addDouble(cpu, true); break;
    case 0o0305:                                                    // DFAM
      cpu.access(y); cpu.access2(y | 1); cpu.srHi &= ~SIGN & HALF;
      fp.addDouble(cpu, true); break;
    case 0o0307:                                                    // DFSM
      cpu.access(y); cpu.access2(y | 1); cpu.srHi |= SIGN;
      fp.addDouble(cpu, true); break;
    case 0o0261:                                                    // DFMP
      cpu.access(y); cpu.access2(y | 1); fp.multiplyDouble(cpu, true); break;

    // --- Logic ------------------------------------------------------------
    case 0o0320:   // ANS — AND to storage; AC is left alone
      cpu.access(y);
      cpu.store(y, cpu.acHi & cpu.srHi & HALF, cpu.acLo & cpu.srLo);
      break;

    case 0o0322:   // ERA — exclusive or to accumulator; clears AC sign and Q
      cpu.access(y);
      cpu.acHi = (cpu.acHi ^ cpu.srHi) & HALF;
      cpu.acLo = (cpu.acLo ^ cpu.srLo) & HALF;
      cpu.acS = 0;
      break;

    // --- Loads -------------------------------------------------------------
    case 0o0500:   // CLA — clear and add
      cpu.access(y);
      cpu.clearAndAdd();
      break;

    case 0o0502:   // CLS — clear and subtract
      cpu.access(y);
      cpu.acS = (cpu.srHi & SIGN) ? 0 : 1;
      cpu.acHi = cpu.srHi & MAG_HI;
      cpu.acLo = cpu.srLo;
      break;

    case 0o0560:   // LDQ — load MQ
      cpu.access(y);
      cpu.mqHi = cpu.srHi;
      cpu.mqLo = cpu.srLo;
      break;

    case 0o0443:   // DLD — double load
      cpu.access(y);
      cpu.clearAndAdd();
      cpu.access(y | 1);
      cpu.mqHi = cpu.srHi;
      cpu.mqLo = cpu.srLo;
      break;

    case 0o0520:   // ZET — storage zero test
      cpu.access(y);
      if ((cpu.srHi & MAG_HI) === 0 && cpu.srLo === 0) {
        cpu.ic = (cpu.ic + 1) & ADDR;
      }
      break;

    // --- Stores ------------------------------------------------------------
    case 0o0600:   // STZ — store zero
      cpu.store(y, 0, 0);
      break;

    case 0o0601:   // STO — store accumulator
      cpu.store(y, cpu.acWordHi(), cpu.acLo);
      break;

    case 0o0602:   // SLW — store logical word; AC's P becomes the sign
      cpu.store(y, cpu.acHi & HALF, cpu.acLo);
      break;

    case 0o0621:   // STA — store address
      cpu.access(y);
      cpu.store(y, cpu.srHi, (cpu.srLo & ~ADDR & HALF) | (cpu.acLo & ADDR));
      break;

    case 0o0622:   // STD — store decrement
      cpu.access(y);
      cpu.store(y, (cpu.srHi & ~ADDR & HALF) | (cpu.acHi & ADDR), cpu.srLo);
      break;

    case 0o0625:   // STT — store tag
      cpu.access(y);
      cpu.store(y, cpu.srHi, (cpu.srLo & ~TAG & HALF) | (cpu.acLo & TAG));
      break;

    case 0o0630:   // STP — store prefix
      cpu.access(y);
      cpu.store(y, (cpu.srHi & ~PREFIX & HALF) | (cpu.acHi & PREFIX), cpu.srLo);
      break;

    // --- Index registers ---------------------------------------------------
    case 0o0534:   // LXA — load index from address
      cpu.access(cpu.iaddr);
      cpu.setxr(cpu.srLo & ADDR);
      break;

    case 0o0535:   // LAC — load complement of address
      cpu.access(cpu.iaddr);
      cpu.setxr(NEG - (cpu.srLo & ADDR));
      break;

    case 0o0634:   // SXA — store index in address
      cpu.access(cpu.iaddr);
      cpu.store(cpu.iaddr, cpu.srHi,
        (cpu.srLo & ~ADDR & HALF) | cpu.getxr(true));
      break;

    case 0o0636: { // SCA — store complement of index in address
      const x = cpu.tag === 0 ? 0 : (NEG - cpu.getxr(true)) & ADDR;
      cpu.access(cpu.iaddr);
      cpu.store(cpu.iaddr, cpu.srHi, (cpu.srLo & ~ADDR & HALF) | x);
      break;
    }

    case 0o0734:   // PAX — place address in index
      cpu.setxr(cpu.acLo & ADDR);
      break;

    case 0o0737:   // PAC — place complement of address in index
      cpu.setxr(NEG - (cpu.acLo & ADDR));
      break;

    case 0o0754:   // PXA — place index in address
      cpu.acS = 0;
      cpu.acHi = 0;
      cpu.acLo = cpu.getxr(true);
      break;

    case 0o0756:   // PCA — place complement of index in address
      cpu.acS = 0;
      cpu.acHi = 0;
      cpu.acLo = cpu.tag === 0 ? 0 : (NEG - cpu.getxr(true)) & ADDR;
      break;

    case 0o0774:   // AXT — address to index true
      cpu.setxr(cpu.srLo & ADDR);
      break;

    // --- Shifts -------------------------------------------------------------
    case 0o0767: als(cpu, y); break;   // ALS
    case 0o0771: ars(cpu, y); break;   // ARS
    case 0o0763: lls(cpu, y); break;   // LLS
    case 0o0765: lrs(cpu, y); break;   // LRS

    // --- Convert ------------------------------------------------------------
    case 0o0114: case 0o0115: case 0o0116: case 0o0117:
      convertByReplacement(cpu);
      break;

    // --- CTSS memory box ----------------------------------------------------
    case 0o0562:   // LRI — load relocation information
      if (cpu.checkUser()) break;
      cpu.access(y);
      cpu.progReloc = cpu.srLo & 0o77400;
      if (!(cpu.srHi & SIGN)) cpu.reloMode = true;
      cpu.trapInhibit = 2;
      break;

    case 0o0564:   // ENB — enable traps
      if (cpu.checkUser()) break;
      cpu.access(y);
      cpu.enbHi = cpu.srHi & 0o377;
      cpu.enbLo = cpu.srLo & 0o770377;
      // The mask is the arming; `trapEnable` is the separate inhibit that a
      // trap in progress sets, and ENB clears it. Without this a program can
      // arm every channel it likes and never be interrupted by any of them,
      // which is how CTSS comes to sit in a delay loop waiting for an I/O
      // completion flag that nothing will ever set.
      cpu.trapEnable = true;
      cpu.trapInhibit = 2;
      if (cpu.onEnb) cpu.onEnb(y);
      break;

    // --- Miscellaneous ------------------------------------------------------
    case 0o0131: { // XCA — exchange AC and MQ, arithmetically
      const hi = cpu.acHi & MAG_HI;
      const lo = cpu.acLo;
      const sign = cpu.acS;
      cpu.acS = (cpu.mqHi & SIGN) ? 1 : 0;
      cpu.acHi = cpu.mqHi & MAG_HI;
      cpu.acLo = cpu.mqLo;
      cpu.mqHi = (sign ? SIGN : 0) | hi;
      cpu.mqLo = lo;
      break;
    }

    case 0o0420:   // HPR — halt and proceed: always a stop for the operator,
                   // resuming at the next instruction rather than an address
      if (cpu.checkUser()) break;
      cpu.progStop = true;
      cpu.progStopResume = cpu.ic;
      cpu.ic = (cpu.ic - 1) & ADDR;
      cpu.halt();
      break;

    case 0o0761:   // NOP
      break;

    // --- Channel and tape control -------------------------------------------
    case 0o0540: case 0o0541: case 0o0542: case 0o0543:   // RCH A,C,E,G
      if (cpu.checkUser()) break;
      channelOp(cpu, (cpu.op & 3) << 1, 'resetAndLoad');
      break;

    case 0o0544: case 0o0545: case 0o0546: case 0o0547:   // LCH A,C,E,G
      if (cpu.checkUser()) break;
      channelOp(cpu, (cpu.op & 3) << 1, 'load');
      break;

    case 0o0640: case 0o0641: case 0o0642: case 0o0643:   // SCH A,C,E,G
      if (cpu.checkUser()) break;
      channelOp(cpu, (cpu.op & 3) << 1, 'storeControl');
      break;

    case 0o0644: case 0o0645: case 0o0646: case 0o0647:   // SCD A,C,E,G
      channelOp(cpu, (cpu.op & 3) << 1, 'diagnose');
      break;

    case 0o0022: case 0o0024: case 0o0026: case 0o0027: { // TRC A,C,E,G
      if (cpu.checkUser()) break;
      // TRCG is encoded 0027 and reads as if it were 0030, which is what puts
      // the four positive variants on the even channels A, C, E and G.
      const index = ((cpu.op === 0o0027 ? 0o030 : cpu.op) & 0o77) - 0o22;
      // While the channel's check trap is armed a check arrives by trap
      // instead, and TRC is a no-op — s709's check_cchk returns at once.
      if (!((cpu.enbHi >>> index) & 1))
        transferOnCondition(cpu, index, 'redundancy');
      break;
    }

    case 0o0030: case 0o0031: case 0o0032: case 0o0033: { // TEF A,C,E,G
      if (cpu.checkUser()) break;
      const index = (cpu.op & 3) << 1;
      // While the channel's trap is armed an end of file arrives by trap
      // instead, and TEF is a no-op — s709's check_eof returns at once.
      if (!((cpu.enbLo >>> index) & 1))
        transferOnCondition(cpu, index, 'endOfFile');
      break;
    }

    case 0o0060: case 0o0061: case 0o0062: case 0o0063:
    case 0o0064: case 0o0065: case 0o0066: case 0o0067: { // TCO A-H
      if (cpu.checkUser()) break;
      if (cpu.trapMode) cpu.traptrace();
      const channel = cpu.channels[cpu.op & 7];
      if (channel && channel.selected) cpu.ic = cpu.trapMode ? 1 : y;
      break;
    }

    case 0o0762: selectDevice(cpu, 'read'); break;        // RDS
    case 0o0766: selectDevice(cpu, 'write'); break;       // WRS
    case 0o0764: selectDevice(cpu, 'backspaceRecord'); break; // BSR
    case 0o0770: selectDevice(cpu, 'writeEndOfFile'); break;  // WEF
    case 0o0772: selectDevice(cpu, 'rewind'); break;      // REW
    case 0o0776: selectDevice(cpu, 'setDensity'); break;  // SDN

    default:
      cpu.illegalInstruction();
      break;
  }
}

/**
 * CVR — convert by replacement from the AC.
 *
 * Six bits at a time are taken from the bottom of the accumulator, used as an
 * offset into a table at the instruction's address, and the table entry's top
 * six bits are put back at the top of the accumulator. It is how the 7094
 * translated character codes; SLIP's BCD routines lean on it.
 */
function convertByReplacement(cpu) {
  let count = cpu.srHi & 0o377;           // count is bits 10-17 of the word
  // Each table entry's own address field becomes the base for the next lookup;
  // the first base comes from the instruction. That chaining is the point of
  // the instruction: a table can redirect to another table mid-conversion.
  cpu.srHi = 0;
  cpu.srLo = cpu.iaddr;
  while (count--) {
    cpu.access((cpu.srLo + (cpu.acLo & 0o77)) & ADDR);
    // Shift AC right six places, then drop the table entry's top character into
    // positions P,1-5 — where the entry's own sign bit lines up.
    cpu.acLo = ((cpu.acLo >>> 6) | ((cpu.acHi & 0o77) << 12)) & HALF;
    cpu.acHi = ((cpu.acHi >>> 6) & 0o7777) | (cpu.srHi & 0o770000);
  }
  cpu.tag &= 1;
  if (cpu.tag) cpu.setxr(cpu.srLo & ADDR);
}

/** Dispatch a channel control instruction, ignoring channels not installed. */
function channelOp(cpu, index, method) {
  const channel = cpu.channels[index];
  if (!channel) return;
  channel[method](cpu);
}

/** TRC and TEF: transfer when a channel raises the named condition. */
function transferOnCondition(cpu, index, condition) {
  if (cpu.trapMode) cpu.traptrace();
  const channel = cpu.channels[index];
  if (!channel) return;
  if (channel.testAndClear(condition)) cpu.ic = cpu.trapMode ? 1 : cpu.y;
}

/**
 * RDS, WRS and the tape motion instructions. The channel is named by bits 9-12
 * of the address field and the unit by the low bits, an encoding shared by all
 * six instructions.
 */
function selectDevice(cpu, operation) {
  if (cpu.checkUser()) return;
  const index = ((cpu.iaddr & 0o17000) >> 9) - 1;
  const channel = cpu.channels[index];
  if (!channel) return;
  channel.select(cpu, operation, cpu.iaddr & 0o777);
}
