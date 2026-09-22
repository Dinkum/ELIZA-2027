/**
 * ELIZA EXTENDED — the vendored browser build.
 *
 * The worker cannot import `dist/transformers.web.min.js` directly, because
 * that file contains two bare specifiers and a module worker inherits no
 * import map. `npm run vendor` rewrites them into paths. These tests fail if
 * that generated file drifts from the installed package, or if a future
 * release reintroduces a specifier the rewrite does not cover.
 *
 * Hermetic: reads files, touches no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { vectorsAreCompatible } from '../encoder.js';

const manifest = JSON.parse(readFileSync(new URL('../vendor/manifest.json', import.meta.url), 'utf8'));
const vendored = readFileSync(new URL('../vendor/transformers.web.js', import.meta.url), 'utf8');
const installed = JSON.parse(
  readFileSync(new URL('../../../node_modules/@huggingface/transformers/package.json', import.meta.url), 'utf8'),
);

test('the vendored build matches the installed package version', () => {
  assert.equal(manifest.source, `@huggingface/transformers@${installed.version}`);
});

test('the vendored build is the file the manifest describes', () => {
  // Same check as `npm run vendor`, recomputed here so a hand-edit or a stale
  // artifact is caught rather than trusted.
  const digest = createHash('sha256').update(vendored).digest('hex');
  assert.equal(digest, manifest.outputSha256);
});

test('no bare specifier survives in the vendored build', () => {
  // Deliberately an independent implementation of the builder's guard: a test
  // that reuses the code under test proves nothing.
  const found = [...vendored.matchAll(/(?:from|import)\s*\(?\s*"([^"]*)"/g)]
    .map((m) => m[1])
    .filter((s) => s && !s.includes('$') && !/\s/.test(s))
    .filter((s) => !s.startsWith('.') && !s.startsWith('/'));
  assert.deepEqual([...new Set(found)], [], 'a bare specifier would throw in a module worker');
});

test('the worker points at the vendored build, not the raw package dist', () => {
  const worker = readFileSync(new URL('../encoder.worker.js', import.meta.url), 'utf8');
  const library = worker.match(/import \{ pipeline, env \} from '([^']+)'/);
  assert.ok(library, 'no vendored transformers import in encoder.worker.js');
  assert.match(library[1], /vendor\/transformers\.web\.js\?v=[0-9a-f]{12}$/);
  assert.doesNotMatch(library[1], /node_modules/);
});

/* -------------------------------------------------------------------------- */
/* Offline: the runtime must not reach into node_modules or the network        */
/* -------------------------------------------------------------------------- */

test('the worker loads its wasm runtime from vendor/, not node_modules', () => {
  const worker = readFileSync(new URL('../encoder.worker.js', import.meta.url), 'utf8');
  assert.match(worker, /const WASM_PATHS = \{/);
  assert.match(worker, /mjs: new URL\('\.\/vendor\/ort\/[^']+\.js\?v=[0-9a-f]{12}'/);
  assert.match(worker, /wasm: new URL\('\.\/vendor\/ort\/[^']+\.wasm\?v=[0-9a-f]{12}'/);
  assert.match(worker, /wasmPaths = WASM_PATHS/);
  // node_modules is not part of a deployed copy, so nothing the runtime needs
  // may live there.
  assert.doesNotMatch(worker, /new URL\(\s*'\.\.\/\.\.\/node_modules/);
});

test('the worker fetches weights from its own origin, never the internet', () => {
  // The weights are vendored, and the loader's local-file path is broken in
  // this browser bundle: it resolves some files and then hands the pipeline a
  // null tokenizer, which only fails on the first turn. So the loader is
  // pointed at our own origin instead, and the guarantee becomes "the host can
  // never be a remote one".
  const worker = readFileSync(new URL('../encoder.worker.js', import.meta.url), 'utf8');
  const host = worker.match(/const ORIGIN = new URL\(\s*'([^']+)'/);
  assert.ok(host, 'no ORIGIN constant in encoder.worker.js');
  assert.equal(host[1], '/', 'ORIGIN must be this server, not a remote host');
  assert.match(worker, /env\.remoteHost = ORIGIN/, 'remoteHost must be this origin');
  // Match an actual assignment, not the word: the comments explain why a remote
  // host is not used, so a bare substring match would fail on its own prose.
  assert.doesNotMatch(
    worker,
    /remoteHost\s*=\s*['"]https?:\/\//,
    'the worker must never assign a remote model host',
  );
});

test('the worker pins the model to a commit, not a branch', () => {
  const worker = readFileSync(new URL('../encoder.worker.js', import.meta.url), 'utf8');
  const revision = worker.match(/const REVISION = '([^']+)'/);
  assert.ok(revision, 'no REVISION constant in encoder.worker.js');
  // `main` moves; a vector only means anything against others from the same
  // model at the same revision, so a branch name is not a pin.
  assert.match(revision[1], /^[0-9a-f]{40}$/, `REVISION must be a commit sha, got ${revision[1]}`);
});

test('every path the worker depends on exists', () => {
  for (const relative of [
    '../vendor/transformers.web.js',
    '../vendor/deps/ort.webgpu.bundle.min.js',
    '../vendor/deps/onnxruntime-common/index.js',
    '../vendor/ort/ort-wasm-simd-threaded.asyncify.js',
    '../vendor/ort/ort-wasm-simd-threaded.asyncify.wasm',
    `../vendor/model/${manifest.model.source}/resolve/${manifest.model.revision}/tokenizer.json`,
    `../vendor/model/${manifest.model.source}/resolve/${manifest.model.revision}/onnx/model_quantized.onnx`,
  ]) {
    assert.doesNotThrow(
      () => readFileSync(new URL(relative, import.meta.url)),
      `${relative} is missing — run \`npm ci && npm run vendor\``,
    );
  }
});

test('the worker\'s weight template resolves to real files', () => {
  // The worker builds a URL from a path template. A layout change on either
  // side would 404 at runtime and surface only as a null tokenizer on the first
  // turn, so the template is resolved here against the actual tree.
  const worker = readFileSync(new URL('../encoder.worker.js', import.meta.url), 'utf8');
  const template = worker.match(/const MODEL_PATH_TEMPLATE = [`'"]([^`'"]+)[`'"]/);
  assert.ok(template, 'no MODEL_PATH_TEMPLATE constant in encoder.worker.js');

  // The revision is interpolated into the template at module load. This test
  // reads the file as *text*, where an interpolation is still the literal
  // characters `${REVISION}`, so the worker's own pin is substituted here.
  const revision = worker.match(/const REVISION = '([^']+)'/);
  assert.ok(revision, 'no REVISION constant in encoder.worker.js');
  const filled = template[1]
    .replace('{model}', manifest.model.source)
    .replace('${REVISION}', revision[1]);
  // The template is relative to the page origin, which is the repo root. This
  // file sits three levels down (modes/extended/test/), so the base has to be
  // resolved from the root rather than from here.
  const base = new URL(`../../../${filled}`, import.meta.url);

  for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']) {
    assert.doesNotThrow(
      () => readFileSync(new URL(name, base)),
      `${name} is not where the worker's template says it is`,
    );
  }
});

test('the vendored library\'s rewritten imports resolve', () => {
  // A static deployment has no node_modules. Every rewritten import must stay
  // inside vendor/deps, and every relative import in onnxruntime-common's ESM
  // graph must resolve there as well.
  const vendored = readFileSync(new URL('../vendor/transformers.web.js', import.meta.url), 'utf8');
  const rewritten = [...vendored.matchAll(/(?:from|import)\s*\(?\s*"(\.\/deps\/[^"]*)"/g)].map((m) => m[1]);
  assert.ok(rewritten.length > 0, 'expected the rewrite table to leave relative imports behind');
  for (const specifier of new Set(rewritten)) {
    const target = new URL(specifier, new URL('../vendor/transformers.web.js', import.meta.url));
    assert.doesNotThrow(
      () => readFileSync(target),
      `${specifier} does not resolve inside vendor/ — run \`npm run vendor\``,
    );
  }

  const commonDir = new URL('../vendor/deps/onnxruntime-common/', import.meta.url);
  for (const name of readdirSync(commonDir).filter((entry) => entry.endsWith('.js'))) {
    const file = new URL(name, commonDir);
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
      assert.doesNotThrow(
        () => readFileSync(new URL(specifier, file)),
        name + ' imports missing ' + specifier,
      );
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Drift: the vendored vectors must describe this script and this model        */
/* -------------------------------------------------------------------------- */

const vectorsPath = new URL('../vendor/families.vectors.json', import.meta.url);
const hasVectors = existsSync(vectorsPath);

test('the vendored vectors match the script and the model they came from', { skip: !hasVectors && 'run `npm run vendor`' }, () => {
  const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'));
  const scriptText = readFileSync(new URL('../script.json', import.meta.url), 'utf8');

  // The examples changed but nobody rebuilt: the shipped vectors would answer
  // for a script that no longer exists.
  assert.equal(
    vectors.scriptSha256,
    createHash('sha256').update(scriptText).digest('hex'),
    'families.vectors.json is stale relative to script.json — re-run `npm run vendor`',
  );

  // The same pin as the worker, because a query embedding and a family vector
  // are only comparable inside one model at one revision.
  const workerRevision = readFileSync(new URL('../encoder.worker.js', import.meta.url), 'utf8')
    .match(/const REVISION = '([^']+)'/)[1];
  assert.equal(vectors.revision, workerRevision, 'worker and vectors disagree on the model revision');
  assert.equal(vectors.model, manifest.model.source, 'worker model and manifest disagree');
  assert.equal(vectors.dimensions, 384, 'MiniLM-L6-v2 is 384-dimensional');
});

test('the runtime rejects vectors generated from another script', () => {
  const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'));
  const client = { model: vectors.model, revision: vectors.revision };
  assert.equal(vectorsAreCompatible(vectors, client, vectors.scriptSha256), true);
  assert.equal(vectorsAreCompatible(vectors, client, '0'.repeat(64)), false);
});

test('the manifest records a hash for every vendored file', { skip: !hasVectors && 'run `npm run vendor`' }, () => {
  for (const [name, digest] of Object.entries(manifest.model.files)) {
    assert.match(digest, /^[0-9a-f]{64}$/, `${name} has no sha256 in the manifest`);
  }
  for (const [name, digest] of Object.entries(manifest.ort.files)) {
    assert.match(digest, /^[0-9a-f]{64}$/, `${name} has no sha256 in the manifest`);
  }
  assert.match(manifest.dependencies['ort.webgpu.bundle.min.js'], /^[0-9a-f]{64}$/);
  for (const [name, digest] of Object.entries(manifest.dependencies['onnxruntime-common'])) {
    assert.match(digest, /^[0-9a-f]{64}$/, `${name} has no dependency sha256 in the manifest`);
  }
  // The revision here is what makes the recorded hashes meaningful, so it has
  // to be a commit and not a branch name.
  assert.match(manifest.model.revision, /^[0-9a-f]{40}$/, 'the model revision must be a commit sha');
});
