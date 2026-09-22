/**
 * The Chronolog clock.
 *
 * Project MAC hung a digital clock off channel A as unit 7, wired so that the
 * processor reads it exactly as it would read a tape: select it, and one record
 * comes back holding the date and time as twelve BCD digits. CTSS reads it
 * during startup, which is why a machine with no clock on channel A gets as far
 * as the supervisor and then stops.
 *
 *     month day hour minute second counter
 *
 * two digits each, packed six characters to a word, so the whole record is two
 * words. The last pair is the interval timer's own counter taken modulo sixty,
 * which is what gives CTSS a sub-second figure to print after the time.
 *
 * Reference: `chrono_rd` in SIMH's i7094_clk.c.
 */

/** The interval timer lives in core location 5 on the CTSS machine. */
const CLOCK_CELL = 0o5;

/**
 * The clock sends plain digits, zero included.
 *
 * Almost everywhere else on this machine a BCD zero is written as 012 — but
 * not here, and it matters: CTSS validates the reading by shifting it six bits
 * at a time and rejecting any character above nine. A zero sent as 012 is ten,
 * so a date with a zero in it — every month before October, every day before
 * the tenth, most hours — would be thrown out as a bad clock.
 *
 * SIMH sends 012 and would fail that test; s709 sends the digit, and s709 is
 * what CTSS was tested against.
 */
const digit = (n) => n & 0o17;

export class ChronologClock {
  /**
   * @param {object} options `now` supplies the time, for tests that need a
   *   clock that does not move. `machine` is optional: when present the
   *   reading is taken from the machine's emulated tick count rather than
   *   the wall clock, so it stays in step with the supervisor's own time
   *   however fast the emulator runs.
   */
  constructor({ now = () => new Date(), machine = null } = {}) {
    this.name = 'CHRONO';
    this.channel = null;
    this.core = null;
    this.now = now;
    this.machine = machine;
    /** Wall time at construction: the epoch emulated ticks are added to. */
    this.epoch = now();
    this.record = null;
    this.at = 0;
  }

  /** The clock has no reel, so these are the answers a tape would give. */
  get atLoadPoint() { return false; }
  get atEndOfTape() { return false; }
  get atFileMark() { return false; }

  /** Take a reading. The record is made once, when the select happens. */
  startRecord(operation) {
    this.at = 0;
    if (operation !== 'read') {
      this.record = [];
      return;
    }
    const time = this.now();
    let counter = 0;
    if (this.machine) {
      // Emulated time: the interval timer ticks sixty times a second of
      // machine time, so the reading is the boot time advanced by that many
      // ticks. This keeps the clock in step with the supervisor's own time
      // no matter how fast the emulator runs.
      const ms = (this.machine.ticks / 60) * 1000;
      const t = new Date(this.epoch.getTime() + ms);
      counter = this.machine.ticks % 60;
      const digits = [
        t.getMonth() + 1,
        t.getDate(),
        t.getHours(),
        t.getMinutes(),
        t.getSeconds(),
        counter,
      ].flatMap((value) => [digit(Math.floor(value / 10)), digit(value % 10)]);
      this.record = [
        [(digits[0] << 12) | (digits[1] << 6) | digits[2],
          (digits[3] << 12) | (digits[4] << 6) | digits[5]],
        [(digits[6] << 12) | (digits[7] << 6) | digits[8],
          (digits[9] << 12) | (digits[10] << 6) | digits[11]],
      ];
      return;
    }
    if (this.core) counter = this.core.lo[CLOCK_CELL] % 60;

    const digits = [
      time.getMonth() + 1,
      time.getDate(),
      time.getHours(),
      time.getMinutes(),
      time.getSeconds(),
      counter,
    ].flatMap((value) => [digit(Math.floor(value / 10)), digit(value % 10)]);

    this.record = [
      [(digits[0] << 12) | (digits[1] << 6) | digits[2],
        (digits[3] << 12) | (digits[4] << 6) | digits[5]],
      [(digits[6] << 12) | (digits[7] << 6) | digits[8],
        (digits[9] << 12) | (digits[10] << 6) | digits[11]],
    ];
  }

  /** One word of the reading, or null when the record is spent. */
  readWord() {
    if (!this.record || this.at >= this.record.length) return null;
    return this.record[this.at++];
  }

  /** Nothing can be written to a clock. */
  writeWord() {}

  endRecord() {
    this.record = null;
    this.at = 0;
  }

  // A clock cannot be wound on or rewound, but the channel may ask.
  backspaceRecord() {}
  backspaceFile() {}
  writeEndOfFile() {}
  rewind() {}
  rewindUnload() {}
  setDensity() {}
}
