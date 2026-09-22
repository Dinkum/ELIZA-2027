/**
 * ELIZA — faithful JavaScript rewrite.
 *
 * Same algorithm and same observable behaviour as Weizenbaum's MAD-SLIP ELIZA,
 * written as ordinary JavaScript rather than transliterated from the original
 * routines. Line references in the comments are to the recovered 1965b listing
 * (references/1965b-recovered-ELIZA.mad); page references are to the January
 * 1966 CACM paper.
 *
 * Two dialects share this engine:
 *
 *   '1965b'  what the recovered source does. One keyword slot, no keystack and
 *            no NEWKEY: the first plain keyword in the sentence wins, and only
 *            a higher-ranked keyword can displace it.
 *   '1966'   what the CACM paper describes. A keystack ordered by precedence,
 *            NEWKEY, and PRE rules.
 */

import { parseScript } from './script.js';
import { decompose, assemble } from './match.js';
import { hashWord } from '../../shared/hollerith.js';

/** Delimiters, from the scan loop at 000660. */
const DELIMITERS = new Set(['.', ',', 'BUT']);

/** Script-error messages hard-coded in ELIZA, chosen by LIMIT (002200-002270). */
const NOMATCH = ['PLEASE CONTINUE', 'HMMM', 'GO ON , PLEASE', 'I SEE'];

/** Give up on a chain of (=KEY) links rather than spin on a cyclic script. */
const MAX_LINKS = 32;

function tokenizeInput(text) {
  return text
    .toUpperCase()
    .replace(/[?!;:]/g, '.')
    .replace(/[^A-Z0-9'\-.,]+/g, ' ')
    .replace(/([.,])/g, ' $1 ') // SLIP gave punctuation a cell of its own
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export class Eliza {
  constructor(scriptText, { dialect = '1966' } = {}) {
    const script = parseScript(scriptText);
    this.dialect = dialect;
    this.greeting = script.greeting;
    this.rules = script.rules;
    this.tags = script.tags;
    this.memoryRule = script.memory;
    this.memories = [];
    // LIMIT, JW's "certain counting mechanism", cycles 1..4 (000510-000520).
    this.limit = 1;
  }

  /** Run one exchange. Takes what the operator typed, returns what ELIZA types. */
  respond(text) {
    this.limit = (this.limit % 4) + 1;

    const scan = this.#scan(tokenizeInput(text));
    let { words } = scan;
    const keystack = scan.keystack;

    // No keyword at all. A memory is recalled only when LIMIT is 4 (001130).
    if (keystack.length === 0 && this.limit === 4 && this.memories.length > 0) {
      return this.memories.shift();
    }

    for (let link = 0; keystack.length > 0 && link < MAX_LINKS; link += 1) {
      const keyword = keystack.shift();
      const rule = this.rules.get(keyword);
      if (!rule) return NOMATCH[this.limit - 1];

      if (keyword === this.memoryRule.keyword) this.#rememberFrom(words);

      const result = this.#transform(rule, words);
      if (result.action === 'complete') return result.words.join(' ');
      if (result.action === 'inapplicable') return NOMATCH[this.limit - 1];
      if (result.words) words = result.words;

      if (result.action === 'link') {
        keystack.unshift(result.keyword);
      } else if (keystack.length === 0) {
        break; // NEWKEY with nothing left on the stack: fall through to NONE.
      }
    }

    // The NONE rule never fails to produce a response (page 41).
    const none = this.rules.get('NONE');
    const result = this.#transform(none, words);
    return result.action === 'complete' ? result.words.join(' ') : NOMATCH[this.limit - 1];
  }

  /**
   * Scan the sentence left to right: honour the delimiters, apply word
   * substitutions, and collect the keyword(s) (000600-001100, page 38-39).
   */
  #scan(inputWords) {
    let words = inputWords.slice();
    const keystack = [];
    let topRank = 0;

    for (let i = 0; i < words.length; i += 1) {
      const word = words[i];

      if (DELIMITERS.has(word)) {
        // Keep only the first clause that contains a keyword (000660-000770).
        if (keystack.length === 0) {
          words = words.slice(i + 1);
          i = -1;
          continue;
        }
        words = words.slice(0, i);
        break;
      }

      const rule = this.rules.get(word);
      if (!rule) continue;

      if (rule.transformations.length > 0) {
        if (this.dialect === '1965b') {
          // One keyword slot. A ranked keyword can displace whatever is held;
          // an unranked one is taken only if nothing has been found yet.
          if (rule.precedence > topRank) {
            topRank = rule.precedence;
            keystack[0] = word;
          } else if (rule.precedence === 0 && keystack.length === 0) {
            keystack[0] = word;
          }
        } else if (rule.precedence > topRank) {
          topRank = rule.precedence;
          keystack.unshift(word);
        } else {
          keystack.push(word);
        }
      }

      words[i] = rule.substitute;
    }

    return { words, keystack };
  }

  /** Try each transformation in turn; the first whose decomposition fits wins. */
  #transform(rule, words) {
    for (const transformation of rule.transformations) {
      if (transformation.link) return { action: 'link', keyword: transformation.link };

      const components = decompose(transformation.decomposition, words, this.tags);
      if (!components) continue;

      const reassembly = this.#nextReassembly(transformation);
      switch (reassembly.kind) {
        case 'template':
          return { action: 'complete', words: assemble(reassembly.template, components) };
        case 'link':
          return { action: 'link', keyword: reassembly.keyword };
        case 'pre':
          return {
            action: 'link',
            keyword: reassembly.keyword,
            words: assemble(reassembly.template, components),
          };
        default:
          return { action: 'newkey' };
      }
    }
    return { action: 'inapplicable' };
  }

  /** Reassemblies are used in rotation and the position persists (001550-001710). */
  #nextReassembly(transformation) {
    const reassembly = transformation.reassemblies[transformation.next % transformation.reassemblies.length];
    transformation.next += 1;
    return reassembly;
  }

  /**
   * Lay down a memory for later use.
   * Which of the four MEMORY transformations is used comes from hashing the
   * last cell of the sentence: I=HASH.(BOT.(INPUT),2)+1 (001230).
   */
  #rememberFrom(words) {
    if (words.length === 0) return;
    const index = hashWord(words[words.length - 1], 2);
    const transformation = this.memoryRule.transformations[index];
    const components = decompose(transformation.decomposition, words, this.tags);
    if (!components) return;
    this.memories.push(assemble(transformation.template, components).join(' '));
  }
}
