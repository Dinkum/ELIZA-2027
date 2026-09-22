/**
 * The 7631 file control, and the disks hanging off it.
 *
 * CTSS lives on disk. The supervisor is loaded from it, every user's files are
 * on it, and the whole time-sharing idea depends on being able to swap a user
 * program out to it and another one in. So this is the device that has to work
 * before `runcom make` can build SLIP and ELIZA on the emulated machine.
 *
 * It is not a block device. A 7631 track is a piece of formatted media that the
 * program lays out itself:
 *
 *     home address 1   the track number, four BCD digits, written by the format
 *     home address 2   six BCD characters of the program's own choosing
 *     record 1..n      each a record address of six characters, then data
 *
 * and a track ends at the first record whose length is zero. Records are
 * variable length and a program addresses them by the identifier it gave them
 * rather than by position, which is why reading one means walking the track and
 * comparing. CTSS writes one 435-word record per track and finds it by name.
 *
 * Orders arrive as ten BCD characters in two words, not as an opcode:
 *
 *     word 0   op op access module d1 d2
 *     word 1   d3 d4 d5 d6 - -
 *
 * where d1..d6 are a track number and home address, or a record identifier,
 * depending on the order. Status comes back the same way, as ten characters of
 * sense data.
 *
 * Reference: SIMH's i7094_dsk.c, which is where the CTSS record layout and the
 * order encoding below are taken from; the 7631 manuals describe a much larger
 * machine than CTSS ever asked for.
 */

import { HALF } from '../word.js';
import { SEL_READ, SEL_WRITE, SEL_SENSE, SEL_CONTROL, UNUSUAL_END } from '../channel9.js';

/** The four devices a 7631 could drive. CTSS used 1301s. */
export const DISK_TYPES = {
  7320: { name: '7320', accesses: 1, wordsPerTrack: 500, tracksPerCylinder: 400, cylinders: 1, overhead: 4 },
  1301: { name: '1301', accesses: 1, wordsPerTrack: 500, tracksPerCylinder: 40, cylinders: 250, overhead: 4 },
  1302: { name: '1302', accesses: 2, wordsPerTrack: 1000, tracksPerCylinder: 40, cylinders: 250, overhead: 7 },
  2302: { name: '2302', accesses: 2, wordsPerTrack: 1000, tracksPerCylinder: 40, cylinders: 250, overhead: 7 },
};

/** Orders in the 0x group: they configure the controller and move nothing. */
const NOP = 0x0;
const RELEASE = 0x4;
const MODE_8BIT = 0x8;
const MODE_6BIT = 0x9;

/** Orders in the 8x group: they name an access and a place on it. */
const SEEK = 0x0;
const SINGLE_RECORD = 0x2;
const WRITE_FORMAT = 0x3;
const TRACK_NO_ADDRESS = 0x4;
const CYLINDER = 0x5;
const WRITE_CHECK = 0x6;
const ACCESS_INOPERATIVE = 0x7;
const TRACK_WITH_ADDRESS = 0x8;
const TRACK_HOME_ADDRESS = 0x9;

/** Positions of the ten characters of an order. */
const OP1 = 0, OP2 = 1, ACCESS = 2, MODULE = 3, T1 = 4;

/**
 * Sense bits, in the first word of the ten-character status. The layout is
 * s709's csns words: character 0 holds the class flag (04 = program check,
 * 02 = data check, 01 = device check), characters 1-3 the specific bit, and
 * CTSS tests them by name in its disk driver.
 */
export const SENSE = {
  INVALID_SEQUENCE: { hi: 0o042000, lo: 0 },
  INVALID_ORDER: { hi: 0o040400, lo: 0 },
  FORMAT_CHECK: { hi: 0o040200, lo: 0 },
  NO_RECORD_FOUND: { hi: 0o040100, lo: 0 },
  INVALID_ADDRESS: { hi: 0o040020, lo: 0 },
  RESPONSE_CHECK: { hi: 0o020004, lo: 0 },
  COMPARE_CHECK: { hi: 0o020002, lo: 0 },
  PARITY_CHECK: { hi: 0o020001, lo: 0 },
  ACCESS_INOPERATIVE: { hi: 0o010000, lo: 0o100000 },
  ACCESS_NOT_READY: { hi: 0o010000, lo: 0o040000 },
};

/** Everything that counts as an error, cleared at the start of each order. */
const ALL_ERRORS_HI = Object.values(SENSE).reduce((a, b) => a | b.hi, 0);
const ALL_ERRORS_LO = Object.values(SENSE).reduce((a, b) => a | b.lo, 0);

/**
 * The six-bit-mode flag survives a sense read: the program's sense clears
 * every other bit of word 0.
 */
const SIXBIT = 0o000400;

/**
 * Where a finished access's attention bit lands in the sense words, indexed
 * [access][module] as [word-half, bit]. This is s709's snsshft table as it
 * appears in memory: modules 0-3 on access 0 share word 0's last character;
 * everything else lives in word 1.
 */
const ATTENTION_BIT = [
  [
    [1, 0o000020], [1, 0o000004], [1, 0o000002], [1, 0o000001],
    [2, 0o040000], [3, 0o000001], [2, 0o010000], [2, 0o004000],
    [2, 0o001000], [2, 0o000200],
  ],
  [
    [2, 0o000200], [2, 0o000100], [2, 0o000020], [2, 0o000004],
    [2, 0o000002], [2, 0o000001], [3, 0o100000], [3, 0o040000],
    [3, 0o020000], [3, 0o010000],
  ],
];

/** BCD zero is 012, not 0: the code for the character, not its value. */
const BCD_ZERO = 0o12;

/** Offsets within a record. */
const RECORD_LENGTH = 0;
const RECORD_ADDRESS = 1;
const RECORD_DATA = 2;

/** What the controller is doing. */
const IDLE = 0;
const CONTROL = 1;
const CONTROL_SECOND = 2;
const SENSING = 3;
const READING = 4;
const WRITING = 5;

/**
 * One disk module.
 *
 * Tracks are allocated as they are written. A 1301 access holds ten thousand
 * tracks of five hundred words, which is twenty megabytes a module if it is
 * taken literally — so it is not taken literally, and an untouched track simply
 * does not exist until something puts a record on it.
 */
export class DiskModule {
  constructor(type = 1301) {
    this.type = DISK_TYPES[type];
    if (!this.type) throw new Error(`no such disk: ${type}`);
    this.tracksPerAccess = this.type.tracksPerCylinder * this.type.cylinders;
    this.tracks = new Map();
    /**
     * The cylinder formats the media has been given, as the format track
     * declares them: for each cylinder, how many characters the home
     * address, each record header, and each record's data take up. A
     * formatted track has its record slots whether or not any program has
     * written them yet, so they live here rather than on the track.
     * Keyed by access * cylinders + cylinder.
     */
    this.formats = new Map();
    /** Cylinders whose format a WRITE_FORMAT order set while running. */
    this.dirtyFormats = new Set();
    /** Where each access arm is standing. */
    this.position = [0, 0];
    this.inoperative = [false, false];
  }

  key(access, track) {
    return access * this.tracksPerAccess + track;
  }

  /** The track, or null if nothing has ever been written there. */
  track(access, track) {
    return this.tracks.get(this.key(access, track)) ?? null;
  }

  /** The track, created empty if it does not exist yet. */
  ensureTrack(access, track, { dirty = false } = {}) {
    const key = this.key(access, track);
    let found = this.tracks.get(key);
    if (!found) {
      found = { hi: new Int32Array(this.type.wordsPerTrack), lo: new Int32Array(this.type.wordsPerTrack), dirty: false };
      this.tracks.set(key, found);
    }
    if (dirty) found.dirty = true;
    return found;
  }
}

export class FileControl {
  constructor() {
    this.channel = null;
    this.modules = new Map();

    this.state = IDLE;
    /** The order being assembled, as ten six-bit characters. */
    this.order = new Array(10).fill(0);
    this.orderWords = [];

    /** What the last order set up: which access, and what kind of transfer. */
    this.access = 0;
    this.module = 0;
    this.mode = 0;
    this.writeCheck = false;
    this.sixBit = false;

    /**
     * The sense words: [word0 hi, word0 lo, word1 hi, word1 lo]. Word 0 is
     * the ten-character status; word 1 carries the attention bits that do
     * not fit in word 0's last character.
     */
    this.sns = [0, SIXBIT, 0, 0];
    this.recordAddressHi = 0;
    this.recordAddressLo = 0;

    /** Where the current transfer has got to within the track. */
    this.track = null;
    this.spans = [];
    this.spanIndex = 0;
    this.spanOffset = 0;
    this.stopped = false;
    /** A WRITE_FORMAT in progress: the arriving characters are the spec. */
    this.collectFormat = false;
    this.formatChars = [];
  }

  /** Plug a module in at a module number, 0 through 9. */
  mount(number, module) {
    this.modules.set(number, module);
  }

  reset() {
    this.state = IDLE;
    this.mode = 0;
    this.sns = [0, SIXBIT, 0, 0];
    this.stopped = false;
    this.track = null;
    this.collectFormat = false;
  }

  /**
   * An access has finished moving and wants the program to know. Its bit goes
   * into the sense words where the next sense order will find it, and the
   * channel raises attention so the program looks.
   */
  setAttentionBit(channel, access, number) {
    const bit = access < 2 && number < 10 ? ATTENTION_BIT[access][number] : null;
    if (bit && !FileControl.noAttnBits) this.sns[bit[0]] |= bit[1];
    channel.setAttention();
  }

  // ====================================================================
  // The channel side
  // ====================================================================

  /**
   * The channel has selected the controller. A select while the controller is
   * still busy with the last one is the sequence error that the 7631 reports
   * rather than trying to sort out.
   */
  select(channel, selection) {
    this.channel = channel;
    if (this.state !== IDLE && selection !== SEL_SENSE) {
      this.unusualEnd(channel, SENSE.INVALID_SEQUENCE);
      return;
    }

    switch (selection) {
      case SEL_CONTROL:
        this.state = CONTROL;
        this.orderWords = [];
        channel.request = true;           // ask for the first order word
        break;

      case SEL_SENSE:
        this.state = SENSING;
        this.senseIndex = 0;
        this.stopped = false;
        channel.request = true;
        break;

      case SEL_READ:
        if (this.mode === 0 || this.mode === WRITE_FORMAT) {
          this.unusualEnd(channel, SENSE.INVALID_SEQUENCE);
          return;
        }
        if (!this.beginTransfer(channel, false)) return;
        this.state = READING;
        break;

      case SEL_WRITE:
        if (this.mode === 0) {
          this.unusualEnd(channel, SENSE.INVALID_SEQUENCE);
          return;
        }
        if (!this.beginTransfer(channel, true)) return;
        this.state = WRITING;
        break;

      default:
        this.unusualEnd(channel, SENSE.INVALID_ORDER);
        break;
    }
  }

  /** A word from the channel: either part of an order, or data to be written. */
  write(channel, hi, lo, stop) {
    this.channel = channel;
    if (stop) {
      // A stop arrives when the channel's word count runs out before the
      // record does. The controller gives up the rest of the record — but it
      // still has to say it has finished, because the CPYD that sent the stop
      // is waiting for exactly that before it takes its next command. Going
      // quiet here leaves the channel and the processor waiting on each other.
      if (this.collectFormat) this.compileFormat();
      this.stopped = true;
      this.state = IDLE;
      channel.setEnd();
      return;
    }

    if (this.state === CONTROL) {
      this.orderWords.push([hi, lo]);
      // Bit 3 of the first character says a second word is coming. That is not
      // a flag bit bolted on: the orders that need the extra four characters
      // are exactly the 8x group, and 8 is the character whose bit 3 is set.
      if (hi & 0o100000) {
        this.state = CONTROL_SECOND;
        channel.request = true;
        return;
      }
      this.runOrder(channel);
      return;
    }

    if (this.state === CONTROL_SECOND) {
      this.orderWords.push([hi, lo]);
      this.runOrder(channel);
      return;
    }

    if (this.state === WRITING) {
      this.storeWord(channel, hi, lo);
      return;
    }
  }

  /**
   * The controller's own cycle, given to it by the channel whenever the channel
   * is waiting on it. This is where words come off the disk on a read and where
   * sense data is handed over.
   */
  service(channel) {
    this.channel = channel;
    if (this.stopped) return;
    if (this.state === SENSING) {
      this.sendSense(channel);
      return;
    }
    if (this.state === READING) {
      this.fetchWord(channel);
      return;
    }
    if (this.state === WRITING) {
      // Nothing to hand over on a write — the controller is simply ready for
      // the next word, and saying so is what keeps the transfer moving.
      channel.request = true;
    }
  }

  // ====================================================================
  // Orders
  // ====================================================================

  /** Split the assembled order into ten BCD characters and act on it. */
  runOrder(channel) {
    // A CPYP ends a write without a stop word: the next order arriving is
    // what retires it, and a format being collected belongs to the record
    // that just ended.
    if (this.collectFormat) this.compileFormat();
    const characters = [];
    for (const [hi, lo] of this.orderWords) {
      characters.push((hi >>> 12) & 0o77, (hi >>> 6) & 0o77, hi & 0o77);
      characters.push((lo >>> 12) & 0o77, (lo >>> 6) & 0o77, lo & 0o77);
    }
    this.raw = characters;
    // BCD writes the digit zero as 012, so that is the one character whose
    // value is not itself.
    //
    // The conversion goes one way only. SIMH also sends a character of 0 back
    // the other way, to 012, which is defensible — a 7631 order is digits and
    // 0 is not one — but it is not what s709 does, and it is not what the CTSS
    // disk loader expects: that loader leaves the access and module characters
    // as plain zeroes, and turning those into tens makes the very first seek
    // of a boot fail with an inoperative access.
    this.order = characters.map((c) => (c === BCD_ZERO ? 0 : c));
    if (FileControl.debugOrder) {
      const str = this.order.map((c) => c.toString(8).padStart(2, '0')).join('');
      FileControl.debugOrder(str, this);
    }

    this.state = IDLE;
    channel.setEnd();                      // the control sequence is over

    const group = this.order[OP1];
    if (group === 0) return this.controllerOrder(channel);
    if (group === 8) return this.accessOrder(channel);
    return this.unusualEnd(channel, SENSE.INVALID_ORDER);
  }

  /** The 0x group: nothing moves and no access is named. */
  controllerOrder(channel) {
    switch (this.order[OP2]) {
      case NOP:
      case RELEASE:
        break;
      case MODE_8BIT:
        this.sixBit = false;
        this.sns[1] &= ~SIXBIT;
        break;
      case MODE_6BIT:
        this.sixBit = true;
        this.sns[1] |= SIXBIT;
        break;
      default:
        this.unusualEnd(channel, SENSE.INVALID_ORDER);
        break;
    }
  }

  /** The 8x group: every one of these names an access and a place on it. */
  accessOrder(channel) {
    const access = this.order[ACCESS];
    const number = this.order[MODULE];
    const module = this.modules.get(number);
    if (!module) {
      this.setAttentionBit(channel, access, number);
      return this.unusualEnd(channel, SENSE.ACCESS_INOPERATIVE);
    }
    if (access >= module.type.accesses || module.inoperative[access]) {
      return this.unusualEnd(channel, SENSE.ACCESS_INOPERATIVE);
    }

    // Four decimal digits of track number. Anything that is not a digit is a
    // track that cannot exist, which the address check below will catch.
    let track = 0;
    let valid = true;
    for (let i = 0; i < 4; i++) {
      const digit = this.order[T1 + i];
      if (digit > 9) valid = false;
      track = track * 10 + (digit > 9 ? 0 : digit);
    }
    if (!valid) track = module.tracksPerAccess + 1;

    let operation = this.order[OP2];
    if (operation === WRITE_CHECK) {
      // Write check re-runs the previous operation and compares instead of
      // moving, so it needs there to have been a previous operation.
      if (this.mode === 0) return this.unusualEnd(channel, SENSE.INVALID_SEQUENCE);
      operation = this.mode;
      this.writeCheck = true;
    } else {
      this.writeCheck = false;
    }

    this.sns[0] &= ~ALL_ERRORS_HI;
    this.sns[1] &= ~ALL_ERRORS_LO;
    this.stopped = false;

    switch (operation) {
      case SEEK:
        if (track >= module.tracksPerAccess) {
          return this.unusualEnd(channel, SENSE.INVALID_ADDRESS);
        }
        module.position[access] = track;
        // A real arm takes milliseconds and says so with attention when it
        // arrives. Here it arrives at once, but it still raises attention,
        // because CTSS waits for that rather than assuming.
        this.setAttentionBit(channel, access, number);
        this.mode = 0;
        return;

      case ACCESS_INOPERATIVE:
        module.inoperative[access] = true;
        this.mode = 0;
        return;

      case SINGLE_RECORD:
        break;                             // addressed by record, not by track

      case WRITE_FORMAT:
      case TRACK_NO_ADDRESS:
      case CYLINDER:
      case TRACK_WITH_ADDRESS:
      case TRACK_HOME_ADDRESS:
        // Every one of these works on the track the arm is already standing
        // on. Asking for a different one is the "no record found" the 7631
        // reports rather than seeking on the program's behalf.
        if (track !== module.position[access]) {
          return this.unusualEnd(channel, SENSE.NO_RECORD_FOUND);
        }
        break;

      default:
        return this.unusualEnd(channel, SENSE.INVALID_ORDER);
    }

    this.access = access;
    this.module = number;
    this.mode = operation;
    // The identifier is the last six of the ten characters — the low 36 bits
    // of the order — and it is compared against what is on the track as the
    // program wrote it, so it is taken raw rather than BCD-converted.
    const r = this.raw;
    this.recordAddressHi = ((r[4] << 12) | (r[5] << 6) | r[6]) & HALF;
    this.recordAddressLo = ((r[7] << 12) | (r[8] << 6) | r[9]) & HALF;
  }

  // ====================================================================
  // Transfers
  // ====================================================================

  /**
   * Position within the track for the transfer the last order set up. Returns
   * false when the controller has already reported why it cannot.
   */
  beginTransfer(channel, writing) {
    const module = this.modules.get(this.module);
    if (!module) {
      this.unusualEnd(channel, SENSE.ACCESS_INOPERATIVE);
      return false;
    }
    if (this.writeCheck) {
      // Write check re-sends the last record so the controller can compare
      // it with the surface. s709's DWRC never calls its writeword at all:
      // the words are simply consumed, so that is all the check does here.
      return true;
    }
    if (this.mode === WRITE_FORMAT) {
      // A format write does not write a data track at all. Its "data" is
      // the format itself — gap and field markers naming where the home
      // address, the record headers, and the data areas sit on every track
      // of the cylinder. It is collected as it arrives and compiled when
      // the record ends.
      this.collectFormat = true;
      this.formatChars = [];
      return true;
    }
    const position = module.position[this.access];
    // Writing brings a track into existence; reading one that was never
    // written finds no record, which is not the same as reading zeroes —
    // unless the cylinder has been formatted, in which case the record
    // slots are on the surface and a read finds zeroes in them.
    let track = writing
      ? module.ensureTrack(this.access, position, { dirty: true })
      : module.track(this.access, position);
    if (!track && module.formats.has(this.formatKey(module, this.access, position))) {
      track = module.ensureTrack(this.access, position);
    }

    if (!track) {
      // Nothing was ever written here. A read finds no record.
      this.unusualEnd(channel, SENSE.NO_RECORD_FOUND);
      return false;
    }
    this.track = track;
    this.trackWords = module.type.wordsPerTrack;

    // A formatted track keeps its record slots even when nothing has been
    // written in them yet. Lay them out so the transfer has somewhere to
    // put or find its words; they read back as zeroes until a write lands.
    if (track.hi[1] === 0) this.layOutFormat(module, track, this.access, position);

    if (this.mode === SINGLE_RECORD) {
      const found = this.findRecord(track);
      if (found < 0) {
        this.unusualEnd(channel, SENSE.NO_RECORD_FOUND);
        return false;
      }
      this.spans = [{ track, from: found + RECORD_DATA, count: track.hi[found + RECORD_LENGTH] }];
    } else if (this.mode === CYLINDER) {
      // A cylinder order runs on from where the arm is to the end of the
      // cylinder, so it spans tracks rather than stopping at one.
      const perCylinder = module.type.tracksPerCylinder;
      const last = (Math.floor(position / perCylinder) + 1) * perCylinder;
      this.spans = [];
      for (let number = position; number < last; number++) {
        const each = module.track(this.access, number);
        if (!each) break;
        this.spans.push(...this.trackSpans(each));
      }
    } else if (
      this.mode === TRACK_NO_ADDRESS
      || this.mode === TRACK_WITH_ADDRESS
      || this.mode === TRACK_HOME_ADDRESS
      || this.mode === WRITE_FORMAT
    ) {
      this.spans = this.trackSpans(track);
    } else {
      this.unusualEnd(channel, SENSE.INVALID_SEQUENCE);
      return false;
    }

    this.spanIndex = 0;
    this.spanOffset = 0;
    return true;
  }

  /** The key under which a cylinder's format is kept on the module. */
  formatKey(module, access, track) {
    return access * module.type.cylinders + Math.floor(track / module.type.tracksPerCylinder);
  }

  /**
   * Give an unwritten track the record slots its cylinder's format
   * declares: a length word and an address word per record, all zeroes,
   * which is what the surface holds until a program writes it. Only the
   * six-character layouts CTSS uses can be represented here — anything
   * else is left alone rather than approximated.
   */
  layOutFormat(module, track, access, position) {
    const format = module.formats.get(this.formatKey(module, access, position));
    if (!format || format.ha2Chars !== 6 || format.hdrChars !== 6) return;
    let at = 1;
    for (const chars of format.dataChars) {
      const words = Math.floor(chars / 6);
      if (at + RECORD_DATA + words > this.trackWords) break;
      track.hi[at] = words;
      track.lo[at] = 0;
      track.hi[at + 1] = 0;
      track.lo[at + 1] = 0;
      at += RECORD_DATA + words;
    }
  }

  /**
   * The end of a format write: turn the collected specification into the
   * cylinder's record layout, the way s709's chkformat compiles the
   * written buffer into the format track. A spec that does not parse is
   * simply not a format — the cylinder keeps whatever it had, which is
   * also what s709 does when chkformat fails.
   */
  compileFormat() {
    this.collectFormat = false;
    const module = this.modules.get(this.module);
    if (!module) return;
    const position = module.position[this.access];
    const format = parseFormatSpec(this.formatChars, module.type.overhead);
    if (format) {
      const key = this.formatKey(module, this.access, position);
      module.formats.set(key, format);
      module.dirtyFormats.add(key);
    }
  }

  /**
   * The words a track order actually moves, as spans of the record structure.
   *
   * This is where the difference between a record and the surface it is
   * written on shows up. A track holds records, and each record holds a length
   * and an address that the program never wrote as data — so a track order
   * moves the data areas and steps over the rest. Which parts count as "the
   * rest" is the whole difference between the four track orders.
   */
  trackSpans(track) {
    const spans = [];
    if (this.mode === TRACK_HOME_ADDRESS) spans.push({ track, from: 0, count: 1 });

    let at = 1;
    while (at + RECORD_DATA <= track.hi.length) {
      const length = track.hi[at + RECORD_LENGTH];
      if (length === 0) break;
      if (this.mode === TRACK_WITH_ADDRESS || this.mode === TRACK_HOME_ADDRESS) {
        spans.push({ track, from: at + RECORD_ADDRESS, count: 1 });
      }
      spans.push({ track, from: at + RECORD_DATA, count: length });
      at += RECORD_DATA + length;
    }
    return spans;
  }

  /** Where the transfer has got to, or null when it has run out. */
  nextPlace() {
    while (this.spanIndex < this.spans.length) {
      const span = this.spans[this.spanIndex];
      if (this.spanOffset < span.count) {
        return { track: span.track, at: span.from + this.spanOffset };
      }
      this.spanIndex += 1;
      this.spanOffset = 0;
    }
    return null;
  }

  /**
   * Walk the track looking for the record the order named. Records are chained
   * by their own length fields and the chain ends at a zero length, which is
   * what "end of valid data on the track" means on a 7631.
   */
  findRecord(track) {
    let at = 1;                            // past home address 2
    while (at + RECORD_DATA <= this.trackWords) {
      const length = track.hi[at + RECORD_LENGTH];
      if (length === 0) return -1;
      if (track.hi[at + RECORD_ADDRESS] === this.recordAddressHi
        && track.lo[at + RECORD_ADDRESS] === this.recordAddressLo) {
        return at;
      }
      at += RECORD_DATA + length;
    }
    return -1;
  }

  /** Read side: one word off the track and into the channel. */
  fetchWord(channel) {
    const place = this.nextPlace();
    if (!place) {
      this.state = IDLE;
      channel.setEnd();
      return;
    }
    channel.inputWord(place.track.hi[place.at], place.track.lo[place.at]);
    this.spanOffset += 1;
  }

  /** Write side: one word from the channel onto the track. */
  storeWord(channel, hi, lo) {
    if (this.writeCheck) {
      // The words come back for comparison and the controller consumes
      // them; s709's DWRC does not even hand them to the device.
      channel.request = true;
      return;
    }
    if (this.collectFormat) {
      this.formatChars.push(
        (hi >>> 12) & 0o77, (hi >>> 6) & 0o77, hi & 0o77,
        (lo >>> 12) & 0o77, (lo >>> 6) & 0o77, lo & 0o77);
      channel.request = true;
      return;
    }
    const place = this.nextPlace();
    if (!place) {
      this.state = IDLE;
      channel.setEnd();
      return;
    }
    place.track.hi[place.at] = hi & HALF;
    place.track.lo[place.at] = lo & HALF;
    // Spans can reach tracks the order did not name — a cylinder write
    // crosses every track of the cylinder — so the dirty mark has to
    // follow the word, not the order that opened the transfer.
    place.track.dirty = true;
    this.spanOffset += 1;
    channel.request = true;                // ready for the next
  }

  // ====================================================================
  // Sense
  // ====================================================================

  /**
   * Hand the sense words over, one per service call. Reading a word consumes
   * it: word 0 keeps only its six-bit-mode flag, word 1 clears entirely, so
   * an attention bit is reported once and then forgotten.
   */
  sendSense(channel) {
    if (this.senseIndex === 0) {
      channel.inputWord(this.sns[0], this.sns[1]);
      this.sns[0] = 0;
      this.sns[1] &= SIXBIT;
      this.senseIndex = 1;
      return;
    }
    if (this.senseIndex === 1) {
      channel.inputWord(this.sns[2], this.sns[3]);
      this.sns[2] = this.sns[3] = 0;
      this.senseIndex = 2;
      return;
    }
    this.state = IDLE;
    channel.setEnd();
  }

  /**
   * Stop, record why, and tell the channel it ended unusually. The channel
   * turns that into an interrupt unless the program has inhibited it, which is
   * how a CTSS disk driver hears about a bad seek. The status word is
   * replaced, not added to: that is what the 7631 does, and it keeps a stale
   * bit from an earlier fault from hanging around.
   */
  unusualEnd(channel, code) {
    this.sns[0] = code.hi;
    this.sns[1] = code.lo;
    this.state = IDLE;
    this.mode = 0;
    channel.setEnd(UNUSUAL_END);
  }
}

/**
 * Compile a written format specification into a cylinder layout.
 *
 * What a format write puts on the surface is not data but a drawing of
 * the format itself: runs of gap characters (02 and 04) between runs of
 * field-marker characters (01 and 03), where each marker run's length is
 * the size of the field it stands for minus the model's per-field
 * overhead. The result is the home-address size, then header and data
 * sizes for each record the track will hold.
 *
 * This is s709's `chkformat` reduced to what the record structure needs;
 * the characters come from the program verbatim, so the field lengths are
 * already six-bit characters, not words.
 */
export function parseFormatSpec(chars, overhead) {
  // Past the end of the spec sits the record-end marker: reading it stops
  // the record loop the way a real end-of-record character would.
  const at = (i) => (i < chars.length ? chars[i] & 0o77 : 0o200);
  const run = (i, chr) => {
    let j = i;
    while (j < chars.length && (chars[j] & 0o77) === chr) j++;
    return j;
  };

  let i = 4;
  while (at(i) === 0o04) i++;                // initial gap
  if (i >= chars.length) return null;

  let j = i;
  i = run(i, 0o03);                          // home address 1
  if (i - j > 12 || at(i++) !== 0o04) return null;
  i = run(i, 0o03);
  if (at(i++) !== 0o04) return null;

  j = i;
  while (at(i) === 0o03 || at(i) === 0o01) i++;
  j = i - j;
  if (j < 6) return null;
  const ha2Chars = j - overhead;

  const dataChars = [];
  let hdrChars = 0;
  while (i < chars.length) {
    let chr = at(i++);
    if (chr === 0o200) break;
    if (chr !== 0o04 && chr !== 0o02) return null;
    j = i;
    i = run(i, chr);
    chr = at(i);
    if (chr === 0o200 || i - j < 11) break;  // a short gap ends the track
    if (chr !== 0o01 && chr !== 0o03) return null;
    j = i;
    i = run(i, chr);
    j = i - j;
    if (j < 10) return null;
    if (!hdrChars) hdrChars = j - overhead;

    chr = at(i++);
    if (chr !== 0o04 && chr !== 0o02) return null;
    chr = at(i);
    if (chr !== 0o01 && chr !== 0o03) return null;
    j = i;
    i = run(i, chr);
    if (i - j < 10) return null;             // the gap between header and data
    chr = at(i++);
    if (chr !== 0o04 && chr !== 0o02) return null;
    chr = at(i);
    if (chr !== 0o01 && chr !== 0o03) return null;
    j = i;
    i = run(i, chr);
    j = i - j;
    if (j < 10) return null;
    dataChars.push(j - overhead);
  }

  if (!hdrChars || !dataChars.length) return null;
  return { ha2Chars, hdrChars, dataChars };
}
