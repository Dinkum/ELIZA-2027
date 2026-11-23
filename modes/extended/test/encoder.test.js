/**
 * ELIZA EXTENDED — the real encoder, opt in.
 *
 *   ELIZA_ONNX=1 npm test
 *
 * Skipped by default. Run npm run vendor first to stage the pinned local model.
 *
 * What it is actually checking, and why it is worth 22 MB:
 *
 *   1. that the pinned model loads at all and produces unit vectors of the
 *      width MiniLM claims, and
 *   2. that a real model does something the hashed encoder cannot. The probe
 *      below shares almost no surface form with the family it belongs to, so
 *      the lexical encoder is essentially guessing and the model is not.
 *
 * If this test is removed, the repository can still claim a semantic index. It
 * should just not claim it works.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ExtendedEliza } from '../engine.js';
import { SemanticIndex } from '../semantics.js';
import { EncoderClient, familyVectors, nodeEmbedder } from '../encoder.js';

const SCRIPT = JSON.parse(readFileSync(new URL('../script.json', import.meta.url), 'utf8'));

const enabled = process.env.ELIZA_ONNX === '1';
const skip = enabled ? false : 'set ELIZA_ONNX=1 to run with the vendored model';
const { model } = JSON.parse(readFileSync(new URL('../vendor/manifest.json', import.meta.url), 'utf8'));
const modelPath = fileURLToPath(new URL(`../vendor/model/${model.source}/resolve/${model.revision}/`, import.meta.url));

test('terminating the encoder settles pending requests', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = class {
    postMessage() {}
    terminate() {}
  };
  try {
    const client = new EncoderClient();
    const reply = client.embed('hello');
    client.terminate();
    assert.equal(await reply, null);
    assert.equal(client.ready, false);
    assert.equal(client.pending.size, 0);
  } finally {
    if (previous === undefined) delete globalThis.Worker;
    else globalThis.Worker = previous;
  }
});

/** The model is slow to build and identical across tests, so build it once. */
let embedder = null;
let vectors = null;

async function setup() {
  if (!embedder) {
    embedder = await nodeEmbedder({ localModelPath: modelPath });
    vectors = await familyVectors(SCRIPT, embedder);
  }
  return { embedder, vectors };
}

test('the pinned model loads and returns unit vectors', { skip }, async () => {
  const { embedder } = await setup();
  const [vector] = await embedder(['my boss is on my case all day']);
  assert.equal(vector.length, 384);
  let norm = 0;
  for (const value of vector) norm += value * value;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-4, `not unit length: ${Math.sqrt(norm)}`);
});

test('family vectors are built for every family that has examples', { skip }, async () => {
  const { vectors: built } = await setup();
  for (const family of SCRIPT.families) {
    if (!(family.examples || []).length) continue;
    assert.ok(built[family.id], `no vector for ${family.id}`);
    assert.equal(built[family.id].length, 384);
  }
});

test('the pinned model can reach a grounded reply for every indexed family', { skip }, async () => {
  const { embedder, vectors: built } = await setup();
  const probes = [
    ['FEELING_CAUSE', 'i cannot shake this feeling'],
    ['WORK_STRESS', 'he is on my case all day'],
    ['FAMILY', 'the person who raised me will not speak to me any more'],
    ['RELATIONSHIP', 'the person i am dating'],
    ['SLEEP_TIRED', 'i stare at the ceiling all night'],
    ['ANXIETY', 'bracing for what might happen'],
    ['HEALTH', 'my nose keeps running'],
    ['MONEY', 'my bank account is empty'],
    ['SCHOOL', 'i have a term paper due'],
    ['GRIEF', 'i visit the grave'],
    ['SELF_ESTEEM', 'nothing i do measures up'],
    ['ANGER', 'it makes my blood boil'],
    ['LONELINESS', 'nobody ever calls me'],
    ['SUBSTANCES', 'i keep reaching for the bottle'],
    ['SMALL_TALK', 'pleased to meet you'],
  ];
  const index = new SemanticIndex(SCRIPT, { vectors: built });
  assert.equal(probes.length, index.families.length);
  const embeddings = await embedder(probes.map(([, text]) => text));
  for (const [i, [family, text]] of probes.entries()) {
    const eliza = new ExtendedEliza(SCRIPT);
    await eliza.respondWithSemantics(text, () => index.suggest(text, embeddings[i]));
    assert.equal(eliza.lastTrace.at(-1).source, 'semantic', text);
    assert.equal(eliza.lastTrace.at(-1).family, family, text);
  }
});

test('the model routes a probe the lexical encoder cannot', { skip }, async () => {
  const { embedder, vectors: built } = await setup();
  const index = new SemanticIndex(SCRIPT, { vectors: built });

  // No FAMILY word in this sentence, so nothing literal can reach the family.
  const probe = 'the person who raised me will not speak to me any more';
  const [vector] = await embedder([probe]);
  const suggestions = index.suggest(probe, vector);

  assert.ok(suggestions.length, 'the model proposed nothing');
  assert.equal(suggestions[0].family, 'FAMILY');
  assert.ok(suggestions[0].score >= 0.35, `weak score ${suggestions[0].score}`);
  const eliza = new ExtendedEliza(SCRIPT);
  const reply = await eliza.respondWithSemantics(probe, () => suggestions);
  assert.match(reply, /the person who raised you/);
  assert.equal(eliza.lastTrace.at(-1).source, 'semantic');
});

test('the lexical encoder gets that same probe wrong, which is the point', { skip }, async () => {
  const lexical = new SemanticIndex(SCRIPT);
  const suggestions = lexical.suggest('the person who raised me will not speak to me any more');
  // Not an assertion that it fails — an assertion that the two do not agree,
  // so the test above is measuring the model and not the fixture.
  assert.notEqual(suggestions[0]?.family, 'FAMILY');
});

test('an engine given model vectors will not encode a query itself', { skip }, async () => {
  const { vectors: built } = await setup();
  const index = new SemanticIndex(SCRIPT, { vectors: built });
  // No query vector supplied: refuse rather than embed in the wrong space.
  assert.deepEqual(index.suggest('my boss is on my case all day'), []);
});

test('a full turn runs on a worker-shaped embedding', { skip }, async () => {
  const { embedder } = await setup();
  const eliza = new ExtendedEliza(structuredClone(SCRIPT), {
    semantics: { suggest: (text, words, embedding) => (embedding ? [{ family: 'WORK_STRESS', score: 1 }] : []) },
  });
  const [embedding] = await embedder(['they keep dumping more on my plate']);
  eliza.respond('they keep dumping more on my plate', { embedding });
  assert.equal(eliza.lastTrace.find((s) => s.step === 'reassemble').family, 'WORK_STRESS');
});
