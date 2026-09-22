/**
 * A 729 magnetic tape unit.
 *
 * Tapes are held in the SIMH .tap format, which is what the CTSS reconstruction
 * in references/ ships and what Dave Pitts' tools produce. A reel is a sequence
 * of records, each written as
 *
 *     4-byte little-endian length, data bytes (padded to an even count), length
 *
 * with a length of zero standing for a tape mark — the end of a file — and
 * 0xFFFFFFFF for the end of the recorded medium. One byte holds one six-bit BCD
 * character, so six bytes make a 36-bit word; the top bit of a byte carries
 * parity and is ignored here.
 *
 * The unit works a whole record at a time. Nothing a program can do through a
 * channel observes the tape moving character by character, and pretending
 * otherwise would only add ways to be wrong.
 */

import { HALF } from '../word.js';

/** End of medium, as the .tap format spells it. */
const END_OF_MEDIUM = 0xffffffff;

export class TapeUnit {
  /**
   * @param {string} name for the console display, e.g. "A1".
   */
  constructor(name) {
    this.name = name;
    /** The reel: an array of records, each a Uint8Array, with null for a mark. */
    this.records = [];
    /** Which record the head is over. */
    this.position = 0;
    /** True when the unit has a reel on it. */
    this.mounted = false;
    /** True when the reel may be written. */
    this.writable = false;

    this.buffer = null;
    this.offset = 0;
    this.atFileMark = false;
    this.channel = null;
  }

  /** Mount a reel from a .tap image. */
  mount(bytes, { writable = false } = {}) {
    this.records = parseTap(bytes);
    this.position = 0;
    this.mounted = true;
    this.writable = writable;
    this.atFileMark = false;
  }

  /** Mount a blank reel that can be written. */
  mountBlank() {
    this.records = [];
    this.position = 0;
    this.mounted = true;
    this.writable = true;
    this.atFileMark = false;
  }

  /** Serialise the reel back to a .tap image. */
  toTap() {
    return writeTap(this.records);
  }

  get atLoadPoint() {
    return this.position === 0;
  }

  get atEndOfTape() {
    return this.position >= this.records.length;
  }

  // --- The channel's interface ------------------------------------------

  /** Begin a record. For a read this pulls the next record off the reel. */
  startRecord(operation) {
    this.atFileMark = false;
    if (operation === 'read') {
      const record = this.records[this.position];
      if (record === undefined) {          // past the end of the recorded tape
        this.buffer = new Uint8Array(0);
        this.atFileMark = true;
        return;
      }
      if (record === null) {               // a tape mark
        this.buffer = new Uint8Array(0);
        this.atFileMark = true;
        this.position += 1;
        return;
      }
      this.buffer = record;
      this.offset = 0;
      this.position += 1;
    } else {
      this.buffer = [];
      this.offset = 0;
    }
  }

  /** The next word of the record, or null once the record is exhausted. */
  readWord() {
    if (!this.buffer || this.offset >= this.buffer.length) return null;
    let hi = 0;
    let lo = 0;
    for (let i = 0; i < 3; i++) {
      hi = (hi << 6) | ((this.buffer[this.offset + i] ?? 0) & 0o77);
    }
    for (let i = 3; i < 6; i++) {
      lo = (lo << 6) | ((this.buffer[this.offset + i] ?? 0) & 0o77);
    }
    this.offset += 6;
    return [hi & HALF, lo & HALF];
  }

  /** Append a word to the record being written. */
  writeWord(hi, lo) {
    if (!this.writable) return;
    this.buffer.push((hi >>> 12) & 0o77, (hi >>> 6) & 0o77, hi & 0o77);
    this.buffer.push((lo >>> 12) & 0o77, (lo >>> 6) & 0o77, lo & 0o77);
  }

  /** The channel has disconnected: commit a written record. */
  endRecord(writing) {
    if (writing && this.writable && this.buffer && this.buffer.length) {
      this.records.splice(this.position, this.records.length, Uint8Array.from(this.buffer));
      this.position = this.records.length;
    }
    this.buffer = null;
  }

  // --- Tape motion -------------------------------------------------------

  backspaceRecord() {
    if (this.position > 0) this.position -= 1;
  }

  backspaceFile() {
    if (this.position > 0) this.position -= 1;
    while (this.position > 0 && this.records[this.position - 1] !== null) {
      this.position -= 1;
    }
  }

  writeEndOfFile() {
    if (!this.writable) return;
    this.records.splice(this.position, this.records.length, null);
    this.position = this.records.length;
  }

  rewind() {
    this.position = 0;
  }

  rewindUnload() {
    this.position = 0;
    this.mounted = false;
  }

  /** Density is a property of the drive, not of anything a program can see. */
  setDensity() {}
}

/** Split a .tap image into records. A tape mark comes back as null. */
export function parseTap(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // The other tape format in the CTSS kit is s709's native "p7b": every
  // record begins with a byte whose high bit is set, and a 0217 byte is a
  // tape mark. SIMH images begin with a 32-bit little-endian length, whose
  // first byte is never high-bit set in a plausible image.
  if (data.length && (data[0] & 0o200)) return parseP7b(data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const records = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length === END_OF_MEDIUM) break;
    if (length === 0) {
      records.push(null);
      continue;
    }
    const padded = length + (length & 1);
    records.push(data.subarray(offset, offset + length));
    offset += padded;
    offset += 4;                            // the trailing length word
  }
  return records;
}

/**
 * s709's native tape image. Each record opens with a byte flagged 0200 — the
 * flag is not data — and runs until the next flagged byte; a 0217 byte is a
 * tape mark. The six-bit characters live in the low six bits, exactly like
 * the SIMH records, so once split the rest of the unit cannot tell the two
 * formats apart.
 */
export function parseP7b(data) {
  const records = [];
  let record = null;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    if (byte === 0o217) {                  // tape mark
      if (record) records.push(Uint8Array.from(record));
      record = null;
      records.push(null);
      continue;
    }
    if (byte & 0o200) {                    // a new record begins
      if (record) records.push(Uint8Array.from(record));
      record = [];
    }
    if (record) record.push(byte & 0o77);
  }
  if (record) records.push(Uint8Array.from(record));
  return records;
}

/** Write records back out as a .tap image. */
export function writeTap(records) {
  let size = 4;                             // room for the end-of-medium mark
  for (const record of records) {
    size += record === null ? 4 : 8 + record.length + (record.length & 1);
  }
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const record of records) {
    if (record === null) {
      view.setUint32(offset, 0, true);
      offset += 4;
      continue;
    }
    view.setUint32(offset, record.length, true);
    offset += 4;
    out.set(record, offset);
    offset += record.length + (record.length & 1);
    view.setUint32(offset, record.length, true);
    offset += 4;
  }
  view.setUint32(offset, END_OF_MEDIUM, true);
  return out;
}
