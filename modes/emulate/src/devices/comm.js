/**
 * The 7750 communications controller, and the lines hanging off it.
 *
 * This is the box a terminal is plugged into. CTSS does not talk to a 1050 —
 * it talks to the 7750, in messages, and the 7750 deals with the lines. So the
 * whole of time-sharing, from the operator's point of view, comes down to this
 * device: what it says the lines have typed, and what it is told to print back.
 *
 * Everything on the wire is twelve bits, three to a word. There are two kinds
 * of message and they are not symmetrical.
 *
 * Input, which the 7094 reads:
 *
 *     char 0      a twelve bit message sequence number
 *     then pairs  line number (with 02000 set to say the line is valid)
 *                 the character that line sent
 *     end         03777, end of medium, padded out to a whole word
 *
 * Output, which the 7094 writes:
 *
 *     word 0      line number in bits 24-32, character count in bits 12-23,
 *                 with 0200000000000 for twelve bit characters and
 *                 0100000000000 for a control message
 *     then        the characters, three to a word
 *     end         07777, end of medium
 *
 * Data characters are ones-complemented, which is the detail most likely to
 * produce something that looks almost like text. An input character is seven
 * bits plus a parity bit, complemented; an output character has a start bit
 * below that as well, so reading one means complementing and then shifting
 * right by one.
 *
 * A message of all ones is not a message: it turns the 7750 on. CTSS sends it
 * once at startup and the controller is dead until it arrives.
 *
 * Reference: SIMH's i7094_com.c, which is itself a reconstruction from what
 * CTSS does, since very little about the real 7750 survives.
 */

import { HALF } from '../word.js';
import { SEL_READ, SEL_WRITE, SEL_SENSE, SEQUENCE_CHECK, INHIBIT_ATTENTION1 } from '../channel9.js';

/** Lines, plus the one the operator's own typewriter is wired to. */
export const LINE_COUNT = 32;
export const CONSOLE_LINE = LINE_COUNT - 1;

/**
 * Line numbers on the wire start at four. The first four are the controller's
 * own business and never correspond to a terminal.
 */
const LINE_BASE = 4;

/** Input: control codes a line can send instead of a character. */
export const VALID_LINE = 0o2000;
export const PARITY = 0o200;
export const DIALUP = 0o2001;
export const END_ID = 0o2002;
export const INTERRUPT = 0o2003;
export const QUIT = 0o2004;
export const HANGUP = 0o2005;
export const END_OF_MEDIUM = 0o3777;
/** A completion message says how many characters a line has finished printing. */
const COMPLETION = 0o3000;
const COMPLETION_MAX = 31;

/**
 * s709 checks idle lines every 10 ms and reports completions after six polls.
 * The emulator checks its channel much faster, so it uses the same wall time
 * before the five channel checks below can raise attention.
 */
const IDLE_POLLS = 5;
const COMPLETION_IDLE_MS = 60;

/** Terminal identifiers, sent when the controller asks a new line who it is. */
export const ID_KSR35 = 1;
export const ID_KSR37 = 7;

/**
 * Output: the first word of a message is a twelve bit line id and a twelve
 * bit count sharing the word with the first data character. Bit 9 of the
 * line id — word bit 33 — says the characters are twelve bits wide. There is
 * no control flag in the header: control arrives in-band as the escape
 * character 03777, which makes the next character a control operation, and
 * 03770 asks the controller to hang the line up.
 */
const OUT_12BIT = 0o200000;     // word bit 34
const OUT_END_OF_MEDIUM = 0o7777;
const OUT_CONTROL_ESCAPE = 0o3777;
const OUT_HANGUP = 0o3770;

/** Sense bits the 7094 reads to find out why it was interrupted. */
export const SENSE = {
  PROGRAM_CHECK: 0o400000,
  DATA_CHECK: 0o200000,
  EXCEPTIONAL: 0o100000,
  MESSAGE_LENGTH: 0o004000,
  CHANNEL_HOLD: 0o002000,
  CHANNEL_QUEUE_FULL: 0o001000,
  DATA_READY: 0o000004,
  INPUT_BUFFER_FREE: 0o000002,
  SERVICE_READY: 0o000001,
};

/** Controller states. */
const IDLE = 0;
const READ_BUILD = 1;
const READ_SEND = 2;
const READ_END = 3;
const WRITE_FIRST = 4;
const WRITE_REST = 5;
const WRITE_DONE = 6;
const SENSING = 7;

/** Even parity, for the seven bit codes a KSR-37 sends. */
const EVEN_PARITY = (() => {
  const table = new Uint8Array(128);
  for (let c = 0; c < 128; c++) {
    let bits = 0;
    for (let b = 0; b < 7; b++) if (c & (1 << b)) bits += 1;
    table[c] = bits & 1;
  }
  return table;
})();

/**
 * One line. A line is a queue in each direction and a little state about what
 * kind of terminal is on the end of it.
 */
export class Line {
  constructor(number, { ksr35 = false } = {}) {
    this.number = number;
    this.ksr35 = ksr35;
    this.input = [];
    this.output = [];
    this.connected = false;
    this.needId = false;
    this.noEcho = false;
    /** Set when the line has a whole line of input waiting to be collected. */
    this.inputPending = false;
    /** Characters printed but not yet accounted for to the 7094. */
    this.notReturned = 0;
    /** Where printed text goes. The page in app/ replaces this. */
    this.onPrint = null;
  }

  print(text) {
    if (this.onPrint) this.onPrint(text);
  }
}

export class CommunicationsController {
  constructor({ lines = LINE_COUNT } = {}) {
    this.channel = null;
    this.lines = [];
    for (let i = 0; i < lines; i++) this.lines.push(new Line(i));

    /** Nothing works until CTSS sends the all-ones message. */
    this.enabled = false;
    this.state = IDLE;
    this.messageNumber = 0;
    this.sense = 0;
    this.stopped = false;

    /** The message being assembled or handed over, as 36-bit word pairs. */
    this.buffer = [];
    this.pointer = 0;
    this.limit = 0;
    this.senseIndex = 0;

    /** The characters that mean interrupt and quit on these lines. */
    this.interruptCharacter = 0o003;   // control C
    this.quitCharacter = 0o034;        // control backslash

    /**
     * Completions owed to the 7094 that it has not been told about yet, and
     * when it can report them. This models s709's `complcount`/`idlecnt` pair:
     * a line's completions become a message of their own after an idle
     * interval, and attention is raised for them.
     */
    this.signalled = false;
    this.idlePolls = 0;
    this.completionReadyAt = 0;
  }

  reset() {
    this.enabled = false;
    this.state = IDLE;
    this.messageNumber = 0;
    this.sense = 0;
    this.stopped = false;
    this.buffer = [];
    this.signalled = false;
    this.idlePolls = 0;
    this.completionReadyAt = 0;
    for (const line of this.lines) {
      line.input.length = 0;
      line.output.length = 0;
      line.inputPending = false;
      line.notReturned = 0;
    }
  }

  // ====================================================================
  // The operator's side
  // ====================================================================

  /**
   * A key was pressed on a line. Characters are queued as the 7750 would hold
   * them: folded to upper case for a KSR-35, given even parity for a KSR-37,
   * and then ones-complemented.
   *
   * A carriage return is what makes the line "pending": CTSS is line at a time,
   * and the controller does not raise attention for a half-typed line.
   */
  typeCharacter(number, code) {
    const line = this.lines[number];
    if (!line || !this.enabled) return;

    let value;
    if (code === this.interruptCharacter) {
      value = INTERRUPT;
      line.inputPending = true;
    } else if (code === this.quitCharacter) {
      value = QUIT;
      line.inputPending = true;
    } else {
      let c = code & 0o177;
      if (c === 0o15) line.inputPending = true;          // carriage return
      if (line.ksr35) {
        if (c >= 0x61 && c <= 0x7a) c -= 0x20;           // fold to upper case
      } else if (EVEN_PARITY[c]) {
        c |= PARITY;
      }
      value = (~c) & 0o377;
    }
    line.input.push(value);
    if (line.inputPending) this.announce();
  }

  /** Type a whole line, the way the page hands one over, return included. */
  typeLine(number, text) {
    for (const character of text) this.typeCharacter(number, character.charCodeAt(0));
    this.typeCharacter(number, 0o15);
  }

  /**
   * A terminal dialed in on a line. The 7750 reports the event as a DIALUP
   * followed by the terminal's model identification and END_ID — s709's
   * senddialup queues exactly this sequence when a socket connects. CTSS
   * answers with the identification exchange and, eventually, a banner.
   */
  dialUp(number, { ksr35 = false } = {}) {
    const line = this.lines[number];
    if (!line || !this.enabled) return;
    line.ksr35 = ksr35;
    line.connected = true;
    line.input.push(DIALUP, ksr35 ? ID_KSR35 : ID_KSR37, 0, 0, 0, END_ID);
    line.inputPending = true;
    this.announce();
  }

  /** The terminal hung up: one HANGUP control code, then attention. */
  hangUp(number) {
    const line = this.lines[number];
    if (!line || !this.enabled) return;
    line.connected = false;
    line.input.push(HANGUP);
    line.inputPending = true;
    this.announce();
  }

  /** Tell the channel there is something to collect. */
  announce() {
    this.sense |= SENSE.DATA_READY;
    if (this.channel) this.channel.setAttention();
  }

  /** True when any line has a complete line of input, or owes a completion. */
  get hasInput() {
    return this.lines.some((line) => line.inputPending || line.notReturned > 0);
  }

  // ====================================================================
  // The channel side
  // ====================================================================

  select(channel, selection) {
    this.channel = channel;
    if (this.state !== IDLE) {
      channel.raise(SEQUENCE_CHECK);
      return;
    }
    this.stopped = false;

    switch (selection) {
      case SEL_READ:
        this.sense = 0;
        this.state = READ_BUILD;
        channel.request = true;
        break;

      case SEL_WRITE:
        this.sense = 0;
        this.state = WRITE_FIRST;
        this.buffer = [];
        this.pointer = 0;
        channel.request = true;
        break;

      case SEL_SENSE:
        this.state = SENSING;
        this.senseIndex = 0;
        channel.request = true;
        break;

      default:
        // The 7750 has no control select: everything is done in messages.
        channel.setEnd();
        break;
    }
  }

  /** A word of an outgoing message. */
  write(channel, hi, lo, stop) {
    this.channel = channel;
    if (stop) {
      // The channel stops the transfer when its count runs out. That is how
      // every message ends — s709 streams the characters as they arrive, so
      // the stop is just the end — not an abort. Whatever was gathered is a
      // complete message if it holds an end of medium.
      if (this.state === WRITE_REST && this.buffer.length > 0) this.deliver(channel);
      else this.state = IDLE;
      this.stopped = true;
      return;
    }

    if (this.state === WRITE_FIRST) {
      // All ones is the message that turns the controller on.
      if (hi === HALF && lo === HALF) {
        this.enabled = true;
        this.messageNumber = 0;
        this.state = IDLE;
        channel.setEnd();
        return;
      }
      this.buffer = [[hi, lo]];
      // The count is in bits 12-23 of the word: the low six bits of the high
      // half and the top six of the low half.
      const count = (((hi & 0o77) << 6) | ((lo >>> 12) & 0o77)) & 0o7777;
      // The count is of data characters; the end of medium adds one more, and
      // twelve bit characters take two six bit slots each. The header's own
      // two characters are the six that gets added before the division, which
      // truncates — the message is not padded out to a whole word.
      const slots = (count + 1) * (hi & OUT_12BIT ? 2 : 1);
      this.limit = Math.max(1, Math.floor((slots + 6 + 5) / 6));
      this.state = WRITE_REST;
      channel.request = true;
      return;
    }

    if (this.state === WRITE_REST) {
      this.buffer.push([hi, lo]);
      if (this.buffer.length >= this.limit) {
        this.deliver(channel);
        return;
      }
      channel.request = true;
    }
  }

  /** The line a message is addressed to, or null if there is no such line. */
  lineOf(hi, lo) {
    // Bits 24-32 of the word: the low nine bits of the high half above bit 6.
    const wire = (hi >>> 6) & 0o777;
    if (wire < LINE_BASE) return null;
    const number = wire - LINE_BASE;
    return number < this.lines.length ? number : null;
  }

  /** The message is complete: turn it into characters and print them. */
  deliver(channel) {
    const first = this.buffer[0];
    const number = this.lineOf(first[0], first[1]);
    this.state = WRITE_DONE;
    if (number === null) {
      this.sense |= SENSE.PROGRAM_CHECK;
      this.state = IDLE;
      channel.setEnd();
      return;
    }

    const line = this.lines[number];
    const characters = unpack(this.buffer);
    // The header's count is the number of data characters the 7094 believes
    // it sent; the line owes that many completions back, however they print.
    line.notReturned += characters[1] & 0o7777;
    let text = '';
    // The first two characters are the header, not data. After that the
    // stream is s709's: an end of medium stops the message, the escape
    // character makes the next one a control operation, and a hangup
    // request drops the line.
    for (let i = 2; i < characters.length; i++) {
      const raw = characters[i];
      if (raw === OUT_END_OF_MEDIUM) break;
      if (raw === OUT_CONTROL_ESCAPE) {                  // next char is control
        i += 1;
        continue;
      }
      if (raw === OUT_HANGUP) {
        line.connected = false;
        continue;
      }
      const decoded = decodeOutput(raw, line);
      if (decoded) text += decoded;
    }
    if (text) line.print(text);

    this.state = IDLE;
    // A line that has just been sent a message owes completions for it: that
    // is a new thing for the controller to report, so the idle cycle below is
    // allowed to raise attention for it again.
    if (line.notReturned > 0) {
      this.signalled = false;
      this.completionReadyAt = Date.now() + COMPLETION_IDLE_MS;
    }
    channel.setEnd();
  }

  /**
   * True when the controller is idle but still owes some line completions the
   * 7094 has not been told about. This is the one thing that makes the
   * controller ask for attention on its own, which is what s709 does from its
   * communications task. Without it the 7094 only ever learns of completions
   * from inside a read message it happens to ask for, CTSS's per-line output
   * accounting climbs past the line's buffer and the job is left in STATUS 5
   * (OUTPUT WAIT, "output buffers filled") with nothing left to wake it.
   */
  get wantsAttention() {
    return this.enabled && this.state === IDLE && !this.signalled
      && Date.now() >= this.completionReadyAt
      && this.lines.some((line) => line.notReturned > 0);
  }

  /**
   * The controller's own cycle, taken while no operation is in flight. s709's
   * communications task does this when the line it serves is quiet: after
   * MAXIDLECNT idle polls it hands the completions over as a message of their
   * own and raises attention (commdev.c commwork:514-531).
   */
  idle(channel) {
    if (!this.wantsAttention || channel.inInterrupt ||
        (channel.sms & INHIBIT_ATTENTION1)) {
      if (!this.wantsAttention) this.idlePolls = 0;
      return;
    }
    if (++this.idlePolls <= IDLE_POLLS) return;
    this.idlePolls = 0;
    this.signalled = true;
    channel.setAttention();
  }

  /**
   * The controller's own cycle. Building an input message and handing it over
   * happen here, because both are things the device does to the channel rather
   * than the other way round.
   */
  service(channel) {
    this.channel = channel;
    if (this.stopped) return;

    switch (this.state) {
      case READ_BUILD:
        this.buffer = this.collect();
        this.pointer = 0;
        this.state = READ_SEND;
        channel.request = true;
        break;

      case READ_SEND:
        if (this.pointer >= this.buffer.length) {
          this.state = READ_END;
          channel.setEnd();
          return;
        }
        {
          const [hi, lo] = this.buffer[this.pointer++];
          channel.inputWord(hi, lo);
        }
        break;

      case READ_END:
        this.state = IDLE;
        if (this.hasInput) channel.setAttention();
        break;

      case WRITE_FIRST:
      case WRITE_REST:
        channel.request = true;                          // ready for the next
        break;

      case SENSING:
        this.sendSense(channel);
        break;

      default:
        break;
    }
  }

  /**
   * Gather what every line has to say and pack the lot into a message. A line
   * with a complete line of input hands over all of it at once — the 7750 is
   * line-at-a-time, and s709 drains the whole ring into one message the same
   * way. Completions are still accounted one count per line.
   */
  collect() {
    const characters = [this.messageNumber & 0o3777];
    this.messageNumber = (this.messageNumber + 1) & 0o3777;

    for (let number = 0; number < this.lines.length; number++) {
      const line = this.lines[number];

      while (line.notReturned > 0) {
        // Send every completion in groups of at most 31 before any input from
        // the same line, as s709's commgo does.
        const count = Math.min(line.notReturned, COMPLETION_MAX);
        line.notReturned -= count;
        this.signalled = false;
        characters.push((number + LINE_BASE) | VALID_LINE);
        characters.push(COMPLETION + count);
      }
      if (line.inputPending) {
        // A pending line drains all at once: s709 empties the whole ring into
        // one message, which is how the six character dialup sequence — and a
        // typed command line — arrives intact rather than one pair at a time.
        while (line.input.length > 0) {
          characters.push((number + LINE_BASE) | VALID_LINE);
          characters.push(line.input.shift() & 0o7777);
        }
        line.inputPending = false;
      }
    }

    // Even a three-character completion message needs its own EOM; otherwise
    // CTSS reads old core words as the end of the next input card.
    characters.push(END_OF_MEDIUM);
    while (characters.length % 3 !== 0) characters.push(END_OF_MEDIUM);
    return pack(characters);
  }

  /** Ten characters of status, two words of it. */
  sendSense(channel) {
    if (this.senseIndex === 0) {
      let bits = this.sense;
      if (this.hasInput) bits |= SENSE.DATA_READY;
      bits |= SENSE.INPUT_BUFFER_FREE;
      channel.inputWord(bits & HALF, 0);
      this.senseIndex = 1;
      return;
    }
    if (this.senseIndex === 1) {
      channel.inputWord(0, 0);
      this.senseIndex = 2;
      return;
    }
    this.state = IDLE;
    channel.setEnd();
  }
}

/** Pack twelve bit characters three to a word. */
function pack(characters) {
  const words = [];
  for (let i = 0; i < characters.length; i += 3) {
    const a = characters[i] & 0o7777;
    const b = (characters[i + 1] ?? END_OF_MEDIUM) & 0o7777;
    const c = (characters[i + 2] ?? END_OF_MEDIUM) & 0o7777;
    words.push([((a << 6) | (b >>> 6)) & HALF, (((b & 0o77) << 12) | c) & HALF]);
  }
  return words;
}

/** Unpack words into twelve bit characters. */
function unpack(words) {
  const characters = [];
  for (const [hi, lo] of words) {
    characters.push((hi >>> 6) & 0o7777);
    characters.push((((hi & 0o77) << 6) | ((lo >>> 12) & 0o77)) & 0o7777);
    characters.push(lo & 0o7777);
  }
  return characters;
}

/**
 * One output character, as text. Complementing and shifting right by one drops
 * the start bit and the parity bit together. DC2 and DC4 are not printed: they
 * turn this line's echo off and on.
 */
function decodeOutput(raw, line) {
  const c = (~raw >> 1) & 0o177;
  if (c >= 0o40 && c !== 0o177) {
    let out = c;
    if (line.ksr35 && out >= 0x61 && out <= 0x7a) out -= 0x20;
    return String.fromCharCode(out);
  }
  switch (c) {
    case 0o11: return '\t';
    case 0o14: return '\f';
    case 0o10: return '\b';
    case 0o7: return '\x07';
    case 0o15: return '\r\n';
    case 0o12: return '\r\n';
    case 0o22: line.noEcho = true; return '';
    case 0o24: line.noEcho = false; return '';
    default: return '';
  }
}
