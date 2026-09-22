/**
 * Boot CTSS on the emulated 7094.
 *
 *     node modes/emulate/ctss.mjs path/to/dasd-dir [instructions] [trace-ic] [cmd.cbn]
 *
 * Wires up the machine the way the CTSS one was built, mirroring the device
 * list s709's runctss mounts:
 *
 *     channel A   clock on 0207, reader 0321, punch 0341, printer 0361,
 *                 tapes A3 and A9
 *     channel C   7909 file control — DISK1 modules 0-1, DRUM1 module 2,
 *                 DISK2 modules 4-5
 *     channel E   7909 7750 communications controller, 32 lines
 *     channel G   7289 drums — DRUM2 physical 0, DRUM3 physical 1
 *
 * deposits the disk loader, and lets the supervisor run. What it prints is
 * the operator's log: the on-line printer, plus anything line 31 is told to
 * type.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Machine } from './src/machine.js';
import { loadFromDisk, loadFromTape } from './src/boot.js';
import { FileControl, DiskModule } from './src/devices/disk.js';
import { loadContainer, readGeometry, storeContainer } from './src/devices/dasd.js';
import { LinePrinter } from './src/devices/printer.js';
import { CardReader, CardPunch } from './src/devices/reader.js';
import { ChronologClock } from './src/devices/chrono.js';
import { TapeUnit } from './src/devices/tape.js';
import { DrumChannel, DrumControl } from './src/devices/drum.js';
import { CommunicationsController, CONSOLE_LINE } from './src/devices/comm.js';
import { octal, octal5, CORE_SIZE, HALF } from './src/word.js';

const DASD = process.argv[2];
const BUDGET = Number(process.argv[3] || 20_000_000);
const TRACE_AT = process.argv[4] ? parseInt(process.argv[4], 8) : -1;
const CMD = process.argv[5];
// The console sense switches, spelled the way s709's run command files do:
// `sw1` flips switch one, `ssw=020` sets the whole six-bit mask. runctss.cmd
// boots CTSS with `sw2`, which the supervisor reads with SWT2 to keep the
// daemon user from logging itself in.
let ssw = 0;
const tapeArgs = new Map();
for (const arg of process.argv.slice(6)) {
  if (/^sw[1-6]$/.test(arg)) ssw ^= 0o40 >>> (Number(arg[2]) - 1);
  else if (arg.startsWith('ssw=')) ssw = parseInt(arg.slice(4), 8);
  else if (/^[ab][1-9][rws]?=/.test(arg)) tapeArgs.set(arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1));
  else if (arg.startsWith('er=')) tapeArgs.set('er', arg.slice(3));
  else if (arg === 'tape') tapeArgs.set('boot', 'tape');
}
if (!DASD) {
  console.error('usage: node modes/emulate/ctss.mjs dasd-dir|DISK1.BIN [instructions] [trace-from-octal-ic] [cmd.cbn] [swN|ssw=mask]');
  process.exit(1);
}
const dir = basename(DASD).includes('.') ? dirname(DASD) : DASD;

const machine = new Machine({ channels: 8, types: { 2: '7909', 4: '7909' } });
const cpu = machine.cpu;

/**
 * Mount a container's modules at consecutive module numbers. The container's
 * own geometry says how many modules and accesses it holds; each module is
 * one `DiskModule` with every access arm loaded into it.
 */
const mountedImages = [];
function mountContainer(control, file, base, type) {
  const bytes = readFileSync(file);
  const geometry = readGeometry(bytes);
  let loaded = 0;
  const modules = [];
  for (let m = 0; m < geometry.modules; m++) {
    const module = new DiskModule(type);
    for (let a = 0; a < geometry.accesses; a++) {
      loaded += loadContainer(bytes, () => module, { module: m, access: a }).tracksLoaded;
    }
    control.mount(base + m, module);
    modules.push(module);
  }
  mountedImages.push({ file, bytes, geometry, modules, base });
  console.log(`${geometry.cylinders}c/${geometry.heads}h/${geometry.accesses}a/${geometry.modules}m -> modules ${base}-${base + geometry.modules - 1}: ${loaded} tracks`);
}

// --- Channel C: the 7631 file control -------------------------------------
const control = new FileControl();
mountContainer(control, join(dir, 'DISK1.BIN'), 0, 1302);
mountContainer(control, join(dir, 'DRUM1.BIN'), 2, 7320);
mountContainer(control, join(dir, 'DISK2.BIN'), 4, 1302);
machine.channels[2].attach(0, control);

// --- Channel G: the two 7289 drums -----------------------------------------
const drums = new DrumControl();
drums.mount(0, readFileSync(join(dir, 'DRUM2.BIN')));
drums.mount(1, readFileSync(join(dir, 'DRUM3.BIN')));
const drumChannel = new DrumChannel(6, drums);
drumChannel.connect(machine.core);
machine.channels[6] = drumChannel;

// --- Channel A: the slow devices --------------------------------------------
const channelA = machine.channels[0];
const chrono = new ChronologClock({ machine });
chrono.core = machine.core;
channelA.attach(0o207, chrono);
channelA.attach(0o321, new CardReader(CMD ? readFileSync(CMD) : null));
channelA.attach(0o341, new CardPunch());
channelA.attach(0o361, new LinePrinter({ onPrint: (t) => console.log(`[printer] ${t}`) }));
for (const [name, unit] of [['A3', 3], ['A9', 9]]) {
  const tape = new TapeUnit(name);
  tape.mountBlank();
  channelA.attach(0o200 + unit, tape);   // BCD
  channelA.attach(0o220 + unit, tape);   // binary
}

// Extra tape assignments, spelled like s709's command line: `a1r=file`
// mounts read-only, `b2r=`/`b3=` put a tape on channel B. The utility
// tapes the CTSS kit boots — extract, setup, salvager — all work this way.
const outputTapes = [];
for (const [key, file] of tapeArgs) {
  if (key === 'boot') continue;
  const channel = key[0] === 'a' ? machine.channels[0] : machine.channels[1];
  const unit = Number(key[1]);
  const tape = new TapeUnit(key.toUpperCase());
  const writable = key[2] !== 'r';
  if (existsSync(file)) tape.mount(readFileSync(file), { writable });
  else { tape.mountBlank(); outputTapes.push([tape, file]); }
  channel.attach(0o200 + unit, tape);
  channel.attach(0o220 + unit, tape);
}

// --- Channel E: the 7750 -----------------------------------------------------
const comm = new CommunicationsController();
machine.channels[4].attach(0, comm);
comm.lines[CONSOLE_LINE].onPrint = (t) => console.log(`[tty] ${JSON.stringify(t)}`);

// Watchdogs: report halts and every trap taken.
let halts = 0;
cpu.onHalt = (c) => console.log(`[halt] ic=${octal5(c.ic)} resume=${octal5(c.progStopResume)} lastError=${c.lastError} machineCheck=${c.machineCheck}`);
const realSettrap = cpu.settrap.bind(cpu);
const traps = new Map();
cpu.settrap = (v, ret, dec) => {
  traps.set(v, (traps.get(v) ?? 0) + 1);
  return realSettrap(v, ret, dec);
};

// Disassembler-free trace: show the raw instruction words once we reach the zone.
let tracing = false;

const tapeBoot = tapeArgs.get('boot') === 'tape';
if (tapeBoot) {
  loadFromTape(machine, { channel: 0, unit: 1 });
  // `ea 236362626060` — the utility programs check the AC for 'CTSS  '.
  cpu.acHi = 0o236362; cpu.acLo = 0o626060;
} else {
  loadFromDisk(machine, { channel: 2, access: 0, module: 0 });
}
machine.clockRunning = true;
cpu.ssw = ssw;

let executed = 0;
const hot = new Map();
while (executed < BUDGET) {
  // The operator: a stopped machine is restarted, the way s709's console
  // resumes on an Enter. CTSS stops for the operator during its own
  // initialisation and expects to be brought back.
  if (!machine.running) {
    if (cpu.machineCheck || cpu.lastError || ++halts > 50) break;
    console.log(`[start] resume=${octal5(cpu.progStop ? cpu.progStopResume : cpu.ic)}`);
    if (tapeBoot && halts === 1) {
      // `er 002000000100`: the tape loader halts when it reaches the mark,
      // and the operator transfers into the program it just read in. The
      // entry differs per utility — the salvager wants 0445 — so an
      // `er=octal` argument overrides it.
      const entry = tapeArgs.has('er') ? parseInt(tapeArgs.get('er'), 8) : 0o100;
      console.log(`[er] TRA ${octal5(entry)}`);
      machine.start(entry);
      continue;
    }
    machine.start();
    continue;
  }
  const before = cpu.ic;
  executed += machine.run(100_000);
  hot.set(before, (hot.get(before) ?? 0) + 1);
  if (TRACE_AT >= 0 && !tracing && before >= TRACE_AT) tracing = true;
  if (tracing) {
    const hi = machine.core.hi[before & 0o77777];
    const lo = machine.core.lo[before & 0o77777];
    console.log(`${octal5(before)}: ${octal(hi, lo)}`);
    if (hot.get(before) > 3) { console.log('(trace cut: repeated)'); tracing = false; }
  }
}

console.log(`executed ${executed}, running=${machine.running}, ic=${octal5(cpu.ic)}`);
console.log(`ioCheck=${cpu.ioCheck} userMode=${cpu.userMode} lastError=${cpu.lastError}`);
console.log(`disk sense=${octal(control.sense, 0)}`);
console.log('traps:', [...traps.entries()].map(([v, n]) => `${octal5(v)} x${n}`).join('  '));
const top = [...hot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log('hot spots:', top.map(([a, n]) => `${octal5(a)} x${n}`).join('  '));
let inB = 0;
for (let i = CORE_SIZE; i < CORE_SIZE * 2; i++) if (machine.core.hi[i] || machine.core.lo[i]) inB++;
console.log(`B core words nonzero: ${inB}`);
for (const [tape, file] of outputTapes) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(tape.toTap()));
  console.log(`${tape.name} -> ${file} (${tape.records.length} records)`);
}
// Whatever the machine wrote on its disks goes back into the container
// images it was loaded from.
for (const image of mountedImages) {
  let tracks = 0;
  for (let m = 0; m < image.modules.length; m++) {
    for (let a = 0; a < image.geometry.accesses; a++) {
      tracks += storeContainer(image.bytes, image.modules[m], { module: m, access: a });
    }
  }
  writeFileSync(image.file, image.bytes);
  console.log(`${basename(image.file)} <- ${tracks} tracks`);
}
