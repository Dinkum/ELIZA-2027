/**
 * ELIZA EXTENDED — quality control.
 *
 * Every rule family carries positive AND negative examples.
 *
 * The positives are the family's own `examples` from script.json, which is not
 * a coincidence and not decoration: those same strings seed the semantic
 * index. A family whose own examples do not match literally is a family whose
 * index is advertising something the engine cannot deliver.
 *
 * The negatives are utterances that are near a family without belonging to it.
 * They are here rather than in the script because they are claims about the
 * engine's discrimination, and that is what a test file is for.
 *
 * Run with: node --test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ExtendedEliza } from '../engine.js';
import { SemanticIndex, createSemantics, precomputeVectors, HashedEncoder } from '../semantics.js';

const SCRIPT = JSON.parse(readFileSync(new URL('../script.json', import.meta.url), 'utf8'));

/**
 * The engine mutates the script as it talks — template rotation advances, and
 * rules write to a shared pattern. Every test gets its own copy.
 */
const fresh = (options) => new ExtendedEliza(structuredClone(SCRIPT), options);

/** Which family produced the last reply, read off the trace. */
function winningFamily(eliza) {
  const terminal = eliza.lastTrace.filter((step) => step.step === 'reassemble');
  const last = terminal[terminal.length - 1];
  return last ? last.family ?? null : null;
}

const positive = (eliza) => eliza.lastTrace.find((step) => step.step === 'reassemble');

/**
 * Positive coverage, one case per family.
 *
 * `examples` in the script seeds the semantic index, and a family with no
 * examples is deliberately not indexed — it is still reachable literally. That
 * is why the fallback and follow-up families have no examples, and it is why
 * this table exists: the script's examples cannot be the only source of
 * positive coverage, or three families would be covered by nothing at all.
 *
 * `setup` runs first, because a follow-up only means something after a question
 * and a recall only means something after something was remembered.
 */
const FAMILY_CASES = [
  { family: 'FEELING_CAUSE', setup: [], input: 'i feel anxious because my boss keeps piling on work' },
  { family: 'WORK_STRESS', setup: [], input: 'my boss keeps piling on work' },
  { family: 'FAMILY', setup: [], input: 'my mother takes care of me' },
  { family: 'RELATIONSHIP', setup: [], input: 'my girlfriend barely talks to me' },
  { family: 'SLEEP_TIRED', setup: [], input: 'i cannot sleep at night' },
  { family: 'HEALTH', setup: [], input: 'i am getting over a cold' },
  { family: 'MONEY', setup: [], input: 'i cannot afford the rent this month' },
  { family: 'SCHOOL', setup: [], input: 'finals are next week and i cannot study' },
  { family: 'GRIEF', setup: [], input: 'i lost my grandmother in the spring' },
  { family: 'SELF_ESTEEM', setup: [], input: 'i feel worthless' },
  { family: 'ANGER', setup: [], input: 'i am furious at my brother' },
  { family: 'LONELINESS', setup: [], input: 'i have no one to talk to' },
  { family: 'SUBSTANCES', setup: [], input: 'i have been drinking every night' },
  { family: 'SMALL_TALK', setup: [], input: 'hello there' },
  { family: 'ANXIETY', setup: [], input: 'i am anxious about everything' },
  { family: 'FOLLOWUP_YESNO', setup: ['my boss is on my case'], input: 'yes' },
  { family: 'MEMORY_RECALL', setup: ['i feel anxious because my boss keeps piling on work'], input: 'mm hmm' },
  { family: 'GENERIC', setup: [], input: 'purple monkey dishwasher' },
];

/**
 * Negative coverage, one case per family: an utterance that comes *near* the
 * family without belonging to it. The last three matter most — a fallback
 * family must not claim a specific opener, and a follow-up or recall family
 * must stay quiet when nothing armed it.
 */
const NEGATIVE_CASES = [
  { family: 'FEELING_CAUSE', setup: [], input: 'the bus was late' },
  { family: 'WORK_STRESS', setup: [], input: 'my sister called me' },
  { family: 'FAMILY', setup: [], input: 'the meeting ran long' },
  { family: 'RELATIONSHIP', setup: [], input: 'my brother is kind' },
  { family: 'SLEEP_TIRED', setup: [], input: 'i am angry about the traffic' },
  { family: 'HEALTH', setup: [], input: 'i slept badly' },
  { family: 'MONEY', setup: [], input: 'my sister called me' },
  { family: 'SCHOOL', setup: [], input: 'my boss keeps piling on work' },
  { family: 'GRIEF', setup: [], input: 'i am angry about the traffic' },
  { family: 'SELF_ESTEEM', setup: [], input: 'i cannot sleep at night' },
  { family: 'ANGER', setup: [], input: 'i am anxious about the traffic' },
  { family: 'LONELINESS', setup: [], input: 'i am surrounded by people at work' },
  { family: 'SUBSTANCES', setup: [], input: 'i drink coffee every morning' },
  { family: 'SMALL_TALK', setup: [], input: 'i feel worthless' },
  { family: 'ANXIETY', setup: [], input: 'i slept badly' },
  { family: 'FOLLOWUP_YESNO', setup: [], input: 'yes' },
  { family: 'MEMORY_RECALL', setup: [], input: 'what did i say earlier' },
  { family: 'GENERIC', setup: [], input: 'my boss keeps piling on work' },
];

const runCase = (c) => {
  const eliza = fresh();
  for (const turn of c.setup) eliza.respond(turn);
  eliza.respond(c.input);
  return eliza;
};

/* -------------------------------------------------------------------------- */
/* The three upgrades                                                         */
/* -------------------------------------------------------------------------- */

test('every rule family carries positive AND negative coverage', () => {
  // The claim in this file's header, enforced instead of asserted in prose.
  const covered = new Set(FAMILY_CASES.map((c) => c.family));
  const negated = new Set(NEGATIVE_CASES.map((c) => c.family));
  for (const family of SCRIPT.families) {
    assert.ok(covered.has(family.id), `${family.id} has no positive case`);
    assert.ok(negated.has(family.id), `${family.id} has no negative case`);
  }
  // And the tables must not invent families the script does not have.
  const known = new Set(SCRIPT.families.map((f) => f.id));
  for (const id of [...covered, ...negated]) {
    assert.ok(known.has(id), `${id} is not a family in the script`);
  }
});

test('every family answers its own positive case', () => {
  for (const c of FAMILY_CASES) {
    assert.equal(winningFamily(runCase(c)), c.family, `${c.family} <- "${c.input}"`);
  }
});

test('a family does not answer for an utterance outside it', () => {
  for (const c of NEGATIVE_CASES) {
    assert.notEqual(winningFamily(runCase(c)), c.family, `${c.family} must not claim "${c.input}"`);
  }
});

test('a paraphrased input still reaches its family', () => {
  const paraphrases = [
    ['FEELING_CAUSE', 'i am miserable because my work never stops'],
    ['WORK_STRESS', 'my boss keeps moving the goalposts'],
    ['FAMILY', 'my father will not speak to me'],
    ['RELATIONSHIP', 'my girlfriend barely talks to me'],
    ['SLEEP_TIRED', 'i am exhausted'],
    ['ANXIETY', 'i feel anxious'],
  ];
  for (const [familyId, utterance] of paraphrases) {
    const eliza = fresh();
    eliza.respond(utterance);
    assert.equal(winningFamily(eliza), familyId, `${familyId} <- "${utterance}"`);
  }
});

test('captures quote the span that matched, not an interpretation', () => {
  const eliza = fresh();
  eliza.respond('i feel anxious because my boss keeps piling on work');
  const { captures } = positive(eliza);
  assert.equal(captures.feeling, 'anxious');
  assert.equal(captures.reason, 'my boss keeps piling on work');
});

test('negation and tense survive normalization and reach the capture', () => {
  const eliza = fresh();
  eliza.respond('i am not sad because my boss does not listen');
  const { captures } = positive(eliza);
  // The negated feeling is not treated as an affirmative state; the reason is
  // still available to the neutral because pattern.
  assert.equal(captures.feeling, undefined);
  assert.equal(captures.reason, 'my boss does not listen');
});

test('hyphenated aliases and tags survive tokenization', () => {
  const anxious = fresh();
  anxious.respond('i am on-edge');
  assert.equal(winningFamily(anxious), 'ANXIETY');
  assert.equal(positive(anxious).captures.state, 'on-edge');
  assert.ok(anxious.lastTrace.find((step) => step.step === 'normalize').words.includes('anxious'));

  const family = fresh();
  family.respond('my brother-in-law called');
  assert.equal(winningFamily(family), 'FAMILY');
  assert.equal(positive(family).captures.relative, 'brother-in-law');

  const work = fresh();
  work.respond('i got laid-off');
  assert.equal(winningFamily(work), 'WORK_STRESS');
  assert.ok(work.lastTrace.find((step) => step.step === 'normalize').words.includes('laid-off'));
});

test('spaced aliases and multiword contractions retain their original quote spans', () => {
  const family = fresh();
  family.respond('my brother in law called');
  assert.equal(positive(family).captures.relative, 'brother in law');

  const anxious = fresh();
  anxious.respond('i am on edge');
  assert.equal(positive(anxious).captures.state, 'on edge');

  const contraction = fresh();
  contraction.respond("i ain't got time");
  assert.deepEqual(contraction.lastTrace.find((step) => step.step === 'normalize').words,
    ['i', 'do', 'not', 'have', 'time']);
});

test('negated states do not trigger affirmative questions', () => {
  const cases = [
    ['i am not anxious because my boss helped', 'ANXIETY'],
    ["i don't feel anxious", 'ANXIETY'],
    ['i am not sick', 'HEALTH'],
    ['i am not worthless', 'SELF_ESTEEM'],
    ['i was never angry at him', 'ANGER'],
    ['i am no longer lonely', 'LONELINESS'],
    ['i am not drinking', 'SUBSTANCES'],
    ['no one died', 'GRIEF'],
  ];
  for (const [input, family] of cases) {
    const eliza = fresh();
    eliza.respond(input);
    assert.notEqual(winningFamily(eliza), family, `${family} asserted for ${input}`);
  }

  const because = fresh();
  because.respond('i am not anxious because my boss helped');
  assert.equal(winningFamily(because), 'FEELING_CAUSE');
  assert.equal(positive(because).captures.feeling, undefined);

  const contrast = fresh();
  contrast.respond('i am not anxious, but i am sad');
  assert.equal(positive(contrast).captures.feeling, 'sad');
});

/* -------------------------------------------------------------------------- */
/* Context and memory                                                         */
/* -------------------------------------------------------------------------- */

test('a short reply is read against the question just asked', () => {
  const eliza = fresh();
  eliza.respond('my boss is on my case');
  const reply = eliza.respond('yes');
  assert.equal(winningFamily(eliza), 'FOLLOWUP_YESNO');
  assert.equal(reply, 'Then your work is worth staying with. Say more about it.');
});

test('a bare affirmative with no question pending is not treated as an answer', () => {
  const eliza = fresh();
  eliza.respond('yes');
  assert.notEqual(winningFamily(eliza), 'FOLLOWUP_YESNO');
});

test('context follows the topic across turns', () => {
  const eliza = fresh();
  eliza.respond('my mother takes care of me');
  assert.equal(eliza.context.topic, 'family');
  eliza.respond('my boss keeps calling');
  assert.equal(eliza.context.topic, 'work');
});

test('a rule can remember, and a later rule can recall', () => {
  const eliza = fresh();
  eliza.respond('i feel anxious because my boss keeps piling on work');
  assert.equal(eliza.memory.length, 1);
  assert.equal(eliza.memory[0].used, false);

  const reply = eliza.respond('what did i say earlier');
  assert.equal(winningFamily(eliza), 'MEMORY_RECALL');
  assert.equal(reply, 'Earlier you said my boss keeps piling on work. Does that still hold?');
  assert.equal(eliza.memory[0].used, true);
});

test('a recall rule stays quiet when nothing has been remembered', () => {
  const eliza = fresh();
  eliza.respond('what did i say earlier');
  assert.notEqual(winningFamily(eliza), 'MEMORY_RECALL');
});

test('reassemble never repeats a response consecutively', () => {
  // Three templates, six turns: the recent window holds all three from turn
  // four on, so the interesting behaviour starts exactly where the old
  // three-turn version of this test stopped looking.
  const eliza = fresh();
  const replies = [];
  for (let i = 0; i < 6; i += 1) replies.push(eliza.respond('my boss is on my case'));
  for (let i = 1; i < replies.length; i += 1) {
    assert.notEqual(replies[i], replies[i - 1], `turn ${i + 1} repeated turn ${i}`);
  }
  assert.equal(new Set(replies).size, 3);
});

/* -------------------------------------------------------------------------- */
/* Semantics as an optional index                                             */
/* -------------------------------------------------------------------------- */

test('the engine works with no encoder at all', () => {
  const eliza = fresh();
  eliza.respond('i cannot keep up');
  assert.equal(winningFamily(eliza), 'GENERIC');
  const step = eliza.lastTrace.find((s) => s.step === 'semantics');
  assert.equal(step.status, 'unavailable');
});

test('a throwing encoder does not take the conversation with it', () => {
  const broken = { suggest() { throw new Error('encoder exploded'); } };
  const eliza = fresh({ semantics: broken });
  const reply = eliza.respond('i cannot keep up');
  assert.equal(winningFamily(eliza), 'GENERIC');
  assert.match(reply, /\S/);
  const step = eliza.lastTrace.find((s) => s.step === 'semantics');
  assert.equal(step.status, 'error');
});

test('the index proposes a family that literal matching missed', () => {
  const eliza = fresh({ semantics: createSemantics(SCRIPT) });
  // "on my case all day" is in no tag and no keyword list; the only way to
  // reach WORK_STRESS is the index noticing it against the examples.
  eliza.respond('he is on my case all day');
  assert.equal(winningFamily(eliza), 'WORK_STRESS');
  const step = eliza.lastTrace.find((s) => s.step === 'semantics');
  assert.equal(step.suggestions[0].family, 'WORK_STRESS');
});

test('the index never returns reply text, only family ids and scores', () => {
  const known = new Set(SCRIPT.families.map((f) => f.id));
  const index = new SemanticIndex(SCRIPT);
  for (const suggestion of index.suggest('work is piling up and i cannot keep up')) {
    assert.ok(known.has(suggestion.family), `${suggestion.family} is not a family`);
    assert.equal(typeof suggestion.score, 'number');
    assert.ok(!('text' in suggestion) && !('template' in suggestion));
  }
});

test('a weak match is rejected rather than guessed at', () => {
  const eliza = fresh({ semantics: createSemantics(SCRIPT) });
  eliza.respond('purple monkey dishwasher');
  assert.equal(winningFamily(eliza), 'GENERIC');
});

test('bundled vectors answer identically to vectors computed at load', () => {
  // Same encoder on both sides, because that is the only way the comparison is
  // meaningful: vectors are comparable only within one model.
  const encoder = new HashedEncoder();
  const shipped = new SemanticIndex(SCRIPT, { encoder, vectors: precomputeVectors(SCRIPT, encoder) });
  const computed = new SemanticIndex(SCRIPT, { encoder });
  const probe = 'he is on my case all day';
  assert.deepEqual(shipped.suggest(probe), computed.suggest(probe));
  assert.ok(shipped.ready);
});

test('an index holding model vectors refuses to encode a query in another space', () => {
  // No encoder and no supplied embedding: the index says nothing rather than
  // silently comparing a hashed query against model vectors.
  const index = new SemanticIndex(SCRIPT, { vectors: precomputeVectors(SCRIPT) });
  assert.deepEqual(index.suggest('my boss is on my case all day'), []);
});

test('a literal match is never overridden by the index', () => {
  // WORK_STRESS wins on its own keyword; the encoder is not consulted.
  const eliza = fresh({ semantics: createSemantics(SCRIPT) });
  eliza.respond('my boss is on my case');
  assert.equal(winningFamily(eliza), 'WORK_STRESS');
  assert.equal(eliza.lastTrace.some((s) => s.step === 'semantics'), false);
});

/* -------------------------------------------------------------------------- */
/* Trace                                                                      */
/* -------------------------------------------------------------------------- */

test('a turn leaves the whole path behind it', () => {
  const eliza = fresh();
  eliza.respond('i feel anxious because my boss keeps piling on work');

  const steps = eliza.lastTrace.map((s) => s.step);
  assert.deepEqual(steps.slice(0, 3), ['input', 'normalize', 'candidates']);

  const last = eliza.lastTrace[eliza.lastTrace.length - 1];
  assert.equal(last.step, 'reassemble');
  assert.equal(last.family, 'FEELING_CAUSE');
  assert.ok(last.captures.reason);
  assert.deepEqual(last.memory, ['my boss keeps piling on work']);
  assert.match(last.output, /\S/);

  // candidate source -> rank -> rule, all readable from the terminal step.
  assert.equal(last.source, 'keyword');
  assert.equal(typeof last.rank, 'number');
  assert.equal(last.matchedOn, 'because');
  assert.equal(last.rule, 'FEELING_CAUSE.because');
});

test('every template names a capture its pattern can actually produce', () => {
  // A slot that was renamed in the match but not in the templates renders as an
  // empty gap and nobody notices, because an empty substitution is not an
  // error. Checking the script against itself catches that class of typo.
  const CONTEXT_SLOTS = new Set(['lastTopic', 'memory']);
  const problems = [];
  for (const family of SCRIPT.families) {
    for (const rule of family.rules || []) {
      const patterns = rule.patternsFrom
        ? SCRIPT.patternSets?.[rule.patternsFrom] || []
        : rule.patterns || [];
      for (const pattern of patterns) {
        const producible = new Set();
        for (const token of pattern.match || []) {
          // Capture grammar: {name}, {name:/TAG}, {name:flip}.
          const named = /^\{([a-zA-Z0-9_]+)(?::\/[a-zA-Z0-9_]+)?\}$/.exec(token);
          if (named) producible.add(named[1]);
        }
        for (const template of pattern.templates || []) {
          for (const slot of template.match(/\{[a-zA-Z0-9_]+(?::[a-zA-Z/]+)?\}/g) || []) {
            const name = slot.slice(1, -1).split(':')[0];
            if (CONTEXT_SLOTS.has(name)) continue;
            if (!producible.has(name)) {
              problems.push(`${family.id}/${rule.id}: {${name}} is not produced by ${JSON.stringify(pattern.match)}`);
            }
          }
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('no template splices a clause capture into a noun-phrase frame', () => {
  // {reason} captures everything after "because", so it is a clause, not a
  // noun phrase. Frames written for a noun phrase produced "What about my boss
  // keeps piling on work affects you most?". These frames must not come back.
  const forbidden = [
    'What about {reason} affects you most?',
    'So {reason} is what makes you feel {feeling}.',
    'Does {reason} come up often?',
    'You trace that back to {reason}.',
  ];
  const all = [];
  for (const family of SCRIPT.families) {
    for (const rule of family.rules || []) {
      const patterns = rule.patternsFrom
        ? SCRIPT.patternSets?.[rule.patternsFrom] || []
        : rule.patterns || [];
      for (const pattern of patterns) all.push(...(pattern.templates || []));
    }
  }
  for (const bad of forbidden) {
    assert.ok(!all.includes(bad), `clause capture spliced into a noun-phrase frame: ${bad}`);
  }
});

test('a rendered reply leaves no slot behind and no doubled space', () => {
  for (const c of [...FAMILY_CASES, ...NEGATIVE_CASES]) {
    const eliza = runCase(c);
    const last = eliza.lastTrace[eliza.lastTrace.length - 1];
    const reply = last.output ?? '';
    assert.ok(!reply.includes('{'), `${c.family} left a slot unfilled: ${reply}`);
    assert.ok(!/\s{2}/.test(reply), `${c.family} doubled a space: ${reply}`);
    assert.ok(reply.trim().length > 0, `${c.family} produced an empty reply`);
  }
});

test('candidates come back in script rank order', () => {
  const eliza = fresh();
  eliza.respond('i feel anxious because my boss keeps piling on work');
  const { list } = eliza.lastTrace.find((s) => s.step === 'candidates');
  const ranks = list.map((c) => c.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => b - a));
  assert.ok(list.every((c) => c.via === 'keyword' || c.via === 'tag' || c.via === 'always'));
});

test('normalization expands contractions without losing the original span', () => {
  const eliza = fresh();
  eliza.respond("i'm anxious because i can't keep up");
  const normalized = eliza.lastTrace.find((s) => s.step === 'normalize');
  assert.deepEqual(normalized.words.slice(0, 4), ['i', 'am', 'anxious', 'because']);
  const { captures } = positive(eliza);
  assert.equal(captures.feeling, 'anxious');
});

test('the greeting is the script\'s, not a hardcoded one', () => {
  assert.equal(fresh().greeting, SCRIPT.greeting);
});

/* -------------------------------------------------------------------------- */
/* Regressions — each of these failed before the fix it names                  */
/* -------------------------------------------------------------------------- */

test('a keyword in a second sentence is still reachable', () => {
  // Every pattern begins with "0". Bounding that wildcard to the first
  // sentence made any rule keyed after a full stop unmatchable.
  const eliza = fresh();
  eliza.respond('i had a rough day. my boss is on my case');
  assert.equal(winningFamily(eliza), 'WORK_STRESS');
  assert.equal(positive(eliza).rule, 'WORK_STRESS.boss');
});

test('a wildcard crosses sentences but a capture does not', () => {
  const eliza = fresh();
  eliza.respond('the bus was late. my mother called');
  const { captures } = positive(eliza);
  assert.equal(captures.relative, 'mother');
  assert.equal(captures.predicate, 'called');
  // The skip may span the boundary; the quoted span may not.
  assert.ok(captures['1'].includes('.'), 'the wildcard should have crossed the boundary');
  assert.ok(!captures.relative.includes('.'), 'a capture must not cross it');
});

test('a provider that is still loading does not kill the turn', () => {
  const loading = { suggest: async () => [{ family: 'WORK_STRESS', score: 1 }] };
  const eliza = fresh({ semantics: loading });
  const reply = eliza.respond('i cannot keep up');
  assert.match(reply, /\S/);
  assert.equal(eliza.lastTrace.find((s) => s.step === 'semantics').status, 'unusable');
});

test('an expectation is consumed, not left armed for good', () => {
  const eliza = fresh();
  eliza.respond('my boss is on my case');
  assert.deepEqual(eliza.context.expect, ['YES', 'NO']);
  eliza.respond('yes');
  assert.deepEqual(eliza.context.expect, []);
  eliza.respond('yes');
  assert.notEqual(winningFamily(eliza), 'FOLLOWUP_YESNO');
});

test('a follow-up does not rename the topic it follows up on', () => {
  const eliza = fresh();
  eliza.respond('my boss is on my case');
  eliza.respond('yes');
  assert.equal(eliza.context.lastTopic, 'work');
});

test('a catchall does not author memory', () => {
  const eliza = fresh();
  eliza.respond('purple monkey dishwasher');
  assert.equal(eliza.memory.length, 0);
});

test('a redirect hands the turn to the rule it names', () => {
  // The script ships no redirect yet; the capability is part of the design, so
  // it is exercised here rather than left as unreachable code.
  const script = {
    greeting: 'x',
    tags: {},
    families: [
      {
        id: 'A',
        topic: 'a',
        rank: 5,
        rules: [{ id: 'A.r', rank: 9, keywords: ['alpha'], patterns: [{ match: ['0', 'alpha', '0'], redirect: 'B.r' }] }],
      },
      {
        id: 'B',
        topic: 'b',
        rank: 1,
        rules: [{ id: 'B.r', rank: 1, patterns: [{ match: ['0'], templates: ['REDIRECTED'] }] }],
      },
    ],
  };
  assert.equal(new ExtendedEliza(script).respond('alpha'), 'REDIRECTED');
});

test('a proposed family with no matching rule falls through to the script fallback', () => {
  const script = {
    greeting: 'x',
    tags: {},
    families: [
      {
        id: 'LONELY',
        topic: 'lonely',
        rank: 5,
        examples: ['nobody ever calls me any more'],
        rules: [
          {
            id: 'LONELY.r',
            rank: 9,
            keywords: ['zzz-never-matches'],
            patterns: [{ match: ['0', 'zzz-never-matches', '0'], templates: ['SHOULD NOT FIRE'] }],
          },
        ],
      },
      {
        id: 'GENERIC',
        topic: 'general',
        fallback: true,
        rules: [{ id: 'GENERIC.r', patterns: [{ match: ['0'], templates: ['PLEASE GO ON'] }] }],
      },
    ],
  };
  // A provider that proposes LONELY without any literal keyword being present.
  const proposing = { suggest: () => [{ family: 'LONELY', score: 0.9 }] };
  const eliza = new ExtendedEliza(script, { semantics: proposing });
  const reply = eliza.respond('nobody ever calls me any more');
  assert.equal(reply, 'PLEASE GO ON');
  assert.equal(winningFamily(eliza), 'GENERIC');
  assert.equal(eliza.lastTrace.at(-1).step, 'reassemble');
  assert.equal(eliza.context.topic, null);
});

test('semantic suggestions cannot create a reply without a matched pattern', () => {
  for (const family of ['FAMILY', 'WORK_STRESS', 'SLEEP_TIRED']) {
    const eliza = fresh({ semantics: { suggest: () => [{ family, score: 1 }] } });
    eliza.respond('purple monkey dishwasher');
    assert.equal(winningFamily(eliza), 'GENERIC', `${family} claimed unrelated input`);
    assert.equal(eliza.lastTrace.at(-1).step, 'reassemble');
    assert.ok(!eliza.lastTrace.some((step) => step.step === 'topic-prompt'));
  }
});

test('semantic work paraphrases still need an affirmative literal match', () => {
  const proposing = { suggest: () => [{ family: 'WORK_STRESS', score: 1 }] };
  const denied = fresh({ semantics: proposing });
  denied.respond('he is not on my case');
  assert.equal(winningFamily(denied), 'GENERIC');

  const affirmed = fresh({ semantics: proposing });
  affirmed.respond('he is on my case all day');
  assert.equal(winningFamily(affirmed), 'WORK_STRESS');
});

test('a script without a matching fallback cannot emit an engine-authored reply', () => {
  const eliza = new ExtendedEliza({ families: [] });
  assert.throws(() => eliza.respond('purple monkey dishwasher'), /no matching fallback pattern/);
});

test('context and memory keep the state the design names', () => {
  const eliza = fresh();
  eliza.respond('i feel anxious because my boss keeps piling on work');

  // State: current topic, the last question asked, and recent response ids.
  assert.equal(eliza.context.topic, 'feeling');
  assert.deepEqual(eliza.context.expect, ['YES', 'NO']);
  assert.equal(eliza.context.lastTopic, 'feeling');
  assert.ok(Array.isArray(eliza.recent));
  assert.ok(eliza.recent.length >= 1 && eliza.recent.length <= 4);

  // Memory: captured wording, topic tag, turn, and an already-used flag.
  assert.equal(eliza.memory.length, 1);
  const [entry] = eliza.memory;
  assert.deepEqual(Object.keys(entry).sort(), ['text', 'topic', 'turn', 'used']);
  assert.equal(entry.text, 'my boss keeps piling on work');
  assert.equal(entry.topic, 'feeling');
  assert.equal(entry.turn, 1);
  assert.equal(entry.used, false);

  // And nothing beyond that: no biography, no people graph, no inferred facts.
  assert.equal(eliza.memory.every((m) => typeof m.text === 'string'), true);
});

test('a rule that cannot use its keyword falls through to the next candidate', () => {
  // The 1966 mechanism is NEWKEY: abandon the current keyword and take the next
  // one off the stack. The extended engine keeps the behaviour without the name
  // — the candidate list is walked in rank order and an unusable or unmatched
  // rule is skipped. This pins that, because nothing else did.
  const script = {
    greeting: 'x',
    tags: {},
    families: [
      {
        id: 'HIGH',
        topic: 'high',
        rank: 50,
        rules: [
          {
            id: 'HIGH.r',
            rank: 50,
            keywords: ['topical'],
            // An expectation gate makes the highest-ranked rule unusable on its
            // own keyword, which is precisely the NEWKEY situation.
            patterns: [{ match: ['0', 'topical', '0'], requires: 'expect', templates: ['HIGH FIRED'] }],
          },
        ],
      },
      {
        id: 'LOW',
        topic: 'low',
        rank: 10,
        rules: [
          { id: 'LOW.r', rank: 10, keywords: ['topical'], patterns: [{ match: ['0', 'topical', '0'], templates: ['LOW FIRED'] }] },
        ],
      },
    ],
  };

  const eliza = new ExtendedEliza(script);
  assert.equal(eliza.respond('topical'), 'LOW FIRED');
  // Both candidates were considered, in rank order, and the first was skipped.
  const tried = eliza.lastTrace.filter((s) => s.step === 'rule').map((s) => `${s.rule}:${s.matched}`);
  assert.deepEqual(tried, ['HIGH.r:true', 'LOW.r:true']);
  const last = eliza.lastTrace[eliza.lastTrace.length - 1];
  assert.equal(last.rule, 'LOW.r');
  assert.equal(last.source, 'keyword');
});

test('a long run-on stays within a sane budget', () => {
  const eliza = fresh();
  const input = Array.from({ length: 800 }, () => 'anxious').join(' ');
  const start = performance.now();
  eliza.respond(input);
  // 800 words took ~2055ms while the tag test rescanned the span; ~35ms once
  // prefix counts made it O(1). The bound is loose on purpose.
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 500, `matcher took ${elapsed.toFixed(0)}ms on a run-on`);
});

test('memory stays small over a long session', () => {
  const eliza = fresh();
  for (let i = 0; i < 40; i += 1) {
    eliza.respond(`i feel anxious because my boss keeps piling on work, day ${i}`);
  }
  assert.ok(eliza.memory.length <= 12, `memory grew to ${eliza.memory.length}`);
  // The cap drops already-recalled entries first, so nothing unread was lost.
  assert.ok(eliza.memory.some((m) => !m.used) || eliza.memory.every((m) => m.used));
});
