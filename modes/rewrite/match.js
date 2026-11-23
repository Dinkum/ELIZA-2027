/**
 * Decomposition matching — SLIP's YMATCH in modern form.
 *
 * A pattern is a list of elements; the result is one list of words per element,
 * which the reassembly template then refers to by 1-based position.
 *
 * Wildcards are tried shortest-first, left to right. That is what makes
 * (0 YOUR 0) split "YOUR BOYFRIEND MADE YOU COME HERE" into [] / YOUR /
 * BOYFRIEND MADE YOU COME HERE rather than swallowing the sentence whole.
 */

function matchesWord(element, word, tags) {
  switch (element.kind) {
    case 'word': return element.word === word;
    case 'any': return element.words.includes(word);
    case 'tag': return element.tags.some((tag) => tags.get(tag)?.has(word));
    default: return false;
  }
}

/**
 * Match `words` against `pattern`.
 * Returns an array of component word-arrays, or null if the pattern fails.
 */
export function decompose(pattern, words, tags) {
  const length = words.length;
  const fits = Array.from({ length: pattern.length + 1 }, () => new Uint8Array(length + 1));
  fits[pattern.length][length] = 1;

  for (let p = pattern.length - 1; p >= 0; p--) {
    const element = pattern[p];
    const row = fits[p];
    const tail = fits[p + 1];
    for (let w = length; w >= 0; w--) {
      if (element.kind === 'wild') {
        row[w] = tail[w] || row[w + 1] || 0;
      } else if (element.kind === 'exact') {
        row[w] = tail[w + element.count] || 0;
      } else if (w < length && tail[w + 1] && matchesWord(element, words[w], tags)) {
        row[w] = 1;
      }
    }
  }

  if (!fits[0][0]) return null;
  let from = 0;
  return pattern.map((element, p) => {
    let to = from;
    if (element.kind === 'wild') {
      while (!fits[p + 1][to]) to++;
    } else {
      to += element.kind === 'exact' ? element.count : 1;
    }
    const component = words.slice(from, to);
    from = to;
    return component;
  });
}

/** Fill a reassembly template from the matched components. */
export function assemble(template, components) {
  const words = [];
  for (const item of template) {
    if (item.kind === 'word') {
      words.push(item.word);
    } else {
      words.push(...(components[item.index - 1] ?? []));
    }
  }
  return words;
}
