import test from 'node:test';
import assert from 'node:assert/strict';

import { LiveLine } from './live.js';

test('a worker constructor failure is retained for the loader', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class {
    constructor() {
      throw new Error('module workers are unavailable');
    }
  };

  try {
    const errors = [];
    const line = new LiveLine('worker.js');
    assert.equal(await line.connect({ onError: (message) => errors.push(message) }), false);
    assert.equal(line.error, 'module workers are unavailable');
    assert.deepEqual(errors, ['module workers are unavailable']);
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  }
});

test('a worker load failure is retained for the loader', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class {
    constructor() {
      queueMicrotask(() => this.onerror?.({ message: 'module script has the wrong MIME type' }));
    }
  };

  try {
    const line = new LiveLine('worker.js');
    assert.equal(await line.connect(), false);
    assert.equal(line.error, 'module script has the wrong MIME type');
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  }
});

test('a CTSS hangup closes the line without redialing', async () => {
  const originalWorker = globalThis.Worker;
  let worker;
  globalThis.Worker = class {
    constructor() {
      worker = this;
      queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
    }

    postMessage() {}
    terminate() {}
  };

  try {
    const line = new LiveLine('worker.js');
    assert.equal(await line.connect(), true);
    let hangups = 0;
    line.onHangup = () => { hangups += 1; };

    worker.onmessage({ data: { type: 'hangup' } });

    assert.equal(line.state, 'closed');
    assert.equal(hangups, 1);
    assert.equal(await line.send('LOGIN ELIZA'), false);
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  }
});

test('boot reports the download and waits for the worker to finish booting', async () => {
  const originalWorker = globalThis.Worker;
  const originalFetch = globalThis.fetch;
  let worker;
  globalThis.Worker = class {
    constructor() {
      worker = this;
      queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
    }

    postMessage(message) {
      if (message.type !== 'boot') return;
      queueMicrotask(() => this.onmessage?.({ data: { type: 'progress', stage: 'unpack' } }));
      queueMicrotask(() => this.onmessage?.({ data: { type: 'progress', stage: 'mounted' } }));
      queueMicrotask(() => this.onmessage?.({ data: { type: 'print', text: 'READY.\n' } }));
      queueMicrotask(() => this.onmessage?.({ data: { type: 'progress', stage: 'boot' } }));
    }
  };
  globalThis.fetch = async (url) => {
    const body = String(url).includes('pack') ? new Uint8Array([1, 2, 3, 4]) : new Uint8Array([5, 6]);
    return new Response(body, { headers: { 'content-length': String(body.byteLength) } });
  };

  try {
    const progress = [];
    const line = new LiveLine('worker.js');
    assert.equal(await line.connect({ onProgress: (message) => progress.push(message) }), true);
    assert.equal(await line.boot('disk.pack', 'cmd.cbn'), true);
    assert.equal(worker !== undefined, true);
    assert.deepEqual(progress.map(({ stage }) => stage), ['fetch', 'unpack', 'mounted', 'boot']);
    assert.deepEqual(progress[0], { type: 'progress', stage: 'fetch', received: 4, total: 4 });
    const printed = [];
    line.onPrint = (text) => printed.push(text);
    line.flushPrint();
    assert.deepEqual(printed, ['READY.\n']);
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
    globalThis.fetch = originalFetch;
  }
});

test('a worker boot error fails boot instead of handing over blank paper', async () => {
  const originalWorker = globalThis.Worker;
  const originalFetch = globalThis.fetch;
  globalThis.Worker = class {
    constructor() {
      queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
    }

    postMessage(message) {
      if (message.type === 'boot') {
        queueMicrotask(() => this.onmessage?.({ data: { type: 'error', message: 'disk mount failed' } }));
      }
    }
  };
  globalThis.fetch = async () => new Response(new Uint8Array([1]), {
    headers: { 'content-length': '1' },
  });

  try {
    const line = new LiveLine('worker.js');
    assert.equal(await line.connect(), true);
    assert.equal(await line.boot('disk.pack', 'cmd.cbn'), false);
    assert.equal(line.error, 'disk mount failed');
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
    globalThis.fetch = originalFetch;
  }
});
