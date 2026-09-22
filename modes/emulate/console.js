/**
 * The operator's console, in a browser tab.
 *
 * Assembles the source in the pane, loads it into core, and runs the machine in
 * slices so the page keeps its thread. A 7094 ran at about 350,000 instructions
 * a second; this paces itself to roughly that, so a program that took a second
 * on the real machine takes a second here. There is a "flat out" control for
 * when that is not the point.
 *
 * Output comes from the on-line printer at unit 0361 on channel A, which is
 * where CTSS and everything before it sent listings.
 */

import { Machine } from './src/machine.js';
import { assembleInto } from './src/assemble.js';
import { octal, octal5 } from './src/word.js';
import { wordToText } from './src/bcd.js';
import { RUN } from './src/cpu.js';

/** Instructions per animation frame at roughly 7094 speed (350 KIPS, 60fps). */
const SLICE = 5800;
const FLAT_OUT = 2000000;

/**
 * The 716 on-line printer. A print record is a line: the first character is
 * carriage control, the rest is the line itself.
 */
class Printer {
  constructor(onLine) {
    this.onLine = onLine;
    this.buffer = '';
    this.channel = null;
    this.atFileMark = false;
  }

  startRecord() { this.buffer = ''; }
  readWord() { return null; }

  writeWord(hi, lo) {
    this.buffer += wordToText(hi, lo);
  }

  endRecord(writing) {
    if (!writing) return;
    this.onLine(this.buffer.replace(/\s+$/, ''));
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

const source = document.getElementById('source');
const listing = document.getElementById('listing');
const statusLine = document.getElementById('status');
const loadButton = document.getElementById('load');
const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const stepButton = document.getElementById('step');
const fastToggle = document.getElementById('fast');

let machine = null;
let frame = null;

function print(line) {
  listing.textContent += `${line}\n`;
  listing.scrollTop = listing.scrollHeight;
}

function buildMachine() {
  const next = new Machine();
  next.channels[0].attach(0o361, new Printer(print));
  return next;
}

function show() {
  if (!machine) return;
  const cpu = machine.cpu;
  set('ac', (cpu.acS ? '-' : '+') + ((cpu.acHi >>> 17) & 3).toString(8)
    + octal(cpu.acHi & 0o377777, cpu.acLo));
  set('mq', ' ' + octal(cpu.mqHi, cpu.mqLo));
  set('si', ' ' + octal(cpu.siHi, cpu.siLo));
  set('ic', octal5(cpu.ic));
  set('xr', [1, 2, 4].map((i) => octal5(cpu.xr[i])).join('  '));
  set('count', cpu.instructions.toLocaleString());

  indicator('overflow', cpu.acOverflow);
  indicator('divide', cpu.divideCheck);
  indicator('io', cpu.ioCheck);
  indicator('bcore', cpu.bcoreInst !== 0);
  indicator('user', cpu.userMode);
  indicator('running', machine.running);
}

function set(id, text) {
  document.getElementById(id).textContent = text;
}

function indicator(id, on) {
  document.getElementById(id).dataset.on = String(Boolean(on));
}

function status(text) {
  statusLine.textContent = text;
}

function load() {
  stop();
  machine = buildMachine();
  listing.textContent = '';
  try {
    const image = assembleInto(machine.core, source.value);
    machine.cpu.ic = image.start;
    status(`loaded ${image.words.size} words, start ${octal5(image.start)}`);
  } catch (error) {
    status(error.message.split('\n')[0]);
    print(error.message);
    machine = null;
  }
  show();
  buttons();
}

function buttons() {
  const loaded = machine !== null;
  startButton.disabled = !loaded || machine.running;
  stopButton.disabled = !loaded || !machine.running;
  stepButton.disabled = !loaded || machine.running;
}

function start() {
  if (!machine) return;
  machine.cpu.run = RUN.RUNNING;
  status('running');
  buttons();
  frame = requestAnimationFrame(tick);
}

function tick() {
  const budget = fastToggle.checked ? FLAT_OUT : SLICE;
  machine.run(budget);
  show();
  if (machine.running) {
    frame = requestAnimationFrame(tick);
  } else {
    frame = null;
    status(machine.cpu.lastError || `halted at ${octal5(machine.cpu.ic)}`);
    buttons();
  }
}

function stop() {
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  if (machine) machine.cpu.run = RUN.STOPPED;
  buttons();
}

function step() {
  if (!machine) return;
  machine.cpu.run = RUN.RUNNING;
  machine.run(1);
  machine.cpu.run = RUN.STOPPED;
  show();
  status(`stopped at ${octal5(machine.cpu.ic)}`);
  buttons();
}

/** The page starts with a program in the pane so there is something to run. */
async function loadDefaultProgram() {
  try {
    const response = await fetch('programs/fibonacci.fap');
    source.value = await response.text();
  } catch {
    // Opened from the file system rather than a server: leave the pane empty
    // and let the operator paste something in.
    status('serve this directory over HTTP to load the sample program');
  }
  load();
}

loadButton.addEventListener('click', load);
startButton.addEventListener('click', start);
stopButton.addEventListener('click', stop);
stepButton.addEventListener('click', step);

loadDefaultProgram();
