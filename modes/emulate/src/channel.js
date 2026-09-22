/**
 * The 7607 data channel.
 *
 * A 7094 does not do its own I/O. It names a device with RDS or WRS, points a
 * channel at a list of command words with RCH, and goes back to computing; the
 * channel then steals memory cycles to move words between core and the device
 * until its command list disconnects. Channel command words look like ordinary
 * instructions but mean something else entirely:
 *
 *     prefix S,1,2   the operation — IOCD, TCH, IORP, IORT, IOCP, IOCT, IOSP, IOST
 *     bit 18         indirect: the real core address is at the address given
 *     bit 19         non-transmit: count the words but do not move them
 *     bit 20         take the data from the B core
 *     bits 3-17      word count
 *     bits 21-35     core address
 *
 * The eight operations differ in two respects: whether the channel goes on to
 * the next command word or disconnects when the count runs out, and what it
 * does when the record ends before the count does. That is the whole design.
 *
 * Devices are plugged in by `attach`. A device only has to move whole words and
 * say when a record or a file ends; the character-level timing of a 729 tape
 * drive is not something any program can observe through a channel.
 */

import { HALF, ADDR, CORE_SIZE } from './word.js';

/** Channel command operations, the value of the prefix field. */
export const IOCD = 0; // transfer, then disconnect
export const TCH = 1;  // transfer control: the command list jumps
export const IORP = 2; // transfer, proceed; stop this command at end of record
export const IORT = 3; // transfer, proceed; count continues across records
export const IOCP = 4; // transfer, proceed
export const IOCT = 5; // transfer, count, then transfer control
export const IOSP = 6; // skip, proceed
export const IOST = 7; // skip, then transfer control

/** The non-transmit bit, ORed into the operation. */
const NON_TRANSMIT = 0o10;

/** What the channel is doing. */
const IDLE = 0;
const LOAD = 1;
const RUN = 2;
const WAIT = 3;
const END = 4;

export class Channel {
  /**
   * @param {number} index 0 for channel A through 7 for channel H.
   */
  constructor(index) {
    this.index = index;
    this.letter = String.fromCharCode(65 + index);
    this.is7909 = false;

    /** Attached devices, by the unit code RDS and WRS name them with. */
    this.devices = new Map();
    /** The device currently selected, or null. */
    this.device = null;
    /** The unit code the current selection named. */
    this.unit = 0;
    /** READ_SEL / WRITE_SEL equivalent: 'read', 'write', or null when idle. */
    this.operation = null;
    /** Cycles left before an unanswered selection drops. */
    this.selectCycles = 0;

    this.state = IDLE;
    /**
     * A 7607 is driven by its state alone. The field exists so that the
     * machine's run loop can poll both kinds of channel without asking which
     * kind it is holding.
     */
    this.request = false;
    /** Command location register: where the next command word comes from. */
    this.clr = 0;
    /** Core address register: where the next data word goes. */
    this.car = 0;
    /** Word count register. */
    this.cwr = 0;
    /** The current command's operation, non-transmit bit included. */
    this.cop = 0;
    /** B-core select for the command list, and for the current command's data. */
    this.ccore = 0;
    this.dcore = 0;

    /** Conditions the CPU can test. */
    this.endOfFile = false;
    this.endOfRecord = false;
    this.redundancy = false;
    this.beginningOfTape = false;
    this.endOfTape = false;
    /** A channel trap is waiting to be taken. */
    this.trapPending = false;
    /**
     * Why the trap is owed, as s709's CHAN_TRAPPEND/CHAN_CHECK/CHAN_EOF:
     * bit 0 is a normal end, bit 1 a channel check, bit 2 end of file. The
     * stored trap word carries the same value in the tag field of the word it
     * leaves behind, which is how the supervisor tells the cases apart.
     */
    this.trapCauses = 0;
    /** Set by SPR; the peripheral code the channel last sent. */
    this.spraCode = 0;

    this.core = null;
    this.bcoreBit = 0;
  }

  /** Give the channel the core it steals cycles from. */
  connect(core) {
    this.core = core;
    this.bcoreBit = core.banks > 1 ? CORE_SIZE : 0;
  }

  /** Attach a device at a unit code, as RDS and WRS spell it (0o201 and so on). */
  attach(unit, device) {
    this.devices.set(unit, device);
    device.channel = this;
  }

  /** True while a device is selected: what TCO and TCN test. */
  get selected() {
    return this.operation !== null;
  }

  /**
   * True while the channel has work in flight: a command list running. A bare
   * device selection does not count — s709's `chan_in_op` is set only when a
   * command list (or a stacked tape motion) is under way, so a processor
   * halted by HTR still stops while a selection is merely outstanding. A
   * trap waiting to be taken does not count either: `chan_in_op` clears
   * when the channel parks, and a pending trap is delivered when the
   * machine next runs rather than keeping it awake.
   */
  get inOperation() {
    return this.state !== IDLE;
  }

  /**
   * True while the channel wants a cycle even though no list is running:
   * a device is selected and the selection timeout has to run down. This
   * is what the machine polls between instructions.
   */
  get wantsCycle() {
    return this.request || this.state === RUN || this.operation !== null;
  }

  reset() {
    this.operation = null;
    this.selectCycles = 0;
    this.device = null;
    this.unit = 0;
    this.state = IDLE;
    this.clr = this.car = this.cwr = this.cop = 0;
    this.ccore = this.dcore = 0;
    this.endOfFile = this.endOfRecord = this.redundancy = false;
    this.trapPending = false;
    this.trapCauses = 0;
  }

  /** TRC and TEF ask about a condition and clear it if it was set. */
  testAndClear(condition) {
    if (!this[condition]) return false;
    this[condition] = false;
    return true;
  }

  // ====================================================================
  // Instructions
  // ====================================================================

  /**
   * RDS, WRS and the tape motion instructions. `unit` is the low nine bits of
   * the address field: the device code.
   */
  select(cpu, operation, unit) {
    const device = this.devices.get(unit);
    if (!device) {
      // Selecting a device that is not there is an I/O check, which the
      // program is expected to notice with IOT.
      cpu.ioCheck = true;
      return;
    }

    switch (operation) {
      case 'read':
      case 'write':
        this.device = device;
        this.unit = unit;
        this.operation = operation;
        this.endOfFile = false;
        this.endOfRecord = false;
        this.trapPending = false;
        this.trapCauses = 0;
        // A selection does not last forever. On the real channel the device
        // answers a select within a fixed time or lets it drop; s709 models
        // that as `ccyc`, counting down from a per-device figure (the printer
        // gets 5000 cycles, a tape 600). If no command list arrives first the
        // selection simply expires, which is how CTSS's write-then-wait
        // sequences avoid deadlock.
        this.selectCycles = device.selectCycles ?? 600;
        device.startRecord(operation);
        break;
      default:
        // Tape motion happens at once; nothing is transferred, so the channel
        // stays unselected and the CPU carries on.
        device[operation]();
        this.beginningOfTape = device.atLoadPoint;
        break;
    }
  }

  /**
   * RCH — reset and load channel. Points the channel at a command list and
   * starts it. Issuing it while the channel is running makes the CPU wait,
   * which the hardware does by refusing to advance the instruction counter.
   */
  resetAndLoad(cpu) {
    if (this.state !== IDLE && this.state !== WAIT) {
      cpu.ic = (cpu.ic - 1) & ADDR;   // stall: re-execute the RCH
      return;
    }
    this.endOfRecord = false;
    this.redundancy = false;
    this.endOfFile = false;
    this.trapPending = false;
    this.trapCauses = 0;
    this.clr = cpu.y;
    this.ccore = cpu.bcoreData;
    if (this.operation === null) {
      cpu.ioCheck = true;
      return;
    }
    this.loadCommand();
  }

  /** LCH — load channel without resetting its conditions. */
  load(cpu) {
    if (this.operation === null) {
      cpu.ioCheck = true;
      return;
    }
    if (this.state === RUN) {
      cpu.ic = (cpu.ic - 1) & ADDR;   // stall until the current command ends
      return;
    }
    this.clr = cpu.y;
    this.ccore = cpu.bcoreData;
    this.loadCommand();
  }

  /** SCH — store the channel's registers so a program can see where it is. */
  storeControl(cpu) {
    const hi = ((this.cop & 7) << 15) | (this.clr & ADDR);
    const lo = ((this.cop & NON_TRANSMIT) ? 0o200000 : 0) | (this.car & ADDR);
    cpu.store(cpu.y, hi & HALF, lo & HALF);
  }

  /** SCD — a 7909 diagnostic. The 7607 has nothing to say. */
  diagnose() {}

  // ====================================================================
  // Running the command list
  // ====================================================================

  /** Fetch the next command word and set up the transfer it describes. */
  loadCommand() {
    const address = (this.clr & ADDR) | this.ccore;
    const hi = this.core.hi[address];
    const lo = this.core.lo[address];
    this.clr = (this.clr + 1) & ADDR;

    this.cop = (hi >>> 15) | ((lo & 0o200000) ? NON_TRANSMIT : 0);
    this.cwr = hi & ADDR;
    this.car = lo & ADDR;
    this.dcore = (lo & 0o100000) ? this.bcoreBit : 0;

    if (lo & 0o400000) {            // indirect: the address names the address
      const pointer = (this.car & ADDR) | this.dcore;
      this.car = this.core.lo[pointer] & ADDR;
    }

    if ((this.cop & 7) === TCH) {
      // Transfer control: not a transfer at all, just a jump in the list.
      this.clr = this.car;
      this.loadCommand();
      return;
    }

    this.state = RUN;
  }

  /**
   * Advance the channel one word. Called by the machine between processor
   * instructions, which is how a real channel steals cycles.
   * Returns true while the channel still has work.
   */
  step() {
    if (this.state !== RUN) {
      // Selected but no command list yet: the device's answer window is
      // running down. When it reaches zero the record is ended and the
      // channel drops the selection. The program sees the channel go idle,
      // which is what a TCO loop is waiting for. A device that sets
      // `selectCycles` to 0 has no window at all: the selection stands until
      // a command list runs or the channel is reset, which is what s709 does
      // for the CTSS drum (`ccyc` is 0 at the load_drum that follows a
      // select, so its deselect path is never entered).
      if (this.operation !== null && this.selectCycles > 0 && --this.selectCycles <= 0) {
        this.device.endRecord(this.operation === 'write');
        this.operation = null;
        // A selected channel going idle raises a channel trap: s709's
        // active_chan sets TRAPPEND on every deselect, not only on IOCD.
        this.trapCauses |= 0o1;
        this.trapPending = true;
      }
      return false;
    }

    const op = this.cop & 7;
    const transmit = (this.cop & NON_TRANSMIT) === 0;

    if (this.cwr > 0) {
      if (op === IORP && this.endOfRecord) {
        this.finishCommand(true);
        return true;
      }
      if (this.operation === 'read') {
        const value = this.device.readWord();
        if (value === null) {
          // The record ended before the count did.
          this.endOfRecord = true;
          if (this.device.atFileMark) {
            this.endOfFile = true;
            // The file mark raises the EOF trap when the channel is armed,
            // alongside the end-of-operation trap the deselect itself gives.
            this.trapCauses |= 0o4;
            this.trapPending = true;
          }
          // Only IOCP reads across a record boundary; everything else
          // finishes the command where the record ends. (s709 checks
          // CHAN_EOR in every op except IOCP.)
          if (op !== IOCP) {
            this.finishCommand(true);
            return true;
          }
          this.device.startRecord('read');
          return true;
        }
        if (transmit && op !== IOSP && op !== IOST) {
          const address = (this.car & ADDR) | this.dcore;
          this.core.hi[address] = value[0];
          this.core.lo[address] = value[1];
        }
      } else {
        const address = (this.car & ADDR) | this.dcore;
        this.device.writeWord(
          transmit ? this.core.hi[address] : 0,
          transmit ? this.core.lo[address] : 0,
        );
      }
      this.car = (this.car + 1) & ADDR;
      this.cwr -= 1;
      if (this.cwr > 0) {
        this.endOfRecord = false;
        return true;
      }
    }

    this.finishCommand(false);
    return true;
  }

  /**
   * The count ran out, or the record ended first. Whether the channel goes on
   * to another command word or disconnects is what distinguishes the eight
   * operations from one another.
   */
  finishCommand(recordEnded) {
    const op = this.cop & 7;
    switch (op) {
      case IOCD:
        this.disconnect();
        break;
      case IORP:
        // The record ends here; the list proceeds unless the device hit
        // the file mark, which drops the selection. (s709 done2.)
        this.device.endRecord(this.operation === 'write');
        if (this.endOfFile) this.park();
        else this.loadCommand();
        break;
      case IOCP:
      case IOSP:
        // Proceed to the next command; only the file mark stops the list.
        // (s709 done4/done6.)
        if (this.endOfFile) this.park();
        else this.loadCommand();
        break;
      case IORT:
      case IOCT:
      case IOST:
        // These terminate the operation: the channel does not continue
        // the command list but stays selected for fresh orders. IORT ends
        // the record on any device; IOCT and IOST only on a write-selected
        // tape (unit 0200-0277 in s709's done3/done5/done7).
        if (this.endOfFile) {
          this.park();
          break;
        }
        if (op === IORT || (this.operation === 'write' && (this.unit & 0o700) === 0o200))
          this.device.endRecord(this.operation === 'write');
        // WAIT, not IDLE: the command finished but the selection is still
        // up, so the channel still counts as in operation (and still takes
        // a fresh RCH) until the deselect window runs out — s709 leaves
        // chan_in_op set across exactly this span.
        this.state = WAIT;
        this.selectCycles = 60;
        break;
      default:
        this.disconnect();
        break;
    }
  }

  /**
   * Drop the selection without loading another command: the parked state a
   * record-terminating op or an end-of-file leaves behind. s709 raises
   * TRAPPEND whenever a selected channel deselects, so the end trap is
   * always queued here — an end of file adds its own cause on top.
   */
  park() {
    this.state = IDLE;
    this.operation = null;
    this.trapCauses |= 0o1;
    this.trapPending = true;
  }

  /**
   * End the record and release the device. s709's IOCD drops the selection
   * without a trap — a channel trap comes only from a selection timing out,
   * not from a command list finishing cleanly.
   */
  disconnect() {
    if (this.device) this.device.endRecord(this.operation === 'write');
    this.state = IDLE;
    this.operation = null;
  }
}
