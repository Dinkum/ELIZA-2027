/**
 * 7750 communications controller tests.
 *
 * The 7750 is the device a terminal hangs off, so these tests are written from
 * both ends: somebody types, and the 7094 has to be able to read what was
 * typed; the 7094 sends a message, and it has to come out as text on the right
 * line. Everything in between is twelve bit characters, three to a word, most
 * of them ones-complemented.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Machine } from '../src/machine.js';
import { CTLR, CTLW, SNS, CPYD, WTR, SMS, INHIBIT_ATTENTION1 } from '../src/channel9.js';
import {
  CommunicationsController, CONSOLE_LINE, VALID_LINE, END_OF_MEDIUM,
  INTERRUPT, QUIT, SENSE,
} from '../src/devices/comm.js';

function cmd(op, decrement, address) {
  const prefix = op >>> 2;
  const bit3 = (op >>> 1) & 1;
  const bit19 = op & 1;
  const hi = ((prefix & 7) << 15) | ((decrement | (bit3 ? 0o40000 : 0)) & 0o77777);
  const lo = (address & 0o77777) | (bit19 ? 0o200000 : 0);
  return [hi, lo];
}

function put(core, address, [hi, lo]) {
  core.hi[address] = hi;
  core.lo[address] = lo;
}

/** Pack twelve bit characters three to a word, as the wire has them. */
function pack(characters) {
  const words = [];
  for (let i = 0; i < characters.length; i += 3) {
    const a = characters[i] & 0o7777;
    const b = (characters[i + 1] ?? END_OF_MEDIUM) & 0o7777;
    const c = (characters[i + 2] ?? END_OF_MEDIUM) & 0o7777;
    words.push([((a << 6) | (b >>> 6)) & 0o777777, (((b & 0o77) << 12) | c) & 0o777777]);
  }
  return words;
}

function unpack(words) {
  const out = [];
  for (const [hi, lo] of words) {
    out.push((hi >>> 6) & 0o7777);
    out.push((((hi & 0o77) << 6) | ((lo >>> 12) & 0o77)) & 0o7777);
    out.push(lo & 0o7777);
  }
  return out;
}

/** An output character: seven bits, a parity bit, a start bit, complemented. */
function outChar(code) {
  return (~(code << 1)) & 0o7777;
}

/**
 * A whole output message, as the wire has it: one stream of twelve bit
 * characters where the line and the count are simply the first two, so the
 * third character - the first of the data - shares the header's word.
 */
function message(line, data, { twelveBit = true } = {}) {
  const head = (line & 0o777) | (twelveBit ? 0o2000 : 0);
  return pack([head, data.length, ...data, END_OF_MEDIUM]);
}

function commMachine() {
  const machine = new Machine({ channels: 6, types: { 4: '7909' } });
  const channel = machine.channels[4];
  const comm = new CommunicationsController();
  channel.attach(0, comm);
  const printed = [];
  comm.lines[CONSOLE_LINE].onPrint = (text) => printed.push(text);
  return { machine, channel, comm, printed, core: machine.core };
}

function runChannel(channel, address, limit = 4000) {
  channel.clr = address;
  channel.ccore = 0;
  channel.state = 2;
  channel.nextCommand();
  let cycles = 0;
  while ((channel.request || channel.state === 2) && cycles < limit) {
    cycles += 1;
    channel.step();
  }
  return cycles;
}

/** Turn the controller on, as CTSS does once at startup. */
function enable(comm, channel, core) {
  core.hi[500] = 0o777777;
  core.lo[500] = 0o777777;
  put(core, 100, cmd(SMS, 0, INHIBIT_ATTENTION1));
  put(core, 101, cmd(CTLW, 0o20000, 0));
  put(core, 102, cmd(CPYD, 1, 500));
  put(core, 103, cmd(WTR, 0, 0));
  runChannel(channel, 100);
}

// --- turning it on ----------------------------------------------------------

test('the controller is dead until the all-ones message arrives', () => {
  const { channel, comm, core } = commMachine();
  assert.equal(comm.enabled, false);
  comm.typeCharacter(CONSOLE_LINE, 0x41);
  assert.equal(comm.lines[CONSOLE_LINE].input.length, 0, 'nothing is taken in');

  enable(comm, channel, core);
  assert.equal(comm.enabled, true);
});

// --- typing in --------------------------------------------------------------

test('a typed line is held until the return, and then announced', () => {
  const { channel, comm, core } = commMachine();
  enable(comm, channel, core);

  comm.typeCharacter(CONSOLE_LINE, 0x48);          // H
  assert.equal(comm.lines[CONSOLE_LINE].inputPending, false, 'half a line waits');

  comm.typeCharacter(CONSOLE_LINE, 0o15);          // return
  assert.equal(comm.lines[CONSOLE_LINE].inputPending, true);
  assert.equal(comm.hasInput, true);
});

test('input characters are ones-complemented with even parity', () => {
  const { channel, comm, core } = commMachine();
  enable(comm, channel, core);
  comm.typeCharacter(CONSOLE_LINE, 0x41);          // A, 0101, odd number of bits
  const held = comm.lines[CONSOLE_LINE].input[0];
  // A is 1000001: two bits set, so even parity adds nothing.
  assert.equal(held, (~0x41) & 0o377);
});

test('the interrupt and quit characters come through as control codes', () => {
  const { channel, comm, core } = commMachine();
  enable(comm, channel, core);
  comm.typeCharacter(CONSOLE_LINE, 0o003);
  assert.equal(comm.lines[CONSOLE_LINE].input[0], INTERRUPT);
  comm.typeCharacter(CONSOLE_LINE, 0o034);
  assert.equal(comm.lines[CONSOLE_LINE].input[1], QUIT);
});

test('a read collects what was typed into a numbered message', () => {
  const { channel, comm, core } = commMachine();
  enable(comm, channel, core);
  comm.typeLine(CONSOLE_LINE, 'HI');

  put(core, 200, cmd(SMS, 0, INHIBIT_ATTENTION1));
  put(core, 201, cmd(CTLR, 0o20000, 0));
  put(core, 202, cmd(CPYD, 8, 600));
  put(core, 203, cmd(WTR, 0, 0));
  runChannel(channel, 200);

  const words = [];
  for (let i = 0; i < 8; i++) words.push([core.hi[600 + i], core.lo[600 + i]]);
  const characters = unpack(words);

  assert.equal(characters[0], 0, 'the first message is number zero');
  assert.equal(characters[1], (CONSOLE_LINE + 4) | VALID_LINE, 'the line is named');
  assert.equal(characters[2], (~0x48) & 0o377, 'and it sent an H');
});

test('a pending line hands over its whole line in one message', () => {
  const { channel, comm, core } = commMachine();
  enable(comm, channel, core);
  comm.typeLine(CONSOLE_LINE, 'AB');

  const read = (at, into) => {
    put(core, at, cmd(SMS, 0, INHIBIT_ATTENTION1));
    put(core, at + 1, cmd(CTLR, 0o20000, 0));
    put(core, at + 2, cmd(CPYD, 8, into));
    put(core, at + 3, cmd(WTR, 0, 0));
    runChannel(channel, at);
    const words = [];
    for (let i = 0; i < 8; i++) words.push([core.hi[into + i], core.lo[into + i]]);
    return unpack(words);
  };

  const first = read(200, 600);
  const second = read(210, 620);
  const lineTag = (CONSOLE_LINE + 4) | VALID_LINE;
  assert.equal(first[0], 0);
  assert.deepEqual(
    [first[1], first[2], first[3], first[4], first[5], first[6]],
    [lineTag, (~0x41) & 0o377, lineTag, (~0x42) & 0o377, lineTag, (~0o215) & 0o377],
    'A, B and the return all arrive together',
  );
  assert.equal(second[0], 1, 'the sequence number advanced');
  assert.equal(second[1], END_OF_MEDIUM, 'and there is nothing left to say');
});

test('a completion-only message ends before the following input record', () => {
  const { channel, comm, core } = commMachine();
  enable(comm, channel, core);
  comm.lines[CONSOLE_LINE].notReturned = 65;
  const characters = unpack(comm.collect());
  const lineTag = (CONSOLE_LINE + 4) | VALID_LINE;
  assert.deepEqual(characters.slice(1, 8), [
    lineTag, 0o3037, lineTag, 0o3037, lineTag, 0o3003, END_OF_MEDIUM,
  ]);
  assert.equal(comm.lines[CONSOLE_LINE].notReturned, 0);
});

test('a dialup is announced as DIALUP, the model and END_ID', () => {
  const { channel, comm, core } = commMachine();
  enable(comm, channel, core);
  comm.dialUp(CONSOLE_LINE, { ksr35: true });

  put(core, 200, cmd(SMS, 0, INHIBIT_ATTENTION1));
  put(core, 201, cmd(CTLR, 0o20000, 0));
  put(core, 202, cmd(CPYD, 8, 600));
  put(core, 203, cmd(WTR, 0, 0));
  runChannel(channel, 200);

  const words = [];
  for (let i = 0; i < 8; i++) words.push([core.hi[600 + i], core.lo[600 + i]]);
  const characters = unpack(words);
  const lineTag = (CONSOLE_LINE + 4) | VALID_LINE;
  const pairs = [];
  for (let i = 1; i + 1 < characters.length && characters[i] === lineTag; i += 2)
    pairs.push(characters[i + 1]);
  assert.deepEqual(pairs, [0o2001, 1, 0, 0, 0, 0o2002], 'DIALUP KSR35 0 0 0 END_ID');
  assert.equal(comm.lines[CONSOLE_LINE].connected, true);
});

// --- printing out -----------------------------------------------------------

test('a write message prints on the line it names', () => {
  const { channel, comm, printed, core } = commMachine();
  enable(comm, channel, core);

  const words = message(CONSOLE_LINE + 4, [outChar(0x48), outChar(0x49)]);  // HI
  for (let i = 0; i < words.length; i++) put(core, 700 + i, words[i]);

  put(core, 300, cmd(SMS, 0, INHIBIT_ATTENTION1));
  put(core, 301, cmd(CTLW, 0o20000, 0));
  put(core, 302, cmd(CPYD, words.length, 700));
  put(core, 303, cmd(WTR, 0, 0));
  runChannel(channel, 300);

  assert.equal(printed.join(''), 'HI');
});

test('a carriage return prints as a return and a line feed', () => {
  const { channel, comm, printed, core } = commMachine();
  enable(comm, channel, core);

  const words = message(CONSOLE_LINE + 4, [outChar(0o15)]);
  for (let i = 0; i < words.length; i++) put(core, 700 + i, words[i]);

  put(core, 300, cmd(SMS, 0, INHIBIT_ATTENTION1));
  put(core, 301, cmd(CTLW, 0o20000, 0));
  put(core, 302, cmd(CPYD, words.length, 700));
  put(core, 303, cmd(WTR, 0, 0));
  runChannel(channel, 300);

  assert.equal(printed.join(''), '\r\n');
});

// --- sense ------------------------------------------------------------------

test('sense reports that there is data waiting', () => {
  const { channel, comm, core } = commMachine();
  enable(comm, channel, core);
  comm.typeLine(CONSOLE_LINE, 'X');

  put(core, 400, cmd(SMS, 0, INHIBIT_ATTENTION1));
  put(core, 401, cmd(SNS, 0, 0));
  put(core, 402, cmd(CPYD, 2, 800));
  put(core, 403, cmd(WTR, 0, 0));
  runChannel(channel, 400);

  assert.equal(core.hi[800] & SENSE.DATA_READY, SENSE.DATA_READY);
});
