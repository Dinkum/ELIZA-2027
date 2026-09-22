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

/** Smallest number of words an element can consume. */
function minimumWidth(element) {
  switch (element.kind) {
    case 'wild': return 0;
    case 'exact': return element.count;
    default: return 1;
  }
}

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
  const components = new Array(pattern.length);

  const walk = (p, w) => {
    if (p === pattern.length) return w === words.length;

    const element = pattern[p];
    const remaining = pattern.slice(p + 1).reduce((sum, e) => sum + minimumWidth(e), 0);

    if (element.kind === 'wild') {
      for (let take = 0; words.length - (w + take) >= remaining; take += 1) {
        components[p] = words.slice(w, w + take);
        if (walk(p + 1, w + take)) return true;
      }
      return false;
    }

    if (element.kind === 'exact') {
      if (w + element.count > words.length) return false;
      components[p] = words.slice(w, w + element.count);
      return walk(p + 1, w + element.count);
    }

    if (w >= words.length || !matchesWord(element, words[w], tags)) return false;
    components[p] = [words[w]];
    return walk(p + 1, w + 1);
  };

  return walk(0, 0) ? components : null;
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
