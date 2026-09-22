/**
 * The 7094, off the page's main thread.
 *
 * Mode 3 used to mean a Node server beside the page: the disk containers were
 * 465 MB and the machine was a Node program, so the browser only ever held the
 * 7750 line. The packed image changed that — the whole DASD tree rides to the
 * page as one ~10 MB fetch, `unpackPacked` rebuilds the modules lazily (a
 * track's words appear when the 7631 first seeks it, ~150 MB resident instead
 * of ~640), and the machine itself is plain ES modules with no `node:` imports.
 * So the machine now runs here, in a Worker, and the page keeps only the line.
 *
 * The wire to `app/live.js` is the same shape the SSE bridge had: events stream
 * in one direction (`print`, `state`, `progress`), a `send` posts the other.
 * The machine is paced at its own clock the way `CtssTerminal` paced it —
 * instructions in chunks, the worker's event loop yielded between them — so
 * the page stays responsive while CTSS runs.
 *
 *   new Worker('modes/emulate/worker.js', { type: 'module' })
 *   <- { type: 'ready' }                        the worker loaded and is listening
 *   <- { type: 'progress', stage: 'fetch', received, total }
 *   <- { type: 'progress', stage: 'unpack', containers }
 *   <- { type: 'state', state: 'booting'|'ready'|'stopped', instructions }
 *   <- { type: 'print', text }
 *   <- { type: 'error', message }
 *   -> { type: 'send', text }
 *   -> { type: 'boot', pack, cmd }   (transferable ArrayBuffers)
 *   -> { type: 'stop' }
 *
 * `ready` is posted the moment this module finishes evaluating, before any
 * `boot` arrives: it is the answer `LiveLine.connect()` waits on, so the page
 * can tell "the worker is there" from "the worker never spoke" without the
 * boot having to come first.
 */

import { Machine } from './src/machine.js';
import { loadFromDisk } from './src/boot.js';
import { FileControl } from './src/devices/disk.js';
import { LinePrinter } from './src/devices/printer.js';
import { CardReader, CardPunch } from './src/devices/reader.js';
import { ChronologClock } from './src/devices/chrono.js';
import { TapeUnit } from './src/devices/tape.js';
import { DrumChannel, DrumControl } from './src/devices/drum.js';
import { CommunicationsController, CONSOLE_LINE } from './src/devices/comm.js';
import { unpackPacked } from './unpack.js';

/** Instructions a second, matching the bridge's pace. */
const INSTRUCTIONS_PER_SECOND = 2_000_000;
/** Instructions per slice of machine time between event-loop yields. */
const CHUNK = 20000;
/** Console output kept for a page that connects late. */
const BACKLOG = 1024;

const post = (message) => self.postMessage(message);

// The yield between chunks. A `setTimeout(0)` is the obvious shape, but a
// hidden tab clamps timers to ~1 s, and a visitor who switches away mid-boot
// would watch the machine crawl at one chunk a second. A MessageChannel
// round trip is a macrotask the clamping does not reach, so the machine
// keeps its own pace whether the page is watched or not.
const yieldChannel = new MessageChannel();
const yieldNow = () => new Promise((resolve) => {
  yieldChannel.port1.onmessage = () => resolve();
  yieldChannel.port2.postMessage(null);
});

// The handshake: the page's `connect()` resolves on the first thing the
// worker says, and until `boot` arrives there is nothing else to say — so
// say this now, or connect and boot each wait on the other forever.
post({ type: 'ready' });

let machine = null;
let comm = null;
let stopped = false;
let started = false;
let startedAt = 0;
let executed = 0;
let dialed = false;
let backlog = '';

function status() {
  const line = comm?.lines?.[CONSOLE_LINE];
  return {
    state: stopped ? 'stopped' : dialed ? 'ready' : 'booting',
    instructions: executed,
    running: machine?.running ?? false,
    ic: machine?.cpu?.ic,
    input: line?.input?.length ?? 0,
    pending: line?.inputPending ?? false,
    notReturned: line?.notReturned ?? 0,
  };
}

function emitState() {
  post({ type: 'state', ...status() });
}

function consolePrint(text) {
  backlog = (backlog + text).slice(-BACKLOG);
  post({ type: 'print', text });
  if (/HANGUP/.test(text)) {
    stopped = true;
    post({ type: 'hangup' });
  }
}

function dial() {
  comm.dialUp(CONSOLE_LINE, { ksr35: true });
  emitState();
}

/**
 * Mount the packed containers the way `CtssTerminal.#mount` mounts the .BIN
 * tree: DISK1 at file-control base 0, DRUM1 at 2, DISK2 at 4, the two 7289
 * drums on channel G, and the rest of channel A's unit table.
 */
function mount(packBytes, cmdBytes) {
  const { containers } = unpackPacked(new Uint8Array(packBytes), { lazy: true });

  machine = new Machine({ channels: 8, types: { 2: '7909', 4: '7909' } });
  const control = new FileControl();
  for (const [name, base] of [['DISK1', 0], ['DRUM1', 2], ['DISK2', 4]]) {
    for (const [m, mod] of containers.get(name).modules) control.mount(base + m, mod);
  }
  machine.channels[2].attach(0, control);

  const drums = new DrumControl();
  drums.mount(0, containers.get('DRUM2').bytes);
  drums.mount(1, containers.get('DRUM3').bytes);
  const drumChannel = new DrumChannel(6, drums);
  drumChannel.connect(machine.core);
  machine.channels[6] = drumChannel;

  const channelA = machine.channels[0];
  const chrono = new ChronologClock({ machine });
  chrono.core = machine.core;
  channelA.attach(0o207, chrono);
  channelA.attach(0o321, new CardReader(cmdBytes ? new Uint8Array(cmdBytes) : null));
  channelA.attach(0o341, new CardPunch());
  channelA.attach(0o361, new LinePrinter({ onPrint: (t) => post({ type: 'printer', text: t }) }));
  for (const unit of [3, 9]) {
    const tape = new TapeUnit(`A${unit}`);
    tape.mountBlank();
    channelA.attach(0o200 + unit, tape);
    channelA.attach(0o220 + unit, tape);
  }

  comm = new CommunicationsController();
  machine.channels[4].attach(0, comm);
  comm.lines[CONSOLE_LINE].onPrint = consolePrint;
}

function boot() {
  loadFromDisk(machine, { channel: 2, access: 0, module: 0 });
  machine.clockRunning = true;
  machine.cpu.ssw = 0o20;
}

/** Run until `stop()`. Yields between chunks so `send` messages get a turn. */
async function run() {
  started = true;
  startedAt = Date.now();
  emitState();
  const paced = INSTRUCTIONS_PER_SECOND > 0;
  while (!stopped) {
    if (!machine.running) machine.start();
    executed += machine.run(CHUNK);
    if (!dialed && comm.enabled) {
      dialed = true;
      dial();
    }
    if (paced) {
      const due = (executed / INSTRUCTIONS_PER_SECOND) * 1000;
      // The pacing wait has the same clamping exposure as the yield: a
      // hidden tab would stretch each 100 ms slice to a second. Sleeping in
      // 100 ms pieces through the unclamped channel keeps the pace honest.
      while (due - (Date.now() - startedAt) > 100) {
        await yieldNow();
        if (stopped) return;
      }
      const left = due - (Date.now() - startedAt);
      if (left > 0) await new Promise((done) => setTimeout(done, left));
    }
    await yieldNow();
  }
}

self.onmessage = async (event) => {
  const message = event.data ?? {};

  if (message.type === 'send') {
    if (!comm?.enabled) return;
    comm.typeLine(CONSOLE_LINE, String(message.text ?? ''));
    return;
  }

  if (message.type === 'stop') {
    stopped = true;
    emitState();
    return;
  }

  if (message.type === 'boot') {
    try {
      post({ type: 'progress', stage: 'unpack' });
      mount(message.pack, message.cmd);
      post({ type: 'progress', stage: 'mounted' });
      boot();
      post({ type: 'progress', stage: 'boot' });
      if (backlog) post({ type: 'print', text: backlog });
      await run();
    } catch (error) {
      post({ type: 'error', message: error?.message ?? String(error) });
    }
    return;
  }
};

// A fault the handler could not catch still reaches the page as an error,
// not as silence.
self.onerror = (event) => {
  post({ type: 'error', message: event?.message ?? 'the machine stopped' });
};
