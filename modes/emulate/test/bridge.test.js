/**
 * The bridge's HTTP half, tested against a stand-in line.
 *
 * `bridgeServer` takes anything with the shape of `CtssTerminal`, so the page's
 * side of the wire can be exercised without booting CTSS and its 465 MB of
 * containers. The emulator's own half is covered by the other tests in this
 * directory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgeServer } from '../bridge.mjs';

/** A line that is not a machine: it records what it is told and says what it is. */
class StandInLine extends EventEmitter {
  constructor() {
    super();
    this.backlog = '';
    this.sent = [];
    this.state = 'ready';
  }

  status() {
    return { state: this.state, instructions: 42, dir: 'stand-in' };
  }

  send(text) {
    this.sent.push(text);
    return true;
  }

  /** The supervisor printing, from the test's side. */
  print(text) {
    this.backlog = (this.backlog + text).slice(-4096);
    this.emit('print', text);
  }
}

/** A repository to serve, with just enough in it. */
function serveFixture() {
  const root = mkdtempSync(join(tmpdir(), 'eliza-bridge-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>paper</title>');
  writeFileSync(join(root, 'main.js'), 'export const mode = 3;');
  writeFileSync(join(root, 'worker.mjs'), 'export const machine = 7094;');
  const line = new StandInLine();
  const server = bridgeServer({ terminal: line, root });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ line, server, base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

test('the page and the repository are served from the same port', async () => {
  const fixture = await serveFixture();
  try {
    const page = await fetch(`${fixture.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /paper/);

    const module = await fetch(`${fixture.base}/main.js`);
    assert.match(module.headers.get('content-type'), /javascript/);
    assert.equal(await module.text(), 'export const mode = 3;');

    const workerModule = await fetch(`${fixture.base}/worker.mjs`);
    assert.match(workerModule.headers.get('content-type'), /javascript/);
    assert.equal(await workerModule.text(), 'export const machine = 7094;');

    const missing = await fetch(`${fixture.base}/nope.js`);
    assert.equal(missing.status, 404);
  } finally {
    fixture.close();
  }
});

test('a line typed at the paper is typed at the line', async () => {
  const fixture = await serveFixture();
  try {
    const response = await fetch(`${fixture.base}/api/emulation/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'LOGIN ELIZA' }),
    });
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(fixture.line.sent, ['LOGIN ELIZA']);

    // A trailing carriage return belongs to the caller, not to the line: the
    // 7750 takes the characters, the operator's carrier return is the operator's.
    await fetch(`${fixture.base}/api/emulation/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'eliza\r\n' }),
    });
    assert.deepEqual(fixture.line.sent, ['LOGIN ELIZA', 'eliza']);

    const get = await fetch(`${fixture.base}/api/emulation/input`);
    assert.equal(get.status, 405);
  } finally {
    fixture.close();
  }
});

test('the console stream carries the backlog, the state, and what comes next', async () => {
  const fixture = await serveFixture();
  try {
    // A page that connects late still sees what the line already printed.
    fixture.line.print('READY.\r\n');

    const response = await fetch(`${fixture.base}/api/emulation/events`);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let buffered = '';
    const read = async () => {
      while (events.length < 3) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffered.indexOf('\n\n')) >= 0) {
          const frame = buffered.slice(0, cut);
          buffered = buffered.slice(cut + 2);
          const data = frame.split('\n').find((l) => l.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    };

    const pending = read();
    // Let the subscription land before the machine says anything else.
    await new Promise((done) => setTimeout(done, 50));
    fixture.line.print('W 1517.2\r\n');
    await pending;

    assert.deepEqual(events[0], { type: 'print', text: 'READY.\r\n' });
    assert.equal(events[1].type, 'state');
    assert.equal(events[1].state, 'ready');
    assert.equal(events[2].text, 'W 1517.2\r\n');

    reader.cancel();
  } finally {
    fixture.close();
  }
});

test('the state of the line is readable without opening the stream', async () => {
  const fixture = await serveFixture();
  try {
    const state = await (await fetch(`${fixture.base}/api/emulation/state`)).json();
    assert.equal(state.state, 'ready');
    assert.equal(state.dir, 'stand-in');
  } finally {
    fixture.close();
  }
});
