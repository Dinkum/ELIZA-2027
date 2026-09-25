/**
 * ELIZA EXTENDED — the encoder client.
 *
 * Two ways to reach the same model, behind one idea: a vector is produced
 * somewhere else and handed to the engine, which stays synchronous.
 *
 *   EncoderClient   the browser. A worker owns the model; this side awaits.
 *   nodeEmbedder    Node. In-process, for the integration test and for
 *                   building the family vectors a page can ship.
 *
 * THE ONE RULE THAT MATTERS
 *
 * A vector is only comparable to vectors from the same model at the same
 * revision. Family vectors computed with the hashed encoder cannot be compared
 * against an input vector from MiniLM, and a MiniLM vector from one revision
 * cannot be compared against another. `familyVectors` always uses the same
 * embedder the caller will use at runtime, and SemanticIndex refuses to encode
 * a query itself once it has been handed precomputed vectors. That guard is
 * deliberate; it is the most likely way to build this wrong.
 */

/** L2-normalize in place and return it. Cosine against a dot product needs this. */
function normalize(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  return vector;
}

/**
 * Mean of several normalized vectors, re-normalized. The mean of unit vectors
 * is not itself a unit vector, and skipping the second normalization quietly
 * biases every score toward whichever family has the most examples.
 */
function meanVector(vectors) {
  const width = vectors[0].length;
  const mean = new Float32Array(width);
  for (const vector of vectors) {
    for (let i = 0; i < width; i += 1) mean[i] += vector[i];
  }
  for (let i = 0; i < width; i += 1) mean[i] /= vectors.length;
  return normalize(mean);
}

/**
 * Build one vector per family, from that family's example utterances, using the
 * embedder the caller will also use at runtime.
 *
 * @param {object} script
 * @param {(texts: string[]) => Promise<Float32Array[]>} embedMany
 */
export async function familyVectors(script, embedMany) {
  const vectors = {};
  for (const family of script.families || []) {
    const examples = family.examples || [];
    if (!examples.length) continue;
    const embedded = await embedMany(examples);
    // Not `embedded.map(Float32Array.from)`: a typed-array constructor used as a
    // bare callback loses its receiver and throws "undefined is not a constructor".
    vectors[family.id] = Array.from(meanVector(embedded.map((vector) => Float32Array.from(vector))));
  }
  return vectors;
}

/** True only when precomputed vectors belong to this model and script. */
export function vectorsAreCompatible(file, client, scriptSha256) {
  return Boolean(
    file
    && scriptSha256
    && file.model === client.model
    && file.revision === client.revision
    && file.scriptSha256 === scriptSha256,
  );
}

/**
 * The browser client. Owns a module worker and multiplexes requests over it.
 *
 * Nothing here throws into the conversation: a failed load leaves `ready`
 * false and every embed resolving to null, which the engine already handles.
 */
export class EncoderClient {
  constructor({ workerUrl = new URL('./encoder.worker.js?v=cc435b77aaff', import.meta.url), device = 'wasm' } = {}) {
    this.workerUrl = workerUrl;
    this.device = device;
    this.worker = null;
    this.pending = new Map();
    this.nextId = 0;
    this.ready = false;
    this.error = null;
    /** Which model the worker actually loaded, reported on `load()`. */
    this.model = null;
    this.revision = null;
  }

  start() {
    if (this.worker) return;
    this.worker = new Worker(this.workerUrl, { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      if (data.ok) entry.resolve(data);
      else entry.reject(new Error(data.error));
    };
    this.worker.onerror = (event) => {
      this.error = String(event.message || 'worker failed to start');
      for (const entry of this.pending.values()) entry.reject(new Error(this.error));
      this.pending.clear();
    };
  }

  send(message) {
    this.start();
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id, device: this.device });
    });
  }

  /** Resolves true when the model is in memory. Never rejects. */
  async load() {
    try {
      const info = await this.send({ type: 'load' });
      // Recorded so a caller can prove that precomputed vectors came from this
      // exact model at this exact revision before trusting them.
      this.model = info.model ?? null;
      this.revision = info.revision ?? null;
      this.ready = true;
      return true;
    } catch (error) {
      this.error = String((error && error.message) || error);
      return false;
    }
  }

  /** One vector, or null. Never rejects — a missing vector is a normal state. */
  async embed(text) {
    try {
      const { vectors } = await this.send({ type: 'embed', text });
      return Float32Array.from(vectors[0]);
    } catch (error) {
      this.error = String((error && error.message) || error);
      return null;
    }
  }

  async embedMany(texts) {
    const { vectors } = await this.send({ type: 'embed', texts });
    return vectors.map((vector) => Float32Array.from(vector));
  }

  /** Give the browser its threads back. */
  terminate() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.ready = false;
    this.pending.clear();
  }
}

/**
 * The same model, in-process, for Node.
 *
 * This is how the family vectors get built and how the integration test checks
 * that a real model actually improves the routing. It is a dynamic import so
 * the browser never evaluates a Node entry point.
 */
export async function nodeEmbedder({ model = 'Xenova/all-MiniLM-L6-v2', dtype = 'q8', revision = undefined } = {}) {
  const { pipeline } = await import('@huggingface/transformers');
  // A revision pins the weights to one commit. Anything derived from the model
  // — a family vector, a query embedding — is only comparable to others from
  // that same commit, so this is passed through rather than left floating.
  const extractor = await pipeline('feature-extraction', model, revision ? { dtype, revision } : { dtype });
  return async function embedMany(texts) {
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    const [, width] = output.dims;
    const flat = Array.from(output.data);
    const vectors = [];
    for (let i = 0; i < flat.length; i += width) vectors.push(Float32Array.from(flat.slice(i, i + width)));
    return vectors;
  };
}
