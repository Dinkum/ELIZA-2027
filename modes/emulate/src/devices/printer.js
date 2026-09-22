/**
 * The 716 on-line printer.
 *
 * CTSS writes its operator log here — what it is doing, which users are on,
 * what went wrong. It is not the terminal: a user sees nothing of this. The
 * machine needs one to exist all the same, because the supervisor prints during
 * startup and a write to a device that is not there is an I/O check.
 *
 * The printer is a column-image device, not a BCD device. A line is printed
 * from twenty-four words: twelve card rows (9 down to 12, two 36-column halves
 * each), where every bit of a word punches one column position of that row.
 * When all twenty-four words have arrived the accumulated column codes are
 * Hollerith, which this decodes to text and passes to `onPrint`.
 */

import { TO_NATIVE } from '../bcd.js';

/** Decode one 12-bit Hollerith column to a 6-bit BCD code. (s709 cardbcd.) */
function columnToBcd(column) {
  let num;
  let row = 1;
  for (num = 10; --num; row <<= 1) {
    if (column & row) break;
  }
  if (num === 8 && (column & 0o174) !== 0) {
    // Row 8 plus another digit row is a multi-punch combination, not an 8.
    row = 4;
    for (num = 16; --num > 10; row <<= 1) {
      if (column & row) break;
    }
  } else if (num === 0 && (column & 0o1000)) {
    num = 10;
  }
  if ((column & 0o1000) && num !== 10) num |= 0o60;
  else if (column & 0o2000) num |= 0o40;
  else if (column & 0o4000) num |= 0o20;
  else if (num === 10) num = 0;
  else if (num === 0) num = 0o60;
  return num;
}

/** A line is twelve rows times two half-words. */
const WORDS_PER_LINE = 24;

export class LinePrinter {
  constructor({ onPrint = null } = {}) {
    this.name = 'PRINTER';
    this.channel = null;
    this.onPrint = onPrint;
    this.lines = [];
    this.columns = new Uint16Array(72);
    this.row = 0;
    /** s709 gives a selected printer 5000 cycles to answer before dropping it. */
    this.selectCycles = 5000;
  }

  get atLoadPoint() { return false; }
  get atEndOfTape() { return false; }
  get atFileMark() { return false; }

  startRecord() {
    // A line is twenty-four words wherever the channel's record boundaries
    // fall, so a fresh record does not clear the half-printed line — s709's
    // initprint runs only when a line completes or the counter wraps.
    if (this.row >= WORDS_PER_LINE) {
      this.row = 0;
      this.columns.fill(0);
    }
  }

  /** Nothing to read from a printer. */
  readWord() {
    return null;
  }

  /**
   * One word is one card row's image across thirty-six columns. Even rows
   * cover columns 0-35 and odd rows 36-71, in write order 9,8,...,1,0,11,12.
   * The twenty-fourth word prints the line.
   */
  writeWord(hi, lo) {
    if (this.row >= WORDS_PER_LINE) {
      this.row = 0;
      this.columns.fill(0);
    }
    const column = this.row & 1 ? 36 : 0;
    const rowBit = 1 << (this.row >> 1);
    for (let k = 0; k < 18; k++) {
      if (hi & (1 << (17 - k))) this.columns[column + k] |= rowBit;
      if (lo & (1 << (17 - k))) this.columns[column + 18 + k] |= rowBit;
    }
    if (++this.row === WORDS_PER_LINE) this.printLine();
  }

  /** Decode the accumulated column image and hand the line out. */
  printLine() {
    let text = '';
    for (const column of this.columns) {
      const code = columnToBcd(column);
      text += TO_NATIVE[code & 0o77] || '?';
    }
    text = text.replace(/\s+$/, '');
    this.row = 0;
    this.columns.fill(0);
    this.lines.push(text);
    if (this.onPrint) this.onPrint(text);
  }

  endRecord() {}

  backspaceRecord() {}
  backspaceFile() {}
  writeEndOfFile() {}
  rewind() {}
  rewindUnload() {}
  setDensity() {}
}
