/**
 * ELIZA.MAD and TESTS.MAD, transliterated.
 *
 * From references/1965b-recovered-ELIZA.mad, the listing recovered from
 * Weizenbaum's papers at MIT. The sequence numbers in the comments are the
 * ones in the right-hand margin of that listing.
 *
 * The structure is the original's. MAD is a language of labels and transfers,
 * so each label here is a case of one dispatch loop and `T'O X` is `label = X`.
 * Nothing is tidied up on the way through: the single keyword slot, the
 * counter cell spliced into the middle of a transformation, and the places
 * where the code reads a datum it has no business reading are all kept.
 *
 * What the 1966 CACM paper describes but this code does not do, so the port
 * does not do it either:
 *
 *   - PRE, the preliminary transformation
 *   - NEWKEY and the keyword stack
 *   - links to another rule at the reassembly level, which fall through to
 *     ASSMBL and get typed out as `= DIT`
 *
 * Two things the driver does differently, because there is no CTSS underneath:
 * EXIT and the ENDPLA script dump return control instead of ending the job,
 * and CHANGE.MAD, the script editor reached by typing `+`, is not ported.
 */

import {
  LIST, LISTMT, MTLIST, IRALST, NEWBOT, NEWTOP, POPTOP, TOP, BOT, SUBST,
  SEQRDR, SEQLR, SEQLL, RDRNEG, LSPNTR, RDRCPY, REMOVE, MRKNEG, MRKPOS,
  LSSCPY, LSTNAM, NODLST, NULSTL, NULSTR, LIST9, ref,
} from './slip.js';
import { YMATCH, ASSMBL, REGEL, TXTPRT, SlipFault } from './slip-eliza.js';
import { LISTRD, TREAD, Tape } from './listrd.js';
import { hashWord, hash } from '../../shared/hollerith.js';

/**
 * HASH. — square the datum and take the middle N bits.
 *
 * Whatever is in the cell gets hashed, and ELIZA does not always hand it a
 * word. At 001230 the datum can be the name of a sublist, because TESTS splices
 * a keyword's DLIST into the input and the sentence can end on it; SLIP then
 * hashes the sublist's address. A number typed by the operator arrives here
 * too. Both are hashed rather than refused, as they were on the 7094.
 */
export function HASH(datum, n) {
  if (typeof datum === 'string') return hashWord(datum, n);
  if (typeof datum === 'number') return hash(BigInt(Math.trunc(datum)), n);
  if (datum && typeof datum.addr === 'number') return hash(BigInt(datum.addr), n);
  throw new SlipFault(`HASH of a datum that is not a word: ${String(datum)}`);
}

/** Script error messages, hard-coded in ELIZA and selected by LIMIT. */
const NOMATCH = ['PLEASE CONTINUE', 'HMMM', 'GO ON , PLEASE', 'I SEE'];

// --- TESTS.MAD ------------------------------------------------------------

/**
 * TESTS. — does the keyword list CAND begin with the word the input reader S
 * is sitting on, and if the keyword carries a substitution, make it.
 *
 * Returns a reader positioned on the keyword's first transformation, or 0.
 * A word of more than six characters occupies several cells, so both sides are
 * gathered a cell at a time into FIRST and SECOND and compared.
 */
export function TESTS(cand, s) {
  const store = RDRCPY(s); // STORE=S
  const reader = SEQRDR(cand);
  const first = [];
  const second = [];
  const fr = ref();
  const f = ref();
  let i;
  let j;

  for (i = 0; !(i > 100); i += 1) { // ONE
    first[i] = SEQLR(reader, fr);
    if (!RDRNEG(reader)) break;
  }

  SEQLL(s, f); // ENDONE
  for (j = 0; !(j > 100); j += 1) { // TWO
    second[j] = SEQLR(s, f);
    if (!RDRNEG(s)) break;
  }

  if (i !== j) return 0; // ENDTWO
  for (let k = 0; !(k > j); k += 1) { // LOOK
    if (first[k] !== second[k]) return 0;
  }

  const eql = SEQLR(reader, fr);
  if (eql !== '=') {
    SEQLL(reader, fr);
    return reader;
  }

  // The keyword substitutes for itself: lift the matched cells out of the
  // input and splice the replacement in where they were.
  let point = store.left; // POINT=LNKL.(STORE)
  for (let k = 0; !(k > j); k += 1) { // DELETE
    REMOVE(LSPNTR(store));
    SEQLR(store, f);
  }
  for (;;) { // INSRT
    point = NEWTOP(SEQLR(reader, fr), point);
    MRKNEG(point);
    if (!RDRNEG(reader)) break;
  }
  MRKPOS(point);
  return reader;
}

// --- ELIZA.MAD ------------------------------------------------------------

export class ElizaPort {
  /**
   * The setup at the head of ELIZA.MAD, down to the end of the BEGIN loop:
   * read the script tape record by record and file each keyword list under
   * HASH of its keyword, with NONE kept apart after the hashed slots. The
   * recovered 1965b program uses 32 slots; the 1966 paper specifies 128.
   */
  constructor(scriptText, { hashBits = 5 } = {}) {
    this.hashBits = hashBits;
    this.noneIndex = 1 << hashBits;
    this.TEST = LIST();
    this.INPUT = LIST();
    this.OUTPUT = LIST();
    this.JUNK = LIST();
    this.LIMIT = 1; // 000120
    this.MYTRAN = [];
    for (let i = 1; !(i > 4); i += 1) this.MYTRAN[i] = LIST(); // MLST
    this.MINE = 0;
    this.MYLIST = LIST();
    this.KEY = [];
    for (let i = 0; !(i > this.noneIndex); i += 1) this.KEY[i] = LIST(); // KEYLST
    this.MEMORY = 0;

    const SCRIPT = new Tape(scriptText);

    // LSSCPY.(THREAD.(INPUT,SCRIPT),JUNK) — the first record is the greeting.
    LSSCPY(LISTRD(this.INPUT, SCRIPT), this.JUNK);
    MTLIST(this.INPUT);

    for (;;) { // BEGIN
      MTLIST(this.INPUT);
      NODLST(this.INPUT);
      LISTRD(this.INPUT, SCRIPT);

      if (LISTMT(this.INPUT) === 0) {
        this.greeting = this.#typeset(this.JUNK);
        MTLIST(this.JUNK);
        break; // T'O START
      }

      if (TOP(this.INPUT) === 'NONE') {
        NEWTOP(LSSCPY(this.INPUT, LIST9()), this.KEY[this.noneIndex]);
      } else if (TOP(this.INPUT) === 'MEMORY') {
        POPTOP(this.INPUT);
        this.MEMORY = POPTOP(this.INPUT);
        for (let i = 1; !(i > 4); i += 1) { // MEM
          LSSCPY(POPTOP(this.INPUT), this.MYTRAN[i]);
        }
      } else {
        NEWBOT(LSSCPY(this.INPUT, LIST9()), this.KEY[HASH(TOP(this.INPUT), hashBits)]);
      }
    }
  }

  /**
   * Say what the machine ran into, where that can be told from the state it
   * left behind. Everything else is reported as it comes.
   */
  #diagnose(error) {
    const s = SEQRDR(this.INPUT);
    const f = ref();
    for (;;) {
      const datum = SEQLR(s, f);
      if (f.v > 0) break;
      if (typeof datum === 'number') {
        return 'A NUMBER IN THE INPUT . SLIP READS IT AND ELIZA CANNOT TYPE IT';
      }
    }
    return error.message.toUpperCase();
  }

  /** Collect what TXTPRT would have typed. */
  #typeset(lst) {
    const lines = [];
    TXTPRT(lst, (line) => lines.push(line));
    return lines.join('\n');
  }

  /**
   * One pass through the major loop, from START to the T'O START that ends it.
   * The operator's line stands in for what TREAD would have read.
   *
   * Where the original would have gone on with whatever bit pattern it found,
   * the port stops and says so: a SlipFault is a place ELIZA came off the
   * rails, not a place the port did.
   */
  respond(text) {
    const out = [];
    try {
      this.#major(text, (line) => out.push(line));
    } catch (error) {
      if (error instanceof SlipFault) throw error;
      throw new SlipFault(this.#diagnose(error));
    }
    return out.join('\n');
  }

  #major(text, print) {
    const typeOut = (lst) => TXTPRT(lst, print);

    const F = ref();
    const FR = ref();
    const SF = ref();
    const ESF = ref();

    let KEYWRD = 0;
    let PREDNC = 0;
    let IT = 0;
    let S = null;
    let WORD = 0;
    let I = 0;
    let SCANER = null;
    let CAND = null;
    let READER = null;
    let NEXT = 0;
    let ES = null;
    let ESRDR = null;
    let POINT = 0;
    let POINTR = null;
    let TRANS = null;

    let label = 'START';

    for (;;) {
      switch (label) {
        // R* * * * * * * * * * BEGIN MAJOR LOOP
        case 'START': // 000480
          TREAD(MTLIST(this.INPUT), text);
          KEYWRD = 0;
          PREDNC = 0;
          this.LIMIT += 1;
          if (this.LIMIT === 5) this.LIMIT = 1;
          if (LISTMT(this.INPUT) === 0) return; // T'O ENDPLA
          IT = 0;
          if (TOP(this.INPUT) === '+') {
            // CHANGE.(KEY,MYTRAN) — the script editor is not ported.
            print('PLEASE INSTRUCT ME');
            print('CHANGE ROUTINE NOT PORTED');
            return;
          }
          if (TOP(this.INPUT) === '*') { label = 'NEWLST'; continue; }
          S = SEQRDR(this.INPUT);
          label = 'NOTYET';
          continue;

        case 'NOTYET': // 000610
          if (RDRNEG(S)) {
            SEQLR(S, F); // step over a continuation cell
            continue;
          }
          WORD = SEQLR(S, F);
          if (WORD === '.' || WORD === ',' || WORD === 'BUT') { // 000660
            if (IT === 0) {
              NULSTL(this.INPUT, LSPNTR(S), this.JUNK);
              MTLIST(this.JUNK);
              continue; // T'O NOTYET
            }
            NULSTR(this.INPUT, LSPNTR(S), this.JUNK);
            MTLIST(this.JUNK);
            label = 'ENDTXT';
            continue;
          }
          if (F.v > 0) { label = 'ENDTXT'; continue; }

          I = HASH(WORD, 5);
          SCANER = SEQRDR(this.KEY[I]);
          SF.v = 0;
          for (;;) { // SEARCH
            CAND = SEQLR(SCANER, SF);
            if (SF.v > 0) break;
            if (TOP(CAND) === WORD) { label = 'KEYFND'; break; }
          }
          if (label === 'KEYFND') continue;
          continue; // T'O NOTYET

        case 'KEYFND': // 000860
          READER = TESTS(CAND, S);
          if (READER === 0) { label = 'NOTYET'; continue; }

          if (LSTNAM(CAND) !== 0) {
            const DL = LSTNAM(CAND);
            while (RDRNEG(S)) SEQLR(S, F); // SEQ
            NEWTOP(DL, LSPNTR(S));
          }

          NEXT = SEQLR(READER, FR);
          if (FR.v > 0) { label = 'NOTYET'; continue; }

          if (IT === 0 && FR.v === 0) {
            IT = RDRCPY(READER); // PLCKEY
            KEYWRD = WORD;
          } else if (FR.v < 0 && NEXT > PREDNC) {
            PREDNC = NEXT;
            SEQLR(READER, FR);
            IT = RDRCPY(READER); // PLCKEY
            KEYWRD = WORD;
          }
          label = 'NOTYET';
          continue;

        // R* * * * * * * * * * END OF MAJOR LOOP
        case 'ENDTXT': // 001120
          if (IT === 0) {
            if (this.LIMIT === 4 && LISTMT(this.MYLIST) !== 0) {
              const OUT = POPTOP(this.MYLIST);
              typeOut(OUT);
              IRALST(OUT);
              return; // T'O START
            }
            ES = BOT(TOP(this.KEY[32]));
            label = 'TRY';
            continue;
          }
          if (KEYWRD === this.MEMORY) {
            I = HASH(BOT(this.INPUT), 2) + 1; // 001230
            NEWBOT(REGEL(this.MYTRAN[I], this.INPUT, LIST()), this.MYLIST);
            SEQLL(IT, FR);
            label = 'MATCH';
            continue;
          }
          SEQLL(IT, FR);
          label = 'MATCH';
          continue;

        // R* * * * * * * * * * MATCHING ROUTINE
        case 'MATCH': // 001300
          ES = SEQLR(IT, FR);
          if (isList(ES) && TOP(ES) === '=') {
            // A link at the transformation level: (HOW (=WHAT))
            S = SEQRDR(ES);
            SEQLR(S, F);
            WORD = SEQLR(S, F);
            I = HASH(WORD, 5);
            SCANER = SEQRDR(this.KEY[I]);
            for (;;) { // SCAN
              const ITS = SEQLR(SCANER, F);
              if (F.v > 0) { label = 'NOMATCH'; break; }
              if (WORD === TOP(ITS)) {
                S = SEQRDR(ITS);
                do { ES = SEQLR(S, F); } while (F.v !== 0); // SCANI
                IT = RDRCPY(S);
                label = 'TRY';
                break;
              }
            }
            continue;
          }
          if (FR.v > 0) { label = 'NOMATCH'; continue; }
          label = 'TRY';
          continue;

        case 'TRY': // 001500
          if (YMATCH(TOP(ES), this.INPUT, MTLIST(this.TEST)) === 0) {
            label = 'MATCH';
            continue;
          }
          ESRDR = SEQRDR(ES);
          SEQLR(ESRDR, ESF); // step over the decomposition
          POINT = SEQLR(ESRDR, ESF);
          POINTR = LSPNTR(ESRDR);

          if (ESF.v === 0) {
            // No counter cell yet: put one in front of the reassembly rules.
            NEWBOT(1, POINTR);
            TRANS = POINT;
          } else {
            for (I = 0; !(I > POINT); I += 1) TRANS = SEQLR(ESRDR, ESF); // FNDHIT
            if (ESF.v > 0) {
              // Off the end of the rules: round to the first one again.
              SEQLR(ESRDR, ESF);
              SEQLR(ESRDR, ESF);
              TRANS = SEQLR(ESRDR, ESF);
              SUBST(1, POINTR);
            } else {
              SUBST(POINT + 1, POINTR);
            }
          }
          label = 'HIT';
          continue;

        case 'HIT': // 001730
          typeOut(ASSMBL(TRANS, this.TEST, MTLIST(this.OUTPUT)));
          return; // T'O START

        // R* * * * * * * * * * INSERT NEW KEYWORD LIST
        case 'NEWLST': // 001770
          POPTOP(this.INPUT);
          NEWBOT(LSSCPY(this.INPUT, LIST9()), this.KEY[HASH(TOP(this.INPUT), 5)]);
          return; // T'O START

        // R* * * * * * * * * * SCRIPT ERROR EXIT
        case 'NOMATCH': // 002200
          print(NOMATCH[this.LIMIT - 1]);
          return; // T'O START

        default:
          throw new SlipFault(`ELIZA: no such label ${label}`);
      }
    }
  }
}

const isList = (x) => x !== null && typeof x === 'object' && 'right' in x;

export { SlipFault };
