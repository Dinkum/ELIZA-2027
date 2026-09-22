/**
 * Booting from disk.
 *
 * A 7094 has no bootstrap of its own for a disk, so the CTSS console deposits
 * a short loader by hand and starts it. These tests check that the loader is
 * deposited the way s709 deposits it, and — when pointed at a real CTSS disk —
 * that running it actually pulls the supervisor off the disk and into the B
 * core, which is as far as this emulator gets today.
 *
 *     CTSS_DISK=/path/to/DISK1.BIN node --test
 *
 * See docs/DESIGN.md for how to build that disk.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import { Machine } from '../src/machine.js';
import { loadFromDisk, BOOT_ENTRY } from '../src/boot.js';
import { FileControl, DiskModule } from '../src/devices/disk.js';
import { loadContainer } from '../src/devices/dasd.js';
import { octal, CORE_SIZE } from '../src/word.js';
import { RUN } from '../src/cpu.js';

function ctssMachine() {
  // Disk on channel C and communications on E, as the CTSS machine had them.
  return new Machine({ channels: 8, types: { 2: '7909', 4: '7909' } });
}

test('the loader is deposited where the console puts it', () => {
  const machine = ctssMachine();
  machine.channels[2].attach(0, new FileControl());
  const entry = loadFromDisk(machine, { channel: 2 });

  assert.equal(entry, BOOT_ENTRY);
  assert.equal(machine.cpu.ic, BOOT_ENTRY, 'the processor starts at 2, not at 0');
  assert.equal(octal(machine.core.hi[0], machine.core.lo[0]), '377777000100');
  assert.equal(octal(machine.core.hi[0o113], machine.core.lo[0o113]), '000000000002');
});

test('the loader is patched for the channel the disk is actually on', () => {
  const machine = ctssMachine();
  machine.channels[2].attach(0, new FileControl());
  loadFromDisk(machine, { channel: 2 });

  // The reset at 0100 names the channel, and the wait at 0102 tests it.
  assert.equal(
    machine.core.lo[0o100] & 0o7000,
    (2 + 1) << 9,
    'the channel reset names channel C',
  );
  assert.notEqual(machine.core.hi[0o101], 0, 'RCH carries the channel in its opcode');
});

test('booting a channel that is not a 7909 is refused', () => {
  const machine = ctssMachine();
  assert.throws(() => loadFromDisk(machine, { channel: 0 }), /not a 7909/);
});

// --- against a real disk ----------------------------------------------------

const REAL = process.env.CTSS_DISK;

test('the loader reads the CTSS supervisor off a real disk into the B core', {
  skip: REAL && existsSync(REAL) ? false : 'set CTSS_DISK to a built DISK1.BIN to run',
}, () => {
  const machine = ctssMachine();
  const control = new FileControl();
  const loaded = loadContainer(readFileSync(REAL), () => new DiskModule(1302), {
    module: 0,
    access: 0,
  });
  control.mount(0, loaded.module);
  machine.channels[2].attach(0, control);

  loadFromDisk(machine, { channel: 2, access: 0, module: 0 });
  machine.clockRunning = true;
  let executed = 0;
  while (executed < 400_000 && machine.cpu.run === RUN.RUNNING) {
    executed += machine.run(1000);
  }

  // The supervisor is read into the second bank of core. Nothing else on the
  // machine writes there, so anything at all in it came off the disk.
  let inB = 0;
  for (let i = CORE_SIZE; i < CORE_SIZE * 2; i++) {
    if (machine.core.hi[i] !== 0 || machine.core.lo[i] !== 0) inB += 1;
  }
  assert.ok(inB > 5000, `expected the supervisor in the B core, found ${inB} words`);
  assert.equal(control.sns[0], 0, 'the file control reported no error');
});
