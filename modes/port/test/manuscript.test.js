import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ElizaPort1966 } from '../eliza-1966.js';
import { SCRIPT_1966 } from '../../../data/scripts/eliza-1966-cacm.js';

// Archive derivatives stay local under their delivery conditions.
const root = new URL('../../../sources/mit-65307-eliza-papers-and-material/documents/', import.meta.url);
const fixture = new URL('109-111-replacement-opening/conversation.json', root);
const tape = new URL('105-107-tape112-copy-c/script.txt', root);

test('local manuscript opening with the published CACM script', {
  skip: !existsSync(fixture) && 'local archive fixture is not installed',
}, () => {
  const eliza = new ElizaPort1966(SCRIPT_1966);
  for (const [input, expected] of JSON.parse(readFileSync(fixture)).turns) {
    assert.equal(eliza.respond(input), expected, input);
  }
});

test('local manuscript opening with the separate TAPE.112 reading', {
  skip: (!existsSync(fixture) || !existsSync(tape)) && 'local archive reading is not installed',
}, () => {
  const eliza = new ElizaPort1966(readFileSync(tape, 'utf8'));
  // This checks compatibility; the manuscript does not identify its executable.
  for (const [input, expected] of JSON.parse(readFileSync(fixture)).turns) {
    assert.equal(eliza.respond(input), expected, input);
  }
});
