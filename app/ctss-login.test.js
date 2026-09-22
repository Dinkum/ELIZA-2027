import assert from 'node:assert/strict';
import test from 'node:test';

import { CtssOutput, logInToCtss } from './ctss-login.js';

test('the virtual operator logs in and stops at CTSS command level', async () => {
  const output = new CtssOutput();
  const typed = [];
  const login = logInToCtss(output, async (line) => {
    typed.push(line);
    if (line === 'LOGIN ELIZA') {
      output.push('W 1618.9\r\nPASS');
      output.push('WORD');
    }
    if (line === 'ELIZA') output.push('WORD\r\n HOME FILE DIRECTORY IS M1416 ELIZA\r\nR 1.733+.000');
    return true;
  });

  output.push('MIT8C0: 0 USERS\r\nREA');
  assert.deepEqual(typed, []);
  output.push('DY.\r\n');

  assert.equal(await login, true);
  assert.deepEqual(typed, ['LOGIN ELIZA', 'ELIZA']);
});

test('the virtual operator stops when the line rejects a credential', async () => {
  const output = new CtssOutput();
  output.push('READY.');

  assert.equal(await logInToCtss(output, async () => false), false);
});
