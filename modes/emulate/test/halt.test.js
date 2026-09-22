/**
 * The halt instructions.
 *
 * A halted processor is not a stopped machine. With the trap enable mask
 * armed, HTR leaves the channels and the interval timer running and the
 * first trap to arrive restarts execution — which is how the CTSS
 * supervisor waits for I/O. Only with nothing armed, or nothing left in
 * flight that could interrupt, does the machine stop for the operator;
 * and a console start then transfers to the address the HTR names.
 * HPR is different: always a stop, resuming at the next instruction.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Machine } from '../src/machine.js';
import { assembleInto } from '../src/assemble.js';
import { ADDR } from '../src/word.js';
import { word } from './machine.js';

const STEP_LIMIT = 100000;

/** Assemble into a machine's core and start the processor. */
function build(source, options = {}) {
  const machine = new Machine(options);
  const image = assembleInto(machine.core, source);
  machine.start(image.start);
  return machine;
}

test('HTR with no traps armed stops the machine', () => {
  const machine = build(`
         ORG   100
         CLA   ONE
         STO   OUT
         HTR   0
  ONE    OCT   000000000001
  OUT    OCT   000000000000
  `);
  machine.run(STEP_LIMIT);
  assert.equal(machine.running, false);
  assert.equal(machine.cpu.progStop, true);
  assert.equal(word(machine.core, 0o150), '000000000001');
});

test('a console start transfers to the address the HTR names', () => {
  const machine = build(`
         ORG   100
         HTR   RESUME
         HTR   0
  RESUME CLA   TWO
         STO   OUT
         HTR   0
  TWO    OCT   000000000002
  OUT    OCT   000000000000
  `);
  machine.run(STEP_LIMIT);
  assert.equal(machine.running, false);
  // The processor sits on the HTR, holding its transfer address for a start.
  machine.start();
  machine.run(STEP_LIMIT);
  assert.equal(word(machine.core, 0o152), '000000000002');
});

test('a channel trap restarts a halted processor', () => {
  const machine = build(`
         ORG   100
         RDS   641
         ENB   MASK
         HTR   0
         HTR   0
  WOKEN  CLA   FIVE
         STO   OUT
         HTR   0
  MASK   OCT   000000000001
  FIVE   OCT   000000000005
  OUT    OCT   000000000000
         ORG   11
         TRA   WOKEN
  `, { channels: 4 });

  // A device that selects cleanly and immediately finishes a record, which
  // is what raises the channel trap the halted processor is waiting for.
  machine.channels[0].attach(0o201, {
    channel: null,
    startRecord() { this.channel.trapPending = true; },
    readWord() { return null; },
    endRecord() {},
    atFileMark: false,
    atLoadPoint: false,
  });

  machine.run(STEP_LIMIT);

  // The trap vector stored where the processor halted: back on the HTR, so
  // returning from the handler re-enters the wait.
  assert.equal(machine.core.lo[0o12] & ADDR, 0o146);

  // The trap was taken: ENB armed channel A, the handler at 13 ran, and the
  // taken trap disarmed the mask, so the HTR that follows stops the machine.
  assert.equal(word(machine.core, 0o155), '000000000005');
  assert.equal(machine.running, false);
});

test('HTR with traps armed but nothing in flight stops the machine', () => {
  const machine = build(`
         ORG   100
         ENB   MASK
         HTR   0
  MASK   OCT   000000000001
  `, { channels: 4 });
  machine.run(STEP_LIMIT);
  assert.equal(machine.running, false);
  assert.equal(machine.cpu.progStop, true);
});

test('HPR stops and a start resumes at the next instruction', () => {
  const machine = build(`
         ORG   100
         CLA   THREE
         HPR   0
         STO   OUT
         HTR   0
  THREE  OCT   000000000003
  OUT    OCT   000000000000
  `);
  machine.run(STEP_LIMIT);
  assert.equal(machine.running, false);
  assert.equal(word(machine.core, 0o151), '000000000000');
  machine.start();
  machine.run(STEP_LIMIT);
  assert.equal(word(machine.core, 0o151), '000000000003');
});

test('the interval timer restarts a halted processor', () => {
  const machine = build(`
         ORG   100
         RDS   641
         RCHA  CMD
         ENB   MASK
         HTR   0
         HTR   0
  TICKED CLA   SEVEN
         STO   OUT
         HTR   0
  MASK   OCT   000000000001
  SEVEN  OCT   000000000007
  OUT    OCT   000000000000
  CMD    IOCP  BUF,0,30000
  BUF    OCT   0
         ORG   7
         TRA   TICKED
  `, { channels: 4 });

  // Keep the channel in operation: a bare selection does not count — only a
  // running command list does — so the device feeds a read that never ends.
  // The clock trap is what wakes the processor, not a channel.
  machine.channels[0].attach(0o201, {
    channel: null,
    startRecord() {},
    readWord() { return [0, 0]; },
    endRecord() {},
    atFileMark: false,
    atLoadPoint: false,
  });
  machine.clockRunning = true;
  // Location 5 is the interval timer: counted up to zero for a trap. Make
  // the next tick carry it over.
  machine.core.lo[0o5] = ADDR;
  machine.cyclesToTick = 10;

  machine.run(STEP_LIMIT);
  assert.equal(word(machine.core, 0o155), '000000000007');
  assert.equal(machine.running, false);
});
