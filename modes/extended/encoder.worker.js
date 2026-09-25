/**
 * ELIZA EXTENDED — the encoder worker.
 *
 * The model lives here and nowhere else, so the page never stalls on it. The
 * main thread asks for a vector, keeps drawing the conversation, and picks the
 * answer up when it lands. If this worker never arrives, or throws, or the
 * browser has no WebAssembly, the engine runs on literals exactly as it does
 * with no encoder at all — that is the contract the whole design rests on.
 *
 * THE LIBRARY COMES FROM THIS REPO, NOT A CDN
 *
 * A preservation project should still run in ten years, so the import resolves
 * inside ./node_modules. The version is the one in package-lock.json, the
 * install is offline after `npm ci`, and nothing here reaches the network for
 * code. Only the model weights come over the wire, once, and the browser then
 * caches them.
 *
 * ONE RUNTIME
 *
 *   device 'wasm'    ort-wasm-simd-threaded.asyncify.wasm  22.5 MiB  everywhere
 *
 * Only the WASM runtime is vendored. The WebGPU build is not: the model is
 * small enough that the CPU answers within a keystroke, and GPU start-up would
 * only delay the first reply. A 'webgpu' device would 404 on its runtime.
 */

import { pipeline, env } from './vendor/transformers.web.js?v=070ec5ae15d0';

/**
 * THE LIBRARY AND THE MODEL BOTH COME FROM THIS REPO
 *
 * The library is vendored so a module worker can import it without an import
 * map. The weights and the WebAssembly runtime are vendored for a different
 * reason: the point of this mode is that the machine keeps working with the
 * network unplugged, and `node_modules` is not part of the deployed artifact.
 */
/** Vendored, so the page keeps working with the network unplugged. */
const WASM_PATHS = {
  mjs: new URL('./vendor/ort/ort-wasm-simd-threaded.asyncify.js?v=5959c6733039', import.meta.url).href,
  wasm: new URL('./vendor/ort/ort-wasm-simd-threaded.asyncify.wasm?v=e0c0c6d3e73d', import.meta.url).href,
};

/**
 * HOW THE WEIGHTS LOAD, AND WHY NOT `localModelPath`
 *
 * `env.localModelPath` is the documented way to point at local files, and it
 * does resolve some of them here — config.json and the .onnx fetch 200 — but
 * the tokenizer files are never requested, so the pipeline is handed a null
 * tokenizer and fails on its first call with "this.tokenizer is not a
 * function". The same directory and the same flags work in Node, so it is this
 * browser bundle's local path that is at fault, not the files.
 *
 * So the loader is pointed at our own origin instead: `remoteHost` is this
 * page's server and the template matches the layout `npm run vendor` writes.
 * "Remote" here means localhost — nothing leaves the machine — and it uses the
 * load path that is demonstrably working (it is how this model loaded, at 384
 * dimensions, before any of it was vendored).
 */
/**
 * Pinned to the commit, not the branch. `main` is a moving target, and a vector
 * only means anything against others from the same model at the same revision —
 * so the family vectors in vendor/families.vectors.json record this same sha
 * and a drift test compares the two.
 *
 * Declared before MODEL_PATH_TEMPLATE, which interpolates REVISION: a `const`
 * is not usable above its own declaration, and the template is evaluated at
 * module load.
 */
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
const DTYPE = 'q8';

const ORIGIN = new URL('/', import.meta.url).href;

/**
 * The revision is written into the template rather than left as `{revision}`.
 *
 * `{revision}` is filled by the loader from its own option, and it filled in
 * `main` here even with `revision` passed to `pipeline(...)` — so the request
 * went to `resolve/main/` and 404'd, while the vendored tree is laid out under
 * the pinned commit. Writing the pin into the template removes that dependency
 * and keeps the single source of truth in REVISION above.
 */
const MODEL_PATH_TEMPLATE = `modes/extended/vendor/model/{model}/resolve/${REVISION}/`;

let extractor = null;

async function load(device) {
  if (extractor) return extractor;

  // The weights are served from THIS origin. `remoteHost` is our own server,
  // not huggingface.co, so allowing "remote" models still means nothing leaves
  // the machine. See the note above for why the local path is not used.
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.remoteHost = ORIGIN;
  env.remotePathTemplate = MODEL_PATH_TEMPLATE;
  // No browser cache. These files are already local, so a cache entry can only
  // ever serve a stale copy of something we have on disk — and a stale
  // tokenizer entry is exactly how the whole pipeline ends up with a null
  // tokenizer that only fails on the first turn.
  env.useBrowserCache = false;
  env.backends.onnx.wasm.wasmPaths = WASM_PATHS;

  extractor = await pipeline('feature-extraction', MODEL, {
    device,
    dtype: DTYPE,
    revision: REVISION,
  });
  return extractor;
}

/**
 * Embed one string or many. The batch case is what the family vectors are
 * built from, so it is the case that has to be right.
 */
async function embed(input, device) {
  const model = await load(device);
  const output = await model(input, { pooling: 'mean', normalize: true });
  const [, width] = output.dims;
  const flat = Array.from(output.data);
  const vectors = [];
  for (let i = 0; i < flat.length; i += width) vectors.push(flat.slice(i, i + width));
  return { vectors, width };
}

self.onmessage = async (event) => {
  const { id, type, text, texts, device = 'wasm' } = event.data;
  try {
    if (type === 'load') {
      await load(device);
      // The model and revision travel with the ready signal so the page can
      // refuse a precomputed vector file that came from a different model.
      // Mixing two vector spaces is the one mistake this design cannot recover
      // from: the scores still look like scores, so nothing reports an error.
      self.postMessage({ id, ok: true, type: 'ready', model: MODEL, revision: REVISION, dtype: DTYPE });
      return;
    }
    if (type === 'embed') {
      const { vectors, width } = await embed(texts ?? text, device);
      self.postMessage({ id, ok: true, vectors, width });
      return;
    }
    self.postMessage({ id, ok: false, error: `unknown message type: ${type}` });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String((error && error.message) || error) });
  }
};
