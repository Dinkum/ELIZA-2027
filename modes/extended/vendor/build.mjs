/**
 * Build the vendored browser copy of transformers.js, its runtime, and its
 * model weights.
 *
 *   node modes/extended/vendor/build.mjs        (npm run vendor)
 *
 * WHY THIS EXISTS
 *
 * dist/transformers.web.min.js contains two bare imports:
 *
 *   import{Tensor as Q0}from"onnxruntime-common";
 *   import*as cA from"onnxruntime-web/webgpu";
 *
 * A document-level import map resolves those on the main thread. It does NOT
 * resolve them inside a module worker — workers get their own module resolution
 * scope and inherit no import map. That is verified, not assumed: the same
 * specifier succeeds on the page and throws in the worker.
 *
 * Since the whole point is to run the model off the main thread, the worker's
 * import graph must contain no bare specifiers and must not escape the
 * deployed vendor directory. So we copy the two dependencies into vendor/deps,
 * rewrite exactly two strings to those local paths, and commit the result.
 *
 * The rewrite is deliberately dumb and total: two literal substitutions, then a
 * hard assertion that nothing else bare survives. If a future release of
 * transformers.js adds a third bare import, this script fails loudly instead of
 * producing a file that breaks in a worker six months from now.
 *
 * OFFLINE
 *
 * The JavaScript dependencies, model weights and WebAssembly runtime land
 * beside the library. After this has run, the page never reaches another
 * origin: the worker's "remote" model host is its own static site.
 *
 * None of those binaries are committed — they are generated, large, and
 * reproducible. `manifest.json` is the committed record of exactly which
 * revisions and hashes they were. Same rule the library itself already follows.
 *
 * This step is idempotent and works offline once the files are present, so a
 * rebuild does not need the network.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { familyVectors, nodeEmbedder } from '../encoder.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

const SOURCE = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.web.min.js');
const PACKAGE = join(ROOT, 'node_modules', '@huggingface', 'transformers', 'package.json');
const OUTPUT = join(HERE, 'transformers.web.js');
const MANIFEST = join(HERE, 'manifest.json');

const SUBSTITUTIONS = [
  ['"onnxruntime-common"', '"./deps/onnxruntime-common/index.js"'],
  ['"onnxruntime-web/webgpu"', '"./deps/ort.webgpu.bundle.min.js"'],
];

const DEPS_DIR = join(HERE, 'deps');
const COMMON_SRC = join(ROOT, 'node_modules', 'onnxruntime-common', 'dist', 'esm');
const COMMON_DIR = join(DEPS_DIR, 'onnxruntime-common');
const WEBGPU_SOURCE = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist', 'ort.webgpu.bundle.min.mjs');
const WEBGPU_OUTPUT = join(DEPS_DIR, 'ort.webgpu.bundle.min.js');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/* --- the model, pinned by commit, not by branch --------------------------- */

/**
 * `main` is a moving target: a vector only means anything against others from
 * the same model *at the same revision*, so the revision is the commit sha.
 * Recorded in the manifest and used for every fetch below.
 */
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const MODEL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
const DTYPE = 'q8';

/**
 * q8 is one file; the tokenizer files are not optional. An .onnx on its own
 * cannot be loaded, which is the mistake this list prevents.
 */
const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

/**
 * The wasm the browser actually asks for, observed rather than guessed: the
 * asyncify pair for the CPU device, the only device the page requests. The
 * jsep pair (the WebGPU build, 24.9 MiB) is not vendored: nothing loads it, and
 * for a six-layer encoder embedding one line at a time the GPU's startup cost
 * outweighs anything it saves. Leftovers from older runs are removed below.
 */
const ORT_FILES = [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
];
const ORT_RETIRED = [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
];
const ORT_ALIASES = [
  ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.js'],
];

const ORT_SRC = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const ORT_DIR = join(HERE, 'ort');
/**
 * Laid out the way the loader's default path template expects:
 *
 *   model/<org>/<name>/resolve/<revision>/<file>
 *
 * The worker points `remoteHost` at this directory on our own origin, which is
 * what makes the weights load. `env.localModelPath` is NOT used: in this
 * version of the browser bundle it resolves the files (they fetch 200) and then
 * hands the pipeline an undefined tokenizer config, which surfaces much later
 * as "this.tokenizer is not a function". Serving the same bytes over HTTP from
 * localhost uses the path that works, and still never leaves the machine.
 */
const MODEL_DIR = join(HERE, 'model', ...MODEL_ID.split('/'), 'resolve', MODEL_REVISION);
const MODEL_ROOT = join(HERE, 'model');
const VECTORS = join(HERE, 'families.vectors.json');

/** Every file under a directory, recursively. */
function walk(dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else found.push(full);
  }
  return found;
}

/** Download once, then leave it alone: a rebuild must work with no network. */
async function fetchCached(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 0) return { cached: true };
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
  return { cached: false };
}

/* --- 1. the library ------------------------------------------------------- */

const source = readFileSync(SOURCE, 'utf8');
const version = JSON.parse(readFileSync(PACKAGE, 'utf8')).version;

let output = source;
let replacements = 0;
for (const [from, to] of SUBSTITUTIONS) {
  const before = output;
  output = output.split(from).join(to);
  if (output === before) {
    throw new Error(`expected to find ${from} in ${SOURCE} and did not — did transformers.js change its imports?`);
  }
  replacements += 1;
}

// Nothing bare may survive: a module worker cannot resolve it. Relative and
// absolute paths are the only things allowed through.
//
// The match is deliberately loose because minified code has no formatting, and
// it therefore catches one thing that is not an import at all: the error string
// `Unable to read image from "${e}"`. A `$` interpolation is not a static
// specifier and no npm package name may contain one, so it is filtered here
// rather than with a smarter regex that minification would defeat anyway.
const bare = [...output.matchAll(/(?:from|import)\s*\(?\s*"([^"]*)"/g)]
  .map((m) => m[1])
  .filter((specifier) => specifier && !specifier.includes('$') && !/\s/.test(specifier))
  .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('/'));

if (bare.length) {
  throw new Error(`bare specifiers survived the rewrite: ${[...new Set(bare)].join(', ')}`);
}

mkdirSync(HERE, { recursive: true });
writeFileSync(OUTPUT, output, 'utf8');
console.log(`vendored @huggingface/transformers@${version} -> vendor/transformers.web.js`);
console.log(`  ${replacements} rewrites, ${output.length} bytes, no bare specifiers remain`);

/* --- 2. the JavaScript import graph -------------------------------------- */

mkdirSync(COMMON_DIR, { recursive: true });
for (const file of walk(COMMON_SRC)) {
  if (!file.endsWith('.js')) continue;
  const destination = join(COMMON_DIR, relative(COMMON_SRC, file));
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(file, destination);
}
mkdirSync(DEPS_DIR, { recursive: true });
copyFileSync(WEBGPU_SOURCE, WEBGPU_OUTPUT);
console.log('copied the browser JavaScript dependencies -> vendor/deps/');

/* --- 3. the wasm runtime -------------------------------------------------- */

mkdirSync(ORT_DIR, { recursive: true });
for (const name of ORT_FILES) {
  copyFileSync(join(ORT_SRC, name), join(ORT_DIR, name));
}
for (const [source, outputName] of ORT_ALIASES) {
  copyFileSync(join(ORT_SRC, source), join(ORT_DIR, outputName));
}
for (const name of ORT_RETIRED) {
  rmSync(join(ORT_DIR, name), { force: true });
}
const ortVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'onnxruntime-web', 'package.json'), 'utf8')).version;
console.log(`copied onnxruntime-web@${ortVersion} runtime -> vendor/ort/ (${ORT_FILES.length + ORT_ALIASES.length} files)`);

/* --- 4. the model --------------------------------------------------------- */

mkdirSync(MODEL_DIR, { recursive: true });
let fetched = 0;
for (const name of MODEL_FILES) {
  const url = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/${name}`;
  const { cached } = await fetchCached(url, join(MODEL_DIR, name));
  if (!cached) fetched += 1;
}
console.log(
  `vendored ${MODEL_ID}@${MODEL_REVISION.slice(0, 7)} (${DTYPE}) -> vendor/model/ ` +
    `(${MODEL_FILES.length} files, ${fetched} downloaded now)`,
);

// Prune anything under vendor/model that the current layout does not claim.
// Without this, changing the layout leaves the previous copy of a 23 MB weights
// file on disk, and nothing would ever remove it.
const expected = new Set(MODEL_FILES.map((name) => join(MODEL_DIR, name)));
let pruned = 0;
for (const file of walk(MODEL_ROOT)) {
  if (!expected.has(file)) {
    rmSync(file);
    pruned += 1;
  }
}
if (pruned) console.log(`  pruned ${pruned} stale file(s) from vendor/model/`);

/* --- 5. the family vectors ------------------------------------------------ */

/**
 * Precomputed once, from the same model at the same revision that will embed
 * the queries. Computed here rather than at page load so a turn never waits on
 * embedding the script's own examples.
 *
 * Rounded to five decimals: the scores move by less than the rejection
 * threshold, and the file stays small enough to read.
 */
const scriptPath = join(HERE, '..', 'script.json');
const scriptText = readFileSync(scriptPath, 'utf8');
const script = JSON.parse(scriptText);
const embedMany = await nodeEmbedder({ model: MODEL_ID, dtype: DTYPE, revision: MODEL_REVISION });
const vectors = await familyVectors(script, (texts) => embedMany(texts));
const rounded = {};
for (const [id, vector] of Object.entries(vectors)) {
  rounded[id] = vector.map((value) => Number(value.toFixed(5)));
}

writeFileSync(
  VECTORS,
  `${JSON.stringify(
    {
      note: 'Generated by build.mjs. Do not edit. Family example vectors for the vendored model; usable only with the same model and revision.',
      model: MODEL_ID,
      revision: MODEL_REVISION,
      dtype: DTYPE,
      dimensions: Object.values(rounded)[0]?.length ?? 0,
      scriptSha256: sha256(scriptText),
      vectors: rounded,
    },
    null,
    1,
  )}\n`,
  'utf8',
);
console.log(`wrote vendor/families.vectors.json (${Object.keys(rounded).length} families, ${Object.values(rounded)[0]?.length ?? 0}-dim)`);

/* --- 6. the provenance record (committed) --------------------------------- */

writeFileSync(
  MANIFEST,
  `${JSON.stringify(
    {
      note: 'Generated by build.mjs. Do not edit. The worker imports this file because module workers cannot resolve bare specifiers.',
      source: `@huggingface/transformers@${version}`,
      sourceFile: 'dist/transformers.web.min.js',
      sourceSha256: sha256(source),
      outputSha256: sha256(output),
      rewrites: SUBSTITUTIONS.map(([from, to]) => ({ from, to })),
      dependencies: {
        'ort.webgpu.bundle.min.js': sha256File(WEBGPU_OUTPUT),
        'onnxruntime-common': Object.fromEntries(
          walk(COMMON_DIR)
            .filter((file) => file.endsWith('.js'))
            .map((file) => [relative(COMMON_DIR, file), sha256File(file)]),
        ),
      },
      ort: {
        source: `onnxruntime-web@${ortVersion}`,
        files: Object.fromEntries(
          [...ORT_FILES, ...ORT_ALIASES.map(([, outputName]) => outputName)]
            .map((name) => [name, sha256File(join(ORT_DIR, name))]),
        ),
      },
      model: {
        source: MODEL_ID,
        revision: MODEL_REVISION,
        dtype: DTYPE,
        files: Object.fromEntries(
          MODEL_FILES.map((name) => [name, sha256File(join(MODEL_DIR, name))]),
        ),
      },
      vectors: {
        file: 'families.vectors.json',
        scriptSha256: sha256(scriptText),
        families: Object.keys(rounded).length,
        dimensions: Object.values(rounded)[0]?.length ?? 0,
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
);
console.log('wrote vendor/manifest.json');
