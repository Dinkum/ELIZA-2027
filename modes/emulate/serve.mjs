/**
 * The 1050 paper and the 7094 behind it, on one port.
 *
 *     npm run serve            # http://127.0.0.1:8027
 *
 * The HTTP server serves the app and an optional CTSS console API. A Node worker
 * boots the console from the raw MODE3_DASD tree while the server answers requests.
 * The app's Mode 3 boots separately from a packed disk image.
 */

import { EventEmitter } from 'node:events';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { CtssTerminal, bridgeServer, DASD_DIR } from './bridge.mjs';

const PORT = Number(process.env.PORT ?? 8027);
const HOST = process.env.HOST ?? '127.0.0.1';

if (isMainThread) {
  const terminal = new EventEmitter();
  const worker = new Worker(new URL(import.meta.url));
  let state = { state: 'booting', instructions: 0, dir: DASD_DIR };
  terminal.backlog = '';
  terminal.status = () => state;
  terminal.send = (text) => {
    if (state.state !== 'ready') return false;
    worker.postMessage(text);
    return true;
  };
  worker.on('message', (message) => {
    if (message.type === 'print') {
      terminal.backlog = (terminal.backlog + message.text).slice(-CtssTerminal.BACKLOG);
      terminal.emit('print', message.text);
    } else if (message.type === 'status') {
      state = message.state;
    } else {
      state = message.state;
      terminal.emit('state');
      console.log(`mode 3: line ${state.state} after ${state.instructions} instructions`);
    }
  });
  worker.on('error', (error) => console.error('CTSS worker failed:', error.message));
  worker.on('exit', () => {
    if (state.state === 'stopped') return;
    state = { ...state, state: 'stopped', running: false };
    terminal.emit('state');
  });

  const server = bridgeServer({ terminal });
  server.listen(PORT, HOST, () => {
    console.log(`ELIZA 2027 on http://${HOST}:${server.address().port}/`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      server.close();
      await worker.terminate();
      process.exit(0);
    });
  }
} else {
  console.log(`mode 3: booting CTSS from ${DASD_DIR}`);
  const terminal = new CtssTerminal();
  terminal.on('printer', (text) => process.stdout.write(`[printer] ${text}\n`));
  terminal.on('print', (text) => parentPort.postMessage({ type: 'print', text }));
  terminal.on('state', (state) => parentPort.postMessage({ type: 'state', state }));
  parentPort.on('message', (text) => terminal.send(text));
  const statusTimer = setInterval(() => {
    parentPort.postMessage({ type: 'status', state: terminal.status() });
  }, 250);
  try {
    await terminal.run();
  } finally {
    clearInterval(statusTimer);
    parentPort.close();
  }
}
