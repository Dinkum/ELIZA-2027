/**
 * Turn a parsed ELIZA script into the rule structures the engine runs on.
 *
 * Weizenbaum: "an important property of ELIZA is that a script is data; i.e.,
 * it is not part of the program itself." The same parser reads both the 1965b
 * .TAPE. 100 script and the 1966 CACM appendix script; constructs that only one
 * of them uses (NEWKEY, PRE) simply never appear in the other.
 */

import { readAll } from './sexp.js';

export const MEMORY_KEY = 'MEMORY';
export const NONE_KEY = 'NONE';

const isInteger = (token) => typeof token === 'string' && /^\d+$/.test(token);
const isList = Array.isArray;

/** One element of a decomposition pattern. */
function parsePatternElement(element) {
  if (isList(element)) {
    if (element[0] === '*') {
      return { kind: 'any', words: element.slice(1) };
    }
    // (/FAMILY) or (/NOUN FAMILY): matches a word carrying any of those tags.
    const tags = element.map((t) => t.replace(/^\//, '')).filter(Boolean);
    return { kind: 'tag', tags };
  }
  if (element === '0') return { kind: 'wild' };
  if (isInteger(element)) return { kind: 'exact', count: Number(element) };
  return { kind: 'word', word: element };
}

const parseDecomposition = (list) => list.map(parsePatternElement);

/**
 * A reassembly rule is one of:
 *   (= KEY)              link to another keyword
 *   (NEWKEY)             abandon this keyword, take the next off the keystack
 *   (PRE (...) (= KEY))  rebuild the text, then link
 *   (LITERAL 3 WORDS)    template; integers name decomposition components
 */
function parseReassembly(list) {
  if (list[0] === '=') return { kind: 'link', keyword: list[1] };
  if (list[0] === 'NEWKEY') return { kind: 'newkey' };
  if (list[0] === 'PRE') {
    return {
      kind: 'pre',
      template: parseTemplate(list[1]),
      keyword: isList(list[2]) ? list[2][1] : list[2],
    };
  }
  return { kind: 'template', template: parseTemplate(list) };
}

const parseTemplate = (list) =>
  list.map((token) =>
    isInteger(token) ? { kind: 'component', index: Number(token) } : { kind: 'word', word: token });

/**
 * A transformation is either a decomposition with its reassemblies, or a bare
 * (= KEY) standing in for the whole rule, as in (EVERYBODY 2 (= EVERYONE)).
 */
function parseTransformation(list) {
  if (list[0] === '=') return { link: list[1] };
  return {
    decomposition: parseDecomposition(list[0]),
    reassemblies: list.slice(1).map(parseReassembly),
    // JW's "certain counting mechanism": reassemblies are used in rotation and
    // the position is remembered across the whole conversation.
    next: 0,
  };
}

/** (KEYWORD [= SUBSTITUTE] [PRECEDENCE] [DLIST(/TAG ...)] TRANSFORMATION...) */
function parseKeywordRule(list) {
  const keyword = list[0];
  let i = 1;
  let substitute = keyword;
  let precedence = 0;
  let tags = [];

  if (list[i] === '=') {
    substitute = list[i + 1];
    i += 2;
  }
  if (isInteger(list[i])) {
    precedence = Number(list[i]);
    i += 1;
  }
  if (list[i] === 'DLIST' && isList(list[i + 1])) {
    tags = list[i + 1].map((t) => t.replace(/^\//, '')).filter(Boolean);
    i += 2;
  }

  return {
    keyword,
    substitute,
    precedence,
    tags,
    transformations: list.slice(i).map(parseTransformation),
  };
}

/** (MEMORY MY (0 YOUR 0 = ...) x4) — decomposition and reassembly share a list. */
function parseMemoryRule(list) {
  const keyword = list[1];
  const transformations = list.slice(2).map((rule) => {
    const split = rule.indexOf('=');
    return {
      decomposition: parseDecomposition(rule.slice(0, split)),
      template: parseTemplate(rule.slice(split + 1)),
    };
  });
  return { keyword, transformations };
}

/**
 * Parse a full script.
 * Returns { greeting, rules, memory, tags } where `rules` is keyed by keyword
 * and `tags` maps a DLIST tag to the words carrying it.
 */
export function parseScript(text) {
  const forms = readAll(text);
  let greeting = '';
  const rules = new Map();
  const tags = new Map();
  let memory = null;

  for (const form of forms) {
    if (!isList(form)) continue; // the CACM script's bare START marker
    if (form.length === 0) continue; // () terminates the script
    if (!greeting) {
      greeting = form.join(' ');
      continue;
    }
    if (form[0] === MEMORY_KEY) {
      memory = parseMemoryRule(form);
      continue;
    }
    const rule = parseKeywordRule(form);
    rules.set(rule.keyword, rule);
    for (const tag of rule.tags) {
      if (!tags.has(tag)) tags.set(tag, new Set());
      tags.get(tag).add(rule.keyword);
    }
  }

  if (!rules.has(NONE_KEY)) throw new Error('script has no NONE rule');
  if (!memory) throw new Error('script has no MEMORY rule');
  return { greeting, rules, memory, tags };
}
