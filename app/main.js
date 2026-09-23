/**
 * ELIZA 2027 — the sheet of paper in the 1052, and the desk it sits on.
 *
 * The paper is only ever the conversation: machine and operator characters
 * print in black, and nothing else is struck onto it.
 * What to run is agreed before the sheet is handed the line, on two short
 * screens of desk chrome — one for the mode, and, where the mode reads an
 * archive tape, one for the version.
 *
 * There is no menu on paper and no number to type at it. The sheet is blank
 * when the engine starts talking, and the mode and version are never printed.
 */

import { Typewriter } from './typewriter.js?v=56ba75bcf382';
import { Sound } from './sound.js';
import { LiveLine } from './live.js?v=7f3799639c78';
import { CtssOutput, logInToCtss } from './ctss-login.js';
import {
  MODES, VERSIONS, LINE_DOWN, needsVersion, previousScreen, liveLineAvailable,
} from './intro.js?v=6a8bbea53bbe';
import { Eliza } from '../modes/rewrite/eliza.js';
import { ElizaPort, SlipFault } from '../modes/port/eliza.js?v=1e3713080283';
import { ElizaPort1966 } from '../modes/port/eliza-1966.js?v=2007d80b9177';
import { SCRIPT_1965B } from '../data/scripts/eliza-1965b-tape100.js';
import { SCRIPT_1966 } from '../data/scripts/eliza-1966-cacm.js';
import { ExtendedEliza } from '../modes/extended/engine.js?v=21b8b65de185';
import { EncoderClient, familyVectors, vectorsAreCompatible } from '../modes/extended/encoder.js?v=1698b728b0a6';
import { createSemantics, SemanticIndex } from '../modes/extended/semantics.js';

/** Extended ships its own richer script rather than reading an archive tape. */
const EXTENDED_SCRIPT_URL = new URL('../modes/extended/script.json?v=6e7b4c0826da', import.meta.url);

/**
 * The family example vectors, emitted by `npm run vendor` beside the model.
 *
 * They are optional: if the file is absent the page computes them once in the
 * worker instead. Either way the vectors must come from the model the worker
 * actually loaded, which is checked below before they are used.
 */
const EXTENDED_VECTORS_URL = new URL('../modes/extended/vendor/families.vectors.json?v=74a5fa26d95e', import.meta.url);

/**
 * The two archive tapes, by version key.
 *
 * A key is all the version screen knows about a version; the script it reads
 * and the dialect it is read in belong to this side, not to the desk.
 */
const TAPES = {
  '1965b': { script: SCRIPT_1965B, dialect: '1965b' },
  '1966': { script: SCRIPT_1966, dialect: '1966' },
};

/** Each machine image has its own compiled ELIZA and script 100. */
const MACHINE_PACKS = {
  '1965b': new URL('../modes/emulate/ctss-dasd.pack', import.meta.url),
  '1966': new URL('../modes/emulate/ctss-1966-dasd.pack', import.meta.url),
};

const form = document.getElementById('form');
const keyboard = document.getElementById('keyboard');
const soundButton = document.getElementById('sound');
const backButton = document.getElementById('back');
const paperTools = document.getElementById('paper-tools');
const liveGuide = document.getElementById('live-guide');
const liveGuideDismiss = document.getElementById('live-guide-dismiss');
const portGuide = document.getElementById('port-guide');
const portGuideDismiss = document.getElementById('port-guide-dismiss');
const intro = document.getElementById('intro');
const note = document.getElementById('modes-note');

const screens = {
  modes: document.getElementById('screen-modes'),
  version: document.getElementById('screen-version'),
  loader: document.getElementById('screen-loader'),
};

const lists = {
  modes: document.getElementById('mode-rows'),
  version: document.getElementById('version-rows'),
};

const loaderLine = document.getElementById('loader-line');
const loaderDetail = document.getElementById('loader-detail');
const loaderProgress = document.getElementById('loader-progress');
const loaderProgressFill = document.getElementById('loader-progress-fill');
const loaderPercent = document.getElementById('loader-percent');

const sound = new Sound();

/** The sheet is replaced whenever a session starts, so this is not a constant. */
let sheet = document.getElementById('sheet');

/** The printer, once there is paper in the platen. */
let printer = null;

/** What BACK does on the screen that is up, or null where there is no BACK. */
let onBack = null;

/**
 * Sessions are numbered. A loop from an abandoned session stops at its next
 * check rather than printing into a sheet that is no longer its own.
 */
let generation = 0;

/** What the machine is waiting for: null, or a line of text. */
let waiting = null;

/** The CTSS instructions are chrome shown once per page load, never paper ink. */
let liveGuideShown = false;
let portGuideShown = false;

// --- the desk -------------------------------------------------------------

/** A printer on the sheet in the platen, at the 1052's own timings. */
function newPrinter(target) {
  return new Typewriter(target, {
    // TXTPRT wraps ELIZA's own output at 84 columns; the paper matches it so the
    // same text is not wrapped a second time.
    margin: 84,
    onBell: () => {
      sound.bell();
      form.classList.add('bell');
      setTimeout(() => form.classList.remove('bell'), 220);
    },
    onStrike: (char) => sound.strike(char),
  });
}

/**
 * Draw one screen's rows: the name, and one line under it.
 *
 * A choice the desk cannot offer is drawn dimmed and disabled, rather
 * than left off the screen, so that what is missing is visible together with the
 * one it is missing from.
 */
function renderRows(name, options, { unavailable = [] } = {}) {
  const list = lists[name];
  list.replaceChildren();

  options.forEach((option) => {
    const missing = unavailable.includes(option.key);

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';
    row.dataset.key = option.key;
    row.disabled = missing;

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = option.label;
    if (name === 'version' && option.key === '1966') {
      const marker = document.createElement('sup');
      marker.className = 'row-marker';
      marker.textContent = '*';
      marker.setAttribute('aria-hidden', 'true');
      label.appendChild(marker);
      row.setAttribute('aria-describedby', 'version-source-note');
    }

    const line = document.createElement('span');
    line.className = 'row-line';
    line.textContent = option.line;

    row.append(label, line);

    const item = document.createElement('li');
    item.appendChild(row);
    list.appendChild(item);
  });
}

/** Show one desk screen. The first screen has nothing behind it, so no BACK. */
function showScreen(name) {
  liveGuide.hidden = true;
  portGuide.hidden = true;
  document.body.append(backButton);
  intro.hidden = false;
  form.hidden = true;
  for (const [id, element] of Object.entries(screens)) element.hidden = id !== name;
  backButton.hidden = previousScreen(name) === null;
}

/** Hand the desk over to the 1050: a blank sheet, and BACK to give it up. */
function showPaper() {
  paperTools.append(backButton);
  intro.hidden = true;
  form.hidden = false;
  backButton.hidden = false;
}

/**
 * Wait for one of a screen's rows to be taken: a click, or a carriage return on
 * the row the operator has walked to with the arrow keys. BACK, or the escape
 * key, gives the screen up and resolves null.
 *
 * @returns {Promise<object|null>}
 */
function askRows(name, options) {
  const list = lists[name];
  const rows = [...list.querySelectorAll('button.row:not(:disabled)')];

  return new Promise((resolve) => {
    const take = (row) => {
      list.removeEventListener('click', onClick);
      list.removeEventListener('keydown', onKey);
      onBack = null;
      resolve(options.find((option) => option.key === row.dataset.key) ?? null);
    };

    const onClick = (event) => {
      const row = event.target.closest('button.row');
      if (row && !row.disabled) take(row);
    };

    const onKey = (event) => {
      const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (step === 0) return;
      event.preventDefault();
      const at = rows.indexOf(document.activeElement);
      const to = Math.min(rows.length - 1, Math.max(0, (at < 0 ? 0 : at + step)));
      rows[to]?.focus();
    };

    list.addEventListener('click', onClick);
    list.addEventListener('keydown', onKey);

    onBack = () => {
      list.removeEventListener('click', onClick);
      list.removeEventListener('keydown', onKey);
      onBack = null;
      resolve(null);
    };

    rows[0]?.focus();
  });
}

/** BACK's own key, for an operator who never touches the mouse. */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !onBack) return;
  event.preventDefault();
  onBack();
});

backButton.addEventListener('click', () => onBack?.());

soundButton.addEventListener('click', () => {
  const on = sound.toggle();
  soundButton.setAttribute('aria-pressed', String(on));
  soundButton.textContent = on ? 'BELL ON' : 'BELL OFF';
  keepFocus();
});

liveGuideDismiss.addEventListener('click', () => {
  liveGuide.hidden = true;
  keepFocus();
});

portGuideDismiss.addEventListener('click', () => {
  portGuide.hidden = true;
  keepFocus();
});

/** The desk's own answer when the line was up a moment ago and is not now. */
function lineDown() {
  note.textContent = LINE_DOWN;
  note.hidden = false;
  return 'modes';
}

/**
 * Agree what to run, then keep running it until BACK is used.
 *
 * BACK from a paper session unwinds one screen: to the version screen where the
 * mode had one, and to the modes otherwise.
 */
async function main() {
  const availability = Object.fromEntries(await Promise.all(
    Object.entries(MACHINE_PACKS).map(async ([key, url]) => [key, await liveLineAvailable(fetch, url)]),
  ));
  const lineUp = Object.values(availability).some(Boolean);
  renderRows('modes', MODES, { unavailable: lineUp ? [] : ['live'] });

  if (!lineUp) {
    note.textContent = LINE_DOWN;
    note.hidden = false;
  }

  let screen = 'modes';
  let mode = null;
  let version = null;

  for (;;) {
    if (screen === 'modes') {
      showScreen('modes');
      mode = await askRows('modes', MODES);
      if (!mode) continue;                    // nothing behind the first screen
      screen = needsVersion(mode) ? 'version' : 'paper';
      continue;
    }

    if (screen === 'version') {
      renderRows('version', VERSIONS, {
        unavailable: mode.kind === 'live'
          ? VERSIONS.filter((choice) => !availability[choice.key]).map((choice) => choice.key)
          : [],
      });
      showScreen('version');
      version = await askRows('version', VERSIONS);
      if (!version) {
        screen = 'modes';
        continue;
      }
      screen = mode.kind === 'live' ? 'loader' : 'paper';
      continue;
    }

    if (screen === 'loader') {
      showScreen('loader');
      screen = await loadMachine(mode, version);
      continue;
    }

    screen = await session(mode, version);
  }
}

/**
 * Bring the machine up behind the loader screen, then hand the paper the line.
 *
 * The worker does the work; this only draws what it reports. A failure is not
 * a dead end: the desk says why and goes back to the modes.
 */
async function loadMachine(mode, version) {
  loaderLine.textContent = 'Bringing the machine up.';
  loaderDetail.textContent = 'Loading the emulator worker.';
  setLoaderProgress(2, 'Loading the emulator worker.');

  const line = new LiveLine();
  const connected = await line.connect({
    onProgress: (progress) => {
      if (progress.stage === 'fetch') {
        const mb = (progress.received / 1048576).toFixed(1);
        const total = Number(progress.total) || 0;
        const ratio = total ? progress.received / total : 0;
        const totalMb = total ? ` / ${(total / 1048576).toFixed(1)} MB` : ' MB';
        loaderDetail.textContent = `Fetching the packed image: ${mb}${totalMb}.`;
        setLoaderProgress(10 + (Math.min(1, ratio) * 60), 'Fetching the packed image.');
      } else if (progress.stage === 'unpack') {
        loaderDetail.textContent = 'Unpacked. Mounting the disks.';
        setLoaderProgress(78, 'Unpacking the disk image.');
      } else if (progress.stage === 'mounted') {
        loaderDetail.textContent = 'Mounted. Booting CTSS.';
        setLoaderProgress(88, 'Mounting the CTSS disks.');
      } else if (progress.stage === 'boot') {
        loaderDetail.textContent = 'CTSS is up. Dialing the line.';
        setLoaderProgress(100, 'CTSS is up.');
      }
    },
    onError: (message) => {
      showLoaderError(message);
    },
  });
  if (!connected) {
    showLoaderError(line.error ?? 'The machine worker could not be loaded.');
    await new Promise((done) => setTimeout(done, 1800));
    return 'modes';
  }

  loaderDetail.textContent = 'Worker online. Fetching the packed image.';
  setLoaderProgress(10, 'Worker online.');

  const booted = await line.boot(
    MACHINE_PACKS[version.key],
    new URL('../modes/emulate/cmd.cbn', import.meta.url),
  );
  if (!booted) {
    showLoaderError(line.error ?? 'The packed image did not arrive.');
    await new Promise((done) => setTimeout(done, 1800));
    return 'modes';
  }

  // The paper takes over from here; the line is already open.
  mode.line = line;
  return 'paper';
}

function setLoaderProgress(value, text) {
  const percent = Math.round(Math.max(0, Math.min(100, Number(value) || 0)));
  loaderProgress.dataset.state = percent === 100 ? 'complete' : 'loading';
  loaderProgress.setAttribute('aria-valuenow', String(percent));
  loaderProgress.setAttribute('aria-valuetext', text);
  loaderProgressFill.style.width = `${percent}%`;
  loaderPercent.value = `${percent}%`;
  loaderPercent.textContent = `${percent}%`;
}

function showLoaderError(message) {
  loaderProgress.dataset.state = 'error';
  loaderProgress.setAttribute('aria-valuetext', 'Emulator startup failed.');
  loaderDetail.textContent = `Failed. ${String(message)}`;
}

/**
 * One conversation on a blank sheet, until BACK.
 *
 * The sheet itself is replaced rather than emptied, so a printer left mid-line
 * by an abandoned session has no paper to strike onto. The linefeed listener
 * that follows the paper belongs to the form, which survives the swap.
 *
 * @returns {Promise<'modes'|'version'>} the screen BACK unwinds to
 */
async function session(mode, version) {
  const mine = ++generation;

  const next = sheet.cloneNode(false);
  sheet.replaceWith(next);
  sheet = next;
  printer = newPrinter(sheet);
  showPaper();
  keepFocus();

  let giveUp;
  const given = new Promise((resolve) => { giveUp = resolve; });
  onBack = () => giveUp('back');

  const line = mode.kind === 'live' ? mode.line : null;
  const answer = mode.kind === 'live'
    ? converseLive(line, mine)
    : converseScript(mode, version, mine);

  let how = await Promise.race([given, answer]);

  // A real hangup leaves its last line on the paper. The operator chooses
  // BACK; the app does not silently redial or erase the evidence.
  if (how === 'hangup') how = await given;

  generation += 1;             // the abandoned loop stops at its next check
  cancelWait();
  liveGuide.hidden = true;
  portGuide.hidden = true;
  line?.close();
  if (mode.kind === 'live') mode.line = null;
  onBack = null;

  return how === 'down' ? lineDown() : previousScreen('paper', mode);
}

/** Run one turn of a scripted conversation at a time until BACK. */
async function converseScript(mode, version, mine) {
  const session = await open(mode, version);
  if (mine !== generation) return 'back';

  if (session.blankLineEnds && !portGuideShown) {
    portGuideShown = true;
    portGuide.hidden = false;
  }

  await printer.print(session.greeting);
  await printer.newline(2);

  if (session.status) {
    await printer.print(`    ${session.status}`);
    await printer.newline(2);
  }

  for (;;) {
    if (mine !== generation) return 'back';

    // The recovered TREAD prints INPUT. The 1966 port reuses that SLIP reader.
    if (session.prompt) {
      await printer.print(session.prompt);
      await printer.newline();
    }

    const text = await readText(session.blankLineEnds);
    if (mine !== generation || text === null) return 'back';
    if (text.trim().length === 0) continue;

    try {
      // Awaited: the rewrite and port answer synchronously, but extended may
      // need the encoder for this turn, so every session is awaited alike.
      await printer.print(await session.respond(text));
    } catch (error) {
      if (!(error instanceof SlipFault)) throw error;
      await printer.print(`SLIP FAULT . ${error.message}`);
      await printer.newline();
      await printer.print(session.faultText ?? 'THE PROGRAM STOPPED . SEE REFERENCES .');
    }
    await printer.newline(2);
  }
}

/**
 * Mode 3 — the machine's own line.
 *
 * There is no program here: the 7094 is running CTSS in a worker the page
 * booted behind the loader screen, and this mode is the 7750 line between them.
 * ELIZA is restored from the machine's own disk (`r eliza`, then the script
 * number CTSS asks for), so what answers is Weizenbaum's MAD-SLIP program on
 * the reconstructed supervisor, not a Javascript one.
 *
 * Every line the operator returns is typed at the line; everything the line
 * types is printed here as it arrives, in that order of events rather than in
 * turns. The line was opened before the paper was handed over, so a line that
 * does not answer here is one that went away, and the desk says so rather than
 * leaving the paper hanging.
 */
async function converseLive(line, mine) {
  if (!line || line.state === 'closed') return 'down';
  let lastPrint = Promise.resolve();
  const output = new CtssOutput();
  line.onPrint = (text) => {
    output.push(text);
    lastPrint = printMachine(text);
  };
  line.flushPrint();
  if (mine !== generation) return 'back';

  if (!liveGuideShown) {
    liveGuideShown = true;
    liveGuide.hidden = false;
  }

  const hungUp = new Promise((resolve) => {
    line.onHangup = () => resolve('hangup');
  });

  const login = logInToCtss(output, async (text) => {
    // The virtual operator types at the 1052's keying speed.
    await printer.print(text);
    await printer.newline();
    return line.send(text);
  }).then((ok) => (ok ? 'logged-in' : 'hangup'));

  const loginOutcome = await Promise.race([login, hungUp]);
  if (loginOutcome === 'hangup') {
    line.onHangup = null;
    cancelWait();
    await lastPrint;
    return 'hangup';
  }

  const input = (async () => {
    for (;;) {
      // Sent on the carrier return, like every other line at this paper. The
      // machine answers when it answers; this loop only feeds the line.
      const text = await readText(false, true);
      if (mine !== generation || text === null) return 'back';
      if (!(await line.send(text))) return 'hangup';
    }
  })();

  const outcome = await Promise.race([input, hungUp]);
  line.onHangup = null;
  if (outcome === 'hangup') {
    cancelWait();
    await lastPrint;
  }
  return outcome;
}

/**
 * Open a conversation in the chosen mode. Modes 1 and 2 read the same two
 * archive scripts. The port selects the recovered 1965b program or the
 * separately reconstructed 1966 program along with that version's script.
 *
 * Mode 4 reads its own script and is asynchronous, because the local encoder is
 * warmed in the background. It answers from literals the whole time that is
 * happening: an encoder that is loading, broken or absent must not stop the
 * conversation, and that is the one claim this module has to keep.
 */
async function open(mode, version) {
  if (mode.kind === 'own') return openExtended();

  const tape = TAPES[version.key];

  if (mode.key === 'port') {
    const eliza = tape.dialect === '1966'
      ? new ElizaPort1966(tape.script)
      : new ElizaPort(tape.script);
    return {
      greeting: eliza.greeting,
      respond: (text) => eliza.respond(text),
      prompt: 'INPUT',
      blankLineEnds: true,
      faultText: tape.dialect === '1965b'
        ? 'THE 1965B CODE HAS NO PATH THROUGH THIS . SEE REFERENCES .'
        : 'THE RECONSTRUCTED 1966 PROGRAM STOPPED . SEE REFERENCES .',
    };
  }

  const eliza = new Eliza(tape.script, { dialect: tape.dialect });
  return {
    greeting: eliza.greeting,
    respond: (text) => eliza.respond(text),
    // The rewrite is not running under CTSS, so only the 1965b reading of it
    // carries the INPUT prompt.
    prompt: tape.dialect === '1965b' ? 'INPUT' : null,
    blankLineEnds: false,
  };
}

/**
 * The extended mode.
 *
 * The symbolic engine runs on its own script from the first turn. The semantic
 * index is an *optional* extra, and there are two spaces it can live in:
 *
 *   hashed   the bundled default. Synchronous, no download, in the page.
 *   model    the real encoder, in a Web Worker, on demand.
 *
 * The two must never be mixed: a vector only means anything against others from
 * the same encoder, so the index is either the hashed one or one built from the
 * worker's own vectors. The worker's family vectors are computed with the same
 * embedder that will embed the queries, which is what keeps them comparable.
 */
async function openExtended() {
  const response = await fetch(EXTENDED_SCRIPT_URL);
  const scriptText = await response.text();
  const script = JSON.parse(scriptText);
  const scriptSha256 = await sha256Text(scriptText);

  // Works immediately, and keeps working if nothing else ever loads.
  const eliza = new ExtendedEliza(script, { semantics: createSemantics(script) });

  // Swapped in only if the model loads. `session.encoder` is what the turn loop
  // awaits; `session.modelSpace` is the provider that goes with it.
  const session = {
    greeting: eliza.greeting,
    prompt: null,
    blankLineEnds: false,
    encoder: null,
    modelSpace: null,
    encoderState: 'loading',
    async respond(text) {
      // Synchronous engine, asynchronous encoder: embed here, hand the vector
      // in. Until the encoder is ready this is a no-op and the engine routes on
      // literals and the hashed index, exactly as it does with no encoder.
      if (!this.encoder || !this.encoder.ready) return eliza.respond(text);
      // The index refuses to encode a query once it holds model vectors, so the
      // query vector has to come from the same worker.
      const embedding = await this.encoder.embed(text);
      if (embedding) eliza.semantics = this.modelSpace;
      return eliza.respond(text, { embedding });
    },
  };

  document.documentElement.dataset.encoderState = session.encoderState;
  warmEncoder(script, eliza, session, scriptSha256);
  return session;
}

/** Hash generated data against the exact script bytes that produced it. */
async function sha256Text(text) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** Record encoder health for diagnostics without printing it into the paper. */
function setEncoderState(session, state, error = null) {
  session.encoderState = state;
  document.documentElement.dataset.encoderState = state;
  if (error) document.documentElement.dataset.encoderError = String(error);
  else delete document.documentElement.dataset.encoderError;
}

/**
 * Load the encoder, rebuild the index in the worker's own vector space, and
 * hand the session a provider that uses it. Every failure is silent on purpose:
 * the conversation already works without this.
 */
async function warmEncoder(script, eliza, session, scriptSha256) {
  // Opt out for a cold profile or a metered connection: ?encoder=off
  const off = new URLSearchParams(window.location.search).get('encoder') === 'off';
  if (off) {
    setEncoderState(session, 'disabled');
    return;
  }

  const client = new EncoderClient();
  try {
    if (!(await client.load())) {
      setEncoderState(session, 'unavailable', client.error);
      return;
    }

    // A resolved load is not proof the model works. This pipeline can build and
    // then throw on its first embed, and `embed()` reports that as null rather
    // than throwing — so without this probe the status line would claim
    // semantic routing while the hashed index quietly answered every turn.
    // The claim is earned by actually embedding something.
    const probe = await client.embed('is the doctor in');
    if (!probe || probe.length === 0) {
      setEncoderState(session, 'unusable', client.error);
      return;
    }

    // Prefer the vectors `npm run vendor` already computed. They save the page
    // from embedding the script's own examples on every load — but only if they
    // came from this exact model at this exact revision, because a vector is
    // meaningless outside the space that produced it and a wrong-space score
    // still looks like a score.
    const vectors = (await vendoredVectors(client, scriptSha256))
      ?? (await familyVectors(script, (texts) => client.embedMany(texts)));
    const index = new SemanticIndex(script, { vectors });
    session.modelSpace = {
      suggest(text, words, embedding) {
        try {
          return index.suggest(text, embedding);
        } catch {
          return [];
        }
      },
    };
    session.encoder = client;
    setEncoderState(session, 'ready');
  } catch (error) {
    setEncoderState(session, 'failed', error);
  }
}

/**
 * The vendored family vectors, or null if they are missing or were built from a
 * different model. Null is not an error: the caller computes them instead.
 */
async function vendoredVectors(client, scriptSha256) {
  try {
    const response = await fetch(EXTENDED_VECTORS_URL);
    if (!response.ok) return null;
    const file = await response.json();
    if (!vectorsAreCompatible(file, client, scriptSha256)) return null;
    return file.vectors;
  } catch {
    return null;
  }
}

/**
 * The machine's characters, printed as they arrive.
 *
 * A carriage return is the line's own line discipline, not something to strike
 * on paper; a newline in the text is what the paper's typewriter turns into a
 * carrier return, so the machine's own line ends become the paper's.
 */
function printMachine(text) {
  return printer.print(String(text).replace(/\r/g, ''));
}

// --- the paper ------------------------------------------------------------

form.addEventListener('linefeed', () => {
  form.scrollTop = form.scrollHeight;
});

/** The keyboard is the machine's own: it holds the line only while there is paper. */
const keepFocus = () => {
  if (!form.hidden) keyboard.focus({ preventScroll: true });
};

keyboard.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key !== 'Enter' && event.key !== 'Backspace' && event.key.length !== 1) return;
  event.preventDefault();
  if (event.repeat) return;
  press(event.key);
});

/** The interlocked keyboard accepts one key only when the 1052 is ready. */
function press(key) {
  if (!waiting || printer.busy) return;
  apply(key);
}

function apply(key) {
  if (key === 'Enter') {
    submitLine();
  } else if (key === 'Backspace') {
    if (waiting.text.length > 0) {
      waiting.text = waiting.text.slice(0, -1);
      printer.rubout();
    }
  } else if (key.length === 1) {
    // The recovered CTSS instructions cap each input line at 72 columns.
    if (waiting.terse && waiting.text.length >= 72) return;
    waiting.text += key;
    printer.echo(key.toUpperCase());
  }
}

/**
 * Read from the operator.
 *
 * `blankLineEnds` is TREAD's own rule: it keeps reading cards until one comes
 * back blank, which is why every exchange in the CTSS printouts has an empty
 * line between what was typed and what ELIZA typed back.
 *
 * Resolves null if the session is given up while the read is outstanding.
 */
function readText(blankLineEnds, terse = false) {
  return new Promise((resolve) => {
    waiting = { kind: 'line', text: '', lines: [], blankLineEnds, terse, resolve };
  });
}

/** Drop an outstanding read: the session it belonged to is over. */
function cancelWait() {
  const held = waiting;
  waiting = null;
  held?.resolve(null);
}

function submitLine() {
  const held = waiting;

  if (!held.blankLineEnds) {
    waiting = null;
    // A submitted card gets its spacing from the code that asked for it; a line
    // typed at a live machine is answered by the machine's own carriage return.
    printer.newline(held.terse ? 1 : 2);
    held.resolve(held.text);
    return;
  }

  printer.newline();
  if (held.text.length > 0) {
    held.lines.push(held.text);
    held.text = '';
    return; // TREAD reads the next card
  }
  waiting = null;
  held.resolve(held.lines.join(' '));
}

window.addEventListener('focus', keepFocus);
main();
