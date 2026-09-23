/**
 * Reconstruction of the 1966 CACM program on the recovered 1965b SLIP port.
 *
 * The 1966 MAD listing has not survived. The paper describes the keystack,
 * NEWKEY, reassembly links and PRE; these are the inferred additions here.
 * List reading, matching, assembly, rotation and MEMORY retain the recovered
 * program's routines. ElizaPort itself remains the unmodified 1965b reading.
 */

import {
  LIST, LISTMT, MTLIST, IRALST, NEWBOT, NEWTOP, POPTOP, TOP, SUBST,
  SEQRDR, SEQLR, SEQLL, RDRNEG, LSPNTR, RDRCPY, NULSTL, NULSTR,
  LSSCPY, LSTNAM, NAMTST, LIST9, ref,
} from './slip.js';
import { YMATCH, ASSMBL, REGEL, TXTPRT, SlipFault } from './slip-eliza.js';
import { TREAD } from './listrd.js';
import { ElizaPort, HASH, TESTS } from './eliza.js?v=1e3713080283';

const NOMATCH = ['PLEASE CONTINUE', 'HMMM', 'GO ON , PLEASE', 'I SEE'];
const MAX_TRANSFERS = 256; // Stop a cyclic custom script from hanging the page.

/** SLIP stores a word in six-character cells; link targets may span cells. */
function readWord(reader, flag) {
  let word = SEQLR(reader, flag);
  while (RDRNEG(reader)) word += SEQLR(reader, flag);
  return word;
}

/** Find a keyword's first transformation, without scanning or substituting input. */
function firstTransformation(keyword, keyTable) {
  const bucket = keyTable[keyword === 'NONE' ? 128 : HASH(keyword.slice(0, 6), 7)];
  const scan = SEQRDR(bucket);
  const flag = ref();
  for (;;) {
    const candidate = SEQLR(scan, flag);
    if (flag.v > 0) return null;
    const reader = SEQRDR(candidate);
    if (readWord(reader, flag) !== keyword) continue;
    do { SEQLR(reader, flag); } while (flag.v < 0);
    return flag.v === 0 ? RDRCPY(reader) : null;
  }
}

/** The word after `=` in a link list, or the list after PRE's template. */
function linkTarget(link) {
  const reader = SEQRDR(link);
  const flag = ref();
  SEQLR(reader, flag);
  return readWord(reader, flag);
}

/** Advance the counter cell embedded in a matched transformation. */
function nextReassembly(rule) {
  const reader = SEQRDR(rule);
  const flag = ref();
  SEQLR(reader, flag); // decomposition
  const counter = SEQLR(reader, flag);
  const counterCell = LSPNTR(reader);
  if (flag.v === 0) {
    NEWBOT(1, counterCell);
    return counter;
  }
  let selected;
  for (let i = 0; i <= counter; i += 1) selected = SEQLR(reader, flag);
  if (flag.v > 0) {
    SEQLR(reader, flag);
    SEQLR(reader, flag);
    selected = SEQLR(reader, flag);
    SUBST(1, counterCell);
  } else {
    SUBST(counter + 1, counterCell);
  }
  return selected;
}

export class ElizaPort1966 extends ElizaPort {
  constructor(scriptText) {
    // CACM p. 38 specifies 128 KEY slots and a seven-bit keyword hash.
    super(scriptText, { hashBits: 7 });
  }

  respond(text) {
    const output = [];
    const print = (line) => output.push(line);
    const typeOut = (list) => TXTPRT(list, print);
    const f = ref();
    const fr = ref();
    const sf = ref();

    TREAD(MTLIST(this.INPUT), text);
    this.LIMIT = this.LIMIT === 4 ? 1 : this.LIMIT + 1;
    if (LISTMT(this.INPUT) === 0) return '';
    if (TOP(this.INPUT) === '+') {
      return 'PLEASE INSTRUCT ME\nCHANGE ROUTINE NOT PORTED';
    }
    if (TOP(this.INPUT) === '*') {
      POPTOP(this.INPUT);
      NEWBOT(LSSCPY(this.INPUT, LIST9()), this.KEY[HASH(TOP(this.INPUT), 7)]);
      return '';
    }

    const keystack = [];
    let highestRank = 0;
    let inputReader = SEQRDR(this.INPUT);
    let sawKeyword = false;

    for (;;) {
      if (RDRNEG(inputReader)) { SEQLR(inputReader, f); continue; }
      const word = SEQLR(inputReader, f);
      if (word === '.' || word === ',' || word === 'BUT') {
        if (!sawKeyword) {
          NULSTL(this.INPUT, LSPNTR(inputReader), this.JUNK);
          MTLIST(this.JUNK);
          continue;
        }
        NULSTR(this.INPUT, LSPNTR(inputReader), this.JUNK);
        MTLIST(this.JUNK);
        break;
      }
      if (f.v > 0) break;

      const bucket = this.KEY[HASH(word, 7)];
      const scan = SEQRDR(bucket);
      sf.v = 0;
      for (;;) {
        const candidate = SEQLR(scan, sf);
        if (sf.v > 0) break;
        if (TOP(candidate) !== word) continue;

        const matchedInputReader = RDRCPY(inputReader);
        const reader = TESTS(candidate, matchedInputReader);
        if (reader === 0) continue;
        inputReader = matchedInputReader;
        const description = LSTNAM(candidate);
        if (description !== 0) {
          while (RDRNEG(inputReader)) SEQLR(inputReader, f);
          NEWTOP(description, LSPNTR(inputReader));
        }

        const rankOrRule = SEQLR(reader, fr);
        if (fr.v > 0) break;
        let rank = 0;
        if (fr.v < 0) {
          rank = rankOrRule;
          SEQLR(reader, fr);
        }
        const entry = { keyword: word, reader: RDRCPY(reader) };
        if (rank > highestRank) {
          highestRank = rank;
          keystack.unshift(entry);
        } else {
          keystack.push(entry);
        }
        sawKeyword = true;
        break;
      }
    }

    if (keystack.length === 0 && this.LIMIT === 4 && LISTMT(this.MYLIST) !== 0) {
      const memory = POPTOP(this.MYLIST);
      typeOut(memory);
      IRALST(memory);
      return output.join('\n');
    }

    let transfers = 0;
    while (keystack.length > 0 && transfers++ < MAX_TRANSFERS) {
      let { keyword, reader } = keystack.shift();
      if (keyword === this.MEMORY) {
        // 1965b can hash the address of a DLIST tag spliced after the final
        // word. The paper describes hashing the word; the 1966 reading uses it.
        let last = this.INPUT.left;
        while (NAMTST(last.datum) === 0) last = last.left;
        const index = HASH(last.datum, 2) + 1;
        NEWBOT(REGEL(this.MYTRAN[index], this.INPUT, LIST()), this.MYLIST);
      }

      for (;;) {
        if (transfers++ >= MAX_TRANSFERS) throw new SlipFault('cyclic 1966 script link');
        const ruleReader = RDRCPY(reader);
        SEQLL(ruleReader, fr);
        let movedToNextKeyword = false;
        for (;;) {
          const rule = SEQLR(ruleReader, fr);
          if (fr.v > 0) return NOMATCH[this.LIMIT - 1];
          if (TOP(rule) === '=') {
            keyword = linkTarget(rule);
            reader = firstTransformation(keyword, this.KEY);
            if (!reader) return NOMATCH[this.LIMIT - 1];
            break;
          }
          if (YMATCH(TOP(rule), this.INPUT, MTLIST(this.TEST)) === 0) continue;
          const reassembly = nextReassembly(rule);
          const action = TOP(reassembly);
          if (action === 'NEWKEY') {
            movedToNextKeyword = true;
            break;
          }
          if (action === '=') {
            keyword = linkTarget(reassembly);
            reader = firstTransformation(keyword, this.KEY);
            if (!reader) return NOMATCH[this.LIMIT - 1];
            break;
          }
          if (action === 'PRE') {
            const preReader = SEQRDR(reassembly);
            SEQLR(preReader, f);
            const template = SEQLR(preReader, f);
            const link = SEQLR(preReader, f);
            const rebuilt = ASSMBL(template, this.TEST, LIST());
            if (!rebuilt) throw new SlipFault('PRE could not assemble input');
            MTLIST(this.INPUT);
            LSSCPY(rebuilt, this.INPUT);
            IRALST(rebuilt);
            keyword = linkTarget(link);
            reader = firstTransformation(keyword, this.KEY);
            if (!reader) return NOMATCH[this.LIMIT - 1];
            break;
          }
          typeOut(ASSMBL(reassembly, this.TEST, MTLIST(this.OUTPUT)));
          return output.join('\n');
        }
        if (movedToNextKeyword) break;
      }
    }

    const none = firstTransformation('NONE', this.KEY);
    if (!none) throw new SlipFault('1966 script has no NONE rule');
    const ruleReader = RDRCPY(none);
    SEQLL(ruleReader, fr);
    const rule = SEQLR(ruleReader, fr);
    if (YMATCH(TOP(rule), this.INPUT, MTLIST(this.TEST)) === 0) return NOMATCH[this.LIMIT - 1];
    typeOut(ASSMBL(nextReassembly(rule), this.TEST, MTLIST(this.OUTPUT)));
    return output.join('\n');
  }
}
