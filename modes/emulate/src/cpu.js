/**
 * The IBM 7094 central processing unit.
 *
 * This is the machine CTSS ran on: a 7094 with the Project MAC modifications —
 * a second bank of core (the B core), memory relocation and protection, and the
 * interval timer that made time-sharing possible at all. Those are not optional
 * extras here; without them CTSS cannot get past its first swap.
 *
 * Word layout and the reasoning behind the two-half representation are in
 * word.js. The instruction cycle below follows the hardware order: fetch, decode,
 * resolve the effective address (index registers *subtract*), execute, then look
 * for traps. Index-class instructions are decoded before everything else because
 * they use the prefix bits the other instructions leave at zero.
 *
 * References:
 *   IBM 7090/7094 Principles of Operation, A22-6703.
 *   Dave Pitts' s709 emulator, which the CTSS reconstruction in references/ runs
 *   on; where the manual is ambiguous, s709's behaviour is what CTSS was built
 *   against and is what is reproduced here.
 */

import { HALF, SIGN, MAG_HI, ADDR, AC_P, AC_HI, CORE_SIZE } from './word.js';
import { executePositive } from './ops-positive.js';
import { executeNegative } from './ops-negative.js';
import { executeSense } from './ops-sense.js';
import { floatingRound } from './float.js';

/** Trap and interrupt vectors, in octal as CTSS listings give them. */
export const TRAP = {
  STANDARD: 0o0,
  CLOCK: 0o6,
  FLOATING: 0o10,
  CHANNEL: 0o12,
  PROTECTION: 0o32,
};

/** Location 5 holds CTSS's interval timer, decremented every 1/60 second. */
export const CLOCK_CELL = 0o5;

/** B-core select bit, OR'd into a core address to reach the second bank. */
export const BCORE = CORE_SIZE;

/** What `step` is doing between instructions. */
export const RUN = { STOPPED: 0, RUNNING: 1 };

export class CPU {
  constructor(core, { multipleTagMode = true } = {}) {
    this.core = core;

    // --- Programmer-visible registers -----------------------------------
    /** Accumulator sign, 0 or 1. Kept apart from the magnitude bits. */
    this.acS = 0;
    /** AC bits Q,P,1-17. Nineteen bits; see word.js for why P lands here. */
    this.acHi = 0;
    /** AC bits 18-35. */
    this.acLo = 0;
    /** MQ bits S,1-17 and 18-35, an ordinary 36-bit word. */
    this.mqHi = 0;
    this.mqLo = 0;
    /** Sense indicator register, a full 36 bits of flags. */
    this.siHi = 0;
    this.siLo = 0;
    /** Index registers 1-7. Index 0 is the hardwired zero the tag field means. */
    this.xr = new Uint16Array(8);
    /** Instruction counter. */
    this.ic = 0;
    /** Sense lights 1-4, and the six console sense switches. */
    this.sl = 0;
    this.ssw = 0;
    /** Console entry keys, read by ENK. */
    this.keysHi = 0;
    this.keysLo = 0;

    // --- Indicators -----------------------------------------------------
    this.acOverflow = false;
    this.mqOverflow = false;
    this.divideCheck = false;
    this.ioCheck = false;

    // --- Modes ----------------------------------------------------------
    /** Multiple tag mode ORs index registers 1,2,4 for tags 3,5,6,7. */
    this.multipleTagMode = multipleTagMode;
    /** Transfer trap mode: every successful transfer traps to location 0. */
    this.trapMode = false;
    /** Floating point trap enable, set by the trap-enable console switch. */
    this.fpTrap = true;
    /** Program stop, set by HTR and HPR: the processor is halted. */
    this.progStop = false;
    /** Where a console start lands while halted: the HTR's address field. */
    this.progStopResume = 0;

    // --- CTSS memory box ------------------------------------------------
    /** User mode: relocation and protection apply only here. */
    this.userMode = false;
    this.reloMode = false;
    this.protMode = false;
    this.progReloc = 0;
    this.progBase = 0;
    this.progLimit = 0;
    /** Set when an access violated protection; forces a re-fetch at the trap. */
    this.protTrapPending = false;
    /** A or B core select for data and for instructions, 0 or BCORE. */
    this.bcoreData = 0;
    this.bcoreInst = 0;

    // --- Interrupt state ------------------------------------------------
    /** Traps enabled. Cleared while a trap is being serviced. */
    this.trapEnable = false;
    /** Counts down instructions for which traps stay inhibited after ESNT/XEC. */
    this.trapInhibit = 0;
    /** Channel trap enable mask, set by ENB. */
    this.enbHi = 0;
    this.enbLo = 0;
    /** Latched interval-timer condition: the word wrapped, trap owed. */
    this.clockPending = false;
    /** Set by an illegal instruction or an unreachable channel. */
    this.machineCheck = false;
    /** Why the machine stopped, for the console display. */
    this.lastError = null;

    // --- Decoded instruction --------------------------------------------
    this.op = 0;
    this.tag = 0;
    this.flag = false;
    this.iaddr = 0;
    this.idecr = 0;
    /** Effective address: the operand address after indexing and indirection. */
    this.y = 0;
    /** Storage register: the operand word most recently fetched. */
    this.srHi = 0;
    this.srLo = 0;
    /** Second storage register, for the double-precision instructions. */
    this.sr2Hi = 0;
    this.sr2Lo = 0;
    /** Instruction/location register: the word the instruction cycle fetched. */
    this.ilrHi = 0;
    this.ilrLo = 0;
    /** Shift count, shared by the shift, multiply and divide instructions. */
    this.shcnt = 0;
    /** Spill flags raised by floating point, examined after each instruction. */
    this.spill = 0;

    // --- Housekeeping ---------------------------------------------------
    this.run = RUN.STOPPED;
    this.cycles = 0;
    this.instructions = 0;
    /** Channels, installed by the machine. Indexed 0-7 for A-H. */
    this.channels = [];
    /** Called when a HTR or HPR stops the machine; set by the machine. */
    this.onHalt = null;

    this.reset();
  }

  /** Console RESET: clears the registers and leaves the machine stopped. */
  reset() {
    this.acS = this.acHi = this.acLo = 0;
    this.mqHi = this.mqLo = 0;
    this.siHi = this.siLo = 0;
    this.xr.fill(0);
    this.ic = 0;
    this.sl = 0;
    this.acOverflow = this.mqOverflow = this.divideCheck = this.ioCheck = false;
    this.trapMode = false;
    this.userMode = this.reloMode = this.protMode = false;
    this.protTrapPending = false;
    this.bcoreData = this.bcoreInst = 0;
    this.trapEnable = false;
    this.trapInhibit = 0;
    this.enbHi = this.enbLo = 0;
    this.clockPending = false;
    this.progStop = false;
    this.progStopResume = 0;
    this.run = RUN.STOPPED;
  }

  // ======================================================================
  // Index registers
  // ======================================================================

  /**
   * Contents of the index register the tag field selects.
   *
   * In multiple tag mode a tag with several bits set reads the logical OR of
   * registers 1, 2 and 4 — the 7094's way of keeping the 709's three-register
   * tag encoding usable. `writeBack` reproduces the hardware side effect where
   * the OR'd value is left in all the selected registers.
   */
  getxr(writeBack) {
    const tag = this.tag;
    if (tag === 0) return 0;
    if (this.multipleTagMode) {
      let r = 0;
      if (tag & 1) r |= this.xr[1];
      if (tag & 2) r |= this.xr[2];
      if (tag & 4) r |= this.xr[4];
      if (writeBack) this.setxr(r);
      return r & ADDR;
    }
    return this.xr[tag] & ADDR;
  }

  /** Store into the index register the tag selects, honouring multiple tag mode. */
  setxr(value) {
    const tag = this.tag;
    if (tag === 0) return;
    const r = value & ADDR;
    if (this.multipleTagMode) {
      if (tag & 1) this.xr[1] = r;
      if (tag & 2) this.xr[2] = r;
      if (tag & 4) this.xr[4] = r;
    } else {
      this.xr[tag] = r;
    }
  }

  // ======================================================================
  // Core access
  //
  // Four entry points, matching the hardware's four reasons to touch core:
  // an operand fetch (access), a second operand for double precision
  // (access2), an instruction fetch (load), and a result (store). Relocation
  // and protection apply to all of them, but only in user mode — the
  // supervisor sees absolute addresses.
  // ======================================================================

  /** Apply relocation and protection. Returns -1 if the access trapped. */
  resolve(address) {
    let a = address;
    if (this.userMode) {
      if (this.reloMode) a = (a + this.progReloc) & ADDR;
      if (this.protMode && (a < this.progBase || a > this.progLimit)) {
        this.settrap(TRAP.PROTECTION, this.ic, 0);
        return -1;
      }
    }
    return a;
  }

  /** Fetch an operand into the storage register. */
  access(address) {
    const a = this.resolve(address);
    if (a < 0) return;
    const i = a | this.bcoreData;
    this.srHi = this.core.hi[i];
    this.srLo = this.core.lo[i];
    this.cycles++;
  }

  /** Fetch the second word of a double-precision operand. */
  access2(address) {
    const a = this.resolve(address);
    if (a < 0) return;
    const i = a | this.bcoreData;
    this.sr2Hi = this.core.hi[i];
    this.sr2Lo = this.core.lo[i];
    this.cycles++;
  }

  /**
   * Fetch into the instruction/location register. `relocate` is false for the
   * trap cells, which the supervisor always reaches absolutely.
   */
  load(address, relocate = true) {
    if (!relocate) {
      this.ilrHi = this.core.hi[address];
      this.ilrLo = this.core.lo[address];
      this.cycles++;
      return;
    }
    const a = this.resolve(address);
    if (a < 0) return;
    const i = a | this.bcoreInst;
    this.ilrHi = this.core.hi[i];
    this.ilrLo = this.core.lo[i];
    this.cycles++;
  }

  /** Store a result. */
  store(address, hi, lo, relocate = true) {
    if (!relocate) {
      this.core.hi[address] = hi & HALF;
      this.core.lo[address] = lo & HALF;
      this.cycles++;
      return;
    }
    const a = this.resolve(address);
    if (a < 0) return;
    const i = a | this.bcoreData;
    this.core.hi[i] = hi & HALF;
    this.core.lo[i] = lo & HALF;
    this.cycles++;
  }

  // ======================================================================
  // Traps
  // ======================================================================

  /**
   * Take a trap.
   *
   * The hardware stores the interrupted location in the address field of the
   * trap cell and resumes at the following word. CTSS reads the B-core flags
   * the decrement carries to know which bank the interrupted program was in,
   * which is why they are folded in here rather than kept in a side register.
   */
  settrap(vector, returnAddress, decrement) {
    let decr = decrement;
    if (this.bcoreData) decr |= 0o20000;
    if (this.bcoreInst) decr |= 0o40000;

    this.load(vector, false);
    // Keep the trap cell's prefix and tag; replace its decrement and address.
    // The decrement is bits 3-17, which is the low fifteen bits of the half.
    const newHi = (this.ilrHi & 0o700000) | (decr & ADDR);
    const newLo = (this.ilrLo & 0o700000) | (returnAddress & ADDR);
    this.store(vector, newHi, newLo, false);

    this.ic = (vector + 1) & ADDR;
    this.bcoreData = 0;
    this.bcoreInst = 0;
    this.trapEnable = false;
    this.trapInhibit = 2;
    // A taken trap disarms the whole mask, not just the delivery gate: s709's
    // do_trap zeroes trap_enb outright, and the program re-arms with ENB.
    this.enbHi = 0;
    this.enbLo = 0;
    if (vector === TRAP.PROTECTION) this.protTrapPending = true;
    this.progStop = false;
    this.userMode = false;
    this.reloMode = false;
    this.protMode = false;
  }

  /**
   * Record a transfer for transfer trap mode. In trap mode a successful
   * transfer stores its own location and goes to location 1 instead of the
   * address it names, which is how CTSS single-steps a user program.
   */
  traptrace() {
    this.load(0, false);
    this.store(0, this.ilrHi,
      (this.ilrLo & ~ADDR & HALF) | ((this.ic - 1) & ADDR), false);
  }

  // ======================================================================
  // Accumulator helpers
  //
  // AC is sign-and-magnitude, so addition is a comparison followed by an add
  // or a subtract rather than two's complement. The Q bit takes part in the
  // magnitude; a carry that changes P sets the overflow indicator.
  // ======================================================================

  /** AC ← AC + the storage register, algebraically. */
  addToAC() {
    const srSign = (this.srHi & SIGN) ? 1 : 0;
    const bHi = this.srHi & MAG_HI;
    const bLo = this.srLo;

    if (this.acS === srSign) {
      let lo = this.acLo + bLo;
      let hi = this.acHi + bHi + (lo >>> 18);
      lo &= HALF;
      const before = this.acHi;
      this.acHi = hi & AC_HI;
      this.acLo = lo;
      if ((this.acHi ^ before) & AC_P) this.acOverflow = true;
    } else if (this.acHi > bHi || (this.acHi === bHi && this.acLo >= bLo)) {
      let lo = this.acLo - bLo;
      let hi = this.acHi - bHi;
      if (lo < 0) { lo += 0o1000000; hi -= 1; }
      this.acHi = hi & AC_HI;
      this.acLo = lo;
    } else {
      let lo = bLo - this.acLo;
      let hi = bHi - this.acHi;
      if (lo < 0) { lo += 0o1000000; hi -= 1; }
      this.acHi = hi & AC_HI;
      this.acLo = lo;
      this.acS ^= 1;
    }
  }

  /** Load AC from the storage register: sign, and bits 1-35. Q and P clear. */
  clearAndAdd() {
    this.acS = (this.srHi & SIGN) ? 1 : 0;
    this.acHi = this.srHi & MAG_HI;
    this.acLo = this.srLo;
  }

  /** The word STO would write: AC sign and bits 1-35, P and Q discarded. */
  acWordHi() {
    return ((this.acS << 17) | (this.acHi & MAG_HI)) & HALF;
  }

  /** True when AC bits Q,P,1-35 are all zero, whatever the sign. */
  acIsZero() {
    return this.acHi === 0 && this.acLo === 0;
  }

  /** True when MQ bits 1-35 are all zero. */
  mqIsZero() {
    return (this.mqHi & MAG_HI) === 0 && this.mqLo === 0;
  }

  // ======================================================================
  // Instruction cycle
  // ======================================================================

  /**
   * Execute one instruction. Returns the number of core cycles it cost, which
   * the machine uses to pace the channels and the interval timer.
   */
  step() {
    const startCycles = this.cycles;

    // A halted processor performs no fetch. The machine's run loop keeps the
    // channels and the interval timer going while this state holds, and a
    // trap is what starts execution again.
    if (this.progStop) return 0;

    this.load(this.ic, true);
    if (this.protTrapPending) return this.takeProtTrap(startCycles);
    this.srHi = this.ilrHi;
    this.srLo = this.ilrLo;
    this.ic = (this.ic + 1) & ADDR;

    this.execute();

    // A floating point result out of range raises a spill. With the trap
    // enabled it becomes a trap to location 10; without it, the overflow
    // indicators simply come on and the program is expected to test them.
    if (this.spill) {
      if (this.fpTrap) {
        this.settrap(TRAP.STANDARD, this.ic, this.spill);
        this.ic = TRAP.FLOATING;
      } else {
        if (this.spill & 1) this.mqOverflow = true;
        if (this.spill & 2) this.acOverflow = true;
      }
      this.spill = 0;
    }

    if (this.trapInhibit > 0) this.trapInhibit--;
    if (this.protTrapPending) return this.takeProtTrap(startCycles);
    return this.cycles - startCycles;
  }

  /**
   * The interval timer. On the CTSS machine location 5 is counted up sixty
   * times a second, and when it runs through zero the processor traps to
   * location 6 — which is how the supervisor gets control back from a user
   * program that would otherwise run forever. Without this, CTSS starts and
   * then hangs in the first user program it dispatches.
   *
   * The count is the whole 36-bit word, not the address field: s709's clock
   * thread does `mem[CLOCK] = (mem[CLOCK] + 1) & MAGMASK` and fires only when
   * the full word wraps to zero. CTSS loads and reads the entire cell, so
   * counting only the low fifteen bits leaves the upper twenty-one frozen at
   * whatever was last stored — which the supervisor then reads back and
   * reports as a broken timer.
   */
  tick() {
    // The count is the 35-bit magnitude, not the whole word: s709's clock
    // thread does `(clock + 1) & MAGMASK`, which drops the sign bit every
    // tick. CTSS loads the cell with values like 0377777777704 — 2^35 minus
    // a quantum — and expects the wrap at 2^35. Counting the sign bit too
    // carries 0377777 into 0400000 and the word can never reach zero.
    let lo = this.core.lo[CLOCK_CELL] + 1;
    let hi = this.core.hi[CLOCK_CELL] & MAG_HI;
    if (lo > HALF) {
      lo = 0;
      hi = (hi + 1) & MAG_HI;
    }
    this.core.lo[CLOCK_CELL] = lo;
    this.core.hi[CLOCK_CELL] = hi;
    // The wrap is a latched condition, not a coincident one: s709's clock
    // thread sets interval_clk when the word runs through zero and the trap
    // is delivered whenever the enable mask next allows it. Requiring the
    // wrap and the open gate in the same instant loses the timer forever —
    // a trap in progress clears enbHi, and the word then counts upward for
    // another 2^36 ticks before it can wrap again.
    if (hi === 0 && lo === 0) this.clockPending = true;
    if (!this.clockPending) return false;
    // s709 fires the interval trap only under trap_enb bit 18 — channel A's
    // check-enable, which sits in the high half of the ENB mask here.
    if (!this.trapEnable || this.trapInhibit > 0 || !(this.enbHi & 1)) return false;
    this.clockPending = false;
    this.settrap(TRAP.CLOCK, this.ic, 0);
    return true;
  }

  /**
   * A protection violation re-enters the instruction cycle at the trap cell
   * without advancing IC — the interrupted instruction is abandoned mid-flight,
   * exactly as the memory box does it.
   */
  takeProtTrap(startCycles) {
    this.protTrapPending = false;
    this.load(this.ic, false);
    this.srHi = this.ilrHi;
    this.srLo = this.ilrLo;
    this.execute();
    return this.cycles - startCycles;
  }

  /** Decode and execute the word sitting in the storage register. */
  execute() {
    this.instructions++;

    const hi = this.srHi;
    const lo = this.srLo;
    // The opcode is word bits 1-11, six places up in the high half. The sign
    // bit is kept apart at 0100000 rather than immediately above bit 1, so that
    // the positive and negative opcode spaces read as they do in the listings:
    // TRA is 0020 and its negative twin is 0100020.
    this.op = ((hi & 0o400000) ? 0o100000 : 0) | ((hi >>> 6) & 0o3777);
    // Indirect addressing is flag bits 12 and 13, both set.
    this.flag = (hi & 0o60) === 0o60;
    this.tag = lo >>> 15;
    this.iaddr = lo & ADDR;

    this.cycles++;

    // Index-class instructions occupy the prefix bits the rest leave at zero.
    if (this.op & 0o3000) {
      this.idecr = hi & ADDR;
      this.executeIndex();
      return;
    }

    // The shift instructions take their count from the address field and are
    // never indirect, whatever the flag bits say.
    if (this.flag && !NEVER_INDIRECT.has(this.op)) {
      this.load((this.iaddr - this.getxr(false)) & ADDR, true);
      if (this.protTrapPending) return;
      const savedTag = this.tag;
      this.tag = this.ilrLo >>> 15;
      const laddr = this.ilrLo & ADDR;
      this.y = (laddr - this.getxr(false)) & ADDR;
      this.tag = savedTag;
    } else {
      this.y = (this.iaddr - this.getxr(false)) & ADDR;
    }

    if (this.op === 0o0522) {         // XEC: execute the word at Y in place
      this.load(this.y, true);
      if (this.protTrapPending) return;
      this.srHi = this.ilrHi;
      this.srLo = this.ilrLo;
      this.trapInhibit = 1;
      this.execute();
      return;
    }

    if ((this.op & 0o7777) === 0o0760) {
      executeSense(this);
      this.cycles++;
      return;
    }

    if ((this.op & 0o100000) === 0) executePositive(this);
    else executeNegative(this);
  }

  /**
   * The index-class instructions: TXI, TIX, TNX, TXH, TXL and STR. They are
   * selected by prefix bits rather than by opcode, and all of them are
   * transfers, so transfer trap mode applies.
   */
  executeIndex() {
    const target = this.iaddr;
    const decr = this.idecr;

    switch (this.op & 0o103000) {
      case 0o101000: {               // STR — store location and trap
        this.load(0, true);
        this.store(0, this.ilrHi, (this.ilrLo & ~ADDR & HALF) | this.ic, true);
        this.ic = 2;
        this.reloMode = false;
        this.protMode = false;
        this.cycles++;
        break;
      }
      case 0o001000:                 // TXI — index true, always transfers
        if (this.trapMode) this.traptrace();
        this.setxr(this.getxr(true) + decr);
        this.ic = this.trapMode ? 1 : target;
        this.cycles++;
        break;
      case 0o002000:                 // TIX — transfer on index high, decrement
        if (this.trapMode) this.traptrace();
        if (this.getxr(true) > decr) {
          this.setxr(this.getxr(true) - decr);
          this.ic = this.trapMode ? 1 : target;
        }
        this.cycles++;
        break;
      case 0o102000:                 // TNX — transfer on index low
        if (this.trapMode) this.traptrace();
        if (this.getxr(true) <= decr) {
          this.ic = this.trapMode ? 1 : target;
        } else {
          this.setxr(this.getxr(true) - decr);
        }
        this.cycles++;
        break;
      case 0o003000:                 // TXH — transfer on index high
        if (this.trapMode) this.traptrace();
        if (this.getxr(true) > decr) this.ic = this.trapMode ? 1 : target;
        this.cycles++;
        break;
      case 0o103000:                 // TXL — transfer on index low or equal
        if (this.trapMode) this.traptrace();
        if (this.getxr(true) <= decr) this.ic = this.trapMode ? 1 : target;
        this.cycles++;
        break;
      default:
        break;
    }
  }

  /**
   * Take a transfer, honouring transfer trap mode. Every conditional transfer
   * routes through here so trap mode is handled in exactly one place.
   */
  transfer(target) {
    if (this.trapMode) {
      this.traptrace();
      this.ic = 1;
    } else {
      this.ic = target & ADDR;
    }
  }

  /**
   * A privileged instruction in CTSS user mode takes a protection trap so the
   * supervisor can decide what the user program really meant. Returns true when
   * the trap was taken, in which case the caller must not go on.
   */
  checkUser() {
    if (this.userMode) {
      this.settrap(TRAP.PROTECTION, this.ic, 0);
      return true;
    }
    return false;
  }

  /**
   * An opcode this machine does not have. A user program gets a protection trap
   * and CTSS deals with it; the supervisor executing one is a machine check,
   * which stops the machine the way the real console would.
   */
  illegalInstruction() {
    this.machineCheck = true;
    if (!this.checkUser()) {
      this.lastError = `illegal instruction ${this.op.toString(8)} at `
        + `${((this.ic - 1) & ADDR).toString(8)}`;
      this.halt();
    }
  }

  /** FRN, the floating point round. Kept here so the sense group can reach it. */
  floatingRound() {
    floatingRound(this);
  }

  /**
   * HTR lands here.
   *
   * A halted processor is not a stopped machine. With the trap enable mask
   * armed the channels keep moving and the interval timer keeps ticking, and
   * the first trap to arrive is what restarts execution — which is exactly
   * how the CTSS supervisor waits for I/O, and why its idle loop is a halt.
   * The counter is left pointing back at the HTR, so returning from a trap
   * re-enters the halt, while a console start transfers to the address the
   * instruction names. Only when no trap is armed at all is the stop final,
   * and the machine halts for the operator at once.
   */
  programStop() {
    this.progStop = true;
    this.progStopResume = this.iaddr;
    this.ic = (this.ic - 1) & ADDR;
    if ((this.enbHi | this.enbLo) === 0) this.halt();
  }

  /** Stop the machine. HPR lands here; HTR only when nothing can wake it. */
  halt() {
    this.run = RUN.STOPPED;
    if (this.onHalt) this.onHalt(this);
  }
}

/**
 * Instructions whose flag bits are not an indirect-address request. The shift
 * group uses the whole address field as a count, so the hardware ignores bits
 * 12 and 13 there.
 */
const NEVER_INDIRECT = new Set([
  0o0767, // ALS
  0o0771, // ARS
  0o0763, // LLS
  0o0765, // LRS
  0o100763, // LGL
  0o100765, // LGR
  0o100773, // RQL
]);
