import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptCharacter } from './input.js';
import { Eliza } from '../modes/rewrite/eliza.js';
import { ElizaPort1966 } from '../modes/port/eliza-1966.js';
import { SCRIPT_1966 } from '../data/scripts/eliza-1966-cacm.js';

test('question mark deletes only the current historical input line', () => {
  const line = { text: '', lines: ['MY MOTHER'], questionDeletes: true };
  const strikes = [];
  for (const key of 'MY DOG?I AM HAPPY') {
    if (acceptCharacter(line, key)) strikes.push(key);
  }
  assert.equal(line.text, 'I AM HAPPY');
  assert.deepEqual(line.lines, ['MY MOTHER']);
  assert.equal(strikes.join(''), 'MY DOG?I AM HAPPY');
  // Independently observed on the compiled 1966 CTSS disk, with a blank card.
  assert.equal(new Eliza(SCRIPT_1966, { dialect: '1966' }).respond(line.text),
    'HOW HAVE I HELPED YOU TO BE HAPPY');
  assert.equal(new ElizaPort1966(SCRIPT_1966).respond(line.text),
    'HOW HAVE I HELPED YOU TO BE HAPPY');
});

test('native CTSS and extended input retain the question mark for their receiver', () => {
  for (const terse of [true, false]) {
    const line = { text: '', terse, questionDeletes: false };
    for (const key of 'MY DOG?I AM HAPPY') acceptCharacter(line, key);
    assert.equal(line.text, 'MY DOG?I AM HAPPY');
  }
});

test('line deletion works at the input limit and allows fresh characters', () => {
  const line = { text: 'A'.repeat(72), terse: true, questionDeletes: true };
  assert.equal(acceptCharacter(line, 'B'), false);
  assert.equal(acceptCharacter(line, '?'), true);
  assert.equal(line.text, '');
  assert.equal(acceptCharacter(line, 'C'), true);
  assert.equal(line.text, 'C');
  assert.equal(acceptCharacter(line, '?'), true);
  assert.equal(acceptCharacter(line, '?'), true);
  assert.equal(line.text, '');
});
