/**
 * The sample programs, run end to end.
 *
 * This is the integration test: an assembler source file goes in, the machine
 * computes, a data channel moves the answer to a printer, and the printed lines
 * come out. Every layer has to be right for it to pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Machine } from '../src/machine.js';
import { assembleInto } from '../src/assemble.js';
import { wordToText } from '../src/bcd.js';

/** A stand-in for the 716 on-line printer: one record is one line. */
class Printer {
  constructor() {
    this.lines = [];
    this.buffer = '';
    this.atFileMark = false;
    this.channel = null;
  }

  startRecord() { this.buffer = ''; }
  readWord() { return null; }
  writeWord(hi, lo) { this.buffer += wordToText(hi, lo); }
  endRecord(writing) {
    if (writing) this.lines.push(this.buffer.replace(/\s+$/, ''));
    this.buffer = '';
  }

  backspaceRecord() {}
  backspaceFile() {}
  writeEndOfFile() {}
  rewind() {}
  rewindUnload() {}
  setDensity() {}
  get atLoadPoint() { return false; }
}

function runProgram(name) {
  const path = fileURLToPath(new URL(`../programs/${name}`, import.meta.url));
  const machine = new Machine();
  const printer = new Printer();
  machine.channels[0].attach(0o361, printer);
  const image = assembleInto(machine.core, readFileSync(path, 'utf8'));
  machine.start(image.start);
  let slices = 0;
  while (machine.running) {
    if (++slices > 10000) throw new Error('program did not halt');
    machine.run(1000);
  }
  return { machine, printer };
}

test('fibonacci.fap prints the first fifteen numbers', () => {
  const { printer, machine } = runProgram('fibonacci.fap');
  assert.equal(machine.cpu.lastError, null);
  assert.deepEqual(printer.lines, [
    '000001', '000001', '000002', '000003', '000005',
    '000008', '000013', '000021', '000034', '000055',
    '000089', '000144', '000233', '000377', '000610',
  ]);
});
