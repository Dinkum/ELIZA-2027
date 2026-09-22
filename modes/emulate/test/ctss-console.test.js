/**
 * The whole machine, end to end, printing on a terminal.
 *
 * Everything below has to be right at once for this to pass: the processor
 * decodes and executes, RCHE finds the 7909 on channel E, the channel runs its
 * own instruction set out of core, the 7750 reassembles twelve bit characters
 * out of the words it is handed, and a line prints them. It is the shape of
 * what CTSS does every time it types at somebody, with the supervisor left out.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Machine } from '../src/machine.js';
import { assembleInto } from '../src/assemble.js';
import { CommunicationsController, CONSOLE_LINE, END_OF_MEDIUM } from '../src/devices/comm.js';

/** The wire's idea of one printable character. */
function outChar(code) {
  return (~(code << 1)) & 0o7777;
}

/** Twelve bit characters, three to a 36 bit word, as two 18 bit halves. */
function pack(characters) {
  const words = [];
  for (let i = 0; i < characters.length; i += 3) {
    const a = characters[i] & 0o7777;
    const b = (characters[i + 1] ?? END_OF_MEDIUM) & 0o7777;
    const c = (characters[i + 2] ?? END_OF_MEDIUM) & 0o7777;
    words.push([((a << 6) | (b >>> 6)) & 0o777777, (((b & 0o77) << 12) | c) & 0o777777]);
  }
  return words;
}

/** An output message: line and count are simply the first two characters. */
function message(line, text) {
  const data = [...text].map((c) => outChar(c.charCodeAt(0)));
  const head = (line & 0o777) | 0o2000;            // twelve bit characters
  return pack([head, data.length, ...data, END_OF_MEDIUM]);
}

/**
 * The program.
 *
 * Two channel command lists, run one after the other by the processor. The
 * first hands the 7750 the all-ones word that turns it on; the second hands it
 * a message. TWT at the end of each stops the channel and asks for a trap.
 *
 * The waits are counted loops rather than TCOE. TCO tests whether a device is
 * selected, which is a 7607 idea: a 7909 is never "selected", it is running a
 * program of its own, and a real driver waits for its trap instead. Counting
 * instructions is the crude version of that, and it is enough to show the
 * channel getting its cycles while the processor runs.
 */
const SOURCE = `
       ORG 100
START  RCHE ONLIST
       AXT 400,1
WAIT1  TIX WAIT1,1,1
       RCHE MSGLIST
       AXT 400,1
WAIT2  TIX WAIT2,1,1
       HTR 0

ONLIST OCT 340000000000
       OCT 120000200000
       OCT 240000000000
       OCT 000000000000

MSGLIST OCT 340000000000
       OCT 120000200000
       OCT 240000000000
       OCT 000000000000
`;

test('a program prints a line on the console through the 7750', () => {
  const machine = new Machine({ channels: 6, types: { 4: '7909' } });
  const channel = machine.channels[4];
  const comm = new CommunicationsController();
  channel.attach(0, comm);

  const printed = [];
  comm.lines[CONSOLE_LINE].onPrint = (text) => printed.push(text);

  const image = assembleInto(machine.core, SOURCE);

  // The two command lists are built here rather than in the assembler: a
  // channel command word is data, and the assembler only knows instructions.
  const on = image.symbols.get('ONLIST');
  const msg = image.symbols.get('MSGLIST');
  const put = (at, hi, lo) => { machine.core.hi[at] = hi; machine.core.lo[at] = lo; };

  // SMS, inhibiting attention; CTLW with nothing to send; CPYD; TWT.
  const cmdWord = (op, decrement, address) => {
    const prefix = op >>> 2;
    const bit3 = (op >>> 1) & 1;
    const bit19 = op & 1;
    return [
      ((prefix & 7) << 15) | ((decrement | (bit3 ? 0o40000 : 0)) & 0o77777),
      (address & 0o77777) | (bit19 ? 0o200000 : 0),
    ];
  };
  const SMS = 0o34, CTLW = 0o12, CPYD = 0o24, TWT = 0o16;

  // Turn the controller on: one word of all ones.
  const onData = 900;
  put(onData, 0o777777, 0o777777);
  put(on + 0, ...cmdWord(SMS, 0, 0o004));
  put(on + 1, ...cmdWord(CTLW, 0o20000, 0));
  put(on + 2, ...cmdWord(CPYD, 1, onData));
  put(on + 3, ...cmdWord(TWT, 0, 0));

  // Then the message.
  const words = message(CONSOLE_LINE + 4, 'HELLO');
  const msgData = 910;
  words.forEach((w, i) => put(msgData + i, w[0], w[1]));
  put(msg + 0, ...cmdWord(SMS, 0, 0o004));
  put(msg + 1, ...cmdWord(CTLW, 0o20000, 0));
  put(msg + 2, ...cmdWord(CPYD, words.length, msgData));
  put(msg + 3, ...cmdWord(TWT, 0, 0));

  machine.start(image.start);
  let steps = 0;
  while (machine.running) {
    if (++steps > 200000) throw new Error('the machine did not halt');
    machine.run(1);
  }

  assert.equal(comm.enabled, true, 'the controller was turned on');
  assert.equal(printed.join(''), 'HELLO');
});
