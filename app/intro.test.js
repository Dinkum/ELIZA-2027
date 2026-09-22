/**
 * The desk's choices: which programs there are, which of them has a version,
 * where BACK goes, and when the live line is worth offering.
 *
 * The rendering and the paper are not tested here — one is markup, and the
 * other is a 1052.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MODES, VERSIONS, LINE_DOWN, needsVersion, previousScreen, liveLineAvailable } from './intro.js';

test('the desk offers four programs, one line each', () => {
  assert.equal(MODES.length, 4);
  for (const mode of MODES) {
    assert.equal(mode.label, mode.label.toUpperCase(), `${mode.label} is not in the desk voice`);
    assert.match(mode.line, /^[A-Z]/, `${mode.key} does not start a line`);
    assert.ok(mode.line.length < 140, `${mode.key} is longer than a desk note`);
    assert.ok(['script', 'live', 'own'].includes(mode.kind));
  }
  assert.deepEqual(MODES.map((m) => m.label), ['JS REWRITE', 'JS PORT', 'EMULATION', 'EXTENDED']);
  assert.deepEqual(MODES.map((m) => m.line), [
    'Written in modern JavaScript',
    'Archeological rewrite in JavaScript',
    'In-browser emulation of the original experience, IBM 7094 mainframe',
    'The original concepts (decomposition rules, pattern matching, response lists, and conversational memory) but extended',
  ]);
});

test('only the modes that read an archive tape have a version to choose', () => {
  assert.deepEqual(MODES.filter(needsVersion).map((m) => m.key), ['rewrite', 'port']);
  assert.equal(needsVersion(MODES.find((m) => m.key === 'live')), false);
  assert.equal(needsVersion(MODES.find((m) => m.key === 'extended')), false);
  assert.equal(needsVersion(null), false);
  assert.deepEqual(VERSIONS.map((v) => v.label), ['1965B', '1966']);
  assert.deepEqual(VERSIONS.map((v) => v.line), [
    'Earlier recovered source.',
    'The famous version the CACM paper refers to. Less hardcoded (added the NEWKEY function and keyword stack).',
  ]);
});

test('BACK is not offered on the first screen, and unwinds one screen at a time', () => {
  const script = MODES.find((m) => m.key === 'rewrite');
  const live = MODES.find((m) => m.key === 'live');

  assert.equal(previousScreen('modes'), null);
  assert.equal(previousScreen('version', script), 'modes');
  assert.equal(previousScreen('paper', script), 'version');
  assert.equal(previousScreen('paper', live), 'modes');
  assert.equal(previousScreen('paper'), 'modes');
});

test('the line is offered only where the browser can run the machine', async () => {
  const pack = (ok = true) => ({
    ok,
    arrayBuffer: async () => {
      const head = new ArrayBuffer(12);
      const view = new DataView(head);
      view.setUint32(0, 0x50544b31);
      view.setUint32(4, 2);
      return head;
    },
  });
  const boom = async () => { throw new Error('offline'); };

  assert.equal(await liveLineAvailable(async () => pack()), true);
  // A static host: 404 for a path that is not a file.
  assert.equal(await liveLineAvailable(async () => pack(false)), false);
  // A host that answers everything with its own page is not a disk image either.
  assert.equal(await liveLineAvailable(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })), false);
  assert.equal(await liveLineAvailable(boom), false);
  assert.equal(await liveLineAvailable(undefined), false);
  assert.match(LINE_DOWN, /^This browser/);
});
