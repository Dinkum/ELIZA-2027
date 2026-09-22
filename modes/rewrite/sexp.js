/**
 * S-expression reader for ELIZA scripts.
 *
 * ELIZA scripts were read by SLIP's LISTRD, which built a list structure out
 * of the parenthesised text. Two details of that reader matter here:
 *
 *   1. Punctuation lives in its own cell. `(REALLY, 2 3)` is the four-element
 *      list REALLY , 2 3, which is why the original transcripts print
 *      "REALLY , EVERYONE" with a space before the comma.
 *   2. `=` and `*` are read as separate atoms, so `(=WHAT)` and `(= WHAT)` are
 *      the same list, as are `(*AM IS)` and `(* AM IS)`.
 *
 * Comment lines beginning with `;` are not part of the original format; they
 * appear in Anthony Hay's transcription of the CACM appendix and are stripped.
 */

const PUNCTUATION = new Set(['.', ',']);

/** Split script text into atoms, parens, and separated punctuation. */
export function tokenize(text) {
  const tokens = [];
  let atom = '';

  const flush = () => {
    if (!atom) return;
    // A leading `=` or `*` is an atom in its own right.
    if (atom.length > 1 && (atom[0] === '=' || atom[0] === '*')) {
      tokens.push(atom[0]);
      atom = atom.slice(1);
    }
    tokens.push(atom);
    atom = '';
  };

  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith(';')) continue;
    for (const ch of line) {
      if (ch === '(' || ch === ')') {
        flush();
        tokens.push(ch);
      } else if (PUNCTUATION.has(ch)) {
        flush();
        tokens.push(ch);
      } else if (/\s/.test(ch)) {
        flush();
      } else {
        atom += ch;
      }
    }
    flush();
  }
  flush();
  return tokens;
}

/**
 * Read every top-level form in the script.
 * Lists become arrays; atoms stay strings. Bare atoms at top level (the `START`
 * marker in the CACM script) are returned as strings.
 */
export function readAll(text) {
  const tokens = tokenize(text);
  const forms = [];
  let i = 0;

  const readForm = () => {
    const token = tokens[i++];
    if (token !== '(') return token;
    const list = [];
    while (i < tokens.length && tokens[i] !== ')') list.push(readForm());
    if (tokens[i] !== ')') throw new Error('unbalanced "(" in script');
    i++;
    return list;
  };

  while (i < tokens.length) {
    if (tokens[i] === ')') throw new Error('unbalanced ")" in script');
    forms.push(readForm());
  }
  return forms;
}
