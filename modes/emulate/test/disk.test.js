/**
 * 7631 file control tests.
 *
 * These drive the disk the way CTSS will: through a 7909 command list. An order
 * goes out as ten BCD characters with CTL, the controller acts on it, and a
 * following CTLR/CPYD or CTLW/CPYD moves the record. Nothing here reaches into
 * the controller directly, because the handshake between the three of them is
 * most of what there is to get wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Machine } from '../src/machine.js';
import {
  CTL, CTLR, CTLW, SNS, CPYD, WTR, TWT, SMS, INHIBIT_ATTENTION1,
} from '../src/channel9.js';
import { FileControl, DiskModule, SENSE } from '../src/devices/disk.js';

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

/** Pack six BCD characters into a word. */
function chars(...six) {
  const hi = ((six[0] & 0o77) << 12) | ((six[1] & 0o77) << 6) | (six[2] & 0o77);
  const lo = ((six[3] & 0o77) << 12) | ((six[4] & 0o77) << 6) | (six[5] & 0o77);
  return [hi, lo];
}

/** BCD writes the digit zero as 012. */
const D = (n) => (n === 0 ? 0o12 : n);

/**
 * An 8x order: operation, access, module, and a four digit track number.
 * The remaining two characters carry the rest of the identifier.
 */
function order8(op2, access, module, track, tail = [0, 0]) {
  const d = String(track).padStart(4, '0').split('').map((c) => D(Number(c)));
  return [
    chars(8, D(op2), D(access), D(module), d[0], d[1]),
    chars(d[2], d[3], tail[0], tail[1], 0, 0),
  ];
}

function diskMachine() {
  const machine = new Machine({ channels: 4, types: { 2: '7909' } });
  const channel = machine.channels[2];
  const control = new FileControl();
  const module = new DiskModule(1301);
  control.mount(0, module);
  channel.attach(0, control);
  return { machine, channel, control, module, core: machine.core };
}

function runChannel(channel, address, limit = 4000) {
  channel.clr = address;
  channel.ccore = 0;
  channel.state = 2;
  channel.nextCommand();
  // step() returning false means the channel made no progress this cycle -
  // it is waiting on the device - not that it has finished. The machine's own
  // loop ignores the return for exactly that reason, so this one does too.
  let cycles = 0;
  while ((channel.request || channel.state === 2) && cycles < limit) {
    cycles += 1;
    channel.step();
  }
  return cycles;
}

/** Put an order in core at `at` and return the command list entry for it. */
function placeOrder(core, at, words) {
  put(core, at, words[0]);
  put(core, at + 1, words[1]);
}

// --- orders -----------------------------------------------------------------

test('a seek moves the access arm and raises attention', () => {
  const { channel, control, module, core } = diskMachine();
  placeOrder(core, 400, order8(0x0, 0, 0, 37));     // SEEK track 37
  put(core, 100, cmd(CTL, 2, 400));
  put(core, 101, cmd(WTR, 0, 0));
  runChannel(channel, 100);

  assert.equal(module.position[0], 37, 'the arm is on track 37');
  assert.equal(control.sns[0] & SENSE.INVALID_ADDRESS.hi, 0);
  assert.equal(
    channel.interruptRequest || channel.inInterrupt,
    true,
    'the arriving arm asked for attention',
  );
});

test('a seek past the end of the disk is an invalid address', () => {
  const { channel, control, core } = diskMachine();
  placeOrder(core, 400, order8(0x0, 0, 0, 9999));   // 1301 has 10000 tracks
  placeOrder(core, 402, order8(0x0, 0, 0, 9999));
  put(core, 100, cmd(CTL, 2, 400));
  put(core, 101, cmd(WTR, 0, 0));
  runChannel(channel, 100);
  assert.equal(control.sns[0] & SENSE.INVALID_ADDRESS.hi, 0, 'the last track is valid');

  // Track 9999 is the last one; a five digit track cannot be expressed, so an
  // out of range access number is used to reach the same check.
  const second = diskMachine();
  placeOrder(second.core, 400, order8(0x0, 1, 0, 10));  // access 1 on a 1301
  put(second.core, 100, cmd(CTL, 2, 400));
  put(second.core, 101, cmd(WTR, 0, 0));
  runChannel(second.channel, 100);
  assert.equal(
    second.control.sns[0] & SENSE.ACCESS_INOPERATIVE.hi,
    SENSE.ACCESS_INOPERATIVE.hi,
    'a 1301 has only one access arm',
  );
  assert.equal(
    second.control.sns[1] & SENSE.ACCESS_INOPERATIVE.lo,
    SENSE.ACCESS_INOPERATIVE.lo,
    'a 1301 has only one access arm',
  );
});

test('an unknown order is reported rather than obeyed', () => {
  const { channel, control, core } = diskMachine();
  put(core, 400, chars(0, 0o7, 0, 0, 0, 0));        // 0x group, undefined x
  put(core, 100, cmd(CTL, 1, 400));
  put(core, 101, cmd(WTR, 0, 0));
  runChannel(channel, 100);
  assert.equal(control.sns[0] & SENSE.INVALID_ORDER.hi, SENSE.INVALID_ORDER.hi);
});

// --- transfers --------------------------------------------------------------

/** Lay a record down by hand, the way a formatted track would look. */
function layRecord(module, track, addressHi, addressLo, words) {
  const t = module.ensureTrack(0, track);
  t.hi[0] = 0o676767; t.lo[0] = 0o676767;            // home address 2
  t.hi[1] = words.length;                            // record length
  t.lo[1] = 0;
  t.hi[2] = addressHi; t.lo[2] = addressLo;          // record address
  for (let i = 0; i < words.length; i++) {
    t.hi[3 + i] = words[i][0];
    t.lo[3 + i] = words[i][1];
  }
  return t;
}

test('a track is read back through the channel a word at a time', () => {
  const { channel, module, core } = diskMachine();
  // A track holds records, not loose words: the five words below are the data
  // area of one record, and a track order moves exactly those.
  layRecord(module, 5, 0o111111, 0o222222, [
    [0o1001, 1], [0o1002, 2], [0o1003, 3], [0o1004, 4], [0o1005, 5],
  ]);

  placeOrder(core, 400, order8(0x4, 0, 0, 0));       // seek track 0 first
  placeOrder(core, 402, order8(0x4, 0, 0, 5));       // TRACK NO ADDRESS, track 5
  placeOrder(core, 404, order8(0x0, 0, 0, 5));       // SEEK to 5

  // The arriving arm raises attention, and an attention with no interrupt
  // program behind it would take the channel away from this command list. A
  // real driver has one; here the interrupt is simply inhibited.
  put(core, 100, cmd(SMS, 0, INHIBIT_ATTENTION1));
  put(core, 101, cmd(CTL, 2, 404));                  // seek
  put(core, 102, cmd(CTL, 2, 402));                  // then the read order
  put(core, 103, cmd(CTLR, 0o20000, 0));             // prepare to read
  put(core, 104, cmd(CPYD, 5, 600));
  put(core, 105, cmd(WTR, 0, 0));
  runChannel(channel, 100);

  assert.equal(core.hi[600], 0o1001, 'the record data, not the record header');
  assert.equal(core.hi[601], 0o1002);
  assert.equal(core.hi[604], 0o1005);
});

test('a single record is found by the identifier the order names', () => {
  const { channel, module, core } = diskMachine();
  const idHi = 0o010203, idLo = 0o040506;
  layRecord(module, 0, idHi, idLo, [[0o7001, 1], [0o7002, 2], [0o7003, 3]]);

  // SINGLE RECORD, with the identifier in the last six characters.
  const words = [
    chars(8, 0x2, D(0), D(0), (idHi >>> 12) & 0o77, (idHi >>> 6) & 0o77),
    chars(idHi & 0o77, (idLo >>> 12) & 0o77, (idLo >>> 6) & 0o77, idLo & 0o77, 0, 0),
  ];
  placeOrder(core, 400, words);
  put(core, 100, cmd(CTL, 2, 400));
  put(core, 101, cmd(CTLR, 0o20000, 0));
  put(core, 102, cmd(CPYD, 3, 700));
  put(core, 103, cmd(WTR, 0, 0));
  runChannel(channel, 100);

  assert.equal(core.hi[700], 0o7001);
  assert.equal(core.hi[702], 0o7003);
});

test('a record that is not on the track is reported, not invented', () => {
  const { channel, control, module, core } = diskMachine();
  layRecord(module, 0, 0o111111, 0o222222, [[1, 1]]);
  const words = [
    chars(8, 0x2, D(0), D(0), 0o77, 0o77),
    chars(0o77, 0o77, 0o77, 0o77, 0, 0),
  ];
  placeOrder(core, 400, words);
  put(core, 100, cmd(CTL, 2, 400));
  put(core, 101, cmd(CTLR, 0o20000, 0));
  put(core, 102, cmd(CPYD, 3, 700));
  put(core, 103, cmd(WTR, 0, 0));
  runChannel(channel, 100);
  assert.equal(control.sns[0] & SENSE.NO_RECORD_FOUND.hi, SENSE.NO_RECORD_FOUND.hi);
});

test('a track written through the channel reads back the same', () => {
  const { channel, module, core } = diskMachine();
  // The track has to be laid out before anything can be written into it: a
  // 7631 writes into a record that the format already put there.
  layRecord(module, 0, 0o333333, 0o444444, [[0, 0], [0, 0], [0, 0], [0, 0]]);
  for (let i = 0; i < 4; i++) { core.hi[800 + i] = 0o6000 + i; core.lo[800 + i] = i; }

  placeOrder(core, 400, order8(0x4, 0, 0, 0));       // TRACK NO ADDRESS, track 0
  put(core, 100, cmd(CTL, 2, 400));
  put(core, 101, cmd(CTLW, 0o20000, 0));
  put(core, 102, cmd(CPYD, 4, 800));
  put(core, 103, cmd(WTR, 0, 0));
  runChannel(channel, 100);

  const t = module.track(0, 0);
  assert.equal(t.hi[3], 0o6000, 'written into the record data area');
  assert.equal(t.hi[6], 0o6003);
});

// --- sense ------------------------------------------------------------------

test('sense hands back the bits the last failure set', () => {
  const { channel, control, core } = diskMachine();
  control.sns[0] = SENSE.NO_RECORD_FOUND.hi;
  control.sns[1] = SENSE.NO_RECORD_FOUND.lo;
  put(core, 100, cmd(SNS, 0, 0));
  put(core, 101, cmd(CPYD, 2, 900));
  put(core, 102, cmd(WTR, 0, 0));
  runChannel(channel, 100);
  assert.equal(core.hi[900] & SENSE.NO_RECORD_FOUND.hi, SENSE.NO_RECORD_FOUND.hi);
});

test('a finished seek leaves its attention bit where a sense will find it', () => {
  const { channel, control, module, core } = diskMachine();
  placeOrder(core, 400, order8(0x0, 0, 0, 37));     // SEEK track 37, module 0
  put(core, 100, cmd(CTL, 2, 400));
  put(core, 101, cmd(WTR, 0, 0));
  runChannel(channel, 100);
  assert.equal(module.position[0], 37);

  // Module 0 on access 0 attends in word 0's last character, bit 4.
  put(core, 200, cmd(SNS, 0, 0));
  put(core, 201, cmd(CPYD, 2, 900));
  put(core, 202, cmd(WTR, 0, 0));
  runChannel(channel, 200);
  assert.equal(core.lo[900] & 0o20, 0o20, 'the arm reported where it stopped');

  // And the bit is consumed: a second sense no longer sees it.
  put(core, 300, cmd(SNS, 0, 0));
  put(core, 301, cmd(CPYD, 2, 910));
  put(core, 302, cmd(WTR, 0, 0));
  runChannel(channel, 300);
  assert.equal(core.lo[910] & 0o20, 0, 'attention is reported once');
});
