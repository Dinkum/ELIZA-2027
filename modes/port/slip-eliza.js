/**
 * The SLIP routines written for ELIZA.
 *
 * Transliterated from references/1965b-CTSS-reconstruction/eliza/src/SLIP/
 * SLIP-eliza/: partn.mad, xlook.mad, goody.mad, xmatch.mad, ymatch.mad,
 * assmbl.mad, txtprt.mad and das.mad. Labels and control flow are the
 * original's, including the loops whose whole body is the THROUGH statement.
 *
 * MAD's `THROUGH label, FOR i = start, step, test` runs while `test` is false
 * and leaves `i` at the first value for which it held, so it is written here as
 * `for (i = start; !(test); i += step)`.
 */

import {
  LIST, LISTMT, MTLIST, IRALST, NEWBOT, POPTOP, POPBOT, TOP,
  SEQRDR, SEQLR, SEQLL, RDRNEG, MRKNEG, NAMTST, LSTNAM, MAKEDL,
  LSSCPY, LSTEQL, LNKBOT, INLSTL, ref, CELL_CHARACTERS,
} from './slip.js';

/** W'R LNKL.(DATUM) .E. 0 — the datum is a small integer, not a word or list. */
const isInteger = (datum) => typeof datum === 'number';

/** A machine fault the original would have taken as garbage or a hang. */
export class SlipFault extends Error {}

// --- PARTN ----------------------------------------------------------------

/**
 * PARTN. — cut a list into PART(1)...PART(n), returning the count in PART(0).
 *
 * Integers are kept as they are; every other datum becomes a one-element list,
 * with any continuation cells of a long word linked on after it. A sublist
 * whose top is SIGNAL is not a part of its own: it becomes the description list
 * of the part before it, which is how a keyword's DLIST tags the input word it
 * was spliced in beside.
 */
export function PARTN(slst, part, signal) {
  const tag = signal;
  let count = 0;
  const reader = SEQRDR(slst);
  const flag = ref();

  for (;;) {
    count += 1;
    const datum = SEQLR(reader, flag);
    if (flag.v > 0) break; // DONE

    if (isInteger(datum)) {
      part[count] = datum;
      continue; // T'O READ
    }

    if (NAMTST(datum) === 0 && TOP(datum) === tag) {
      count -= 1;
      const it = LSSCPY(datum, LIST());
      POPTOP(it); // drop the signal itself
      MAKEDL(it, part[count]);
      IRALST(it);
      continue; // T'O READ
    }

    // PLAIN
    part[count] = LIST();
    NEWBOT(datum, part[count]);
    while (RDRNEG(reader)) { // ATTCH
      LNKBOT(SEQLR(reader, flag), part[count]);
    }
  }

  count -= 1;
  part[0] = count;
  return count;
}

// --- XLOOK and GOODY ------------------------------------------------------

/** XLOOK. — 0 if VALUE appears on LST's description list. */
export function XLOOK(value, lst) {
  const dl = LSTNAM(lst);
  if (dl === 0) return 1;
  const s = SEQRDR(dl);
  const f = ref();
  for (;;) {
    const word = SEQLR(s, f);
    if (f.v > 0) return 1; // FAIL
    if (word === value) return 0; // SUCCES
  }
}

/**
 * GOODY. — does the input word B satisfy the pattern sublist LST?
 * Two forms: (/TAG ...) asks whether B carries any of those tags, and
 * (* WORD ...) asks whether B is any of those words. 0 for yes.
 */
export function GOODY(lst, b) {
  if (TOP(lst) === '/') {
    const s = SEQRDR(lst);
    const f = ref();
    for (;;) {
      // Read backwards from the header: the tags come before the slash.
      const word = SEQLL(s, f);
      if (word === '/') return 1; // FAIL
      if (XLOOK(word, b) === 0) return 0; // SUCCES
    }
  }

  if (TOP(lst) !== '*') return 1; // FAIL

  const s = SEQRDR(lst);
  const f = ref();
  SEQLR(s, f); // step over the star
  const temp = LIST();

  for (;;) {
    let word = SEQLR(s, f);
    if (f.v > 0) { // FAILA
      IRALST(temp);
      return 1;
    }
    for (;;) { // PUT
      NEWBOT(word, temp);
      if (!RDRNEG(s)) break; // TST
      word = SEQLR(s, f); // RDB: a word of more than six characters
    }
    if (LSTEQL(temp, b) === 0) { // GOOD
      IRALST(temp);
      return 0;
    }
    MTLIST(temp);
  }
}

// --- XMATCH ---------------------------------------------------------------

/**
 * XMATCH. — match one stretch of the pattern, from A(AA) to A(AC).
 *
 * A(AB) is the fixed element the stretch is anchored on, or an integer when the
 * stretch runs off the end of the pattern. NUMBER records, for each element
 * matched going forward, how many input words it took and where they started;
 * ENDSTR then shares the words before the anchor out among the gaps, and
 * FORWRD replays NUMBER to fill the elements after it.
 *
 * AB and BA are modified in place, as they are in MAD.
 */
function XMATCH(a, b, aa, ab, ac, ba) {
  const blast = b[0];
  let number = LIST();
  let bb;
  let bmark;
  let amark;
  let obj;
  let i;
  let j;

  const state = { label: 'ENTRY' };

  for (;;) {
    switch (state.label) {
      case 'ENTRY':
        if (!isInteger(a[ab.v])) {
          state.label = 'NORMAL';
          continue;
        }
        if (ba.v === 1 && a[aa] !== 0) {
          bb = 1;
          for (i = 1; !(i > ab.v); i += 1) bb += a[i]; // SUMB
          bmark = bb;
        } else {
          bb = blast + 1;
        }
        ab.v = ac;
        state.label = 'ENDSTR';
        continue;

      case 'NORMAL':
        amark = ab.v;
        bmark = ba.v;
        for (i = aa; !(i === ab.v); i += 1) bmark += a[i]; // INIT
        state.label = 'START';
        continue;

      case 'START': {
        obj = a[ab.v];
        let found = false;
        for (i = bmark; !(i > blast); i += 1) { // LOCATE
          if (LSTEQL(obj, b[i]) === 0) { found = true; break; }
          if (NAMTST(TOP(obj)) === 0 && GOODY(TOP(obj), b[i]) === 0) {
            found = true;
            break;
          }
        }
        if (!found) { state.label = 'FAIL'; continue; }
        // GOOD
        bmark = i;
        bb = i;
        obj = 1;
        state.label = 'FOUND';
        continue;
      }

      case 'GO':
        amark += 1;
        if (amark === ac) { state.label = 'ENDSTR'; continue; }
        if (bmark > blast) { state.label = 'FAIL'; continue; }
        obj = a[amark];
        if (isInteger(obj)) { state.label = 'FOUND'; continue; }
        if (LSTEQL(obj, b[bmark]) === 0) {
          obj = 1;
          state.label = 'FOUND';
          continue;
        }
        if (NAMTST(TOP(obj)) !== 0 || GOODY(TOP(obj), b[bmark]) !== 0) {
          // FEHLER: this anchor was the wrong one, try the next occurrence.
          MTLIST(number);
          bmark = bb + 1;
          amark = ab.v;
          state.label = 'START';
          continue;
        }
        obj = 1;
        state.label = 'FOUND';
        continue;

      case 'FOUND':
        NEWBOT({ lnkl: obj, lnkr: bmark }, number);
        bmark += obj;
        state.label = 'GO';
        continue;

      case 'ENDSTR': {
        let failed = false;
        for (i = ab.v - 1; !(i < aa); i -= 1) { // MORE
          obj = a[i];
          a[i] = LIST();
          if (obj === 0) obj = bb - ba.v;
          bb -= obj;
          if (bb < ba.v) { failed = true; break; }
          for (j = 0; !(j === obj); j += 1) INLSTL(b[bb + j], a[i]); // CONC
        }
        if (failed) { state.label = 'FAIL'; continue; }

        i = ab.v - 1;
        for (;;) { // FORWRD
          if (LISTMT(number) === 0) {
            IRALST(number);
            ba.v = bmark;
            return 0;
          }
          i += 1;
          const it = POPTOP(number);
          obj = it.lnkl;
          j = it.lnkr;
          if (NAMTST(a[i]) === 0) IRALST(a[i]);
          a[i] = LIST();
          for (let k = 0; !(k === obj); k += 1) INLSTL(b[j + k], a[i]); // PLACE
        }
      }

      case 'FAIL':
        IRALST(number);
        return 1;

      default:
        throw new SlipFault(`XMATCH: ${state.label}`);
    }
  }
}

// --- YMATCH ---------------------------------------------------------------

/**
 * YMATCH. — match the decomposition SLST against the input OLST.
 * On success OUTLST holds one list per pattern element and YMATCH returns it;
 * on failure OUTLST is emptied and YMATCH returns 0.
 */
export function YMATCH(slst, olst, outlst) {
  const a = [];
  const b = [];
  PARTN(slst, a, ' NONE');
  PARTN(olst, b, '/');

  const ba = ref(1);
  const limit = a[0];
  let markc = 1;
  let marka;
  let markb;
  let switch_;
  let i;
  let j;

  outer: for (;;) { // MORE
    marka = markc;
    let mka = marka;

    if (a[mka] === 0) {
      if (mka === limit) {
        i = limit; // AMARK
        markb = i;
        for (j = i + 1; !(j > limit || a[j] === 0); j += 1); // FINDC
        markc = j;
      } else {
        mka += 1;
        for (i = mka; !(i === limit || !isInteger(a[i]) || a[i] === 0); i += 1); // FINDB
        if (a[i] !== 0) {
          markb = i; // BMARK
          for (j = i + 1; !(j > limit || a[j] === 0); j += 1); // FINDC
          markc = j;
        } else {
          markb = i - 1;
          markc = i;
        }
      }
    } else {
      for (i = mka; !(i === limit || !isInteger(a[i]) || a[i] === 0); i += 1); // FINDB
      if (a[i] !== 0) {
        markb = i; // BMARK
        for (j = i + 1; !(j > limit || a[j] === 0); j += 1); // FINDC
        markc = j;
      } else {
        markb = i - 1;
        markc = i;
      }
    }

    // MATCH
    const abRef = ref(markb);
    if (XMATCH(a, b, marka, abRef, markc, ba) === 0) {
      markb = abRef.v;
      if (markc > limit) { switch_ = 2; break outer; } // SUCCES
      continue outer;
    }
    switch_ = 1;
    break outer;
  }

  for (i = 1; !(i > b[0]); i += 1) IRALST(b[i]); // MTB
  for (i = 1; !(i > limit); i += 1) { // MTA
    if (!isInteger(a[i])) {
      NEWBOT(a[i], outlst);
      IRALST(a[i]);
    }
  }

  if (switch_ === 1) {
    MTLIST(outlst);
    return 0;
  }
  return outlst;
}

// --- ASSMBL ---------------------------------------------------------------

/**
 * ASSMBL. — build the reply NEW from the reassembly rule RHS and the matched
 * components PART. An integer in RHS names a component; anything else is
 * copied through, with the continuation cells of a long word copied with it.
 *
 * A component number that is out of range returns 0, which ELIZA hands
 * straight to TXTPRT without checking. That is the path a number typed by the
 * operator takes.
 */
export function ASSMBL(rhs, part, xnew) {
  const a = [];
  let s = SEQRDR(part);
  const flag = ref(0);
  let i;

  for (i = 1; !(flag.v > 0); i += 1) a[i] = SEQLR(s, flag); // PLACE
  const limit = i - 1;

  s = SEQRDR(rhs);
  for (;;) { // READ
    const datum = SEQLR(s, flag);
    if (flag.v > 0) return xnew; // END

    if (isInteger(datum)) {
      if (datum >= limit) return 0; // FAIL
      const copy = LIST();
      INLSTL(LSSCPY(a[datum], copy), xnew);
      IRALST(copy);
    } else {
      NEWBOT(datum, xnew);
      while (RDRNEG(s)) LNKBOT(SEQLR(s, flag), xnew); // LONG
    }
  }
}

// --- REGEL ----------------------------------------------------------------

/**
 * REGEL. — apply a MEMORY rule, whose decomposition and reassembly live in one
 * list either side of an `=`.
 */
export function REGEL(spec, obj, xnew) {
  MTLIST(xnew);
  let datum = 0;
  let result = 0;
  const lhs = LIST();
  const rhs = LIST();
  const int = LIST();
  const s = SEQRDR(spec);
  const f = ref();

  while (datum !== '=') { // LEFT
    datum = SEQLR(s, f);
    const cell = NEWBOT(datum, lhs);
    if (RDRNEG(s)) MRKNEG(cell);
  }
  POPBOT(lhs); // drop the `=`

  while (!(f.v > 0)) { // RIGHT
    const cell = NEWBOT(SEQLR(s, f), rhs);
    if (RDRNEG(s)) MRKNEG(cell);
  }
  POPBOT(rhs); // drop the header datum read at the end

  if (YMATCH(lhs, obj, int) !== 0 && ASSMBL(rhs, int, xnew) !== 0) {
    result = xnew;
  }

  IRALST(lhs);
  IRALST(rhs);
  IRALST(int);
  return result;
}

// --- TXTPRT ---------------------------------------------------------------

/** 14 words of six characters: the line TXTPRT builds before it types. */
const OUT_WORDS = 14;
export const TXTPRT_COLUMNS = OUT_WORDS * CELL_CHARACTERS;

/**
 * TXTPRT. — type a list as text.
 *
 * One blank separates cells, except where a cell is marked negative and so
 * continues the one before it. The line is built in a fixed buffer of fourteen
 * six-character words; when it fills, the partial word at the end is blanked
 * out and typed again at the start of the next line, which is what wraps
 * ELIZA's output at eighty-four columns.
 */
export function TXTPRT(lst, print) {
  if (lst === 0 || typeof lst !== 'object') {
    // ASSMBL failed and returned 0. On the 7094 this walked off into whatever
    // the accumulator held; there is nothing faithful to print.
    throw new SlipFault('TXTPRT called on a datum that is not a list');
  }

  const s = SEQRDR(lst);
  const f = ref();
  let line = '';

  const emit = (char) => {
    line += char;
    if (line.length < TXTPRT_COLUMNS) return;
    // TYPE: blank out the partial word at the end, type the rest, and set the
    // reader back to the last word boundary so that word is typed again.
    let cut = line.length;
    while (cut > 0 && line[cut - 1] !== ' ') cut -= 1;
    if (cut === 0) cut = line.length; // one word filled the whole line
    print(line.slice(0, cut).trimEnd());
    line = line.slice(cut);
  };

  let started = false;
  let continued = false; // the cell just typed is continued by the next one

  for (;;) {
    const datum = SEQLR(s, f);
    if (f.v > 0) break; // DONE
    if (typeof datum !== 'string') {
      throw new SlipFault(`TXTPRT cannot type the datum ${String(datum)}`);
    }
    if (started && !continued) emit(' ');
    for (const char of datum) emit(char);
    started = true;
    continued = RDRNEG(s);
  }

  print(line.trimEnd());
  return lst;
}
