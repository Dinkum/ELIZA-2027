/**
 * The two published ELIZA conversations, used as the acceptance test for the
 * JS rewrite. Both must reproduce exactly, word for word.
 *
 *   1965b  references/1965b-CTSS-reconstruction/etc/running-eliza.txt
 *          (script .TAPE. 100 running on the reconstructed CTSS)
 *   1966   the conversation on pages 36-37 of the CACM paper
 *          (references/1966-Weizenbaum-CACM-ELIZA.pdf)
 *
 * Run with: node --test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Eliza } from '../eliza.js';
import { hashWord, lastChunkAsBcd } from '../../../shared/hollerith.js';
import { SCRIPT_1965B } from '../../../data/scripts/eliza-1965b-tape100.js';
import { SCRIPT_1966 } from '../../../data/scripts/eliza-1966-cacm.js';

const CTSS_1965B = [
  ['Men are all alike.', 'DID YOU THINK THEY MIGHT NOT BE ALL ALIKE'],
  ["They're always bugging us about something or other.", 'CAN YOU THINK OF A SPECIFIC EXAMPLE'],
  ['Well, my boyfriend made me come here.', 'YOUR BOYFRIEND MADE YOU COME HERE'],
  ['He says I am depressed much of the time.',
    'IS IT BECAUSE YOU ARE DEPRESSED MUCH OF THE TIME THAT YOU CAME TO ME'],
  ["It's true. I am unhappy.", 'HOW LONG HAVE YOU BEEN UNHAPPY'],
  ['I need some help, that much seems certain.', 'YOU SAY YOU NEED SOME HELP'],
  ['Perhaps I could learn to get along with my mother.', "YOU DON'T SEEM QUITE CERTAIN"],
  ['My mother takes care of me.', 'TELL ME MORE ABOUT YOUR FAMILY'],
  ['My father.', 'WHO ELSE IN YOUR FAMILY'],
  ['You are like my father in some ways.',
    'WHAT MAKES YOU THINK I AM LIKE YOUR FATHER IN SOME WAYS'],
  ["You are not very aggressive, but I think you don't want me to notice that.",
    'DOES IT PLEASE YOU TO BELIEVE I AM NOT VERY AGGRESSIVE'],
  ["You don't argue with me.", "WHY DO YOU THINK I DON'T ARGUE WITH YOU"],
  // Not a rewrite bug: .TAPE. 100 substitutes ARE -> AM before reassembly.
  ['You are afraid of me.', 'DID YOUR PARENTS AM AFRAID OF YOU'],
  ['My father is afraid of everybody.', 'REALLY , EVERYONE'],
  ['Bullies.',
    'DOES THAT HAVE ANYTHING TO DO WITH THE FACT THAT YOUR BOYFRIEND MADE YOU COME HERE'],
];

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

test('1965b reproduces the CTSS .TAPE. 100 transcript', () => {
  const eliza = new Eliza(SCRIPT_1965B, { dialect: '1965b' });
  assert.equal(
    eliza.greeting,
    'HOW DO YOU DO . I AM THE DOCTOR . PLEASE SIT DOWN AT THE TYPEWRITER AND TELL ME YOUR PROBLEM .',
  );
  for (const [input, expected] of CTSS_1965B) assert.equal(eliza.respond(input), expected, input);
});

test('1966 reproduces the CACM paper conversation', () => {
  const eliza = new Eliza(SCRIPT_1966, { dialect: '1966' });
  assert.equal(eliza.greeting, 'HOW DO YOU DO . PLEASE TELL ME YOUR PROBLEM');
  for (const [input, expected] of CACM_1966) assert.equal(eliza.respond(input), expected, input);
});

test('SLIP HASH matches the documented values', () => {
  // Weizenbaum, CACM page 38: "The word 'always' ... yields the integer 14."
  assert.equal(lastChunkAsBcd('ALWAYS'), 0o214366217062n);
  assert.equal(hashWord('ALWAYS', 7), 14);
  // MEMORY rule selection: hash of the last cell, two bits.
  assert.equal(hashWord('HERE', 2), 3);
  assert.equal(hashWord('PURPOSE', 2), 1);
  assert.equal(hashWord('DEVONSHIRE', 2), 0);
  assert.equal(hashWord('PREDICAMENT', 2), 3);
  // SLIP packed six characters per cell, so only the last chunk is hashed.
  assert.equal(lastChunkAsBcd('INVENTED'), 0o252460606060n);
});
