import test from 'node:test';
import assert from 'node:assert/strict';
import { ElizaPort1966 } from '../eliza-1966.js';
import { SCRIPT_1966 } from '../../../data/scripts/eliza-1966-cacm.js';

test('published opening reply', () => {
  const eliza = new ElizaPort1966(SCRIPT_1966);
  assert.equal(eliza.KEY.length, 129); // CACM p. 38: 128 hashed slots plus NONE.
  assert.equal(eliza.respond('Men are all alike.'), 'IN WHAT WAY');
});

test('MEMORY hashes the final word even when a DLIST tag follows it', () => {
  const eliza = new ElizaPort1966(SCRIPT_1966);
  assert.equal(eliza.respond('My mother cares for me.'), 'TELL ME MORE ABOUT YOUR FAMILY');
  assert.equal(eliza.respond('cobalt.'), 'I AM NOT SURE I UNDERSTAND YOU FULLY');
  assert.equal(eliza.respond('cobalt.'), 'BUT YOUR MOTHER CARES FOR YOU');
});

test('PRE rebuilds the sentence before following its link', () => {
  const eliza = new ElizaPort1966(SCRIPT_1966);
  assert.equal(eliza.respond("I'm depressed."), 'I AM SORRY TO HEAR YOU ARE DEPRESSED');
});

test('reassembly links and NEWKEY advance through script rules', () => {
  const eliza = new ElizaPort1966(SCRIPT_1966);
  const reply = () => eliza.respond('I dreamt about my mother.');
  assert.equal(reply(), 'REALLY , ABOUT YOUR MOTHER');
  assert.equal(reply(), 'HAVE YOU EVER FANTASIED ABOUT YOUR MOTHER WHILE YOU WERE AWAKE');
  assert.equal(reply(), 'HAVE YOU DREAMT ABOUT YOUR MOTHER BEFORE');
  assert.equal(reply(), 'WHAT DOES THAT DREAM SUGGEST TO YOU');
  assert.equal(reply(), 'YOU SAY YOU DREAMT ABOUT YOUR MOTHER');
});

test('words sharing their first six-character cell are checked in full', () => {
  assert.equal(new ElizaPort1966(SCRIPT_1966).respond('machines.'), 'DO COMPUTERS WORRY YOU');
  assert.equal(new ElizaPort1966(SCRIPT_1966).respond('computers.'), 'DO COMPUTERS WORRY YOU');
});

test('a top-level keyword link follows its target rule', () => {
  const eliza = new ElizaPort1966(SCRIPT_1966);
  assert.equal(eliza.respond('everybody is here.'), 'REALLY , EVERYBODY');
});

// The published conversation on pages 36-37 of the CACM paper.
const CACM_1966 = [
  ['Men are all alike.', 'IN WHAT WAY'],
  ["They're always bugging us about something or other.", 'CAN YOU THINK OF A SPECIFIC EXAMPLE'],
  ['Well, my boyfriend made me come here.', 'YOUR BOYFRIEND MADE YOU COME HERE'],
  ["He says I'm depressed much of the time.", 'I AM SORRY TO HEAR YOU ARE DEPRESSED'],
  ["It's true. I am unhappy.", 'DO YOU THINK COMING HERE WILL HELP YOU NOT TO BE UNHAPPY'],
  ['I need some help, that much seems certain.', 'WHAT WOULD IT MEAN TO YOU IF YOU GOT SOME HELP'],
  ['Perhaps I could learn to get along with my mother.', 'TELL ME MORE ABOUT YOUR FAMILY'],
  ['My mother takes care of me.', 'WHO ELSE IN YOUR FAMILY TAKES CARE OF YOU'],
  ['My father.', 'YOUR FATHER'],
  ['You are like my father in some ways.', 'WHAT RESEMBLANCE DO YOU SEE'],
  ["You are not very aggressive but I think you don't want me to notice that.",
    'WHAT MAKES YOU THINK I AM NOT VERY AGGRESSIVE'],
  ["You don't argue with me.", "WHY DO YOU THINK I DON'T ARGUE WITH YOU"],
  ['You are afraid of me.', 'DOES IT PLEASE YOU TO BELIEVE I AM AFRAID OF YOU'],
  ['My father is afraid of everybody.', 'WHAT ELSE COMES TO MIND WHEN YOU THINK OF YOUR FATHER'],
  ['Bullies.',
    'DOES THAT HAVE ANYTHING TO DO WITH THE FACT THAT YOUR BOYFRIEND MADE YOU COME HERE'],
];

test('complete published CACM conversation', () => {
  const eliza = new ElizaPort1966(SCRIPT_1966);
  for (const [input, expected] of CACM_1966) assert.equal(eliza.respond(input), expected, input);
});
