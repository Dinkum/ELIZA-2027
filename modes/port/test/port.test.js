/**
 * The JS PORT, checked against the CTSS reconstruction.
 *
 * Both sessions in references/1965b-CTSS-reconstruction/etc/running-eliza.txt
 * are the recovered ELIZA binary running under CTSS on an emulated 7094, one
 * with each script. The port must match them line for line, including the
 * places where the code is wrong.
 *
 * Run with: node --test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ElizaPort, SlipFault } from '../eliza.js';
import { SCRIPT_1965B } from '../../../data/scripts/eliza-1965b-tape100.js';
import { SCRIPT_1966 } from '../../../data/scripts/eliza-1966-cacm.js';

const PROMPTS = [
  'Men are all alike.',
  "They're always bugging us about something or other.",
  'Well, my boyfriend made me come here.',
  'He says I am depressed much of the time.',
  "It's true. I am unhappy.",
  'I need some help, that much seems certain.',
  'Perhaps I could learn to get along with my mother.',
  'My mother takes care of me.',
  'My father.',
  'You are like my father in some ways.',
  "You are not very aggressive, but I think you don't want me to notice that.",
  "You don't argue with me.",
  'You are afraid of me.',
  'My father is afraid of everybody.',
  'Bullies.',
];

const TAPE_100 = [
  'DID YOU THINK THEY MIGHT NOT BE ALL ALIKE',
  'CAN YOU THINK OF A SPECIFIC EXAMPLE',
  'YOUR BOYFRIEND MADE YOU COME HERE',
  'IS IT BECAUSE YOU ARE DEPRESSED MUCH OF THE TIME THAT YOU CAME TO ME',
  'HOW LONG HAVE YOU BEEN UNHAPPY',
  'YOU SAY YOU NEED SOME HELP',
  "YOU DON'T SEEM QUITE CERTAIN",
  'TELL ME MORE ABOUT YOUR FAMILY',
  'WHO ELSE IN YOUR FAMILY',
  'WHAT MAKES YOU THINK I AM LIKE YOUR FATHER IN SOME WAYS',
  'DOES IT PLEASE YOU TO BELIEVE I AM NOT VERY AGGRESSIVE',
  "WHY DO YOU THINK I DON'T ARGUE WITH YOU",
  // TESTS substitutes ARE -> AM in the input before the reply is assembled.
  'DID YOUR PARENTS AM AFRAID OF YOU',
  'REALLY , EVERYONE',
  'DOES THAT HAVE ANYTHING TO DO WITH THE FACT THAT YOUR BOYFRIEND MADE YOU COME HERE',
];

const TAPE_200 = [
  'IN WHAT WAY',
  'CAN YOU THINK OF A SPECIFIC EXAMPLE',
  'YOUR BOYFRIEND MADE YOU COME HERE',
  'I AM SORRY TO HEAR YOU ARE DEPRESSED',
  'DO YOU THINK COMING HERE WILL HELP YOU NOT TO BE UNHAPPY',
  'WHAT WOULD IT MEAN TO YOU IF YOU GOT SOME HELP',
  'TELL ME MORE ABOUT YOUR FAMILY',
  'WHO ELSE IN YOUR FAMILY TAKES CARE OF YOU',
  'YOUR FATHER',
  // (LIKE 10 ((0 (*AM IS ARE WAS) 0 LIKE 0) (=DIT))): the 1965b code has no
  // reassembly-level links, so ASSMBL copies the link through and types it.
  '= DIT',
  'WHAT MAKES YOU THINK I AM NOT VERY AGGRESSIVE',
  "WHY DO YOU THINK I DON'T ARGUE WITH YOU",
  'DOES IT PLEASE YOU TO BELIEVE I AM AFRAID OF YOU',
  'WHAT ELSE COMES TO MIND WHEN YOU THINK OF YOUR FATHER',
  'DOES THAT HAVE ANYTHING TO DO WITH THE FACT THAT YOUR BOYFRIEND MADE YOU COME HERE',
];

test('.TAPE. 100 session', () => {
  const eliza = new ElizaPort(SCRIPT_1965B);
  // TXTPRT builds its line in fourteen six-character words, so the greeting
  // breaks after TELL ME exactly as it does on the printout.
  assert.equal(
    eliza.greeting,
    'HOW DO YOU DO . I AM THE DOCTOR . PLEASE SIT DOWN AT THE TYPEWRITER AND TELL ME\nYOUR PROBLEM .',
  );
  PROMPTS.forEach((prompt, i) => assert.equal(eliza.respond(prompt), TAPE_100[i], prompt));
});

test('.TAPE. 200 session', () => {
  const eliza = new ElizaPort(SCRIPT_1966);
  assert.equal(eliza.greeting, 'HOW DO YOU DO . PLEASE TELL ME YOUR PROBLEM');
  PROMPTS.forEach((prompt, i) => assert.equal(eliza.respond(prompt), TAPE_200[i], prompt));
});

/*
 * The three features the 1966 paper describes and the 1965b code does not have.
 * KNOWN-ISSUES.md in the CTSS reconstruction lists all three; the point of the
 * port is that they fail here the way they fail there.
 */

test('NEWKEY is typed out, not acted on', () => {
  const eliza = new ElizaPort(SCRIPT_1966);
  const dreamt = () => eliza.respond('I dreamt about my mother.');
  assert.equal(dreamt(), 'REALLY , ABOUT YOUR MOTHER');
  assert.equal(dreamt(), 'HAVE YOU EVER FANTASIED ABOUT YOUR MOTHER WHILE YOU WERE AWAKE');
  assert.equal(dreamt(), 'HAVE YOU DREAMT ABOUT YOUR MOTHER BEFORE');
  assert.equal(dreamt(), '= DREAM'); // a reassembly-level link
  assert.equal(dreamt(), 'NEWKEY');
  assert.equal(dreamt(), 'REALLY , ABOUT YOUR MOTHER'); // round to the first rule
});

test('PRE leaves a sublist in the reply that TXTPRT cannot type', () => {
  const eliza = new ElizaPort(SCRIPT_1966);
  // (I'M = YOU'RE ((0 YOU'RE 0) (PRE (YOU ARE 3) (=I))))
  assert.throws(() => eliza.respond("I'm depressed."), SlipFault);
});

test('a number in the input stops the machine', () => {
  // KNOWN-ISSUES.md: "Numerical input ... may cause ELIZA to crash or hang.
  // It looks like ELIZA/SLIP reads numbers correctly from input, but does not
  // know how to print them when outputting her response."
  const eliza = new ElizaPort(SCRIPT_1966);
  assert.throws(() => eliza.respond('I have 99 bugs to fix today.'), SlipFault);
});

test('the reply for a sentence with no keyword comes from NONE', () => {
  const eliza = new ElizaPort(SCRIPT_1965B);
  assert.equal(eliza.respond('Zork frobnicates.'), 'I AM NOT SURE I UNDERSTAND YOU FULLY');
  assert.equal(eliza.respond('Zork frobnicates.'), 'PLEASE GO ON');
});
