/**
 * Test harness: assemble a fragment, run it to a halt, and look at the result.
 *
 * Programs say where they load with ORG. Addresses in the variable field are
 * decimal, as FAP has them, so `ORG 100` is octal 144 — clear of the trap cells
 * and CTSS's communication region in the first 32 words of core.
 */

import { CPU, RUN } from '../src/cpu.js';
import { Core } from '../src/memory.js';
import { assembleInto } from '../src/assemble.js';
import { octal } from '../src/word.js';

const STEP_LIMIT = 100000;

export function build(source, options = {}) {
  const core = new Core(options.banks ?? 2);
  const cpu = new CPU(core, options);
  const image = assembleInto(core, source);
  cpu.ic = image.start;
  return { core, cpu, image };
}

/** Assemble, run to the first halt, and hand back the machine. */
export function run(source, options = {}) {
  const machine = build(source, options);
  const { cpu } = machine;
  cpu.run = RUN.RUNNING;
  let steps = 0;
  while (cpu.run === RUN.RUNNING) {
    if (++steps > STEP_LIMIT) throw new Error('program did not halt');
    cpu.step();
  }
  machine.steps = steps;
  return machine;
}

/** The accumulator as a signed octal string, sign digit first. */
export function ac(cpu) {
  return (cpu.acS ? '-' : '+') + octal(cpu.acHi & 0o377777, cpu.acLo);
}

/** AC including its Q and P bits, which STO would throw away. */
export function acFull(cpu) {
  return (cpu.acS ? '-' : '+')
    + ((cpu.acHi >>> 17) & 3).toString(8)
    + octal(cpu.acHi & 0o377777, cpu.acLo);
}

/** The MQ as an octal string. */
export function mq(cpu) {
  return octal(cpu.mqHi, cpu.mqLo);
}

/** A word of core as an octal string. */
export function word(core, address) {
  return octal(core.hi[address], core.lo[address]);
}
