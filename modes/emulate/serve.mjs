/**
 * The 1050 paper and the 7094 behind it, on one port.
 *
 *     npm run serve            # http://127.0.0.1:8027
 *
 * This replaces the plain `python3 -m http.server` so that mode 3 on the paper
 * reaches a *live* CTSS line and not a stub in the browser. Modes 1, 2 and 4 are
 * unaffected: they are still files the page fetches.
 *
 * The machine is booted once, at startup, from the frozen tree (MODE3_DASD,
 * default tmp/mode3-dasd) and dials line 0 as soon as CTSS is listening. What it
 * prints goes to the page over SSE; what the operator types comes back as POSTs.
 * Nothing is written back to the disks.
 */

import { CtssTerminal, bridgeServer, DASD_DIR } from './bridge.mjs';

const PORT = Number(process.env.PORT ?? 8027);
const HOST = process.env.HOST ?? '127.0.0.1';

// Listen before mounting DASD. Reading and decoding the containers is tens of
// seconds of blocking work, and doing it first leaves the page and the health
// probe with nothing to connect to. The proxy below answers 'booting' until the
// real terminal exists, then forwards to it.
let live = null;
const queued = [];

const terminal = {
  get backlog() { return live?.backlog ?? ''; },
  on(event, fn) {
    if (live) live.on(event, fn); else queued.push([event, fn]);
  },
  off(event, fn) { live?.off(event, fn); },
  status() {
    return live?.status() ?? { state: 'booting', instructions: 0, dir: DASD_DIR };
  },
  send(text) { return live ? live.send(text) : false; },
  stop() { live?.stop(); },
};

const server = bridgeServer({ terminal });
server.listen(PORT, HOST, () => {
  console.log(`ELIZA 2027 on http://${HOST}:${PORT}/   (mode 3 = the live CTSS line)`);
});

console.log(`mode 3: booting CTSS from ${DASD_DIR}`);
live = new CtssTerminal();
for (const [event, fn] of queued) live.on(event, fn);
live.on('printer', (text) => process.stdout.write(`[printer] ${text}\n`));
live.on('state', (state) => console.log(`mode 3: line ${state.state} after ${state.instructions} instructions`));
live.run();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    terminal.stop();
    server.close(() => process.exit(0));
    process.exit(0);
  });
}
