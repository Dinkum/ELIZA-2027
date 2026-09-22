/**
 * Core storage.
 *
 * A 7094 addresses 32768 words. The CTSS machines at Project MAC had two such
 * banks — the A core and the B core — selected by the SEA and SEB instructions,
 * which is how CTSS kept the supervisor and the swapped-in user program
 * addressable at once. Both banks live in one pair of arrays here, the B core at
 * offset 32768, so a bank select is an offset rather than a pointer swap.
 *
 * Words are stored as the two 18-bit halves described in word.js. Uint32Array
 * rather than Int32Array so that halves read back unsigned without a mask.
 */

import { CORE_SIZE, HALF } from './word.js';

export class Core {
  /**
   * @param {number} banks 1 for a stock 7094, 2 for the CTSS A/B configuration.
   */
  constructor(banks = 2) {
    this.banks = banks;
    this.size = CORE_SIZE * banks;
    this.hi = new Uint32Array(this.size);
    this.lo = new Uint32Array(this.size);
  }

  /** Wipe both banks. The real machine came up with whatever was left in it. */
  clear() {
    this.hi.fill(0);
    this.lo.fill(0);
  }

  /** Read the high half of the word at an already-resolved core address. */
  readHi(address) {
    return this.hi[address];
  }

  /** Read the low half of the word at an already-resolved core address. */
  readLo(address) {
    return this.lo[address];
  }

  /** Write a word at an already-resolved core address. */
  write(address, hi, lo) {
    this.hi[address] = hi & HALF;
    this.lo[address] = lo & HALF;
  }

  /**
   * Load a block of words at once, for a tape or card loader dropping an
   * absolute core image in. Words come in as [hi, lo] pairs.
   */
  writeBlock(address, words) {
    for (let i = 0; i < words.length; i++) {
      this.write(address + i, words[i][0], words[i][1]);
    }
  }
}
