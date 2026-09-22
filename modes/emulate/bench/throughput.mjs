/**
 * How fast the emulated 7094 runs, and what the channels cost.
 *
 * The number that matters is not raw speed but the ratio to the real machine.
 * A 7094 executed roughly 350,000 instructions a second, and `src/machine.js`
 * paces its interval timer against that figure. Anything comfortably above 1x
 * can run CTSS in real time; the headroom above that is what lets the browser
 * do its own work in between.
 *
 *     node modes/emulate/bench/throughput.mjs
 */

import { Machine } from '../src/machine.js';
import { assembleInto } from '../src/assemble.js';

/** Ordinary work: index arithmetic, load and store, add, subtract, compare. */
const SOURCE = `
       ORG 100
START  AXT 0,1
LOOP   CLA DATA
       ADD DATA
       STO DATA
       CLA DATA
       SUB ONE
       STO DATA
       TXI NEXT,1,1
NEXT   TXL LOOP,1,20000
       HTR 0
DATA   DEC 1
ONE    DEC 1
`;

/** Instructions a second on the real machine, per the Principles of Operation. */
const REAL_7094 = 350000;

function makeMachine(options) {
  const machine = new Machine(options);
  const image = assembleInto(machine.core, SOURCE);
  machine.start(image.start);
  return machine;
}

function bench(label, options, clock, seconds = 2) {
  const once = () => {
    const machine = makeMachine(options);
    machine.clockRunning = clock;
    return machine.run(200000);
  };
  once();                                     // let the JIT settle
  const start = process.hrtime.bigint();
  let executed = 0;
  while (Number(process.hrtime.bigint() - start) / 1e9 < seconds) executed += once();
  const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
  const rate = executed / elapsed;
  console.log(
    label.padEnd(34),
    (rate / 1e6).toFixed(1).padStart(5), 'M inst/s ',
    (rate / REAL_7094).toFixed(0).padStart(4) + 'x a real 7094',
  );
}

console.log('7094 instruction throughput\n');
bench('no channels', { channels: 0 }, false);
bench('4 channels, idle', { channels: 4 }, false);
bench('4 channels, interval timer on', { channels: 4 }, true);
bench('8 channels incl. 2x 7909', { channels: 8, types: { 2: '7909', 4: '7909' } }, true);
console.log('\nThe spread between the first and last lines is what polling every');
console.log('channel once per instruction costs. See docs/DESIGN.md.');
