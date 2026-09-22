/**
 * ELIZA EXTENDED — the optional semantic index.
 *
 * WHAT THIS IS ALLOWED TO DO
 *
 * Exactly one thing: look at the user's sentence and say "try the WORK_STRESS
 * rules." It never supplies a response, and it never fills a slot. It cannot
 * say person=boss or emotion=anxiety or cause=deadline. Those require an
 * actual pattern match, and only the engine can produce one.
 *
 * WHAT HAPPENS WHEN IT IS ABSENT
 *
 * Nothing. The engine asks; if there is no provider, or it is still loading, or
 * it throws, the answer is an empty list and the symbolic path continues
 * untouched. The index is an accelerator over families that already exist in
 * the script — never a source of new meaning.
 *
 * THE ENCODER
 *
 * The default encoder here is dependency-free: it hashes word unigrams and
 * character trigrams into a fixed-width signed vector and L2-normalizes it.
 * That is a real local encoder — deterministic, offline, no model weights, no
 * network — but it is a *lexical* one. It matches on shared word forms and
 * shared subwords, not on learned meaning. It is honest about that: two
 * sentences that share no surface form score near zero even when they mean the
 * same thing.
 *
 * `setEncoder()` is the seam for a real model. A WASM/ONNX sentence encoder
 * runs behind this same interface — `encode(text) -> Float32Array` — and the
 * index, the thresholds, and the engine contract do not change. Because the
 * interface is async-tolerant, a slow encoder can load lazily in a Web Worker
 * while the symbolic engine keeps answering.
 *
 * NO VECTOR DATABASE. Family examples are embedded once at load and held as a
 * flat array. The script is small by construction; that is the whole index.
 */

/** Vector width. Small on purpose: this is an index, not a model. */
export const DIMENSIONS = 256;

/** Below this cosine score, a suggestion is not worth acting on. */
export const MIN_SCORE = 0.35;

/** If the top two families are this close, the reading is ambiguous: reject. */
export const MIN_MARGIN = 0.04;

/**
 * The default encoder: signed feature hashing over words and character
 * trigrams, L2-normalized.
 *
 * Trigram features are what let "exhausted" and "exhausting" land near each
 * other without a stemmer or a word list.
 */
export class HashedEncoder {
  constructor({ dimensions = DIMENSIONS } = {}) {
    this.dimensions = dimensions;
  }

  features(text) {
    const clean = String(text).toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
    const out = [];
    for (const word of clean.split(' ').filter(Boolean)) {
      out.push(`w:${word}`);
      const padded = `^${word}$`;
      for (let i = 0; i + 3 <= padded.length; i += 1) out.push(`c:${padded.slice(i, i + 3)}`);
    }
    return out;
  }

  /** FNV-1a. Small, fast, and stable across engines — no Math.random seeding. */
  hash(feature) {
    let h = 0x811c9dc5;
    for (let i = 0; i < feature.length; i += 1) {
      h ^= feature.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  encode(text) {
    const vector = new Float32Array(this.dimensions);
    for (const feature of this.features(text)) {
      const h = this.hash(feature);
      const index = h % this.dimensions;
      // The sign bit spreads collisions instead of letting them pile up.
      vector[index] += (h & 0x80000000) ? -1 : 1;
    }
    let norm = 0;
    for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
    return vector;
  }
}

/** Cosine of two already-normalized vectors: a dot product. */
export function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/**
 * The family index. One vector per family, averaged over that family's example
 * utterances and re-normalized. A family with no examples is not indexed at
 * all — it can still be reached literately.
 */
export class SemanticIndex {
  /**
   * @param {object} script
   * @param {object} [options]
   * @param {object} [options.encoder] anything with encode(text)
   * @param {object} [options.vectors] precomputed family vectors, keyed by
   *   family id. Supplying these skips embedding entirely — which is what a
   *   bundler should do for a real model.
   */
  constructor(script, { encoder = null, vectors = null } = {}) {
    // With precomputed vectors there is deliberately no default encoder. A
    // query must arrive already embedded by the same model that produced them;
    // silently encoding it here would compare two different vector spaces.
    this.encoder = encoder || (vectors ? null : new HashedEncoder());
    this.families = [];
    this.ready = false;

    const entries = vectors
      ? Object.entries(vectors)
      : (script.families || [])
          .filter((family) => (family.examples || []).length)
          .map((family) => [family.id, family.examples]);

    for (const [id, value] of entries) {
      const vector = Array.isArray(value) && typeof value[0] === 'string'
        ? this.meanVector(value)
        : Float32Array.from(value);
      this.families.push({ id, vector });
    }
    this.ready = this.families.length > 0;
  }

  meanVector(examples) {
    const vector = new Float32Array(this.encoder.encode(examples[0]).length);
    for (const example of examples) {
      const encoded = this.encoder.encode(example);
      for (let i = 0; i < vector.length; i += 1) vector[i] += encoded[i];
    }
    let norm = 0;
    for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
    return vector;
  }

  /**
   * Rank families against the input.
   *
   * `vector` may carry an embedding computed elsewhere — by a worker, by a
   * model, by a cache. When it is absent the index falls back to its own
   * encoder, which is what keeps the synchronous path working with no model
   * in the room.
   *
   * A match that is weak (below MIN_SCORE) or ambiguous (barely ahead of the
   * runner-up) is rejected rather than guessed at. Returning nothing is the
   * correct answer far more often than returning a wrong family.
   */
  suggest(text, vector = null) {
    if (!this.ready) return [];
    // No vector and no encoder: the caller has precomputed vectors from a model
    // and has not supplied a matching query. Saying nothing is the only honest
    // answer; guessing in the wrong space would be worse than no suggestion.
    if (!vector && !this.encoder) return [];
    const query = vector || this.encoder.encode(text);
    const scored = this.families
      .map(({ id, vector: family }) => ({ family: id, score: cosine(query, family) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < MIN_SCORE) return [];

    const runnerUp = scored[1];
    const ambiguous = runnerUp && best.score - runnerUp.score < MIN_MARGIN;
    // Even when ambiguous, name the leader as unconfident. The engine will not
    // act on it, but the trace records what was considered.
    return scored
      .filter((s) => s.score >= MIN_SCORE)
      .slice(0, 2)
      .map((s, i) => ({ ...s, confident: !(ambiguous && i === 0) }));
  }
}

/**
 * A provider the engine can use directly. `suggest` is synchronous and never
 * throws: anything that goes wrong resolves to "no suggestion", because a
 * broken index must not interrupt a conversation.
 */
export function createSemantics(script, options = {}) {
  const index = new SemanticIndex(script, options);
  return {
    index,
    // The engine calls (text, words, embedding). The index only wants the
    // embedding; `words` is part of the provider contract and is passed on in
    // case a provider wants the tokenization the engine already did.
    suggest(text, words, embedding) {
      try {
        return index.suggest(text, embedding);
      } catch {
        return [];
      }
    },
  };
}

/**
 * WHERE A REAL MODEL PLUGS IN
 *
 * The engine's semantic step is synchronous by contract and stays that way: a
 * conversation must not stall on a model loading. So a worker does not answer
 * questions — it warms the encoder and embeds the script's examples ahead of
 * time, and the main thread keeps the resulting vectors.
 *
 *   1. the worker loads the model (WASM on the CPU, WebGPU where it helps)
 *   2. it embeds every family example once and posts the vectors back
 *   3. the page builds `new SemanticIndex(script, { encoder, vectors })` with a
 *      synchronous encoder implementing the same `encode(text)` interface
 *      HashedEncoder does
 *   4. until that lands — and if it never does — the engine runs on literals
 *
 * Nothing above this line assumes the default encoder. Swapping in a real one
 * changes no engine code and no script content.
 */

/** Embed every family once, so a page can ship vectors instead of a model. */
export function precomputeVectors(script, encoder = new HashedEncoder()) {
  const index = new SemanticIndex(script, { encoder });
  const vectors = {};
  for (const { id, vector } of index.families) vectors[id] = Array.from(vector);
  return vectors;
}
