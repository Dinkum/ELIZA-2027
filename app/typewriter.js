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
 * Carrier return time is not given in the manual; it is modelled as a fixed
 * engage time plus travel proportional to the distance back to the left
 * margin, which is how the Selectric mechanism behaves.
 */

const CHARS_PER_SECOND = 14.8;
const MS_PER_CHARACTER = 1000 / CHARS_PER_SECOND;
const CARRIER_RETURN_MS = 90;
const CARRIER_RETURN_MS_PER_COLUMN = 2.4;
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
   * @param {'black'|'red'} [options.ribbon]  automatic ribbon shift colour
   * @param {string} [options.field]  tag the run of characters as a click target
   * @param {string[]} [options.classes]
   */
  print(text, options = {}) {
    return this.#enqueue(async () => {
      let run = this.#openRun(options);
      for (const char of this.#wrap(text, this.column)) {
        if (char === '\n') {
          await this.#carrierReturn();
          run = this.#openRun(options);
          continue;
        }
        this.#strike(char, run, options);
        await sleep(MS_PER_CHARACTER + jitter(MS_PER_CHARACTER * 0.12));
      }
    });
  }

  /** Print with no delay — used to echo the operator's own keystrokes. */
  echo(text, options = {}) {
    return this.#enqueue(async () => {
      let run = this.#openRun(options);
      for (const char of this.#wrap(text, this.column)) {
        if (char === '\n') {
          await this.#carrierReturn();
          run = this.#openRun(options);
        } else {
          this.#strike(char, run, options);
        }
      }
    });
  }

  /** Back the carrier up one position and lift the character off the paper. */
  rubout() {
    return this.#enqueue(async () => {
      const struck = this.carrier.previousElementSibling;
      if (!struck) return;
      if (struck.classList.contains('run')) {
        struck.lastElementChild?.remove();
        if (!struck.firstElementChild) struck.remove();
      } else {
        struck.remove();
      }
      this.column = Math.max(0, this.column - 1);
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
   * Break text so no word crosses the right margin.
   * Spacing is left exactly as given: the machine prints what it is sent, and
   * columns of spaces are how the paper gets laid out.
   */
  #wrap(text, startColumn) {
    const chars = [...String(text)];
    const out = [];
    let column = startColumn;

    for (let i = 0; i < chars.length; i += 1) {
      const char = chars[i];

      if (char === '\n') {
        out.push('\n');
        column = 0;
        continue;
      }
      if (char === ' ') {
        if (column >= this.margin) {
          out.push('\n');
          column = 0;
        } else {
          out.push(' ');
          column += 1;
        }
        continue;
      }

      // Start of a word: return the carrier first if it will not fit whole.
      let end = i;
      while (end < chars.length && chars[end] !== ' ' && chars[end] !== '\n') end += 1;
      const width = end - i;
      if (column > 0 && column + width > this.margin && width <= this.margin) {
        out.push('\n');
        column = 0;
      }
      for (; i < end; i += 1) {
        if (column >= this.margin) {
          out.push('\n');
          column = 0;
        }
        out.push(chars[i]);
        column += 1;
      }
      i -= 1;
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
    const span = document.createElement('span');
    span.className = `ch ribbon-${ribbon}`;
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

    if (run) run.appendChild(span);
    else this.line.insertBefore(span, this.carrier);

    this.column += 1;
    this.onStrike?.(char);
    if (this.column === this.margin - BELL_FROM_RIGHT_MARGIN) this.onBell?.();
  }

  async #carrierReturn() {
    const travel = CARRIER_RETURN_MS + this.column * CARRIER_RETURN_MS_PER_COLUMN;
    this.#feed();
    await sleep(travel);
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
