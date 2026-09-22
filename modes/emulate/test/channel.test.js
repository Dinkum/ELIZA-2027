/**
 * Channel and tape tests.
 *
 * A program selects a tape with RDS, points channel A at a command list with
 * RCHA, and the channel moves the record into core while the program waits on
 * TCOA. That handshake is the whole of 7094 input, and everything CTSS does
 * with its disks and its terminals is built on it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Machine } from '../src/machine.js';
import { TapeUnit, parseTap, writeTap } from '../src/devices/tape.js';
import { assembleInto } from '../src/assemble.js';
import { textToWord, wordToText } from '../src/bcd.js';

/** Build a one-record reel holding the given six-character words. */
function reelOf(words) {
  const bytes = [];
  for (const text of words) {
    const [hi, lo] = textToWord(text);
    bytes.push((hi >>> 12) & 0o77, (hi >>> 6) & 0o77, hi & 0o77);
    bytes.push((lo >>> 12) & 0o77, (lo >>> 6) & 0o77, lo & 0o77);
  }
  return writeTap([Uint8Array.from(bytes), null]);
}

function machineWithTape(source, reel) {
  const machine = new Machine();
  const tape = new TapeUnit('A1');
  tape.mount(reel);
  machine.channels[0].attach(0o201, tape);
  const image = assembleInto(machine.core, source);
  machine.start(image.start);
  let steps = 0;
  while (machine.running) {
    if (++steps > 100000) throw new Error('program did not halt');
    machine.run(1);
  }
  return { machine, tape };
}

test('.tap images round trip', () => {
  const reel = reelOf(['HELLO ', 'WORLD ']);
  const records = parseTap(reel);
  assert.equal(records.length, 2);
  assert.equal(records[0].length, 12);
  assert.equal(records[1], null);          // the tape mark
});

test('a channel reads a tape record into core', () => {
  const { machine } = machineWithTape(`
         ORG   100
         RDS   641
         RCHA  CMD
  WAIT   TCOA  WAIT
         HTR   0
  CMD    IOCD  BUF,0,2
  BUF    BSS   4
  `, reelOf(['HELLO ', 'WORLD ']));

  const core = machine.core;
  const base = 0o151;                      // BUF, two words past CMD
  assert.equal(wordToText(core.hi[base], core.lo[base]), 'HELLO ');
  assert.equal(wordToText(core.hi[base + 1], core.lo[base + 1]), 'WORLD ');
});

test('the channel disconnects and TCO falls through', () => {
  const { machine } = machineWithTape(`
         ORG   100
         RDS   641
         RCHA  CMD
  WAIT   TCOA  WAIT
         CLA   MARK
         HTR   0
  CMD    IOCD  BUF,0,2
  MARK   OCT   000000000777
  BUF    BSS   4
  `, reelOf(['HELLO ', 'WORLD ']));

  assert.equal(machine.cpu.acLo, 0o777);
  assert.equal(machine.channels[0].selected, false);
});

test('writing a tape produces a record that reads back', () => {
  const machine = new Machine();
  const tape = new TapeUnit('A1');
  tape.mountBlank();
  machine.channels[0].attach(0o201, tape);
  const image = assembleInto(machine.core, `
         ORG   100
         WRS   641
         RCHA  CMD
  WAIT   TCOA  WAIT
         HTR   0
  CMD    IOCD  TEXT,0,1
  TEXT   BCI   1,CTSS
  `);
  machine.start(image.start);
  let steps = 0;
  while (machine.running) {
    if (++steps > 100000) throw new Error('program did not halt');
    machine.run(1);
  }

  assert.equal(tape.records.length, 1);
  tape.rewind();
  tape.startRecord('read');
  const word = tape.readWord();
  assert.equal(wordToText(word[0], word[1]), 'CTSS  ');
});
