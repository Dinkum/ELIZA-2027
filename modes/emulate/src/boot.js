/**
 * Initial program load from disk.
 *
 * A 7094 has no bootstrap in it. The operator sets the load-tape or load-drum
 * key and the hardware reads one record into core and jumps to it; for a disk
 * there is no such key, so the CTSS machine's console deposits a small loader
 * by hand and starts it. That loader lives in the CTSS sources as
 * `s.util/cylod.fap`, and what is written here is the same twenty-one words
 * s709's `ld` command deposits, which is how the reconstruction boots.
 *
 * The loader does four things: reset the channel, point it at a command list,
 * wait, and jump to what arrived. The command list at 0120 is a 7909 program —
 * a control order naming the module and track, a read select, a copy, and a
 * trap — so the whole of it exercises the channel and the file control together
 * before a single instruction of CTSS runs.
 *
 * Reference: `boot_7909` in s709's `chan7909.c`.
 */

import { ADDR } from './word.js';

/**
 * The loader, as twelve octal digits a word.
 *
 * Eighteen bits is exactly six octal digits, so the halves this machine carries
 * are the two halves of the printed number — which is why these are written out
 * as strings rather than computed.
 */
const LOADER = {
  0o0000: '377777000100',
  0o0001: '006000000001',
  0o0002: '007400400100',

  0o0100: '076000000350',   // reset the channel; the channel number is ORed in
  0o0101: '000000000120',   // RCH, pointing at the command list; opcode ORed in
  0o0102: '006000000102',   // wait here; the channel number is ORed in
  0o0103: '476100000042',
  0o0104: '450000000000',
  0o0105: '036100477777',
  0o0106: '200001400105',
  0o0107: '476100000041',
  0o0110: '032200000131',
  0o0111: '450100000046',
  0o0112: '010000000132',
  0o0113: '000000000002',
  0o0114: '101200001212',   // the order: access and module are ORed in
  0o0115: '121212121212',
  0o0116: '100500001212',   // and again for the second order
  0o0117: '121267671212',
  0o0120: '700000000004',   // the channel command list starts here
  0o0121: '200000000114',
  0o0122: '500000200122',
  0o0123: '200000200116',
  0o0124: '400007000125',
};

/** Where the loader starts. Not zero: 0 and 1 are set up for it. */
export const BOOT_ENTRY = 0o2;

/**
 * RCH for a channel, as a whole word. On a 7909 this instruction is a reset
 * and start rather than a load, which is why the loader needs nothing else to
 * get the channel going. Channels alternate between the positive and negative
 * opcode groups, which is where the sign bit in the odd entries comes from.
 */
function resetAndStart(channel) {
  const pair = channel >> 1;
  const hi = (channel & 1 ? 0o454000 : 0o054000) + pair * 0o100;
  return { hi, lo: 0 };
}

/** Split twelve octal digits into the two halves the machine carries. */
function split(digits) {
  return {
    hi: parseInt(digits.slice(0, 6), 8),
    lo: parseInt(digits.slice(6), 8),
  };
}

/**
 * Deposit the loader and point the processor at it.
 *
 * `channel` is the index of the 7909 the disk is on — channel C on the CTSS
 * machine — and `access` and `module` say which arm of which module holds the
 * system. Returns the address the processor should start at.
 */
export function loadFromDisk(machine, { channel = 2, access = 0, module = 0 } = {}) {
  const core = machine.core;
  const target = machine.channels[channel];
  if (!target || !target.is7909) {
    throw new Error(`channel ${String.fromCharCode(65 + channel)} is not a 7909`);
  }

  machine.reset();
  for (const [at, digits] of Object.entries(LOADER)) {
    const { hi, lo } = split(digits);
    core.hi[Number(at)] = hi;
    core.lo[Number(at)] = lo;
  }

  // The loader is written for channel A and patched for the one in use.
  core.lo[0o0100] |= ((channel + 1) << 9) & 0o777777;

  const rch = resetAndStart(channel);
  core.hi[0o0101] |= rch.hi;
  core.lo[0o0101] |= rch.lo;

  // The wait loop tests the channel it is actually waiting on. The channel
  // number goes in at bit 24 of the word, which is bit 6 of the high half —
  // one place lower than it looks, because the high half starts at bit 18.
  // A channel out by one here leaves the processor waiting on a channel that
  // is not doing anything, so it never waits at all.
  core.hi[0o0102] |= (channel << 6) & 0o777777;

  // The access and module go into the two orders, at bit 18 and bit 12 — the
  // first of those is the bottom of the high half, the second the top of the
  // low half.
  const accessBits = access & 0o7;
  const moduleBits = module & 0o17;
  for (const at of [0o0114, 0o0116]) {
    core.hi[at] |= accessBits;
    core.lo[at] |= (moduleBits << 12) & 0o777777;
  }

  machine.start(BOOT_ENTRY);
  return BOOT_ENTRY;
}

/**
 * Initial program load from tape.
 *
 * The load-tape key deposits five words at 01000: read-select the unit, reset
 * the channel into a one-command list, wait for it with LCH, and jump to
 * location 1 — the second word of whatever the first record brought in. Tape
 * boot records are self-loading from there; these are the same five words
 * s709's `lt` console command deposits. The unit code is the one RDS spells
 * it with: channel number over tape type over unit, so A1 is 01221.
 */
export function loadFromTape(machine, { channel = 0, unit = 1 } = {}) {
  const core = machine.core;
  machine.reset();
  const cunit = ((channel + 1) << 9) | 0o220 | unit;
  const rch = resetAndStart(channel);
  const words = [
    [0o0762 << 6, cunit],            // RDS cunit
    [rch.hi, 0o1004 | rch.lo],       // RCHx *+3
    [rch.hi + 0o400, 0],             // LCHx 0
    [0o0021 << 6, 1],                // TTR 1
    [0o500003, 0],                   // IOCT 0,,3 — the command list
  ];
  for (const [i, [hi, lo]] of words.entries()) {
    core.hi[0o1000 + i] = hi;
    core.lo[0o1000 + i] = lo;
  }
  machine.start(0o1000);
  return 0o1000;
}

/**
 * Run a loaded machine for a while and say what stopped it.
 *
 * A boot that works does not stop at all: CTSS runs until somebody halts it.
 * So the interesting answer is almost always why it stopped early, and this
 * returns enough to tell the difference between a halt, a trap loop and a
 * machine still going when the budget ran out.
 */
export function runBoot(machine, { instructions = 5_000_000, sample = 50_000 } = {}) {
  const cpu = machine.cpu;
  machine.clockRunning = true;
  let executed = 0;
  const visited = new Map();

  while (executed < instructions && machine.running) {
    const before = cpu.ic;
    executed += machine.run(Math.min(sample, instructions - executed));
    // Record where it spends its time, so a tight loop is visible afterwards.
    visited.set(before, (visited.get(before) ?? 0) + 1);
  }

  const hot = [...visited.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return {
    executed,
    halted: !machine.running,
    ic: cpu.ic,
    ioCheck: cpu.ioCheck,
    hot: hot.map(([at, n]) => ({ at: (at & ADDR).toString(8), n })),
  };
}
