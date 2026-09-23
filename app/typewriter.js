/**
 * IBM 1050 / 1052 Printer-Keyboard.
 *
 * The 1052 prints with a Selectric mechanism: the paper stays still and a
 * single type element moves across the line. Timings below come from the
 * system operation manual (references/IBM-1050-system-operation-manual-1965.pdf):
 *
 *   "The maximum character rate of the system is 14.8 characters per second.
 *    The maximum keying speed is also 14.8 characters per second."
 *   "The horizontal spacing of the printed characters is either ten or twelve
 *    characters per inch ... Either six or eight lines-per-inch vertical
 *    spacing is also available."
 *   "A signal bell operates when the printing element carrier moves to within
 *    twelve character positions from the right margin."
 *
 * The 1050 manual gives carrier-return time as (1.5 + T) × 67.5 ms, where T
 * is inches of carrier travel. The paper uses ten character positions per inch.
 */

const CHARS_PER_SECOND = 14.8;
const MS_PER_CHARACTER = Math.ceil(1000 / CHARS_PER_SECOND);
const CHARACTER_WIDTH_INCHES = 0.1;
const CARRIER_RETURN_CHARACTER_TIMES = 1.5;
const CHARACTER_TIME_MS = 67.5;
const BELL_FROM_RIGHT_MARGIN = 12;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Printing is mechanical, not metronomic: vary each strike a little. */
const jitter = (amount) => (Math.random() * 2 - 1) * amount;

export class Typewriter {
  pending = 0;

  /**
   * @param {HTMLElement} sheet  element the printed lines are appended to
   * @param {object} options
   * @param {number} [options.margin]  right margin, in character positions
   * @param {number} [options.ribbonWear]  optional ink-transfer variation, 0 to 1
   * @param {number} [options.strikeVariation]  optional registration variation, 0 to 1
   * @param {() => void} [options.onBell]
   * @param {(char: string) => void} [options.onStrike]
   */
  constructor(sheet, { margin = 80, ribbonWear = 0, strikeVariation = 0,
    onBell, onStrike } = {}) {
    this.sheet = sheet;
    this.margin = margin;
    this.ribbonWear = Math.max(0, Math.min(1, ribbonWear));
    this.strikeVariation = Math.max(0, Math.min(1, strikeVariation));
    this.onBell = onBell;
    this.onStrike = onStrike;

    this.column = 0;
    this.line = null;
    this.carrier = document.createElement('span');
    this.carrier.className = 'carrier';
    this.queue = Promise.resolve();
    this.#feed();
  }

  /** True while the element is still printing. */
  get busy() {
    return this.pending > 0;
  }

  /**
   * Print text at machine speed, wrapping at the right margin.
   * @param {string} text
   * @param {object} [options]
   * @param {'black'|'red'} [options.ribbon]  explicit ribbon colour
   * @param {string} [options.field]  tag the run of characters as a click target
   * @param {string[]} [options.classes]
   */
  print(text, options = {}) {
    return this.#enqueue(async () => {
      let run = null;
      for (const char of this.#wrap(text, this.column)) {
        if (char === '\n') {
          await this.#carrierReturn();
          run = null;
          continue;
        }
        if (!run && !this.carrier.nextElementSibling) run = this.#openRun(options);
        this.#strike(char, run, options);
        await sleep(MS_PER_CHARACTER + Math.random() * MS_PER_CHARACTER * 0.12);
      }
    });
  }

  /** Echo operator keys at the 1052's maximum keying speed. */
  echo(text, options = {}) {
    return this.#enqueue(async () => {
      let run = null;
      for (const char of this.#wrap(text, this.column)) {
        if (char === '\n') {
          await this.#carrierReturn();
          run = null;
        } else {
          if (!run && !this.carrier.nextElementSibling) run = this.#openRun(options);
          this.#strike(char, run, options);
          await sleep(MS_PER_CHARACTER);
        }
      }
    });
  }

  /** Back the carrier up one position, leaving every impression on the paper. */
  rubout() {
    return this.#enqueue(async () => {
      let struck = this.carrier.previousElementSibling;
      if (!struck && this.carrier.parentElement?.classList.contains('run')) {
        struck = this.carrier.parentElement.previousElementSibling;
        if (struck) this.carrier.parentElement.before(this.carrier);
      }
      if (!struck) return;
      if (struck.classList.contains('run')) {
        struck.insertBefore(this.carrier, struck.lastElementChild);
      } else {
        struck.before(this.carrier);
      }
      this.column -= 1;
      await sleep(MS_PER_CHARACTER);
    });
  }

  /** Carrier return and line feed. */
  newline(count = 1) {
    return this.#enqueue(async () => {
      for (let i = 0; i < count; i += 1) await this.#carrierReturn();
    });
  }

  pause(ms) {
    return this.#enqueue(() => sleep(ms));
  }

  /** Queue work so everything prints in the order it was asked for. */
  #enqueue(job) {
    this.pending += 1;
    this.queue = this.queue.then(job).finally(() => {
      this.pending -= 1;
    });
    return this.queue;
  }

  /**
   * Return at the right margin, without looking ahead to the next word.
   * Spaces are struck in their own columns, just like other characters.
   */
  #wrap(text, startColumn) {
    const out = [];
    let column = startColumn;

    for (const char of String(text)) {
      if (char === '\n') {
        out.push('\n');
        column = 0;
        continue;
      }
      if (column >= this.margin) {
        out.push('\n');
        column = 0;
      }
      out.push(char);
      column += 1;
      if (column === this.margin) {
        out.push('\n');
        column = 0;
      }
    }
    return out;
  }

  /** A run groups the characters of one field so it can be clicked or marked. */
  #openRun({ field, classes = [], ribbon = 'black' } = {}) {
    if (!field && classes.length === 0) return null;
    const run = document.createElement('span');
    run.className = ['run', `ribbon-${ribbon}`, ...classes].join(' ');
    if (field) run.dataset.field = field;
    this.line.insertBefore(run, this.carrier);
    return run;
  }

  #strike(char, run, { ribbon = 'black' } = {}) {
    const next = this.carrier.nextElementSibling;
    const occupied = next?.classList.contains('ch') ? next : null;
    const span = document.createElement('span');
    span.className = `${occupied ? 'overstrike' : 'ch'} ribbon-${ribbon}`;
    if (this.ribbonWear > 0) {
      const density = 1 - this.ribbonWear * (0.04 + Math.random() * 0.13);
      span.style.setProperty('--weight', density.toFixed(3));
    }
    if (this.strikeVariation > 0) {
      span.style.setProperty('--dx', `${jitter(0.1 * this.strikeVariation).toFixed(2)}px`);
      span.style.setProperty('--dy', `${jitter(0.15 * this.strikeVariation).toFixed(2)}px`);
      span.style.setProperty('--tilt', `${jitter(0.2 * this.strikeVariation).toFixed(2)}deg`);
    }
    span.textContent = char;

    if (occupied) {
      occupied.appendChild(span);
      occupied.after(this.carrier);
      if (this.carrier.parentElement.classList.contains('run') &&
          !this.carrier.nextElementSibling) {
        this.carrier.parentElement.after(this.carrier);
      }
    } else if (run) run.appendChild(span);
    else this.line.insertBefore(span, this.carrier);

    this.column += 1;
    this.onStrike?.(char);
    if (this.column === this.margin - BELL_FROM_RIGHT_MARGIN) this.onBell?.();
  }

  async #carrierReturn() {
    const travel = (CARRIER_RETURN_CHARACTER_TIMES + this.column * CHARACTER_WIDTH_INCHES) * CHARACTER_TIME_MS;
    const distance = Math.max(0,
      this.carrier.getBoundingClientRect().left - this.line.getBoundingClientRect().left);
    const motion = distance > 0 ? this.carrier.animate?.([
      { transform: 'translateX(0)' },
      { transform: `translateX(-${distance}px)` },
    ], { duration: travel, easing: 'linear', fill: 'forwards' }) : null;
    await sleep(travel);
    motion?.cancel();
    this.#feed();
  }

  #feed() {
    this.line = document.createElement('div');
    this.line.className = 'line';
    this.line.appendChild(this.carrier);
    this.sheet.appendChild(this.line);
    this.column = 0;
    this.sheet.dispatchEvent(new CustomEvent('linefeed', { bubbles: true }));
  }
}
