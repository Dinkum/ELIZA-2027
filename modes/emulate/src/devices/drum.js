/**
 * The 7289 drum, CTSS's fast swap store.
 *
 * The drum is nothing like the disk. There is no file control, no orders and
 * no record structure: it is word-addressed bulk memory on a channel of its
 * own. A drum operation is two words where the disk needs a whole order:
 *
 *     word 0   drum address — bits 30-32 name the physical drum (which of the
 *              mounted containers), bits 18-20 the logical drum inside it
 *              (a container is six of them), bits 0-15 a word offset
 *     word 1   an ordinary channel command word — operation, count, address
 *
 * after which the channel moves words until the count runs out and reports
 * done the way anything else does, with a trap. CTSS keeps its most-used
 * supervisor pages and its swap image here, which is why the reconstruction
 * mounts two of them on channel G.
 *
 * The channel side is the 7607's: a write or read select first (the address
 * word cannot say which direction it wants), then a reset-and-load pointing
 * at the two words above. s709 handles it inside the 7909 code as a special
 * case (`load_drum`); here it is a `Channel` subclass, because the transfer
 * itself is exactly what a 7607 does.
 *
 * Reference: `load_drum` and the `DASD_CTSSDRUM` paths in s709's
 * `chan7607.c`.
 */

import { Channel } from '../channel.js';
import { ADDR } from '../word.js';

/** Six bytes hold one word: a six-bit character each. */
const BYTES_PER_WORD = 6;
/** One container is six logical drums. */
const WORDS_PER_LOGICAL = 0o100000;            // 32768
const LOGICAL_BYTES = WORDS_PER_LOGICAL * BYTES_PER_WORD;
/** The container's fixed header, the same sixteen bytes every container has. */
const HEADER_BYTES = 16;

/**
 * The drums mounted on a channel, by physical drum number. Holds the whole
 * container in memory — a drum is only ever a million characters, and being
 * able to write into it directly is worth more than seeking.
 */
export class DrumControl {
  constructor() {
    this.name = 'DRUM';
    this.channel = null;
    /** Mounted containers, by the physical drum number the address word names. */
    this.modules = new Map();
    this.active = null;
    this.byte = 0;
    /**
     * The CTSS drum's selection does not time out. s709's `load_drum` runs
     * with `csel` still holding READ_SEL or WRITE_SEL and `ccyc` zero, so its
     * deselect path is never entered: the selection stands until the command
     * list runs or the channel is reset. CTSS depends on that — FREAD issues
     * RDS ten instructions before its RCHU and FWRITE issues WRS the same way,
     * and the RCH takes the transfer direction from the surviving selection.
     * Expiring it turns every FWRITE into a read, which writes the drum image
     * over the machine-conditions block in A core (0o72156/0o72556) instead of
     * saving it — that is how the session's USRFIL/AFSTU2 revert to the values
     * an earlier image was saved with.
     */
    this.selectCycles = 0;
  }

  /** Mount a container's bytes as physical drum `number`. */
  mount(number, bytes) {
    this.modules.set(number, { bytes });
  }

  /** Where a drum operation starts: logical drum and word offset inside it. */
  begin(number, logical, word) {
    const module = this.modules.get(number);
    this.active = module ?? null;
    if (!module) return;
    this.byte = HEADER_BYTES + (logical - 1) * LOGICAL_BYTES + word * BYTES_PER_WORD;
  }

  startRecord() {}

  /** The next word off the drum, or null when there is no drum there. */
  readWord() {
    const module = this.active;
    if (!module || this.byte + BYTES_PER_WORD > module.bytes.length) return null;
    const b = module.bytes;
    const at = this.byte;
    this.byte += BYTES_PER_WORD;
    const hi = ((b[at] & 0o77) << 12) | ((b[at + 1] & 0o77) << 6) | (b[at + 2] & 0o77);
    const lo = ((b[at + 3] & 0o77) << 12) | ((b[at + 4] & 0o77) << 6) | (b[at + 5] & 0o77);
    return [hi, lo];
  }

  writeWord(hi, lo) {
    const module = this.active;
    if (!module || this.byte + BYTES_PER_WORD > module.bytes.length) return;
    const b = module.bytes;
    b[this.byte] = (hi >>> 12) & 0o77;
    b[this.byte + 1] = (hi >>> 6) & 0o77;
    b[this.byte + 2] = hi & 0o77;
    b[this.byte + 3] = (lo >>> 12) & 0o77;
    b[this.byte + 4] = (lo >>> 6) & 0o77;
    b[this.byte + 5] = lo & 0o77;
    this.byte += BYTES_PER_WORD;
  }

  endRecord() {}

  backspaceRecord() {}
  backspaceFile() {}
  writeEndOfFile() {}
  rewind() {}
  rewindUnload() {}
  setDensity() {}
}

/**
 * A channel wired to drums rather than a file control. Behaves as a 7607 in
 * every respect except how a command list begins: the first word is the drum
 * address, the second the command. Which drum the address names comes out of
 * the word itself — the select does not choose it, only the direction.
 */
export class DrumChannel extends Channel {
  /**
   * @param {number} index channel index, G on the CTSS machine.
   * @param {DrumControl} control the drums on the end of it.
   */
  constructor(index, control) {
    super(index);
    this.control = control;
    this.device = control;
    control.channel = this;
  }

  /**
   * The drums have no unit codes: any read or write select takes the drum.
   * Everything else a select can name is an I/O check, as it is on a 7909.
   */
  select(cpu, operation) {
    if (operation !== 'read' && operation !== 'write') {
      cpu.ioCheck = true;
      return;
    }
    this.device = this.control;
    this.operation = operation;
    this.endOfFile = false;
    this.endOfRecord = false;
    this.trapPending = false;
    this.trapCauses = 0;
    this.selectCycles = this.control.selectCycles;
    this.control.startRecord(operation);
  }

  /**
   * Reset and load: first the drum address word, then one command word.
   * Unlike the disk, no select is required — the address word carries the
   * drum number — but without a select the transfer reads rather than
   * writes, which is what the hardware's write-check does too.
   */
  resetAndLoad(cpu) {
    if (this.state !== 0 && this.state !== 3) {      // not IDLE or WAIT
      cpu.ic = (cpu.ic - 1) & ADDR;      // stall: re-execute when free
      return;
    }
    this.endOfRecord = false;
    this.redundancy = false;
    this.endOfFile = false;
    this.trapPending = false;
    this.trapCauses = 0;
    this.clr = cpu.y;
    this.ccore = cpu.bcoreData;
    this.device = this.control;
    if (!this.operation) this.operation = 'read';

    // The drum address word: physical drum in bits 30-32, logical drum in
    // bits 18-20, word offset in bits 0-15.
    const at = (this.clr & ADDR) | this.ccore;
    this.control.begin(
      (this.core.hi[at] >>> 12) & 7,
      this.core.hi[at] & 7,
      this.core.lo[at] & 0o177777,
    );
    this.clr = (this.clr + 1) & ADDR;

    this.loadCommand();
  }

  /**
   * A CTSS drum reports every completed operation with a channel trap —
   * s709's `check_reset` sets CHAN_TRAPPEND for DASD_CTSSDRUM on both the
   * read and write paths, including the clean IOCD disconnect that an
   * ordinary 7607 lets pass silently. CTSS relies on it: the drum driver
   * zeroes its trap cell before the operation and reads the stored status
   * back afterwards, so a silent disconnect looks like a failed transfer
   * and is retried until the supervisor reports a drum error.
   */
  disconnect() {
    super.disconnect();
    this.trapCauses |= 0o1;
    this.trapPending = true;
  }
}
