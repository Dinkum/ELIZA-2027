/**
 * The 711 card reader.
 *
 * CTSS reads its first command off a punched card — `MIT8C0`, which starts the
 * supervisor's housekeeping — so a machine that boots without a reader in
 * channel A's unit 0321 gets as far as asking for the card and then reports an
 * I/O check where s709 reads a deck.
 *
 * A card is eighty columns of twelve rows. The channel does not get the card
 * as columns, though: a read produces twenty-four words, one per row per
 * half-card — the first word is row 12 of columns 1-36, the second is row 12
 * of columns 37-72, and so on down the rows and across the card, one bit per
 * punch. Column seventy-three onwards never reaches core.
 *
 * The card file is the `.cbn` the reconstruction's `bcd2cbn` writes: two
 * bytes a column, six bits of row punches in each, the first byte of a card
 * marked with 0200 and every byte carrying odd parity in bit 6. Both marks
 * are stripped on the way in.
 *
 * Reference: `readword` for unit 0321 and `bincard` in s709's `chan7607.c`
 * and `io.c`.
 */

import { HALF } from '../word.js';

/** Columns on a card, and the words the channel sees per card. */
const COLUMNS = 80;
const WORDS_PER_CARD = 24;
/** A byte with bit 0200 set begins a new card. */
const RECORD_MARK = 0o200;

export class CardReader {
  /**
   * @param {Uint8Array} bytes the whole `.cbn` file, or null for an empty
   *   hopper: a select on an empty reader ends the file at once.
   */
  constructor(bytes = null) {
    this.name = 'READER';
    this.channel = null;
    /** Cards as lists of eighty twelve-bit column codes. */
    this.cards = bytes ? parseCbn(bytes) : [];
    this.next = 0;
    this.columns = null;
    this.word = 0;
    this.atFileMark = false;
    /** s709 gives a selected reader 4600 cycles to answer. */
    this.selectCycles = 4600;
  }

  get atLoadPoint() { return false; }
  get atEndOfTape() { return false; }

  /** Begin a card: pull the next one in and stand on its first word. */
  startRecord(operation) {
    if (operation !== 'read') return;
    this.word = 0;
    if (this.next >= this.cards.length) {
      this.columns = null;
      this.atFileMark = true;
      return;
    }
    this.columns = this.cards[this.next++];
  }

  /**
   * One word of the card: row `word >> 1`, thirty-six columns starting at
   * `(word & 1) * 36`, most significant bit first. Null when the card is
   * spent or the hopper is empty.
   */
  readWord() {
    if (!this.columns || this.word >= WORDS_PER_CARD) return null;
    const row = 1 << (this.word >> 1);
    const start = (this.word & 1) * 36;
    this.word += 1;

    let hi = 0;
    let lo = 0;
    for (let i = 0; i < 18; i++) {
      hi = (hi << 1) | ((this.columns[start + i] & row) ? 1 : 0);
    }
    for (let i = 18; i < 36; i++) {
      lo = (lo << 1) | ((this.columns[start + i] & row) ? 1 : 0);
    }
    return [hi & HALF, lo & HALF];
  }

  /** Nothing can be punched through the reader. */
  writeWord() {}

  endRecord() {
    this.columns = null;
    this.word = 0;
  }

  backspaceRecord() {}
  backspaceFile() {}
  writeEndOfFile() {}
  rewind() {
    this.next = 0;
    this.atFileMark = false;
  }
  rewindUnload() {}
  setDensity() {}
}

/**
 * The card punch next to the reader. Cards arrive one word at a time and are
 * kept so a caller can file them; nothing here needs the column decoding,
 * because a punch writes the same twenty-four word picture the reader reads.
 */
export class CardPunch {
  constructor() {
    this.name = 'PUNCH';
    this.channel = null;
    this.cards = [];
    this.buffer = [];
    /** s709 gives a selected punch 8000 cycles to answer. */
    this.selectCycles = 8000;
  }

  get atLoadPoint() { return false; }
  get atEndOfTape() { return false; }
  get atFileMark() { return false; }

  startRecord() {
    this.buffer = [];
  }

  readWord() {
    return null;
  }

  writeWord(hi, lo) {
    if (this.buffer.length < WORDS_PER_CARD) this.buffer.push([hi, lo]);
  }

  endRecord() {
    if (this.buffer.length) this.cards.push(this.buffer);
    this.buffer = [];
  }

  backspaceRecord() {}
  backspaceFile() {}
  writeEndOfFile() {}
  rewind() {}
  rewindUnload() {}
  setDensity() {}
}

/**
 * Split a `.cbn` file into cards. A byte holding 0200 starts a new card;
 * everything else is column data, two bytes to a twelve-bit column. A card
 * short of eighty columns is padded with blank ones, the way the reader
 * would see a mispunched deck.
 */
export function parseCbn(bytes) {
  const cards = [];
  let columns = null;
  let pending = -1;

  for (const byte of bytes) {
    if (byte & RECORD_MARK) {
      columns = [];
      cards.push(columns);
    }
    if (columns === null) continue;
    if (pending < 0) {
      pending = byte & 0o77;
    } else {
      if (columns.length < COLUMNS) columns.push((pending << 6) | (byte & 0o77));
      pending = -1;
    }
  }

  for (const card of cards) while (card.length < COLUMNS) card.push(0);
  return cards;
}
