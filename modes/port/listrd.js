/**
 * LISTRD. and TREAD. — reading text into list structure.
 *
 * Transliterated from SLIP-core/listrd.mad, with the character categories of
 * SLIP-reconstructed/letter.mad:
 *
 *   1 =   2 -   3 +   4 A-Z   5 .   6 )   7 $
 *   8 *   9 (space)  10 (   11 /   12 0-9   13 ,   14 '
 *
 * What the original does that matters downstream:
 *
 *   - A word is packed six characters to a cell. The sixth character closes the
 *     cell and marks it negative, so INVENTED is the cells INVENT and ED, and
 *     everything reading the list must step over continuation cells.
 *   - The singular characters = - + $ * / and , each get a cell of their own,
 *     which is why ELIZA types REALLY , EVERYONE with a space before the comma.
 *   - A period is a singular character too, once a letter has been seen.
 *   - Parentheses open sublists. `DLIST(` opens a description list on the list
 *     being built instead.
 *   - A digit that does not follow a letter starts an integer datum.
 *   - Text before the first parenthesis is ignored, which is how the comment
 *     lines and the bare START marker in the 1966 script are skipped.
 *
 * Not transliterated: the 84-column card reader underneath it all. LISTRD reads
 * from a tape a card at a time and TREAD reads the console a line at a time;
 * both are given the text directly here.
 */

import { LIST, LISTMT, MTLIST, NEWBOT, MRKNEG, MRKPOS, MAKEDL } from './slip.js';

const CATEGORY = {
  '=': 1, '-': 2, '+': 3, '.': 5, ')': 6, $: 7, '*': 8, ' ': 9, '(': 10, '/': 11, ',': 13, "'": 14,
};

const LETTER = (char) => {
  if (char >= 'A' && char <= 'Z') return 4;
  if (char >= '0' && char <= '9') return 12;
  return CATEGORY[char] ?? 4; // anything else is taken for a letter
};

/** A script tape. LISTRD reads one list off it per call. */
export class Tape {
  constructor(text) {
    this.text = text.toUpperCase();
    this.pos = 0;
  }
}

/**
 * The reader's state: W(1) is SLIP's stack of lists being built, IS is how deep
 * inside parentheses the reader is.
 */
class Builder {
  constructor(xnew, text) {
    this.new = xnew;
    this.stack = [];
    this.is = 0;
    this.word = '';
    this.count = 1;
    this.mode = -1;
    this.prev = 0;
    this.text = text;
  }

  get current() {
    return this.stack[this.stack.length - 1];
  }

  /** PUT. — store the word being accumulated, if there is one. */
  put() {
    if (this.word === '' && this.mode < 0) {
      // A word of exactly six characters has already been stored and marked
      // negative; this is where that mark comes off.
      const lst = this.current;
      if (lst && LISTMT(lst) !== 0) MRKPOS(lst.left);
      return;
    }
    const datum = this.mode < 0 ? this.word : Number(this.word);
    NEWBOT(datum, this.current);
    this.word = '';
    this.count = 1;
    this.mode = -1;
  }

  /** W6 — a singular character: close the word, then give the character a cell. */
  singular(char) {
    this.put();
    NEWBOT(char, this.current);
  }
}

/**
 * Read one list. Returns NEW, which is left empty at the end of the tape — and
 * also by the `()` that terminates every ELIZA script.
 */
export function LISTRD(xnew, tape) {
  MTLIST(xnew);
  const b = new Builder(xnew, tape.text);

  while (tape.pos < tape.text.length) {
    const char = tape.text[tape.pos];
    tape.pos += 1;
    if (char === '\n') {
      // The card reader ends a card here, which separates words like a blank.
      scan(b, ' ');
      // Comment lines are not part of the format; they appear in the
      // transcription of the CACM appendix.
      skipComment(tape);
      continue;
    }
    if (scan(b, char) === 'done') return xnew;
  }
  return xnew;
}

function skipComment(tape) {
  while (tape.pos < tape.text.length && /[ \t]/.test(tape.text[tape.pos])) tape.pos += 1;
  if (tape.text[tape.pos] !== ';') return;
  while (tape.pos < tape.text.length && tape.text[tape.pos] !== '\n') tape.pos += 1;
}

/**
 * TREAD. — read the operator's typing.
 *
 * The console has no parentheses, so TREAD opens the list itself, types INPUT
 * and reads lines until one comes back blank. A blank card is turned into
 * fourteen words of right parenthesis, which closes the list and ends the read.
 */
export function TREAD(xnew, text) {
  MTLIST(xnew);
  const b = new Builder(xnew, text);
  b.is = 1;
  b.stack.push(xnew);

  for (const char of text.toUpperCase()) {
    scan(b, char === '\n' ? ' ' : char);
  }
  b.put(); // the blank card that terminates the read
  return xnew;
}

/** The body of ANALIZ: dispatch on the character's category. */
function scan(b, char) {
  const ident = LETTER(char);
  const prev = b.prev;
  b.prev = ident;

  switch (ident) {
    case 4: // W4, alphabetic
    case 14: // apostrophe, read as a letter
      return alphabetic(b, char);

    case 12: // digit
      if (prev === 4) {
        b.prev = 4;
        return alphabetic(b, char);
      }
      if (b.is === 0) return 'more';
      // W12: an integer datum
      if (b.mode < 0) {
        b.mode = 0;
        b.word = '';
      }
      b.word += char;
      return 'more';

    case 5: // W8, period. TREAD always takes it as a singular character.
      if (b.is === 0) return 'more';
      b.singular(char);
      return 'more';

    case 6: // W9, right parenthesis
      b.put();
      b.is -= 1;
      b.stack.pop();
      return b.is === 0 ? 'done' : 'more';

    case 9: // W10, blank
      if (b.is === 0) return 'more';
      b.put();
      return 'more';

    case 13: // W10 with a comma, which does get a cell
      if (b.is === 0) return 'more';
      b.put();
      NEWBOT(char, b.current);
      return 'more';

    case 10: // LEFTP into W11
      return leftParenthesis(b);

    default: // W6: = - + $ * /
      if (b.is === 0) return 'more';
      b.singular(char);
      return 'more';
  }
}

function alphabetic(b, char) {
  if (b.is === 0) return 'more'; // outside any list: ignored
  b.word += char;
  if (b.count === 6) {
    // A43: the cell is full. Store it marked negative and start the next.
    MRKNEG(NEWBOT(b.word, b.current));
    b.word = '';
    b.count = 1;
    b.mode = -1;
    return 'more';
  }
  b.count += 1;
  return 'more';
}

function leftParenthesis(b) {
  if (b.is === 0) {
    // A112: the first parenthesis opens the list being read.
    b.is = 1;
    b.stack.push(b.new);
    return 'more';
  }

  b.is += 1;
  if (b.word === 'DLIST') {
    // The parenthesised group becomes the description list of this list.
    b.word = '';
    b.count = 1;
    b.mode = -1;
    const dl = LIST();
    MAKEDL(dl, b.current);
    b.stack.push(dl);
    return 'more';
  }

  b.put();
  const sub = LIST();
  NEWBOT(sub, b.current);
  b.stack.push(sub);
  return 'more';
}
