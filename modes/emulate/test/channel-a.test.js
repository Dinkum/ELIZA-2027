/**
 * The two devices CTSS needs on channel A.
 *
 * Neither is interesting on its own. They matter because the supervisor reads
 * the clock and writes the log during startup, and on a machine where those are
 * missing it gets as far as its own initialisation and stops — which is a much
 * harder thing to diagnose than a missing device usually deserves.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Machine } from '../src/machine.js';
import { ChronologClock } from '../src/devices/chrono.js';
import { LinePrinter } from '../src/devices/printer.js';
import { toBCD } from '../src/bcd.js';

/** Turn a BCD code into a twelve-bit Hollerith column image. */
function bcdToColumn(code) {
  const digit = code & 0o17;
  const zone = code & 0o60;
  if (code === 0o60) return 0;                       // blank: no punches
  let column = 0;
  if (zone === 0o20) column |= 0o4000;               // row 12
  else if (zone === 0o40) column |= 0o2000;          // row 11
  else if (zone === 0o60) column |= 0o1000;          // row 0 as a zone
  if (digit === 0) {
    if (!column) column = 0o1000;                    // a bare zero
  } else {
    column |= 1 << (9 - digit);                      // rows 9..1 -> bits 0..8
  }
  return column;
}

/** Pack a line of text as the printer's twenty-four row-image words. */
function textToColumns(text) {
  const columns = new Array(72).fill(0);
  for (let i = 0; i < text.length && i < 72; i++) columns[i] = bcdToColumn(toBCD(text[i]));
  const words = [];
  for (let row = 0; row < 24; row++) {
    const bit = 1 << (row >> 1);
    const base = row & 1 ? 36 : 0;
    let hi = 0;
    let lo = 0;
    for (let k = 0; k < 18; k++) {
      if (columns[base + k] & bit) hi |= 1 << (17 - k);
      if (columns[base + 18 + k] & bit) lo |= 1 << (17 - k);
    }
    words.push([hi, lo]);
  }
  return words;
}

/** Pull the twelve digits back out of the clock's two words. */
function digitsOf(words) {
  const out = [];
  for (const [hi, lo] of words) {
    out.push((hi >>> 12) & 0o77, (hi >>> 6) & 0o77, hi & 0o77);
    out.push((lo >>> 12) & 0o77, (lo >>> 6) & 0o77, lo & 0o77);
  }
  // BCD writes the digit zero as 012.
  return out.map((c) => (c === 0o12 ? 0 : c));
}

test('the clock reads as one record of twelve BCD digits', () => {
  const clock = new ChronologClock({ now: () => new Date(2027, 2, 9, 14, 5, 37) });
  clock.startRecord('read');

  const words = [];
  for (;;) {
    const word = clock.readWord();
    if (word === null) break;
    words.push(word);
  }
  assert.equal(words.length, 2, 'twelve characters is two words');

  const d = digitsOf(words);
  assert.deepEqual(d.slice(0, 2), [0, 3], 'March, as two digits');
  assert.deepEqual(d.slice(2, 4), [0, 9], 'the ninth');
  assert.deepEqual(d.slice(4, 6), [1, 4], 'the hour');
  assert.deepEqual(d.slice(6, 8), [0, 5], 'the minute');
  assert.deepEqual(d.slice(8, 10), [3, 7], 'the second');
});

test('the clock takes its last two digits from the interval timer', () => {
  const machine = new Machine({ channels: 1 });
  const clock = new ChronologClock({ now: () => new Date(2027, 0, 1, 0, 0, 0) });
  clock.core = machine.core;
  machine.core.lo[0o5] = 125;                    // the timer cell

  clock.startRecord('read');
  const d = digitsOf([clock.readWord(), clock.readWord()]);
  assert.deepEqual(d.slice(10, 12), [0, 5], '125 modulo 60 is 5');
});

test('nothing can be written to a clock', () => {
  const clock = new ChronologClock();
  clock.startRecord('write');
  clock.writeWord(0o777777, 0o777777);
  assert.equal(clock.readWord(), null);
});

test('the printer turns a record into a line of text', () => {
  const lines = [];
  const printer = new LinePrinter({ onPrint: (line) => lines.push(line) });
  printer.startRecord('write');
  for (const [hi, lo] of textToColumns('HELLO WORLD')) printer.writeWord(hi, lo);
  printer.endRecord();
  assert.deepEqual(lines, ['HELLO WORLD']);
});

test('an empty record prints nothing at all', () => {
  const lines = [];
  const printer = new LinePrinter({ onPrint: (line) => lines.push(line) });
  printer.startRecord('write');
  printer.endRecord();
  assert.deepEqual(lines, []);
});

test('the machine finds both of them where CTSS looks', () => {
  const machine = new Machine({ channels: 4 });
  machine.channels[0].attach(0o207, new ChronologClock());
  machine.channels[0].attach(0o361, new LinePrinter());
  const cpu = { ioCheck: false };

  machine.channels[0].select(cpu, 'read', 0o207);
  assert.equal(cpu.ioCheck, false, 'the clock is unit 7 on channel A');
  machine.channels[0].select(cpu, 'write', 0o361);
  assert.equal(cpu.ioCheck, false, 'the printer answers as the BCD printer');

  machine.channels[0].select(cpu, 'read', 0o204);
  assert.equal(cpu.ioCheck, true, 'and a unit that is not there is an I/O check');
});
