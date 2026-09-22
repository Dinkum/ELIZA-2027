/**
 * 7909 channel tests.
 *
 * The 7909 is a small computer with its own instruction set, so these tests are
 * written the way the CPU tests are: put a program in core, let it run, and look
 * at what changed. The "program" here is a channel command list, and the device
 * on the end of it is a stub that records what it was told and hands back
 * whatever the test wants it to.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Machine } from '../src/machine.js';
import {
  WTR, XMT, TCH, LIPT, CTL, CTLR, CTLW, SNS, LAR, SAR, TWT,
  CPYP, CPYD, TCM, LIP, TDC, LCC, SMS, ICC,
  ATTENTION1, UNUSUAL_END, SEQUENCE_CHECK, INHIBIT_ATTENTION1,
  SEL_READ, SEL_WRITE, SEL_SENSE, SEL_CONTROL,
} from '../src/channel9.js';

/**
 * Assemble one channel command word.
 *
 * The five-bit opcode is scattered across the word — prefix, bit 3 of the
 * decrement, and bit 19 — so building one by hand is exactly the encoding the
 * channel has to undo.
 */
function cmd(op, decrement, address, { indirect = false, bcore = false } = {}) {
  const prefix = op >>> 2;
  const bit3 = (op >>> 1) & 1;
  const bit19 = op & 1;
  const hi = ((prefix & 7) << 15) | ((decrement | (bit3 ? 0o40000 : 0)) & 0o77777);
  const lo = (address & 0o77777)
    | (bit19 ? 0o200000 : 0)
    | (indirect ? 0o400000 : 0)
    | (bcore ? 0o100000 : 0);
  return [hi, lo];
}

function put(core, address, [hi, lo]) {
  core.hi[address] = hi;
  core.lo[address] = lo;
}

/**
 * A stub adapter that records everything and can be told to talk back.
 *
 * It has to ask for each next word, because that is how a 7909 transfer really
 * runs: the channel hands over a word and stops, and the device drives the next
 * cycle when it is ready. A control sequence ends when the device says it has
 * heard enough — there is no word count doing it.
 */
class StubDevice {
  constructor({ controlWords = 2 } = {}) {
    this.selects = [];
    this.written = [];
    this.stopped = false;
    this.controlWords = controlWords;
  }
  select(channel, selection) {
    this.selects.push(selection);
    // Being selected is what starts the device; it then drives the channel.
    if (selection === SEL_CONTROL) channel.request = true;
  }
  write(channel, hi, lo, stop) {
    if (stop) {
      this.stopped = true;
      return;
    }
    this.written.push([hi, lo]);
    if (this.written.length < this.controlWords) channel.request = true;
    else channel.setEnd();
  }
}

/** A machine whose channel C is a 7909, as the CTSS configuration has it. */
function machine9() {
  const machine = new Machine({ channels: 4, types: { 2: '7909' } });
  const channel = machine.channels[2];
  const device = new StubDevice();
  channel.attach(0, device);
  return { machine, channel, device, core: machine.core };
}

/** Start the channel at `address` and give it up to `n` cycles. */
function runChannel(channel, address, n = 50) {
  channel.clr = address;
  channel.ccore = 0;
  channel.state = 2;
  channel.nextCommand();
  // step() returning false means the channel made no progress this cycle -
  // it is waiting on the device - not that it has finished. The machine's own
  // loop ignores the return for exactly that reason, so this one does too.
  let cycles = 0;
  while ((channel.request || channel.state === 2) && cycles < n) {
    cycles += 1;
    channel.step();
  }
  return cycles;
}

// --- decoding ---------------------------------------------------------------

test('the opcode is assembled from the prefix, bit 3 and bit 19', () => {
  const { channel, core } = machine9();
  // TDC is 032: prefix 6, bit 3 set, bit 19 clear.
  put(core, 100, cmd(TDC, 0, 200));
  channel.clr = 100;
  channel.nextCommand();
  assert.equal(channel.cop, TDC);

  // SNS is 013: prefix 2, bit 3 set, bit 19 set.
  put(core, 101, cmd(SNS, 0, 0));
  channel.clr = 101;
  channel.nextCommand();
  assert.equal(channel.cop, SNS);

  // CPYP is 020: prefix 4, and prefix 4 does not use bit 3 at all.
  put(core, 102, cmd(CPYP, 5, 300));
  channel.clr = 102;
  channel.nextCommand();
  assert.equal(channel.cop, CPYP);
  assert.equal(channel.cwr, 5);
});

test('an indirect command takes its address from core', () => {
  const { channel, core } = machine9();
  core.lo[400] = 0o1234;
  put(core, 100, cmd(LAR, 0, 400, { indirect: true }));
  channel.clr = 100;
  channel.nextCommand();
  assert.equal(channel.car, 0o1234);
});

// --- transfers within the command list --------------------------------------

test('TCH jumps and WTR stops', () => {
  const { channel, core } = machine9();
  put(core, 100, cmd(TCH, 0, 200));
  put(core, 200, cmd(WTR, 0, 0));
  runChannel(channel, 100);
  assert.equal(channel.state, 0, 'WTR leaves the channel idle');
});

test('TDC counts down and falls through at zero', () => {
  const { channel, core } = machine9();
  // LCC 3, then a loop that decrements until it falls through to WTR.
  put(core, 100, cmd(LCC, 0, 3));
  put(core, 101, cmd(TDC, 0, 101));
  put(core, 102, cmd(WTR, 0, 0));
  runChannel(channel, 100);
  assert.equal(channel.lcc, 0, 'the counter is spent');
  assert.equal(channel.state, 0);
});

test('LCC and ICC put the counter into the assembly register', () => {
  const { channel, core } = machine9();
  put(core, 100, cmd(LCC, 0, 0o52));
  // ICC with condition select 2 writes byte 4 of AR.
  put(core, 101, cmd(ICC, 2 << 12, 0));
  put(core, 102, cmd(WTR, 0, 0));
  runChannel(channel, 100);
  assert.equal(channel.lcc, 0o52);
  assert.equal(channel.getByte(4), 0o52);
});

test('LAR and SAR move a word between core and the assembly register', () => {
  const { channel, core } = machine9();
  core.hi[400] = 0o123456;
  core.lo[400] = 0o654321;
  put(core, 100, cmd(LAR, 0, 400));
  put(core, 101, cmd(SAR, 0, 401));
  put(core, 102, cmd(WTR, 0, 0));
  runChannel(channel, 100);
  assert.equal(core.hi[401], 0o123456);
  assert.equal(core.lo[401], 0o654321);
});

test('XMT moves one word per cycle, not a block at a time', () => {
  const { channel, core } = machine9();
  for (let i = 0; i < 4; i++) {
    core.hi[201 + i] = 0o7000 + i;
    core.lo[201 + i] = i;
  }
  put(core, 200, cmd(XMT, 4, 300));
  put(core, 201 + 4, cmd(WTR, 0, 0));
  channel.clr = 200;
  channel.state = 2;
  channel.nextCommand();
  channel.step();
  assert.equal(channel.cwr, 3, 'one word moved, three to go');
  assert.equal(core.hi[300], 0o7000);
  for (let i = 0; i < 200 && (channel.request || channel.state === 2); i++) {
    channel.step();
  }
  assert.equal(core.hi[303], 0o7003, 'the rest followed');
});

// --- TCM --------------------------------------------------------------------

test('TCM tests the condition register for an exact value', () => {
  const { channel, core } = machine9();
  put(core, 100, cmd(TCM, (0 << 12) | ATTENTION1, 200));
  put(core, 101, cmd(WTR, 0, 0));
  put(core, 200, cmd(TWT, 0, 0));
  channel.condition = ATTENTION1;
  runChannel(channel, 100);
  assert.equal(channel.trapPending, true, 'the exact match transferred');
});

test('TCM with bit 11 matches any of the named bits', () => {
  const { channel, core } = machine9();
  // Mask names two conditions; only one is present.
  const mask = ATTENTION1 | UNUSUAL_END;
  put(core, 100, cmd(TCM, (0 << 12) | mask | 0o100, 200));
  put(core, 101, cmd(WTR, 0, 0));
  put(core, 200, cmd(TWT, 0, 0));
  channel.condition = ATTENTION1;
  runChannel(channel, 100);
  assert.equal(channel.trapPending, false, 'all named bits must be on');

  const second = machine9();
  put(second.core, 100, cmd(TCM, (0 << 12) | mask | 0o100, 200));
  put(second.core, 101, cmd(WTR, 0, 0));
  put(second.core, 200, cmd(TWT, 0, 0));
  second.channel.condition = mask;
  runChannel(second.channel, 100);
  assert.equal(second.channel.trapPending, true);
});

test('TCM with condition select 7 transfers only on a zero mask', () => {
  const { channel, core } = machine9();
  put(core, 100, cmd(TCM, 7 << 12, 200));
  put(core, 101, cmd(WTR, 0, 0));
  put(core, 200, cmd(TWT, 0, 0));
  runChannel(channel, 100);
  assert.equal(channel.trapPending, true);
});

// --- devices ----------------------------------------------------------------

test('CTLW sends its control words and then prepares to write', () => {
  const { channel, core, device } = machine9();
  core.hi[400] = 0o11; core.lo[400] = 0o22;
  core.hi[401] = 0o33; core.lo[401] = 0o44;
  put(core, 100, cmd(CTLW, 2, 400));
  put(core, 101, cmd(WTR, 0, 0));
  runChannel(channel, 100);
  assert.deepEqual(device.selects, [SEL_CONTROL, SEL_WRITE]);
  assert.equal(device.written.length >= 1, true, 'control words went out');
  assert.equal(channel.prepareWrite, true);
});

test('SNS asks the device for status and prepares to read', () => {
  const { channel, core, device } = machine9();
  put(core, 100, cmd(SNS, 0, 0));
  put(core, 101, cmd(WTR, 0, 0));
  runChannel(channel, 100);
  assert.deepEqual(device.selects, [SEL_SENSE]);
  assert.equal(channel.prepareRead, true);
});

test('a read moves the device words into core and CPYD disconnects on end', () => {
  const { channel, core, device } = machine9();
  put(core, 100, cmd(CTLR, 0o20000, 0));     // no-store: no control words
  put(core, 101, cmd(CPYD, 3, 500));
  put(core, 102, cmd(WTR, 0, 0));

  channel.clr = 100;
  channel.state = 2;
  channel.nextCommand();
  channel.step();                              // CTLR issues the read select
  assert.deepEqual(device.selects, [SEL_READ]);

  // The device now drives the transfer, a word at a time.
  for (const value of [0o111, 0o222, 0o333]) {
    channel.inputWord(value, value);
    channel.step();
  }
  assert.equal(core.hi[500], 0o111);
  assert.equal(core.hi[501], 0o222);
  assert.equal(core.hi[502], 0o333);

  channel.setEnd();
  channel.step();
  assert.equal(device.stopped, true, 'the channel sent a stop');
});

test('CPYP with no words falls straight through to the next command', () => {
  const { channel, core } = machine9();
  put(core, 100, cmd(CPYP, 0, 0));
  put(core, 101, cmd(TWT, 0, 0));
  channel.prepareRead = true;                  // a transfer is standing
  runChannel(channel, 100);
  assert.equal(channel.trapPending, true, 'it reached the next command');
});

// --- interrupts -------------------------------------------------------------

test('an attention interrupt saves the channel and runs the interrupt command', () => {
  const { channel, core } = machine9();
  const save = 0o42 + (2 << 1);
  put(core, 100, cmd(WTR, 0, 0));
  put(core, save + 1, cmd(TWT, 0, 0));         // the interrupt command

  runChannel(channel, 100);
  assert.equal(channel.state, 0, 'stopped at WTR');

  channel.setAttention();
  channel.step();
  assert.equal(core.lo[save], 100, 'a stopped channel comes back to its own command');
  assert.equal(channel.inInterrupt, true);
  assert.equal(channel.condition, ATTENTION1);
  assert.equal(channel.trapPending, true, 'the interrupt command ran');
});

test('LIP leaves the interrupt and goes back to where the channel was', () => {
  const { channel, core } = machine9();
  const save = 0o42 + (2 << 1);
  put(core, 100, cmd(WTR, 0, 0));
  put(core, save + 1, cmd(TCH, 0, 300));       // interrupt: jump to a handler
  put(core, 300, cmd(LIP, 0, 0));
  put(core, 301, cmd(WTR, 0, 0));

  runChannel(channel, 100);
  channel.setAttention();
  for (let i = 0; i < 200 && (channel.request || channel.state === 2); i++) {
    channel.step();
  }
  assert.equal(channel.inInterrupt, false, 'the interrupt was left');
  assert.equal(channel.condition, 0, 'the condition register was cleared');
});

test('SMS inhibits attention, and lifting the inhibit interrupts at once', () => {
  const { channel, core } = machine9();
  put(core, 100, cmd(SMS, 0, INHIBIT_ATTENTION1));
  put(core, 101, cmd(WTR, 0, 0));
  runChannel(channel, 100);
  assert.equal(channel.sms & INHIBIT_ATTENTION1, INHIBIT_ATTENTION1);

  channel.setAttention();
  assert.equal(channel.interruptRequest, false, 'no interrupt while inhibited');
  assert.equal(
    channel.condition & ATTENTION1,
    ATTENTION1,
    'but the condition register still records it, so TCM can find it',
  );

  // Lifting the inhibit must interrupt now, not at the next unrelated event.
  put(core, 200, cmd(SMS, 0, 0));
  put(core, 201, cmd(WTR, 0, 0));
  runChannel(channel, 200);
  assert.equal(channel.interruptRequest || channel.inInterrupt, true);
});

test('a copy outside a transfer is refused, not a sequence check', () => {
  // s709's writeword/readword refuse a word when no device is engaged, and
  // the command simply ends — no condition is raised for the program.
  const { channel, core } = machine9();
  put(core, 100, cmd(CPYD, 2, 500));
  put(core, 101, cmd(WTR, 0, 0));
  runChannel(channel, 100);
  assert.equal(channel.condition & SEQUENCE_CHECK, 0);
  assert.equal(channel.state, 0);
});

test('TWT stops the channel and asks the processor for a trap', () => {
  const { channel, core } = machine9();
  put(core, 100, cmd(TWT, 0, 0));
  runChannel(channel, 100);
  assert.equal(channel.state, 0);
  assert.equal(channel.trapPending, true);
});

// --- starting a stopped program (LCH/STC) -----------------------------------
//
// On a 7909 an LCH is "start channel", not a second way to load a command
// list: it restarts a program that stopped at a WTR or a TWT, at the address
// that command names, and its own address field is never used. CTSS's `STCE`
// is assembled with address zero (CHNE0115, at the end of every channel
// interrupt, and CHNE0081 STARTE), so reading the address field ran the word
// at core 0 — the processor's trap cell — which decodes as a WTR and leaves
// the 7750 parked for good. s709: `check_load` starts the channel only for
// `cflags & CHAN_INWAIT` and `start_7909` resumes from `car`.

test('LCH restarts a program stopped at a WTR, at the address it names', () => {
  const { channel, core } = machine9();
  put(core, 100, cmd(WTR, 0, 300));
  put(core, 300, cmd(LCC, 0, 5));
  put(core, 301, cmd(WTR, 0, 0));
  channel.resetAndLoad({ y: 100, bcoreData: 0 });
  assert.equal(channel.state, 0, 'WTR leaves the channel stopped');
  assert.equal(channel.waiting, true);
  assert.equal(channel.clr, 100, 'the stop is remembered at the WTR');
  channel.load({ y: 0, bcoreData: 0 });            // STCE, address zero
  // The command the WTR named is the one decoded — the counter has already
  // moved past it, the way every other command leaves it.
  assert.equal(channel.cop, LCC, 'resumes at the address the WTR named');
  assert.equal(channel.clr, 301);
  while (channel.request) channel.step();
  assert.equal(channel.lcc, 5, 'the rest of the program ran');
  assert.equal(channel.waiting, true, 'and stopped again at its own WTR');
});

test('LCH continues a TWT at the trap command\'s operand', () => {
  const { channel, core } = machine9();
  put(core, 100, cmd(TWT, 0, 101));
  put(core, 101, cmd(LCC, 0, 7));
  put(core, 102, cmd(WTR, 0, 0));
  channel.resetAndLoad({ y: 100, bcoreData: 0 });
  assert.equal(channel.trapPending, true);
  channel.load({ y: 0, bcoreData: 0 });
  while (channel.request) channel.step();
  assert.equal(channel.lcc, 7);
});

test('LCH does nothing when no program is waiting', () => {
  const { channel, core } = machine9();
  put(core, 0, cmd(WTR, 0, 0));                    // the trap cell's word
  channel.clr = 0o1234;
  channel.load({ y: 0, bcoreData: 0 });
  assert.equal(channel.state, 0, 'a stopped channel is not started');
  assert.equal(channel.clr, 0o1234, 'and the command counter is untouched');
});
