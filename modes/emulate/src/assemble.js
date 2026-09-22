/**
 * A small FAP-flavoured assembler.
 *
 * Enough of FAP to write test programs, bootstrap loaders and console patches
 * by hand, in the notation the CTSS listings use:
 *
 *     LOOP   CLA*  TABLE,2         indirect, indexed by register 2
 *            TIX   LOOP,1,1        decrement index 1 and loop
 *            HTR   0
 *     TABLE  OCT   000000000007
 *            BCI   1,HELLO         six characters of BCD
 *            END   LOOP
 *
 * A line is `[label] mnemonic [variable field] [comment]`, free-form rather than
 * column-bound. The variable field is `address,tag,decrement`, any part of which
 * may be a symbol, a decimal number, an octal number written `O'777'`, or `*`
 * for the current location counter.
 *
 * This is not a complete FAP — no macros, no literals, no relocatable output.
 * It assembles absolute core images, which is what the emulator loads.
 */

import { POSITIVE, NEGATIVE, SENSE_POSITIVE, SENSE_NEGATIVE } from './opcodes.js';
import { HALF, ADDR } from './word.js';
import { toBCD } from './bcd.js';

/** mnemonic -> { hi bits of the opcode, kind } */
const OPS = new Map();

function defineTable(table, negative) {
  table.forEach((name, code) => {
    if (!name || OPS.has(name)) return;
    OPS.set(name, { kind: 'normal', op: (negative ? 0o100000 : 0) | code });
  });
}
defineTable(POSITIVE, false);
defineTable(NEGATIVE, true);

/**
 * The sense group: one opcode, 0760, with the address field selecting which
 * instruction is meant. The tables spell the ones that take an operand with the
 * operand attached — SLN1 through SLN4, SWT1 through SWT6 — so `SLN 2` is
 * assembled by joining the two before the lookup.
 */
function defineSense(table, negative) {
  table.forEach((name, code) => {
    if (!name || OPS.has(name)) return;
    OPS.set(name, { kind: 'sense', op: negative ? 0o100760 : 0o0760, address: code });
  });
}
defineSense(SENSE_POSITIVE, false);
defineSense(SENSE_NEGATIVE, true);
// s709's display table misspells enter-floating-trap-mode; accept both.
OPS.set('EFTM', OPS.get('ETFM'));

/** The index class, which lives in the prefix bits. */
const INDEX_OPS = {
  TXI: 0o001000, TIX: 0o002000, TXH: 0o003000,
  STR: 0o101000, TNX: 0o102000, TXL: 0o103000,
};
for (const [name, op] of Object.entries(INDEX_OPS)) {
  OPS.set(name, { kind: 'index', op });
}

/** The channel-addressed members of the sense group, named by channel letter. */
const CHANNEL_SENSE = { BTT: 0o000, ETT: 0o000, RIC: 0o350, RDC: 0o352, SPR: 0o360 };

/**
 * Channel command words. These are not instructions — the processor never
 * executes them — but they are written in the same source and assemble to a
 * word whose prefix field names the operation. Syntax is `IOCD address,tag,count`.
 */
const CHANNEL_COMMANDS = {
  IOCD: 0, TCH: 1, IORP: 2, IORT: 3, IOCP: 4, IOCT: 5, IOSP: 6, IOST: 7,
};

const PSEUDO = new Set(['ORG', 'OCT', 'DEC', 'BCI', 'PZE', 'MZE', 'END', 'EQU',
  'BSS']);

/** True when the token names something this assembler can assemble. */
function isOperation(token) {
  if (!token) return false;
  const name = token.toUpperCase().replace(/\*$/, '');
  return OPS.has(name) || PSEUDO.has(name)
    || CHANNEL_SENSE[name] !== undefined || CHANNEL_COMMANDS[name] !== undefined;
}

class AssemblyError extends Error {
  constructor(message, line, text) {
    super(`line ${line}: ${message}\n    ${text}`);
    this.name = 'AssemblyError';
    this.line = line;
  }
}

/**
 * Assemble source text into an absolute core image.
 * Returns { words: Map<address, [hi, lo]>, symbols: Map<name, value>, start }.
 */
export function assemble(source) {
  const lines = parse(dedent(source));
  const symbols = new Map();

  // First pass fixes the location counter for every label; the second resolves
  // forward references. Two passes are enough because nothing here changes
  // length depending on a symbol's value.
  let location = 0;
  for (const line of lines) {
    if (line.label) symbols.set(line.label, location);
    if (line.op === 'ORG') { location = evaluate(line.fields[0], symbols, location, line); continue; }
    if (line.op === 'EQU') { symbols.set(line.label, evaluate(line.fields[0], symbols, location, line)); continue; }
    if (line.op === 'END') break;
    location += sizeOf(line);
  }

  const words = new Map();
  // Without an END operand the program starts where it was first assembled.
  let start = null;
  location = 0;
  for (const line of lines) {
    if (line.op === 'ORG') { location = evaluate(line.fields[0], symbols, location, line); continue; }
    if (line.op === 'EQU') continue;
    if (line.op === 'END') {
      if (line.fields[0]) start = evaluate(line.fields[0], symbols, location, line) & ADDR;
      break;
    }
    for (const word of emit(line, symbols, location)) {
      if (start === null) start = location;
      words.set(location++, word);
    }
  }

  return { words, symbols, start: start === null ? 0 : start };
}

/** Assemble and load straight into core. */
export function assembleInto(core, source) {
  const image = assemble(source);
  for (const [address, [hi, lo]] of image.words) core.write(address, hi, lo);
  return image;
}

// ---------------------------------------------------------------------------

/**
 * Strip the common indentation from embedded source, so a program written
 * inside a template literal still has its labels in column 1.
 */
function dedent(source) {
  const lines = source.split('\n');
  let margin = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    margin = Math.min(margin, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(margin) || margin === 0) return source;
  return lines.map((line) => line.slice(margin)).join('\n');
}

function parse(source) {
  const lines = [];
  source.split('\n').forEach((raw, index) => {
    const number = index + 1;
    const text = raw.replace(/\t/g, '    ');
    if (/^\s*$/.test(text)) return;
    if (/^\s*[*#]/.test(text)) return;           // FAP comments start in column 1

    // FAP puts labels in column 1 and the operation in column 8. After the
    // source has been dedented, a line that starts at the margin is carrying a
    // label — unless the token there is itself an operation, which is how an
    // unlabelled program written at a uniform indent still reads correctly.
    const tokens = /^(\S+)(?:\s+(\S+))?(?:\s+(\S+))?/.exec(text.trimStart());
    if (!tokens) return;
    let label = null;
    let [, op, operand] = tokens;
    if (!/^\s/.test(text) && !isOperation(op)) {
      label = tokens[1];
      op = tokens[2];
      operand = tokens[3];
      if (op === undefined) throw new AssemblyError('no operation', number, text);
    }

    let indirect = false;
    if (op.endsWith('*')) { indirect = true; op = op.slice(0, -1); }

    lines.push({
      label,
      op: op.toUpperCase(),
      indirect,
      fields: splitFields(operand),
      number,
      text: text.trimEnd(),
    });
  });
  return lines;
}

/** Split `a,b,c` while keeping BCI's character payload intact. */
function splitFields(operand) {
  if (operand === undefined) return [];
  return operand.split(',');
}

function sizeOf(line) {
  if (line.op === 'BSS') return Number(line.fields[0]);
  if (line.op === 'BCI') return Number(line.fields[0] || 1);
  return 1;
}

function* emit(line, symbols, location) {
  const { op } = line;

  if (op === 'OCT') {
    for (const field of line.fields) yield octalWord(field, line);
    return;
  }
  if (op === 'DEC') {
    for (const field of line.fields) yield decimalWord(field, line);
    return;
  }
  if (op === 'BSS') {
    const count = Number(line.fields[0]);
    for (let i = 0; i < count; i++) yield [0, 0];
    return;
  }
  if (op === 'BCI') {
    // BCI n,text — n words of six BCD characters each.
    const count = Number(line.fields[0] || 1);
    const text = line.text.slice(line.text.indexOf(',') + 1);
    for (let i = 0; i < count; i++) yield bcdWord(text.slice(i * 6, i * 6 + 6));
    return;
  }
  if (CHANNEL_COMMANDS[op] !== undefined) {
    const address = field(line, 0, symbols, location);
    const tag = field(line, 1, symbols, location);
    const count = field(line, 2, symbols, location);
    yield [((CHANNEL_COMMANDS[op] & 7) << 15) | (count & ADDR),
      ((tag & 7) << 15) | (address & ADDR)];
    return;
  }
  if (op === 'PZE' || op === 'MZE') {
    const address = field(line, 0, symbols, location);
    const tag = field(line, 1, symbols, location);
    const decrement = field(line, 2, symbols, location);
    yield [((op === 'MZE' ? 0o400000 : 0) | (decrement & ADDR)),
      ((tag & 7) << 15) | (address & ADDR)];
    return;
  }

  // A sense instruction that takes an operand is spelled with the operand
  // joined on, so SLN 2 is looked up as SLN2.
  let entry = OPS.get(op);
  if (!entry && /^\d+$/.test(line.fields[0] || '')) {
    entry = OPS.get(op + line.fields[0]);
  }
  if (!entry) throw new AssemblyError(`unknown operation ${op}`, line.number, line.text);

  const tag = field(line, 1, symbols, location);
  let address;

  if (entry.kind === 'sense') {
    address = entry.address;
  } else if (CHANNEL_SENSE[op] !== undefined) {
    const channel = field(line, 0, symbols, location);
    address = ((channel + 1) << 9) | CHANNEL_SENSE[op];
  } else {
    address = field(line, 0, symbols, location);
  }

  // The high half is S,1-17. An opcode occupies word bits 1-11, so it sits six
  // places up; the sign bit is the top of the half. The index class puts its
  // selector in word bits 1 and 2 and its decrement in bits 3-17.
  const sign = (entry.op & 0o100000) ? 0o400000 : 0;
  let hi;
  if (entry.kind === 'index') {
    const decrement = field(line, 2, symbols, location);
    hi = sign | ((entry.op & 0o3000) << 6) | (decrement & ADDR);
  } else {
    hi = sign | ((entry.op & 0o777) << 6);
  }
  if (line.indirect) hi |= 0o60;

  yield [hi & HALF, (((tag & 7) << 15) | (address & ADDR)) & HALF];
}

function field(line, index, symbols, location) {
  const text = line.fields[index];
  if (text === undefined || text === '') return 0;
  return evaluate(text, symbols, location, line);
}

/**
 * Evaluate an address expression: a symbol, a decimal number, `O'octal'`, `*`
 * for the current location, and sums or differences of those.
 */
function evaluate(text, symbols, location, line) {
  const terms = text.match(/[+-]?[^+-]+/g) || [];
  let total = 0;
  for (const raw of terms) {
    let term = raw.trim();
    let sign = 1;
    if (term.startsWith('-')) { sign = -1; term = term.slice(1).trim(); }
    else if (term.startsWith('+')) term = term.slice(1).trim();
    total += sign * term1(term, symbols, location, line);
  }
  return total;
}

function term1(term, symbols, location, line) {
  if (term === '*' || term === '**') return location;
  const octal = /^O'([0-7]+)'$/i.exec(term);
  if (octal) return parseInt(octal[1], 8);
  if (/^\d+$/.test(term)) return Number(term);
  if (symbols.has(term)) return symbols.get(term);
  throw new AssemblyError(`undefined symbol ${term}`, line.number, line.text);
}

function octalWord(text, line) {
  const digits = text.trim();
  if (!/^[0-7]{1,12}$/.test(digits)) {
    throw new AssemblyError(`not an octal constant: ${text}`, line.number, line.text);
  }
  const value = BigInt('0o' + digits);
  return [Number((value >> 18n) & BigInt(HALF)), Number(value & BigInt(HALF))];
}

function decimalWord(text, line) {
  const value = Number(text.trim());
  if (!Number.isInteger(value)) {
    throw new AssemblyError(`not an integer: ${text}`, line.number, line.text);
  }
  const magnitude = Math.abs(value);
  const hi = Math.floor(magnitude / 0o1000000) & 0o377777;
  const lo = magnitude % 0o1000000;
  return [(value < 0 ? 0o400000 : 0) | hi, lo];
}

function bcdWord(text) {
  const padded = (text + '      ').slice(0, 6);
  let hi = 0, lo = 0;
  for (let i = 0; i < 3; i++) hi = (hi << 6) | toBCD(padded[i]);
  for (let i = 3; i < 6; i++) lo = (lo << 6) | toBCD(padded[i]);
  return [hi & HALF, lo & HALF];
}
