/**
 * The 7909 data channel.
 *
 * The 7607 next door is a cycle-stealing engine with eight command words and no
 * opinions: the processor points it at a list, and it moves words until the list
 * disconnects. The 7909 is a small computer. It has nineteen instructions, an
 * assembly register, a loop counter, a mask of options, a condition register and
 * its own interrupt mechanism — because the devices it was built for cannot be
 * driven by a fixed list. A disk has to be told a seek address and then asked
 * whether the seek worked; a communications controller raises attention when a
 * line has something to say, on nobody's schedule but its own.
 *
 * It is also, in one way, simpler than the 7607: it has two states, and it has
 * no concept of a record. Where the 7607's eight operations are distinguished
 * entirely by what happens when a record ends, the 7909 leaves that to the
 * device, which signals the end explicitly and waits for the channel to notice.
 *
 * A channel command word is decoded quite differently from a 7607 one:
 *
 *     prefix S,1,2   the operation, times four
 *     bit 3          a second operation bit, for the prefixes that use it
 *     bits 3-17      word count, or a condition and mask, or a counter value
 *     bit 18         indirect: the real core address is at the address given
 *     bit 19         the low operation bit
 *     bits 21-35     core address
 *
 * so the five-bit opcode is assembled from three separate places in the word.
 * That is not gratuitous: it lets the 7909 keep the 7607's word layout, so the
 * same assembler and the same SCH can be pointed at either.
 *
 * Reference: IBM 7909 Data Channel Instruction Reference (223-2551), with the
 * behaviour taken from SIMH's i7094, which is the implementation the CTSS
 * reconstruction in `references/` is exercised against.
 */

import { HALF, ADDR, CORE_SIZE } from './word.js';

// --- The instruction set ----------------------------------------------------
// Five bits, assembled as (prefix << 2) | (bit 3) << 1 | (bit 19).

export const WTR = 0o00;   // wait for a signal, then take the next command
export const XMT = 0o01;   // transmit: copy a block core-to-core
export const TCH = 0o04;   // transfer: jump in the command list
export const LIPT = 0o05;  // leave interrupt program and transfer
export const CTL = 0o10;   // control: send control words to the device
export const CTLR = 0o11;  // control, then prepare to read
export const CTLW = 0o12;  // control, then prepare to write
export const SNS = 0o13;   // sense: ask the device for its status
export const LAR = 0o14;   // load the assembly register from core
export const SAR = 0o15;   // store the assembly register to core
export const TWT = 0o16;   // trap the processor, then wait
export const CPYP = 0o20;  // copy and proceed
export const CPYD = 0o24;  // copy and disconnect
export const TCM = 0o25;   // transfer on condition met
export const LIP = 0o31;   // leave interrupt program
export const TDC = 0o32;   // transfer and decrement the loop counter
export const LCC = 0o33;   // load the loop counter
export const SMS = 0o34;   // load the options mask
export const ICC = 0o35;   // insert the loop counter into the assembly register
export const ICCA = 0o37;  // the same, with the second operation bit ignored

/** Decrement-field subfields, for the instructions that use them. */
const NO_STORE = 0o20000;  // CTL group: do not send control words from core
const ANY_BIT = 0o100;     // TCM: match any named bit rather than the exact value
const COND_SHIFT = 12;     // TCM and ICC: which of the seven sources to test
const COND_MASK = 0o7;
const VALUE_MASK = 0o77;   // the six-bit mask, counter and options values

/** The second operation bit, as it sits in the decrement field. */
const OP_BIT3 = 0o40000;

/** Interrupt conditions, and the bits of the condition register. */
export const ADAPTER_CHECK = 0o01;
export const ATTENTION2 = 0o02;
export const ATTENTION1 = 0o04;
export const UNUSUAL_END = 0o10;
export const SEQUENCE_CHECK = 0o20;
export const IO_CHECK = 0o40;

/** Options mask bits, set by SMS. Each inhibits something. */
export const SELECT2 = 0o001;
export const INHIBIT_ATTENTION2 = 0o002;
export const INHIBIT_ATTENTION1 = 0o004;
export const INHIBIT_UNUSUAL_END = 0o010;
export const BCD_CONVERT = 0o020;
export const READ_BACKWARD = 0o040;
export const NONCONTIGUOUS = 0o100;

/**
 * Where the processor's core holds a channel's interrupt. Two words each:
 * the first takes the channel's place in its own program, the second is the
 * command the channel executes instead.
 */
const INTERRUPT_BASE = 0o42;

/** The two states. */
const IDLE = 0;
const RUN = 2;   // the same number the 7607 uses, so the machine polls both alike

/** Device selection codes, shared with the 7607. */
export const SEL_READ = 0o01;
export const SEL_WRITE = 0o02;
export const SEL_SENSE = 0o03;
export const SEL_CONTROL = 0o04;

export class Channel9 {
  constructor(index) {
    this.index = index;
    this.letter = String.fromCharCode(65 + index);
    this.is7909 = true;

    this.devices = new Map();
    /** The 7909 drives one adapter, not a shelf of tape units. */
    this.device = null;

    this.state = IDLE;
    /** True when the channel wants a cycle. The machine polls this. */
    this.request = false;

    /** Command location counter: where the next command word comes from. */
    this.clr = 0;
    /** Core address register. */
    this.car = 0;
    /** Word count, or the decrement field of a non-data command. */
    this.cwr = 0;
    /** The decoded five-bit operation. */
    this.cop = 0;
    /** B-core select for the command list and for data. */
    this.ccore = 0;
    this.dcore = 0;

    /** The assembly register: one 36-bit word, in two halves. */
    this.arHi = 0;
    this.arLo = 0;
    /** True while the assembly register holds a word the device just sent. */
    this.arValid = false;

    /** Loop control counter, options mask, condition register. */
    this.lcc = 0;
    this.sms = 0;
    this.condition = 0;

    /** Where the channel is in a transfer. */
    this.prepareRead = false;
    this.prepareWrite = false;
    this.reading = false;
    this.writing = false;
    this.endOfRecord = false;
    /**
     * The adapter has been selected and has not yet reported the engagement
     * over — s709's csel. A copy command cannot move a word without it: the
     * device is the only clock the transfer has, and a device that is not
     * there never asks for the next word.
     */
    this.deviceSelected = false;

    /**
     * True while the program is stopped at a WTR or TWT, s709's CHAN_INWAIT.
     * This is what tells an LCH/STC that there is a program to restart, and it
     * is cleared by every way of starting the channel — RCH, the interrupt, and
     * the start itself (s709 clears it in load_7909, start_7909 and check_7909).
     */
    this.waiting = false;

    /** An interrupt is requested; an interrupt is in progress. */
    this.interruptRequest = false;
    this.inInterrupt = false;

    /** A processor trap is waiting, raised by TWT. */
    this.trapPending = false;
    /** Why the trap is owed; a 7909 only ever ends normally (cause 0o1). */
    this.trapCauses = 0;

    /** Conditions the 7607 exposes and the sense instructions ask about. */
    this.endOfFile = false;
    this.redundancy = false;
    this.beginningOfTape = false;
    this.endOfTape = false;
    this.spraCode = 0;

    this.core = null;
    this.bcoreBit = 0;
  }

  connect(core) {
    this.core = core;
    this.bcoreBit = core.banks > 1 ? CORE_SIZE : 0;
  }

  /**
   * Attach the adapter. The unit code is kept so the same call works for both
   * kinds of channel, but a 7909 has exactly one thing on the end of it.
   */
  attach(unit, device) {
    this.devices.set(unit, device);
    this.device = device;
    device.channel = this;
  }

  /**
   * What TCO asks: is the channel in operation?
   *
   * On a 7607 this means a device is selected, because that is the only way a
   * 7607 is ever busy. A 7909 is busy whenever it is running a program of its
   * own, which is what the disk loader waits on between starting the channel
   * and using what it fetched — so "selected" here is "not stopped".
   */
  get selected() {
    return this.state !== IDLE;
  }

  /**
   * True while the channel has work in flight. A 7909 parked at WTR or TWT is
   * not in operation; one running a program, mid-transfer, or asking for a
   * cycle is. A trap waiting to be taken does not count — s709's `chan_in_op`
   * clears when the channel parks, and a pending trap is delivered when the
   * machine next runs rather than keeping it awake. A processor halted by
   * HTR waits on this: when no channel is in operation there is nothing left
   * that could restart it, and the machine stops.
   */
  get inOperation() {
    return this.state !== IDLE || this.request || this.transferring || this.interruptRequest;
  }

  /**
   * What the machine polls between instructions: a 7909 wants a cycle while
   * it has a request outstanding, a program running, or an interrupt waiting
   * to be taken — s709's check_7909 honors a pending interrupt on every
   * processor cycle, so there is no request gate on it here either.
   */
  get wantsCycle() {
    return this.request || this.state === RUN || this.interruptRequest
      || this.deviceWantsAttention;
  }

  /**
   * A device that is not transferring can still have something to say. Only
   * the communications controller does: it owes lines completions the 7094 has
   * not collected, and it has no other way to ask (s709 runs its comm task on
   * its own, see devices/comm.js `idle`). Polling the channel for it here is
   * what gives the device its idle cycle at all.
   */
  get deviceWantsAttention() {
    return !this.request && !this.transferring && !!this.device
      && !!(this.device.wantsAttention);
  }

  reset() {
    this.state = IDLE;
    this.request = false;
    this.clr = this.car = this.cwr = this.cop = 0;
    this.ccore = this.dcore = 0;
    this.arHi = this.arLo = 0;
    this.arValid = false;
    this.lcc = this.sms = this.condition = 0;
    this.prepareRead = this.prepareWrite = false;
    this.reading = this.writing = false;
    this.endOfRecord = false;
    this.deviceSelected = false;
    this.waiting = false;
    this.interruptRequest = this.inInterrupt = false;
    this.trapPending = false;
    this.trapCauses = 0;
    this.endOfFile = this.redundancy = false;
    if (this.device && this.device.reset) this.device.reset();
  }

  testAndClear(condition) {
    if (!this[condition]) return false;
    this[condition] = false;
    return true;
  }

  // ====================================================================
  // What the processor can do to it
  // ====================================================================

  /**
   * RDS and WRS name a 7607. Pointing one at a 7909 is a program error the
   * hardware reports as an I/O check rather than obeying.
   */
  select(cpu) {
    cpu.ioCheck = true;
  }

  /** RCH — start the channel at a command list. */
  resetAndLoad(cpu) {
    this.clr = cpu.y;
    this.ccore = cpu.bcoreData;
    this.state = RUN;
    this.waiting = false;
    this.nextCommand();
  }

  /**
   * LCH — which the CTSS listings assemble as STC, "start channel". On a 7909
   * this is not a second way to load a command list: it restarts a program that
   * stopped at a wait, and the instruction's address field is not used at all
   * (CTSS's `STCE` is assembled with address zero — CHNE0140-0182 uses it both
   * in STARTE, "restart channel E", and at the end of every 7909 interrupt
   * (CHNE0115)).
   *
   * s709 makes the same distinction: `check_load` starts the channel only when
   * the program is stopped in a wait (`cflags & CHAN_INWAIT`, set by the WTR
   * and TWT handlers) and otherwise leaves the instruction a no-op, and
   * `start_7909` takes the resume point from the channel's own address
   * register — the operand of the command it stopped on. That operand is the
   * designed resume point: `160 WTR CKTRAP` waits for a signal and continues at
   * CKTRAP, `166 RSTRAP TWT *+1` traps and continues one word later. Reading
   * the address field instead (as an RCH) runs the word at core 0 — the 7094's
   * own trap cell — whose all-but-empty word decodes as a WTR and parks the
   * channel for good.
   */
  load(cpu) {
    if (!this.waiting) return;
    this.waiting = false;
    this.clr = this.car & ADDR;
    this.state = RUN;
    this.nextCommand();
  }

  /** SCH — store where the channel has got to. */
  storeControl(cpu) {
    const hi = ((this.cop & 7) << 15) | (this.clr & ADDR);
    const lo = this.car & ADDR;
    cpu.store(cpu.y, hi & HALF, lo & HALF);
  }

  /**
   * SCD — the 7909 diagnostic store. Unlike the 7607, this channel has plenty
   * to say: the condition register, the options mask and the loop counter are
   * how a program finds out why an interrupt happened.
   */
  diagnose(cpu) {
    const hi = ((this.condition & 0o77) << 6) | (this.sms & 0o177);
    const lo = ((this.lcc & 0o77) << 12) | (this.car & 0o7777);
    cpu.store(cpu.y, hi & HALF, lo & HALF);
  }

  // ====================================================================
  // What the device can do to it
  // ====================================================================

  /**
   * The device has a word for the channel. Handing over a second word before
   * the channel has taken the first is an I/O check — the channel has exactly
   * one assembly register and nowhere to put it.
   */
  inputWord(hi, lo) {
    if (this.arValid) this.setIoCheck();
    this.arHi = hi & HALF;
    this.arLo = lo & HALF;
    this.arValid = true;
    this.request = true;
  }

  /** The device has finished. `conditions` is usually 0 or UNUSUAL_END. */
  setEnd(conditions = 0) {
    this.endOfRecord = true;
    this.deviceSelected = false;
    this.raise(conditions);
    this.request = true;
  }

  /** A line, or an access arm, wants attention. */
  setAttention() {
    this.raise(ATTENTION1);
  }

  /**
   * Something went wrong that the channel could not have caused. This also
   * lights the processor's I/O check indicator, which is what IOT tests —
   * unless we are already inside an interrupt, where the flag would be lost.
   */
  setIoCheck() {
    if (this.inInterrupt) return;
    this.ioCheckPending = true;
    this.raise(IO_CHECK);
  }

  /**
   * Fold new conditions in, and decide whether they add up to an interrupt.
   *
   * A condition that the options mask inhibits still gets recorded — it simply
   * does not interrupt — which is how a program can turn attention off, do
   * something uninterruptible, and turn it back on without losing the fact that
   * a line was asking. Sequence check is different: it is inhibited for exactly
   * as long as a transfer is in progress, because during a transfer it is not
   * an error at all.
   */
  raise(conditions) {
    // The condition register records what happened whether or not anybody is
    // going to be interrupted about it. That distinction is the whole point of
    // the options mask: a program that inhibits attention is not saying it does
    // not care, it is saying it would rather ask than be interrupted — and then
    // it asks with TCM. The CTSS disk loader is exactly that program, and it
    // waits forever if an inhibited condition never reaches the register.
    this.condition |= conditions;
    if (this.inInterrupt) return;

    let inhibited = 0;
    if (this.sms & INHIBIT_UNUSUAL_END) inhibited |= UNUSUAL_END;
    if (this.sms & INHIBIT_ATTENTION1) inhibited |= ATTENTION1;
    if (this.sms & INHIBIT_ATTENTION2) inhibited |= ATTENTION2;
    if (this.transferring) inhibited |= SEQUENCE_CHECK;

    if (!(this.condition & ~inhibited)) return;
    this.interruptRequest = true;
    this.request = true;
  }

  /** True while a transfer is set up or running. */
  get transferring() {
    return this.prepareRead || this.prepareWrite || this.reading || this.writing;
  }

  // ====================================================================
  // Running the command list
  // ====================================================================

  /** Read the next command word, decode it, and set the channel going. */
  nextCommand() {
    const address = (this.clr & ADDR) | this.ccore;
    const hi = this.core.hi[address];
    const lo = this.core.lo[address];
    this.decode(hi, lo);
    if (this.debug) {
      const w = hi.toString(8).padStart(6, '0') + lo.toString(8).padStart(6, '0');
      console.log(`LC9 ${this.letter} clr=${address.toString(8)} word=${w} cop=${this.cop.toString(8)} cwr=${this.cwr.toString(8)} car=${this.car.toString(8)} dcore=${this.dcore ? 1 : 0}`);
    }
    // A command that stopped the channel leaves the counter where it is, so
    // the saved location on an interrupt points at the right place.
    if (this.state !== IDLE) this.clr = (this.clr + 1) & ADDR;
  }

  /**
   * Decode one command word and take whatever action it needs before the
   * channel's next cycle. The five-bit opcode comes from three places: the
   * prefix, bit 3 of the decrement, and bit 19.
   */
  decode(hi, lo) {
    const prefix = (hi >>> 15) & 7;
    const decrement = hi & ADDR;
    const base = prefix << 2;

    this.cwr = decrement;
    this.car = lo & ADDR;
    this.dcore = (lo & 0o100000) ? this.bcoreBit : 0;
    this.cop = base
      | ((lo & 0o200000) ? 1 : 0)
      | (((base & 0o10) && (decrement & OP_BIT3)) ? 2 : 0);

    if (lo & 0o400000) {                    // indirect
      const pointer = (this.car & ADDR) | this.dcore;
      this.car = this.core.lo[pointer] & ADDR;
    }

    switch (this.cop) {
      // Instructions the channel executes itself, on its own next cycle.
      case LAR: case SAR: case ICC: case ICCA:
      case XMT: case LCC: case SMS:
        // None of these may happen in the middle of a transfer.
        if (this.transferring) this.raise(SEQUENCE_CHECK);
        this.request = true;
        break;

      case TCM: case TCH: case TDC: case LIPT: case LIP:
        this.request = true;
        break;

      case CTL: case CTLR: case CTLW:
        if (this.transferring) this.raise(SEQUENCE_CHECK);
        this.endOfRecord = false;
        if (this.cwr & NO_STORE) this.request = true;
        else this.sendSelect(SEL_CONTROL);
        break;

      case SNS:
        if (this.transferring) this.raise(SEQUENCE_CHECK);
        this.endOfRecord = false;
        this.request = true;
        break;

      case CPYD: case CPYP:
        // A copy with no transfer standing is not a sequence error in s709:
        // the word transfer is simply refused and the command ends. Raising
        // the check here would interrupt a program that was never told to
        // expect one.
        if (this.prepareRead) this.reading = true;
        else if (this.prepareWrite) this.writing = true;
        // An end of record still standing here is the device reporting that
        // the transfer it was selected for never engaged — a rejected select
        // ends it through unusualEnd. Copy sees it and finishes the command,
        // which is what s709 does when writeword/readword refuse a word.
        this.prepareRead = this.prepareWrite = false;
        // The command gets one cycle no matter what: copy decides whether a
        // word moves, whether the device must be waited on, or whether the
        // command is already done. Asking only the device to start it leaves
        // a copy parked forever when there is no device to ask.
        this.request = true;
        break;

      case WTR:
        this.state = IDLE;
        this.request = false;
        this.waiting = true;
        break;

      case TWT:
        this.state = IDLE;
        this.request = false;
        this.waiting = true;
        this.trapCauses |= 0o1;
        this.trapPending = true;
        break;

      default:
        // An opcode the channel has no wiring for stops it, rather than
        // letting it run away through core.
        this.state = IDLE;
        this.request = false;
        break;
    }
  }

  /** Tell the adapter what kind of operation is coming. */
  sendSelect(selection) {
    // The adapter is engaged until it says it is done. A select it rejects
    // ends at once through unusualEnd, which clears the flag again before
    // the next cycle can mistake the refusal for a working transfer.
    this.deviceSelected = true;
    if (this.device && this.device.select) this.device.select(this, selection);
  }

  /** Hand one word to the adapter. */
  sendWord(hi, lo, stop = false) {
    if (this.device && this.device.write) this.device.write(this, hi, lo, stop);
  }

  /**
   * Advance the channel one cycle. Called by the machine between processor
   * instructions, exactly as the 7607 is.
   */
  step() {
    // A 7909 transfer is driven by the device, not by the channel: the channel
    // hands over or takes one word and then waits to be asked again. SIMH gets
    // the asking from its event scheduler. There is no scheduler here, so a
    // device that is mid-transfer and has the channel waiting on it is given
    // the cycle instead — which is the same handshake, minus the clock.
    if (!this.request && this.transferring && this.device && this.device.service) {
      this.device.service(this);
    } else if (!this.request && !this.transferring && this.device && this.device.idle) {
      // Nothing is in flight, but the device may still have its own work: the
      // 7750 runs a task of its own in s709 and reports completions nobody has
      // asked it for. That task lives here.
      this.device.idle(this);
    }
    // s709's check_7909 honors a pending interrupt on every processor cycle
    // that the channel is not running — there is no request gate. A channel
    // parked at WTR with an interrupt still jumps to its interrupt program.
    if (this.interruptRequest && this.state !== RUN) return this.takeInterrupt();
    if (!this.request) return false;
    this.request = false;
    if (this.state !== RUN) return false;

    switch (this.cop) {
      case WTR: case TWT: case TCH:
        this.clr = this.car & ADDR;
        break;

      case TDC:
        if (this.lcc !== 0) {
          this.lcc -= 1;
          this.clr = this.car & ADDR;
        }
        break;

      case TCM:
        if (this.conditionMet()) this.clr = this.car & ADDR;
        break;

      case LIP: {
        const save = INTERRUPT_BASE + (this.index << 1);
        this.inInterrupt = false;
        this.interruptRequest = false;
        this.condition = 0;
        this.clr = this.core.lo[save] & ADDR;
        break;
      }

      case LIPT:
        this.inInterrupt = false;
        this.interruptRequest = false;
        this.condition = 0;
        this.clr = this.car & ADDR;
        break;

      case LAR: {
        const address = (this.car & ADDR) | this.dcore;
        this.arHi = this.core.hi[address];
        this.arLo = this.core.lo[address];
        break;
      }

      case SAR: {
        const address = (this.car & ADDR) | this.dcore;
        this.core.hi[address] = this.arHi;
        this.core.lo[address] = this.arLo;
        break;
      }

      case SMS:
        this.sms = this.car & 0o177;
        // Un-inhibiting attention with a condition already waiting must
        // interrupt now, not at whatever unrelated moment the next one
        // arrives. s709 also drops a stale pending interrupt when the new
        // mask does not allow one — an SMS is the program's way of saying
        // the conditions it has seen are the ones that count.
        if (!(this.sms & INHIBIT_ATTENTION1) &&
            (this.condition & (ATTENTION1 | ATTENTION2 | ADAPTER_CHECK | SEQUENCE_CHECK | IO_CHECK | UNUSUAL_END))) {
          this.raise(0);
        } else {
          this.interruptRequest = false;
        }
        break;

      case LCC:
        this.lcc = this.car & VALUE_MASK;
        break;

      case ICC: case ICCA: {
        const select = (this.cwr >>> COND_SHIFT) & COND_MASK;
        if (select === 0) {
          this.arLo = (this.arLo & ~0o177) | (this.sms & 0o177);
        } else if (select < 7) {
          this.putByte(6 - select, this.lcc & VALUE_MASK);
        }
        break;
      }

      case XMT: {
        if (this.cwr === 0) break;
        const from = (this.clr & ADDR) | this.ccore;
        const to = (this.car & ADDR) | this.dcore;
        this.core.hi[to] = this.core.hi[from];
        this.core.lo[to] = this.core.lo[from];
        this.clr = (this.clr + 1) & ADDR;
        this.car = (this.car + 1) & ADDR;
        this.cwr -= 1;
        // One word per cycle: come back for the rest rather than blocking.
        this.request = true;
        return true;
      }

      case SNS:
        this.sendSelect(SEL_SENSE);
        this.prepareRead = true;
        break;

      case CTL: case CTLR: case CTLW: {
        // Control words go out one per cycle until the count is spent or the
        // device says it has heard enough.
        if (!(this.cwr & NO_STORE) && !this.endOfRecord) {
          const address = (this.car & ADDR) | this.dcore;
          const hi = this.core.hi[address];
          const lo = this.core.lo[address];
          this.car = (this.car + 1) & ADDR;
          this.sendWord(hi, lo);
          return true;
        }
        this.endOfRecord = false;
        if (this.cop === CTLR) {
          this.sendSelect(SEL_READ);
          this.prepareRead = true;
          this.arValid = false;
        } else if (this.cop === CTLW) {
          this.sendSelect(SEL_WRITE);
          this.prepareWrite = true;
        }
        break;
      }

      case CPYD:
        return this.copy(true);

      case CPYP:
        return this.copy(false);

      default:
        this.state = IDLE;
        return false;
    }

    this.nextCommand();
    return true;
  }

  /**
   * CPYD and CPYP. The difference is what happens when the count runs out:
   * CPYD stops the device and disconnects, CPYP simply moves on to the next
   * command with the transfer still standing.
   */
  copy(disconnect) {
    if (disconnect) {
      if (this.cwr === 0 || this.endOfRecord) {
        if (this.transferring) {
          this.prepareRead = this.prepareWrite = false;
          this.reading = this.writing = false;
          this.sendWord(0, 0, true);          // stop
        }
        if (this.endOfRecord) {
          this.endOfRecord = false;
          this.nextCommand();
          return true;
        }
        return false;                          // wait for the device to end
      }
    } else {
      // The command is done when the count runs out or when the device ends
      // the record on its own — s709's CPYP takes the next command on either.
      // A device that has already gone idle cannot take another word, and
      // asking it anyway leaves the channel waiting on an answer that never
      // comes. A device end also retires the transfer flags: the record is
      // over, so nothing stands to keep copying.
      if (this.cwr === 0 || this.endOfRecord) {
        if (this.endOfRecord) this.reading = this.writing = false;
        this.endOfRecord = false;
        this.nextCommand();
        return true;
      }
    }

    // No adapter is engaged, so no word can move and none ever will — the
    // transfer the copy expected is not there. s709's readword/writeword
    // refuse the word and the command is over; waiting instead would park
    // the channel on a device that never calls back.
    if (!this.deviceSelected) {
      this.reading = this.writing = false;
      this.nextCommand();
      return true;
    }

    if (this.reading) {
      // Nothing to store until the device has actually handed a word over.
      // Storing anyway would write the previous word a second time, which is
      // the kind of fault that leaves a plausible-looking record on a disk.
      if (!this.arValid) return false;
      this.storeWord();
    } else {
      this.fetchWord();
    }

    if (!disconnect && this.cwr === 0) {
      this.nextCommand();
      return true;
    }
    return true;
  }

  /** Read side: the assembly register goes to core. */
  storeWord() {
    this.arValid = false;
    if (this.cwr === 0) return;
    const address = (this.car & ADDR) | this.dcore;
    this.core.hi[address] = this.arHi;
    this.core.lo[address] = this.arLo;
    this.car = (this.car + 1) & ADDR;
    this.cwr -= 1;
  }

  /** Write side: core goes to the assembly register and out to the device. */
  fetchWord() {
    if (this.cwr === 0) {
      this.arHi = this.arLo = 0;
    } else {
      const address = (this.car & ADDR) | this.dcore;
      this.arHi = this.core.hi[address];
      this.arLo = this.core.lo[address];
      this.car = (this.car + 1) & ADDR;
      this.cwr -= 1;
    }
    this.sendWord(this.arHi, this.arLo);
  }

  /**
   * TCM's test. The condition select picks one of seven sources: the condition
   * register itself, or one of the six characters of the assembly register.
   * Bit 11 chooses between "every named bit is on" and "exactly this value".
   */
  conditionMet() {
    const select = (this.cwr >>> COND_SHIFT) & COND_MASK;
    const mask = this.cwr & VALUE_MASK;
    if (select === 7) return mask === 0;
    const value = select === 0 ? this.condition : this.getByte(6 - select);
    if (this.cwr & ANY_BIT) return (value & mask) === mask;
    return value === mask;
  }

  /** One of the six six-bit characters of the assembly register, 0 leftmost. */
  getByte(index) {
    if (index < 3) return (this.arHi >>> (12 - index * 6)) & 0o77;
    return (this.arLo >>> (12 - (index - 3) * 6)) & 0o77;
  }

  putByte(index, value) {
    if (index < 3) {
      const shift = 12 - index * 6;
      this.arHi = (this.arHi & ~(0o77 << shift) & HALF) | ((value & 0o77) << shift);
    } else {
      const shift = 12 - (index - 3) * 6;
      this.arLo = (this.arLo & ~(0o77 << shift) & HALF) | ((value & 0o77) << shift);
    }
  }

  /**
   * Enter the interrupt program.
   *
   * The channel writes where it had got to into the first of its two words and
   * executes the second in place, without disturbing the command counter. Which
   * address gets saved depends on whether the channel was between commands or
   * stopped at one: a stopped channel has not yet advanced past the command it
   * is sitting on, and must come back to it rather than to the one after.
   */
  takeInterrupt() {
    const save = INTERRUPT_BASE + (this.index << 1);
    const resume = this.state === IDLE ? this.clr : (this.clr + 1) & ADDR;
    this.core.hi[save] = (this.car & ADDR) & HALF;
    this.core.lo[save] = resume & ADDR;

    this.state = RUN;
    this.waiting = false;
    this.inInterrupt = true;
    this.interruptRequest = false;
    this.prepareRead = this.prepareWrite = false;
    this.reading = this.writing = false;

    this.decode(this.core.hi[save + 1], this.core.lo[save + 1]);
    return true;
  }
}
