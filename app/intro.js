/**
 * What the desk offers before the paper is handed the line.
 *
 * Two short lists — the modes, and, for the modes that read an archive tape, the
 * versions — plus the one thing about them that is not fixed: whether a 7094 is
 * answering at this origin. Nothing here touches the DOM or the paper, so the
 * choices can be reasoned about without one.
 *
 * The copy is the reading of each program in one line. It is deliberately
 * flat: a spec line, not a pitch.
 */

/** The four programs, in the order the desk lists them. */
export const MODES = [
  { key: 'rewrite', label: 'JS REWRITE', line: 'Written in modern JavaScript', kind: 'script' },
  { key: 'port', label: 'JS PORT', line: 'Archeological rewrite in JavaScript', kind: 'script' },
  { key: 'live', label: 'EMULATION', line: 'ELIZA running under CTSS on an emulated IBM 7094', kind: 'live' },
  { key: 'extended', label: 'EXTENDED', line: 'The original concepts (decomposition rules, pattern matching, response lists, and conversational memory) but extended', kind: 'own' },
];

/** Each choice pairs a program with its DOCTOR script. */
export const VERSIONS = [
  { key: '1965b', label: '1965B', line: 'Recovered program and its DOCTOR script.' },
  { key: '1966', label: '1966', line: 'Reconstructed program and the published DOCTOR script.' },
];

/** What the desk says when this browser cannot run the machine. */
export const LINE_DOWN = 'This browser cannot run the 7094. Mode 3 needs a worker and the packed image.';

/** The header on each screen. */
export const DOCKET = 'ELIZA 2027';

/** The title of each screen. */
export const TITLES = { modes: 'Pick A Mode', version: 'Pick A Version' };

/**
 * Where the line the operator runs.
 *
 * `script` reads one of the two archive tapes, `live` boots the corresponding
 * compiled CTSS disk, and `own` carries a script of its own.
 */
export function needsVersion(mode) {
  return mode?.kind === 'script' || mode?.kind === 'live';
}

/**
 * The screen the BACK control returns to.
 *
 * BACK is not offered on the first screen: there is nothing behind it. From a
 * paper session it returns to the version screen when the mode had one, and to
 * the modes otherwise.
 *
 * @param {'modes'|'version'|'paper'} screen
 * @param {object} [mode]  the mode the session was opened with
 * @returns {'modes'|'version'|null}
 */
export function previousScreen(screen, mode) {
  if (screen === 'version') return 'modes';
  if (screen === 'paper') return needsVersion(mode) ? 'version' : 'modes';
  return null;
}

/**
 * Can this browser run the 7094?
 *
 * Mode 3 is the machine's own console line, and the machine is a Web Worker
 * the page boots from a packed image. Where the browser cannot give the page
 * a module worker — or the image is not there to fetch — the choice is not
 * offered, rather than offered and then failing.
 *
 * A reachable pack is not enough on its own: the answer has to parse as a
 * PTK1 header, because a host that answers every path with its own page is
 * not a disk image either.
 *
 * @param {typeof fetch} [fetchImpl]  injectable for tests
 * @param {string|URL} [packUrl]    where the packed image lives
 * @returns {Promise<boolean>}
 */
export async function liveLineAvailable(fetchImpl = globalThis.fetch, packUrl = 'modes/emulate/ctss-dasd.pack') {
  // `Worker` is undefined under `node --test`, where this function is exercised
  // with an injected fetch; the gate is for browsers that truly lack workers.
  const hasWorker = typeof Worker === 'function' || typeof process !== 'undefined';
  if (!hasWorker || typeof fetchImpl !== 'function') return false;
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(2500) : undefined;
    const response = await fetchImpl(packUrl, { headers: { range: 'bytes=0-11' }, signal });
    if (!response?.ok) return false;
    let head;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const bytes = new Uint8Array(12);
      let count = 0;
      while (count < bytes.length) {
        const { done, value } = await reader.read();
        if (done) break;
        const take = Math.min(value.byteLength, bytes.length - count);
        bytes.set(value.subarray(0, take), count);
        count += take;
      }
      await reader.cancel();
      head = bytes.subarray(0, count).buffer;
    } else {
      head = await response.arrayBuffer();
    }
    if (head.byteLength < 12) return false;
    const view = new DataView(head);
    return view.getUint32(0) === 0x50544b31 && view.getUint32(4) === 2;
  } catch {
    return false;
  }
}
