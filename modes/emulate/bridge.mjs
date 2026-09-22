/**
 * The 7750 console line of a live CTSS, offered to the paper in the 1052.
 *
 * The 1050 page cannot hold a 7094: the disk containers are 465 MB and the
 * machine is a Node program. So the machine stays here, in the page's server,
 * and only the *line* crosses to the browser — the same thing the 7750 did in
 * 1965, with an SSE stream and a POST in place of the coax pair.
 *
 *   node modes/emulate/serve.mjs         # page + machine on one port
 *
 * `CtssTerminal` boots exactly one Machine() from the frozen dasd tree, dials
 * line 0, and turns the supervisor's console output into events. `bridgeServer`
 * is the HTTP half and is kept free of the emulator so it can be tested with a
 * stand-in terminal.
 *
 * Nothing is written back: the frozen tree is read-only here, and the operator's
 * session lives in the machine's core until the server stops.
 */

import { readFileSync } from 'node:fs';
import { join, normalize, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile as readFileAsync, stat as statAsync } from 'node:fs/promises';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';

import { Machine } from './src/machine.js';
import { loadFromDisk } from './src/boot.js';
import { FileControl, DiskModule } from './src/devices/disk.js';
import { loadContainer, readGeometry } from './src/devices/dasd.js';
import { LinePrinter } from './src/devices/printer.js';
import { CardReader, CardPunch } from './src/devices/reader.js';
import { ChronologClock } from './src/devices/chrono.js';
import { TapeUnit } from './src/devices/tape.js';
import { DrumChannel, DrumControl } from './src/devices/drum.js';
import { CommunicationsController, CONSOLE_LINE } from './src/devices/comm.js';

/** The frozen tree the 1050's mode 3 boots. Override with MODE3_DASD. */
export const DASD_DIR = process.env.MODE3_DASD ?? 'tmp/mode3-dasd';

/**
 * Instructions a second, default. A 7094 ran at about 350,000 and CTSS's own
 * clock is driven by the machine's time, so a machine run flat out hands an idle
 * terminal its "maximum inactive time" in seconds rather than minutes — the
 * line drops while the operator is still reading. A few times the real speed
 * keeps a session alive long enough to type at and still boots CTSS in about
 * two seconds. MODE3_IPS=0 runs flat out.
 */
export const INSTRUCTIONS_PER_SECOND = Number(process.env.MODE3_IPS ?? 2_000_000);

/** The card reader image CTSS expects at boot, as `ctss.mjs` mounts it. */
const CMD_CBN = process.env.MODE3_CMD ?? 'tmp/run/cmd.cbn';

/**
 * One 7094, one CTSS, one dialed line.
 *
 * Instructions are run in chunks and the event loop is yielded between them, so
 * the HTTP server answers while the machine runs. Everything the page sends is
 * typed while the machine is between chunks, which is the only moment a line
 * can be fed: `comm.typeLine` is synchronous and the machine is single-minded.
 */
export class CtssTerminal extends EventEmitter {
  /** Instructions of console output kept for a page that connects late. */
  static BACKLOG = 1024;

  /**
   * @param {object} [options]
   * @param {string} [options.dir]  dasd tree to mount
   * @param {number} [options.chunk]  instructions per slice of machine time
   * @param {string} [options.cmd]  card reader image
   */
  constructor({ dir = DASD_DIR, chunk = 20000, cmd = CMD_CBN, speed = INSTRUCTIONS_PER_SECOND } = {}) {
    super();
    this.dir = dir;
    this.chunk = chunk;
    this.cmd = cmd;
    this.speed = speed;
    this.executed = 0;
    this.dialed = false;
    this.started = false;
    this.stopped = false;
    this.backlog = '';
    this.#mount();
    this.#boot();
  }

  /** What the page needs to know to describe the machine. */
  status() {
    const line = this.comm?.lines?.[CONSOLE_LINE];
    return {
      state: this.stopped ? 'stopped' : this.dialed ? 'ready' : 'booting',
      instructions: this.executed,
      dir: this.dir,
      speed: this.speed,
      running: this.machine?.running ?? false,
      ic: this.machine?.cpu?.ic,
      input: line?.input?.length ?? 0,
      pending: line?.inputPending ?? false,
      notReturned: line?.notReturned ?? 0,
    };
  }

  /**
   * Type one line into line 0, the way the operator's keyboard would.
   * Returns false if the line is not up yet.
   */
  send(text) {
    if (!this.comm.enabled) return false;
    this.comm.typeLine(CONSOLE_LINE, String(text ?? ''));
    return true;
  }

  /** Run until `stop()`. Yields between chunks so HTTP requests get a turn. */
  async run() {
    this.started = true;
    this.startedAt = Date.now();
    this.#emitState();
    const paced = this.speed > 0;
    while (!this.stopped) {
      if (!this.machine.running) this.machine.start();
      this.executed += this.machine.run(this.chunk);
      if (!this.dialed && this.comm.enabled) {
        // The operator's hand on the phone: CTSS answers a line only once its
        // communications task is up.
        this.dialed = true;
        this.dial();
      }
      if (paced) {
        // Hold the machine to its speed rather than to the host's: everything
        // about a session's timing — the interval timer, the clock, CTSS's own
        // patience with an idle terminal — is measured in the machine's time.
        const due = (this.executed / this.speed) * 1000;
        const spent = Date.now() - this.startedAt;
        if (due > spent) await new Promise((done) => setTimeout(done, Math.min(due - spent, 100)));
      }
      await new Promise((done) => setImmediate(done));
    }
  }

  /** Pick the phone up. */
  dial() {
    this.comm.dialUp(CONSOLE_LINE, { ksr35: true });
    this.#emitState();
  }

  stop() {
    this.stopped = true;
    this.emit('state', this.status());
  }

  // --- pieces ---------------------------------------------------------------

  #mount() {
    const machine = new Machine({ channels: 8, types: { 2: '7909', 4: '7909' } });
    const control = new FileControl();
    this.#mountContainer(control, machine, 'DISK1', 0, 1302);
    this.#mountContainer(control, machine, 'DRUM1', 2, 7320);
    this.#mountContainer(control, machine, 'DISK2', 4, 1302);
    machine.channels[2].attach(0, control);

    const drums = new DrumControl();
    drums.mount(0, readFileSync(join(this.dir, 'DRUM2.BIN')));
    drums.mount(1, readFileSync(join(this.dir, 'DRUM3.BIN')));
    const drumChannel = new DrumChannel(6, drums);
    drumChannel.connect(machine.core);
    machine.channels[6] = drumChannel;

    const channelA = machine.channels[0];
    const chrono = new ChronologClock({ machine });
    chrono.core = machine.core;
    channelA.attach(0o207, chrono);
    channelA.attach(0o321, new CardReader(readFileSync(this.cmd)));
    channelA.attach(0o341, new CardPunch());
    // The on-line printer is where CTSS logs its business — operator messages,
    // logins, error detail. The paper does not show it, but it belongs to the
    // machine and the server's own log is a fair place for it.
    channelA.attach(0o361, new LinePrinter({ onPrint: (t) => this.emit('printer', t) }));
    for (const unit of [3, 9]) {
      const tape = new TapeUnit(`A${unit}`);
      tape.mountBlank();
      channelA.attach(0o200 + unit, tape);
      channelA.attach(0o220 + unit, tape);
    }

    const comm = new CommunicationsController();
    machine.channels[4].attach(0, comm);
    comm.lines[CONSOLE_LINE].onPrint = (text) => this.#console(text);

    this.machine = machine;
    this.comm = comm;
  }

  #mountContainer(control, machine, name, base, type) {
    const bytes = readFileSync(join(this.dir, `${name}.BIN`));
    const geometry = readGeometry(bytes);
    for (let m = 0; m < geometry.modules; m++) {
      const module = new DiskModule(type);
      for (let a = 0; a < geometry.accesses; a++) loadContainer(bytes, () => module, { module: m, access: a });
      control.mount(base + m, module);
    }
  }

  #boot() {
    const cpu = this.machine.cpu;
    loadFromDisk(this.machine, { channel: 2, access: 0, module: 0 });
    this.machine.clockRunning = true;
    cpu.ssw = 0o20;   // switch two, as runctss.cmd sets it
  }

  #console(text) {
    this.backlog = (this.backlog + text).slice(-CtssTerminal.BACKLOG);
    this.emit('print', text);
    if (/HANGUP/.test(text)) this.stop();
  }

  #emitState() {
    this.emit('state', this.status());
  }
}

/** Content types for the page's own files. Anything else is text. */
const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}));

/**
 * The page and the machine on one port.
 *
 *   GET  /api/emulation/events   the console line, as it is typed (SSE)
 *   POST /api/emulation/input    {"text":"LOGIN ELIZA"} — typed into line 0
 *   GET  /api/emulation/state    {"state","instructions","dir"}
 *   *                            the repository, as a file server
 *
 * The terminal is anything with the shape of `CtssTerminal`: `on`/`emit`,
 * `status()`, `send(text)` and a `backlog` string. That is what makes this half
 * testable without booting CTSS.
 */
export function bridgeServer({ terminal, root }) {
  const files = resolve(root ?? fileURLToPath(new URL('../..', import.meta.url)));

  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;

    if (path === '/api/emulation/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      if (terminal.backlog) send({ type: 'print', text: terminal.backlog });
      send({ type: 'state', ...terminal.status() });
      const onPrint = (text) => send({ type: 'print', text });
      const onState = () => send({ type: 'state', ...terminal.status() });
      terminal.on('print', onPrint);
      terminal.on('state', onState);
      const beat = setInterval(() => response.write(': keep-alive\n\n'), 15000);
      request.on('close', () => {
        clearInterval(beat);
        terminal.off('print', onPrint);
        terminal.off('state', onState);
      });
      return;
    }

    if (path === '/api/emulation/state') {
      response.writeHead(200, { 'content-type': TYPES.get('.json') });
      response.end(JSON.stringify(terminal.status()));
      return;
    }

    if (path === '/api/emulation/input') {
      if (request.method !== 'POST') {
        response.writeHead(405, { 'content-type': TYPES.get('.json') });
        response.end(JSON.stringify({ ok: false, error: 'POST only' }));
        return;
      }
      let body = '';
      for await (const part of request) body += part;
      let text = '';
      try { text = JSON.parse(body || '{}').text ?? ''; } catch { /* a bare body is the line itself */ text = body; }
      const ok = terminal.send(String(text).replace(/[\r\n]+$/, ''));
      response.writeHead(200, { 'content-type': TYPES.get('.json') });
      response.end(JSON.stringify({ ok }));
      return;
    }

    // The page's own files. `tmp/` is where the 465 MB disk containers live and
    // is never worth serving, so it is refused outright.
    const wanted = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
    const file = join(files, wanted === '/' ? 'index.html' : wanted);
    if (!file.startsWith(files + '/') || file.startsWith(join(files, 'tmp') + '/')) {
      response.writeHead(403).end('forbidden');
      return;
    }
    try {
      const info = await statAsync(file);
      if (!info.isFile()) throw new Error('not a file');
      response.writeHead(200, {
        'content-type': TYPES.get(extname(file)) ?? 'application/octet-stream',
        'content-length': info.size,
      });
      response.end(await readFileAsync(file));
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
    }
  });
}
