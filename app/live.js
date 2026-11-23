/**
 * The 7750 line, seen from the page.
 *
 * The 7094 is in the browser now: the disk containers it boots from ride to
 * the page as one packed image (~10 MB), a Worker rebuilds the modules and
 * runs the machine off the main thread, and this module is the wire between
 * the two — a message port in place of the SSE stream and POST the server
 * used to carry.
 *
 * The paper is not a terminal emulator: it prints the machine's characters in
 * black, including the operator's, exactly as modes 1, 2 and 4 do, and it sends
 * a line only when the operator's carrier returns.
 */

/** Everything the page needs of the machine's line. */
export class LiveLine {
  /**
   * @param {string|URL} [workerUrl]  where the machine's worker lives
   */
  constructor(workerUrl = new URL('../modes/emulate/worker.js?v=2423b2b976c4', import.meta.url)) {
    this.workerUrl = workerUrl;
    this.state = 'closed';
    this.worker = null;
    this.onPrint = null;
    this.pendingPrint = [];
    this.onState = null;
    this.onProgress = null;
    this.onError = null;
    this.onHangup = null;
    this.error = null;
    this.finishConnect = null;
    this.finishBoot = null;
    this.lifetime = null;
  }

  /** True once the line has answered. */
  get live() {
    return this.state !== 'closed';
  }

  /**
   * Open the line.
   *
   * Resolves true when the machine has answered with a state, false if it has
   * not — the page then says so instead of pretending the line is up.
   *
   * @param {object} handlers
   * @param {(text: string) => void} handlers.onPrint   console output, as typed
   * @param {(state: object) => void} handlers.onState  dial/boot progress
   * @param {(progress: object) => void} handlers.onProgress  fetch/unpack/boot
   * @param {(message: string) => void} handlers.onError  a failure the page should show
   * @returns {Promise<boolean>}
   */
  connect({ onPrint, onState, onProgress, onError } = {}) {
    this.close();
    this.lifetime = new AbortController();
    this.onPrint = onPrint;
    this.onState = onState;
    this.onProgress = onProgress;
    this.onError = onError;
    this.error = null;

    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(silence);
        this.finishConnect = null;
        resolve(ok);
      };
      this.finishConnect = done;
      const fail = (message) => {
        this.error = String(message || 'the machine worker could not be loaded');
        this.close();
        this.onError?.(this.error);
      };

      // A worker that never speaks is a line that is not up: fail rather
      // than leave the loader waiting on it forever.
      const silence = setTimeout(() => {
        fail('the machine worker did not answer');
      }, 15000);

      let worker;
      try {
        worker = new Worker(this.workerUrl, { type: 'module' });
      } catch (error) {
        fail(error?.message ?? error);
        return;
      }
      this.worker = worker;

      worker.onmessage = (event) => {
        const message = event.data ?? {};
        if (message.type === 'ready') {
          // The worker loaded and is listening — the answer connect() waits
          // on. Nothing else has run yet, so this is the earliest honest
          // "the machine can run here" the line can give.
          this.state = 'booting';
          done(true);
        } else if (message.type === 'print') {
          done(true);
          if (this.onPrint) this.onPrint(message.text);
          else this.pendingPrint.push(message.text);
        } else if (message.type === 'state') {
          this.state = message.state;
          done(true);
          this.onState?.(message);
        } else if (message.type === 'progress') {
          this.onProgress?.(message);
          if (message.stage === 'boot') this.finishBoot?.(true);
        } else if (message.type === 'hangup') {
          this.state = 'closed';
          this.onHangup?.();
        } else if (message.type === 'error') {
          fail(message.message);
        }
      };

      worker.onerror = (event) => fail(event?.message || 'the machine worker could not be loaded');
      worker.onmessageerror = () => fail('the machine worker sent an unreadable message');
    });
  }

  /**
   * Fetch the packed image and the card deck, hand them to the worker, and
   * start the machine. Progress is reported through `onProgress` so the page
   * can draw the loader.
   *
   * @param {string|URL} packUrl   the packed DASD image
   * @param {string|URL} cmdUrl    the card reader image CTSS expects at boot
   * @returns {Promise<boolean>} whether the machine took the job
   */
  async boot(packUrl, cmdUrl) {
    if (!this.worker) return false;
    const worker = this.worker;
    const { signal } = this.lifetime;
    try {
      const [packResponse, cmdResponse] = await Promise.all([fetch(packUrl, { signal }), fetch(cmdUrl, { signal })]);
      if (!packResponse.ok) throw new Error(`pack ${packResponse.status}`);
      if (!cmdResponse.ok) throw new Error(`cmd ${cmdResponse.status}`);

      const total = Number(packResponse.headers?.get?.('content-length')) || 0;
      const pack = await readResponse(packResponse, (received) => {
        this.onProgress?.({ type: 'progress', stage: 'fetch', received, total });
      });
      const cmd = await cmdResponse.arrayBuffer();
      if (signal.aborted || this.worker !== worker) return false;
      if (!total) {
        this.onProgress?.({ type: 'progress', stage: 'fetch', received: pack.byteLength, total: pack.byteLength });
      }

      return await new Promise((resolve) => {
        let settled = false;
        const timeout = setTimeout(() => finish(false, 'the machine did not finish booting'), 30000);
        const finish = (ok, message) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.finishBoot = null;
          if (message) {
            this.error = message;
            this.close();
            this.onError?.(message);
          }
          resolve(ok);
        };
        this.finishBoot = (ok) => finish(ok);
        worker.postMessage({ type: 'boot', pack, cmd }, [pack, cmd]);
      });
    } catch (error) {
      if (signal.aborted) return false;
      this.error = error?.message ?? String(error);
      this.close();
      this.onError?.(this.error);
      return false;
    }
  }

  /**
   * Type a line at the line. The carriage return is the operator's own: sending
   * a line is what the carrier return does on a 1050.
   *
   * @param {string} text
   * @returns {Promise<boolean>} whether the machine took it
   */
  async send(text) {
    if (this.state === 'closed' || !this.worker) return false;
    this.worker.postMessage({ type: 'send', text: String(text ?? '') });
    return true;
  }

  /** Deliver machine text received during boot before the paper had a listener. */
  flushPrint() {
    if (!this.onPrint || this.pendingPrint.length === 0) return;
    const text = this.pendingPrint.join('');
    this.pendingPrint.length = 0;
    this.onPrint(text);
  }

  close() {
    this.state = 'closed';
    this.pendingPrint.length = 0;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      this.worker.terminate?.();
    }
    this.worker = null;
    this.lifetime?.abort();
    this.finishConnect?.(false);
    this.finishBoot?.(false);
  }
}

async function readResponse(response, onProgress) {
  if (!response.body?.getReader) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
