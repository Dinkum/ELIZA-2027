/**
 * ELIZA EXTENDED — the engine.
 *
 * Mode 4 of ELIZA 2027. An extension of the 1966 design, not a reconstruction:
 * there is no recovered source behind this and no transcript to reproduce. What
 * it keeps from 1966 is the shape of the thing — a script is data, a keyword is
 * looked up, a decomposition pattern is tried, a response is reassembled.
 *
 * The unit of the script is unchanged:
 *
 *   KEYWORD / TOPIC + rank + ordered decomposition patterns
 *                   + response templates + optional memory instructions
 *
 * There is no separate reasoning engine. Every reply is produced by a pattern
 * that matched text the user actually typed.
 *
 * THREE THINGS THIS DOES THAT THE 1965b/1966 ENGINES DO NOT
 *
 *   1. Captures. A pattern may name the span it matched (`{feeling}`) and a
 *      template may place it. A capture is a matched text span — never an
 *      inferred meaning. Nothing here decides that a word "means" an emotion.
 *
 *   2. Context and memory. Small, explicit, and written by the rules
 *      themselves. Rules say what to remember and when to recall it. A
 *      follow-up rule can read "yes" against the question it just asked.
 *
 *   3. An optional semantic index. When literal matching only turns up a
 *      generic catchall, a local encoder may suggest a *rule family* to try.
 *      It suggests families, never responses and never slot values. The
 *      symbolic path runs first, runs always, and works when the encoder is
 *      absent, loading, or broken.
 *
 * Order of business, per the design:
 *
 *   NORMALIZE -> FIND LITERAL KEYWORDS/TAGS -> ORDER CANDIDATES
 *     -> TRY DECOMPOSITION RULES --(useful match)--> REASSEMBLE
 *     -> SEMANTIC FALLBACK -> TRY THOSE FAMILIES' RULES --> REASSEMBLE
 *     -> MEMORY RECALL / GENERIC FALLBACK --> REASSEMBLE
 */

/** Sentence terminators. A capture never crosses one. */
const TERMINATORS = new Set(['.', '?', '!', ';']);

/** How many recent responses to avoid repeating. */
const RECENT_WINDOW = 4;

/**
 * Memory is meant to be small and explicit, so it does not grow without bound.
 * A long session that never recalls anything would otherwise carry every span
 * it ever chose to remember.
 */
const MEMORY_LIMIT = 12;

/**
 * Words are the unit of matching; raw tokens are the unit of quoting.
 *
 * A contraction expands into several words ("don't" -> "do not") but the raw
 * token keeps the original spelling, so a capture can hand back what the user
 * actually typed rather than the expansion the matcher worked on.
 */
function tokenize(text) {
  const raw = [];
  const words = [];
  let sentence = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (TERMINATORS.has(ch) || ch === ',') {
      raw.push({ text: ch, start: i, end: i + 1, punct: true, sentence });
      if (TERMINATORS.has(ch)) sentence += 1;
      i += 1;
      continue;
    }
    let j = i;
    while (j < text.length && !/\s/.test(text[j]) && !TERMINATORS.has(text[j]) && text[j] !== ',') {
      j += 1;
    }
    raw.push({ text: text.slice(i, j), start: i, end: j, punct: false, sentence });
    i = j;
  }

  raw.forEach((token, rawIndex) => {
    if (token.punct) return;
    token.rawIndex = rawIndex;
    token.wordStart = words.length;
    for (const part of token.text.toLowerCase().match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g) || []) {
      words.push({ raw, rawIndex, text: token.text, sentence: token.sentence, surface: part });
    }
    token.wordEnd = words.length;
  });

  return { raw, words };
}

/**
 * A configured hyphenated alias also matches its spaced spelling, and a
 * multiword contraction is consumed before either word is expanded alone.
 */
const PHRASE_KEYS = new WeakMap();

function phraseKeys(script) {
  const cached = PHRASE_KEYS.get(script);
  if (cached) return cached;
  const byFirst = new Map();
  const { contractions = {}, aliases = {} } = script.normalize || {};
  for (const key of [...Object.keys(contractions), ...Object.keys(aliases)]) {
    const parts = key.split(/[\s-]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const entries = byFirst.get(parts[0]) || [];
    entries.push({ key, parts });
    byFirst.set(parts[0], entries);
  }
  for (const entries of byFirst.values()) entries.sort((a, b) => b.parts.length - a.parts.length);
  PHRASE_KEYS.set(script, byFirst);
  return byFirst;
}

/** Expand contractions and aliases without changing the original quote span. */
function normalize(words, script) {
  const { contractions = {}, aliases = {} } = script.normalize || {};
  const phrases = phraseKeys(script);
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    let surface = word.surface;
    let end = i;
    for (const phrase of phrases.get(surface) || []) {
      if (!phrase.parts.every((part, offset) => {
        const current = words[i + offset];
        return current?.surface === part && current.sentence === word.sentence &&
          (offset === 0 || current.rawIndex === words[i + offset - 1].rawIndex + 1);
      })) continue;
      surface = phrase.key;
      end = i + phrase.parts.length - 1;
      break;
    }
    const expanded = contractions[surface] || surface;
    for (const piece of expanded.split(' ').filter(Boolean)) {
      out.push({ ...word, rawEndIndex: words[end].rawIndex, norm: aliases[piece] || piece });
    }
    i = end;
  }
  return out;
}

/**
 * Per-tag prefix counts for one tokenised turn, computed once and cached
 * against the word array itself.
 *
 * "Does every word in this span carry TAG" is the inner question of a
 * tag-bounded capture, and answering it by scanning the span made the matcher
 * cubic: a tag-constrained pattern that ultimately fails, against a 1600-word
 * run-on, took 16 seconds. Two prefix lookups make it O(1).
 */
const TAG_PREFIXES = new WeakMap();

function tagPrefixesFor(words, script) {
  const cached = TAG_PREFIXES.get(words);
  if (cached) return cached;

  const perTag = new Map();
  for (const tag of Object.keys(script.tags || {})) {
    const prefix = new Int32Array(words.length + 1);
    for (let i = 0; i < words.length; i += 1) {
      prefix[i + 1] = prefix[i] + (hasTag(words[i], tag, script) ? 1 : 0);
    }
    perTag.set(tag, prefix);
  }
  TAG_PREFIXES.set(words, perTag);
  return perTag;
}

const hasTag = (word, tag, script) => (script.tags?.[tag] || []).includes(word.norm);

/**
 * Quote a span of words back as the user typed it, in sentence case.
 *
 * The span is resolved to raw tokens by character offset and sliced out of the
 * original string, so expansions and rewrites performed for matching do not
 * leak into the reply. The cutter's output is judged as prose, not quoted as a
 * transcription: the 1050 keyboard arrives in caps, so echoing a literal span
 * mid-sentence printed "You say IM DOING PRETTY GOOD." — read back as shouting.
 * Sentence case keeps the words and drops the casting.
 */
function quoteSpan(input, words, from, to) {
  // A "0" is allowed to match nothing, and a wildcard at the end of a pattern
  // is allowed to run out of words. Both quote as the empty string.
  if (from >= to || !words[from]) return '';
  const first = words[from].rawIndex;
  const last = words[to - 1].rawEndIndex ?? words[to - 1].rawIndex;
  const raw = words[from].raw;
  const span = input.slice(raw[first].start, raw[last].end).trim();
  // Sentence case the first letter of the first word only; leave acronyms and
  // proper nouns that were typed mixed-case as they are.
  return span.length && span === span.toUpperCase()
    ? span[0] + span.slice(1).toLowerCase()
    : span;
}

/**
 * Parse a capture token.
 *
 *   {name}        capture, one or more words, greedy
 *   {name:/TAG}   capture, one or more words, each carrying TAG
 */
function captureToken(token) {
  const inner = token.slice(1, -1);
  const [name, tag] = inner.split(':');
  return { name, tag: tag ? tag.replace(/^\//, '') : null };
}

/** A semantic family needs a literal or tag in its pattern, not only a wildcard. */
function hasPatternEvidence(pattern) {
  return pattern.match.some((token) =>
    token.startsWith('/') || /^\{[^}]+:\/[^}]+\}$/.test(token) ||
    (token !== '0' && !token.startsWith('{')));
}

/** A nearby denial governs a state until punctuation or a contrasting clause. */
function isNegated(words, at) {
  const word = words[at];
  let next = at;
  for (let i = at - 1; i >= 0 && at - i <= 5; i -= 1) {
    const previous = words[i];
    if (previous.sentence !== word.sentence) break;
    const after = previous.rawEndIndex ?? previous.rawIndex;
    if (word.raw.slice(after + 1, words[next].rawIndex).some((token) => token.punct)) break;
    if (['but', 'because', 'although', 'though', 'however', 'yet'].includes(previous.norm)) break;
    const nextWord = words[i + 1]?.norm;
    if (['not', 'never', 'cannot', 'nobody', 'none'].includes(previous.norm)) {
      if (!['stop', 'help', 'avoid'].includes(nextWord)) return true;
    }
    if (previous.norm === 'no' && ['longer', 'one', 'person', 'people', 'body'].includes(nextWord)) return true;
    next = i;
  }
  return false;
}

/**
 * Match a pattern against the words, left to right, with backtracking.
 *
 * Search order is deliberate and is what makes the same wildcard work in two
 * different places:
 *
 *   zero   tries the SHORTEST span first, so a leading "0" scans forward until
 *          the next literal lines up
 *   {name} tries the LONGEST span first, so a trailing capture takes the rest
 *          of the sentence
 *
 * Returns a map of capture name -> [from, to], or null.
 */
function matchPattern(input, words, pattern, script, from = 0) {
  const captures = new Map();
  const wilds = [];
  const tagPrefixes = tagPrefixesFor(words, script);

  const walk = (pi, wi) => {
    if (pi === pattern.match.length) return true;
    const token = pattern.match[pi];
    const word = words[wi];

    if (token === '0') {
      // Shortest first: a leading "0" scans forward until the next element
      // lines up.
      //
      // A wildcard MAY cross a sentence boundary, and must: every pattern in
      // the script begins with one, so bounding it to the first sentence made
      // any rule keyed on a word after a full stop a candidate whose pattern
      // could never match. Only a *capture* is sentence-bounded, just below.
      // The asymmetry is the point — "0" skips, "{name}" quotes, and quoting
      // two sentences back as a single span reads as nonsense.
      for (let end = wi; end <= words.length; end += 1) {
        wilds.push([wi, end]);
        if (walk(pi + 1, end)) return true;
        wilds.pop();
      }
      return false;
    }

    if (!word) return false;

    if (token.startsWith('{')) {
      const { name, tag } = captureToken(token);
      if (pattern.unnegated?.includes(name) && isNegated(words, wi)) return false;
      const sentence = word.sentence;
      const prefix = tag ? tagPrefixes.get(tag) : null;
      for (let end = words.length; end > wi; end -= 1) {
        if (words[end - 1].sentence !== sentence) continue;
        // Every word in the span must carry the tag, in O(1).
        if (prefix && prefix[end] - prefix[wi] !== end - wi) continue;
        const previous = captures.get(name);
        captures.set(name, [wi, end]);
        if (walk(pi + 1, end)) return true;
        if (previous) captures.set(name, previous);
        else captures.delete(name);
      }
      return false;
    }

    if (token.startsWith('/')) {
      if (!hasTag(word, token.slice(1), script)) return false;
      return walk(pi + 1, wi + 1);
    }

    if (word.norm !== token) return false;
    if (pattern.unnegated?.includes(token) && isNegated(words, wi)) return false;
    return walk(pi + 1, wi + 1);
  };

  if (!walk(0, from)) return null;

  const resolved = new Map();
  for (const [name, [a, b]] of captures) resolved.set(name, quoteSpan(input, words, a, b));
  wilds.forEach(([a, b], n) => resolved.set(String(n + 1), quoteSpan(input, words, a, b)));
  return resolved;
}

/** Pronoun and agreement flipping, applied only where a template asks for it. */
function flip(text, script) {
  const table = script.pronouns?.flip || {};
  return text
    .split(' ')
    .map((word) => table[word.toLowerCase()] || word)
    .join(' ');
}

/**
 * Fill a template. `{name}` places a capture, `{name:flip}` places it with the
 * pronoun table applied. `{lastTopic}` and `{memory}` are supplied by context
 * and memory rather than by the pattern.
 */
function fillTemplate(template, captures, extra, script) {
  return template.replace(/\{([a-zA-Z0-9_]+)(?::flip)?\}/g, (match, name) => {
    const value = captures.get(name) ?? extra[name] ?? '';
    return match.includes(':flip') ? flip(value, script) : value;
  });
}

export class ExtendedEliza {
  /**
   * @param {object} script   the parsed script.json
   * @param {object} [options]
   * @param {object} [options.semantics] an optional suggestion provider: it
   *   must expose `suggest(text, words) -> [{family, score}]`. Absent, loading
   *   or throwing all behave identically: the symbolic path is unaffected.
   */
  constructor(script, { semantics = null } = {}) {
    this.script = script;
    this.semantics = semantics;
    this.families = new Map((script.families || []).map((f) => [f.id, f]));
    this.greeting = script.greeting || 'How do you do. Please tell me what is on your mind.';

    this.context = { topic: null, expect: [], lastTopic: null };
    this.memory = [];
    this.recent = [];
    this.turn = 0;
    this.lastTrace = null;
  }

  /** Rules in a family, with `patternsFrom` expanded against the shared sets. */
  patternsFor(rule) {
    if (rule.patternsFrom) return this.script.patternSets?.[rule.patternsFrom] || [];
    return rule.patterns || [];
  }

  /**
   * Find the rules a literal reading of the input could reach.
   *
   * A rule is a candidate if the input contains one of its keywords (after
   * normalization) or a word carrying one of its tags.
   */
  candidates(words) {
    const forms = new Set(words.map((w) => w.norm));
    const found = [];

    for (const family of this.script.families || []) {
      for (const rule of family.rules || []) {
        let source = null;
        let matchedOn = null;

        for (const keyword of rule.keywords || []) {
          if (forms.has(keyword)) {
            source = 'keyword';
            matchedOn = keyword;
            break;
          }
        }
        if (!source) {
          for (const tag of rule.tags || []) {
            const hit = words.find((w) => hasTag(w, tag, this.script));
            if (hit) {
              source = 'tag';
              matchedOn = tag;
              break;
            }
          }
        }
        // A rule with neither keywords nor tags can only be a catchall. Allow
        // it as a candidate solely when the script marks it a fallback, so an
        // unconditional rule cannot quietly outrank a specific one.
        if (!source && !(rule.keywords || []).length && !(rule.tags || []).length) {
          if (rule.fallback || family.fallback) {
            source = 'always';
            matchedOn = null;
          }
        }
        if (source) found.push({ family, rule, source, matchedOn });
      }
    }

    // Script-defined ranks. On a tie, the topic already under discussion wins.
    const order = new Map();
    (this.script.families || []).forEach((f, i) => (f.rules || []).forEach((r, j) => order.set(r, [i, j])));

    return found.sort((a, b) => {
      const rank = (b.rule.rank ?? b.family.rank ?? 0) - (a.rule.rank ?? a.family.rank ?? 0);
      if (rank) return rank;
      const aTopic = a.family.topic === this.context.topic ? 1 : 0;
      const bTopic = b.family.topic === this.context.topic ? 1 : 0;
      if (aTopic !== bTopic) return bTopic - aTopic;
      const [ai, aj] = order.get(a.rule);
      const [bi, bj] = order.get(b.rule);
      return ai - bi || aj - bj;
    });
  }

  /** Try a list of candidates in order and return the first usable match. */
  tryRules(input, words, found, trace) {
    for (const candidate of found) {
      const patterns = this.patternsFor(candidate.rule);
      for (const pattern of patterns) {
        if (candidate.source === 'semantic' && !hasPatternEvidence(pattern)) {
          trace.push({ step: 'rule', rule: candidate.rule.id, family: candidate.family.id,
            via: candidate.source, on: candidate.matchedOn, matched: false, skipped: 'no-pattern-evidence' });
          continue;
        }
        const captures = matchPattern(input, words, pattern, this.script);
        trace.push({
          step: 'rule',
          rule: candidate.rule.id,
          family: candidate.family.id,
          via: candidate.source,
          on: candidate.matchedOn,
          matched: Boolean(captures),
        });
        if (!captures) continue;
        if (pattern.requires === 'expect' && !this.context.expect.length) continue;
        // Nothing remembered yet: a recall rule has nothing to say, so it must
        // not answer with an empty slot.
        if (pattern.recall && !this.memory.some((m) => !m.used)) continue;
        if (pattern.redirect) {
          const target = this.findRule(pattern.redirect);
          if (target) return this.tryRules(input, words, [target], trace);
          continue;
        }
        return { candidate, pattern, captures };
      }
    }
    return null;
  }

  findRule(id) {
    for (const family of this.script.families || []) {
      for (const rule of family.rules || []) {
        if (rule.id === id) return { family, rule, source: 'redirect', matchedOn: id };
      }
    }
    return null;
  }

  /**
   * Candidate entries for every rule in a family, so a fallback step can offer
   * one to the ordinary matcher instead of answering from a literal in here.
   */
  rulesInFamily(familyId) {
    const family = this.families.get(familyId);
    if (!family) return [];
    return (family.rules || []).map((rule) => ({
      family,
      rule,
      source: 'family',
      matchedOn: familyId,
    }));
  }

  /**
   * The semantic step. It may only propose families to try; the same matcher
   * and the same capture requirements decide whether anything comes of it.
   */
  suggestFamilies(input, words, trace, embedding = null) {
    if (!this.semantics) {
      trace.push({ step: 'semantics', status: 'unavailable' });
      return [];
    }
    let suggestions = [];
    try {
      const raw = this.semantics.suggest(input, words, embedding);
      // A provider that is still loading hands back a Promise. The design says
      // an unavailable encoder must behave exactly like an absent one, so
      // anything that is not an array becomes "no suggestion" rather than a
      // TypeError thrown out of respond() and a dead turn.
      suggestions = Array.isArray(raw) ? raw : [];
      if (raw != null && !Array.isArray(raw)) {
        trace.push({ step: 'semantics', status: 'unusable', got: typeof raw });
      }
    } catch (error) {
      // A broken encoder must not take the conversation with it.
      trace.push({ step: 'semantics', status: 'error', error: String(error && error.message) });
      return [];
    }
    trace.push({ step: 'semantics', status: 'ok', suggestions });
    return suggestions.filter((s) => s.confident !== false && this.families.has(s.family));
  }

  /**
   * A readable phrase for a topic, so a follow-up rule can name what it is
   * about without a bare topic id leaking into the reply.
   */
  labelFor(topic) {
    return this.script.topicLabels?.[topic] || topic || 'that';
  }

  /** Text for {memory}: the oldest unused thing the rules chose to remember. */
  recall() {
    const entry = this.memory.find((m) => !m.used);
    if (!entry) return null;
    return entry;
  }

  commitMemory(pattern, captures) {
    if (!pattern.remember) return null;
    // A memory instruction names a capture, and the script names captures with
    // the same braces a template uses. Accept either spelling.
    const names = (Array.isArray(pattern.remember) ? pattern.remember : [pattern.remember])
      .map((name) => String(name).replace(/[{}]/g, ''));
    const committed = [];
    for (const name of names) {
      const text = captures.get(name);
      if (!text) continue;
      const entry = { text, topic: pattern.context?.topic ?? this.context.topic, turn: this.turn, used: false };
      this.memory.push(entry);
      committed.push(entry);
    }
    // Drop what has already been recalled before dropping anything still
    // waiting to be, so the cap never throws away unread text first.
    while (this.memory.length > MEMORY_LIMIT) {
      const used = this.memory.findIndex((m) => m.used);
      this.memory.splice(used === -1 ? 0 : used, 1);
    }
    return committed.length ? committed : null;
  }

  /**
   * Choose the next eligible template: rotation, skipping anything in the
   * recent window and never returning what it returned last time.
   *
   * The "never last time" clause is load-bearing. Once every template of a
   * pattern has been used the recent window holds all of them, so the loop
   * below finds nothing to return; the fallback then advances past the previous
   * template instead of handing back the same reply forever.
   */
  chooseTemplate(pattern) {
    const templates = pattern.templates || [];
    if (!templates.length) return { index: -1, template: '' };
    pattern.next = pattern.next ?? 0;

    for (let step = 0; step < templates.length; step += 1) {
      const index = (pattern.next + step) % templates.length;
      const template = templates[index];
      if (this.recent.includes(template) || template === pattern.last) continue;
      pattern.next = (index + 1) % templates.length;
      pattern.last = template;
      return { index, template };
    }

    const previous = templates.indexOf(pattern.last);
    const index = previous === -1 ? 0 : (previous + 1) % templates.length;
    pattern.next = (index + 1) % templates.length;
    pattern.last = templates[index];
    return { index, template: templates[index] };
  }

  /** Assemble and record a reply from a matched pattern. */
  reassemble(input, words, match, trace) {
    const { candidate, pattern, captures } = match;
    const { template } = this.chooseTemplate(pattern);

    const recalled = this.recall();
    const extra = {
      lastTopic: this.labelFor(this.context.lastTopic),
      memory: recalled ? recalled.text : '',
    };
    if (pattern.recall && recalled) recalled.used = true;

    let reply = fillTemplate(template, captures, extra, this.script);
    reply = reply.replace(/\s+([.,?])/g, '$1').replace(/\s{2,}/g, ' ').trim();

    const committed = this.commitMemory(pattern, captures);
    const previousTopic = this.context.topic;
    if (pattern.context) {
      if (pattern.context.topic) this.context.topic = pattern.context.topic;
      // An expectation is consumed by the rule that sets it. Anything else
      // releases it: otherwise a bare "yes" stays armed as an answer to a
      // question nobody asked any more, for the rest of the conversation.
      this.context.expect = pattern.context.expect || [];
    } else {
      this.context.expect = [];
    }
    // A rule that asks about the topic under discussion — a follow-up — must
    // not rename it, or {lastTopic} degrades to the filler.
    if (pattern.context?.carryTopic !== true) {
      this.context.lastTopic = pattern.context?.topic || candidate.family.topic || previousTopic;
    }

    this.recent.push(template);
    if (this.recent.length > RECENT_WINDOW) this.recent.shift();

    trace.push({
      step: 'reassemble',
      rule: candidate.rule.id,
      family: candidate.family.id,
      // The trace line the design asks for is candidate source -> rank -> rule
      // -> captures -> template -> memory -> output, so the winning candidate's
      // provenance belongs on the terminal step too, not only on the candidate
      // list it was chosen from.
      source: candidate.source,
      rank: candidate.rule.rank ?? candidate.family.rank ?? null,
      matchedOn: candidate.matchedOn ?? null,
      template,
      captures: Object.fromEntries(captures),
      memory: committed ? committed.map((m) => m.text) : [],
      recalled: pattern.recall && recalled ? recalled.text : null,
      output: reply,
    });

    return reply;
  }

  /**
   * A full turn. Returns the reply and leaves a trace of how it was reached:
   *
   *   candidate source -> rank -> rule -> captures -> template -> memory -> out
   */
  respond(input, { embedding = null } = {}) {
    this.turn += 1;
    const trace = [{ step: 'input', text: input }];
    const { words: rawWords } = tokenize(input);
    const words = normalize(rawWords, this.script);
    trace.push({ step: 'normalize', words: words.map((w) => w.norm) });

    const found = this.candidates(words);
    trace.push({
      step: 'candidates',
      list: found.map((c) => ({ rule: c.rule.id, rank: c.rule.rank, via: c.source, on: c.matchedOn })),
    });

    // Which candidates are only catchalls? A fallback marked in the script must
    // not pre-empt a more useful semantic lookup.
    const isFallback = (c) => c.rule.fallback || c.family.fallback;
    const useful = found.filter((c) => !isFallback(c));
    const catchalls = found.filter(isFallback);

    let match = this.tryRules(input, words, useful, trace);

    // No useful match: the diagram's fallback chain runs here. It is not gated
    // on a catchall existing — SEMANTIC FALLBACK and MEMORY RECALL come before
    // GENERIC FALLBACK and must run whether or not the script ships a catchall.
    // Gating the whole block on one made both steps unreachable for any script
    // without one, which the trace line silently hid.
    if (!match) {
      const suggestions = this.suggestFamilies(input, words, trace, embedding);
      for (const suggestion of suggestions) {
        const family = this.families.get(suggestion.family);
        const rules = (family.rules || []).map((rule) => ({
          family,
          rule,
          source: 'semantic',
          matchedOn: suggestion.family,
        }));
        match = this.tryRules(input, words, rules, trace);
        if (match) break;
      }
      // Memory recall re-enters at REASSEMBLE rather than short-circuiting it.
      // The hardcoded sentence this replaced could not rotate, so a conversation
      // that recalled twice got the identical line twice, and the script's
      // MEMORY_RECALL templates were unreachable. Recall is a rule family like
      // any other: same matcher, same capture requirements, same template choice.
      if (!match) {
        const recallRules = this.rulesInFamily('MEMORY_RECALL');
        if (recallRules.length) match = this.tryRules(input, words, recallRules, trace);
      }
      if (!match) match = this.tryRules(input, words, catchalls, trace);
    }

    if (!match) {
      this.lastTrace = trace;
      throw new Error('Extended script has no matching fallback pattern');
    }

    const reply = this.reassemble(input, words, match, trace);
    this.lastTrace = trace;
    return reply;
  }
}

/** Convenience: build an engine from a parsed script object. */
export function createExtendedEliza(script, options) {
  return new ExtendedEliza(script, options);
}
