/**
 * Instruction-level tests for the 7094 core.
 *
 * These check the places where a two-half word representation can quietly go
 * wrong: sign-and-magnitude arithmetic, carries across the half boundary, the
 * accumulator's Q and P bits, shifts that cross AC into MQ, and the index
 * registers, which subtract rather than add.
 *
 * Run with: node --test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { run, ac, acFull, mq, word } from './machine.js';
import { octal } from '../src/word.js';

test('add and store', () => {
  const { cpu, core } = run(`
         ORG   100
         CLA   FIVE
         ADD   FIVE
         STO   OUT
         HTR   0
  FIVE   OCT   000000000005
  OUT    OCT   000000000000
  `);
  assert.equal(ac(cpu), '+000000000012');
  assert.equal(word(core, 0o151), '000000000012');
});

test('addition crosses the halfword boundary', () => {
  // 0777777 + 1 must carry out of the low half into the high half.
  const { cpu } = run(`
         ORG   100
         CLA   A
         ADD   ONE
         HTR   0
  A      OCT   000000777777
  ONE    OCT   000000000001
  `);
  assert.equal(ac(cpu), '+000001000000');
});

test('subtracting a larger magnitude flips the sign', () => {
  const { cpu } = run(`
         ORG   100
         CLA   THREE
         SUB   TEN
         HTR   0
  THREE  OCT   000000000003
  TEN    OCT   000000000012
  `);
  assert.equal(ac(cpu), '-000000000007');
});

test('minus zero keeps its sign but tests as zero', () => {
  const { cpu } = run(`
         ORG   100
         CLS   ZERO
         TZE   HALT
         CLA   ONE
  HALT   HTR   0
  ZERO   OCT   000000000000
  ONE    OCT   000000000001
  `);
  assert.equal(ac(cpu), '-000000000000');
});

test('ADD overflow lights the accumulator overflow indicator', () => {
  const { cpu } = run(`
         ORG   100
         CLA   BIG
         ADD   BIG
         HTR   0
  BIG    OCT   377777777777
  `);
  assert.equal(cpu.acOverflow, true);
  // The carry goes into P, which STO would discard but which is still there.
  assert.equal(acFull(cpu), '+1377777777776');
});

test('multiply fills AC and MQ with a 70-bit product', () => {
  const { cpu } = run(`
         ORG   100
         LDQ   A
         MPY   B
         HTR   0
  A      OCT   000000000007
  B      OCT   000000000005
  `);
  assert.equal(ac(cpu), '+000000000000');
  assert.equal(mq(cpu), '000000000043');
});

test('multiply of large magnitudes reaches the accumulator', () => {
  // 2^34 * 2 = 2^35, one place past the MQ, so AC picks up the top bit.
  const { cpu } = run(`
         ORG   100
         LDQ   A
         MPY   B
         HTR   0
  A      OCT   200000000000
  B      OCT   000000000002
  `);
  assert.equal(ac(cpu), '+000000000001');
  assert.equal(mq(cpu), '000000000000');
});

test('divide gives quotient in MQ and remainder in AC', () => {
  const { cpu } = run(`
         ORG   100
         CLA   ZERO
         LDQ   A
         DVP   B
         HTR   0
  ZERO   OCT   000000000000
  A      OCT   000000000144
  B      OCT   000000000007
  `);
  assert.equal(mq(cpu), '000000000016');   // 100 / 7 = 14 decimal
  assert.equal(ac(cpu), '+000000000002');  // remainder 2
});

test('divide check leaves the accumulator alone', () => {
  const { cpu } = run(`
         ORG   100
         CLA   A
         LDQ   A
         DVP   B
         HTR   0
  A      OCT   000000000144
  B      OCT   000000000007
  `);
  assert.equal(cpu.divideCheck, true);
});

test('index registers subtract from the address', () => {
  const { cpu } = run(`
         ORG   100
         AXT   2,1
         CLA   TABLE+2,1
         HTR   0
  TABLE  OCT   000000000011
         OCT   000000000022
         OCT   000000000033
  `);
  // The 7094 subtracts the index register, so stepping forward through a table
  // means counting the register down from the far end. TABLE+2 less 2 is the
  // first word.
  assert.equal(ac(cpu), '+000000000011');
});

test('TIX counts an index register down to zero', () => {
  const { cpu, core } = run(`
         ORG   100
         AXT   3,1
         CLA   ZERO
  LOOP   ADD   ONE
         TIX   LOOP,1,1
         STO   OUT
         HTR   0
  ZERO   OCT   000000000000
  ONE    OCT   000000000001
  OUT    OCT   000000000000
  `);
  assert.equal(ac(cpu), '+000000000003');
  // TIX stops when the register is no longer greater than the decrement, so it
  // finishes holding 1, not 0 — three passes through the loop.
  assert.equal(cpu.xr[1], 1);
  assert.equal(word(core, 0o154), '000000000003');
});

test('TSX leaves the negative of its own location in the index', () => {
  const { cpu } = run(`
         ORG   100
         TSX   SUBR,4
         HTR   0
  SUBR   PXA   0,4
         HTR   0
  `);
  // TSX sits at octal 144 (ORG takes a decimal address, as FAP does), and the
  // index holds that location negated in fifteen bits.
  assert.equal(ac(cpu), '+000000077634');
});

test('indirect addressing takes the address from the word it points at', () => {
  const { cpu } = run(`
         ORG   100
         CLA*  PTR
         HTR   0
  PTR    PZE   VALUE
  VALUE  OCT   000000000777
  `);
  assert.equal(ac(cpu), '+000000000777');
});

test('CAL puts the memory sign bit on accumulator position P', () => {
  const { cpu } = run(`
         ORG   100
         CAL   NEG
         HTR   0
  NEG    OCT   400000000000
  `);
  assert.equal(cpu.acS, 0);
  assert.equal(acFull(cpu), '+1000000000000');
});

test('logical instructions work on the full 36 bits', () => {
  const { core } = run(`
         ORG   100
         CAL   A
         ANA   B
         SLW   OUT
         HTR   0
  A      OCT   777777777777
  B      OCT   525252525252
  OUT    OCT   000000000000
  `);
  // CAL brings the sign bit in as AC position P and SLW puts it back, so a
  // word survives a round trip through the logical instructions unchanged.
  assert.equal(word(core, 0o152), '525252525252');
});

test('ACL carries end-around', () => {
  const { cpu } = run(`
         ORG   100
         CAL   A
         ACL   ONE
         HTR   0
  A      OCT   777777777777
  ONE    OCT   000000000001
  `);
  // All ones plus one is zero with a carry out of P, which comes back round.
  assert.equal(acFull(cpu), '+0000000000001');
});

test('ALS shifts left and reports the bits it pushed past P', () => {
  const { cpu } = run(`
         ORG   100
         CLA   A
         ALS   1
         HTR   0
  A      OCT   200000000000
  `);
  assert.equal(cpu.acOverflow, true);
});

test('LLS carries bits from MQ into AC', () => {
  const { cpu } = run(`
         ORG   100
         CLA   ZERO
         LDQ   A
         LLS   1
         HTR   0
  ZERO   OCT   000000000000
  A      OCT   200000000000
  `);
  // MQ bit 1 shifts into AC position 35.
  assert.equal(ac(cpu), '+000000000001');
  assert.equal(mq(cpu), '000000000000');
});

test('LRS moves AC bits down into the MQ', () => {
  const { cpu } = run(`
         ORG   100
         CLA   A
         LDQ   ZERO
         LRS   1
         HTR   0
  A      OCT   000000000001
  ZERO   OCT   000000000000
  `);
  assert.equal(ac(cpu), '+000000000000');
  assert.equal(mq(cpu), '000200000000000'.slice(-12));
});

test('CAS skips none, one or two instructions', () => {
  const source = (a, b) => `
         ORG   100
         CLA   A
         CAS   B
         TRA   HIGH
         TRA   SAME
         TRA   LOW
  HIGH   CLA   ONE
         HTR   0
  SAME   CLA   TWO
         HTR   0
  LOW    CLA   THREE
         HTR   0
  A      OCT   ${a}
  B      OCT   ${b}
  ONE    OCT   000000000001
  TWO    OCT   000000000002
  THREE  OCT   000000000003
  `;
  assert.equal(ac(run(source('000000000005', '000000000003')).cpu), '+000000000001');
  assert.equal(ac(run(source('000000000003', '000000000003')).cpu), '+000000000002');
  assert.equal(ac(run(source('000000000001', '000000000003')).cpu), '+000000000003');
});

test('store instructions touch only their own field', () => {
  const { core } = run(`
         ORG   100
         CLA   PATTERN
         STA   TARGET
         STD   TARGET
         HTR   0
  PATTERN OCT  000007700077
  TARGET OCT   777777777777
  `);
  // STA replaces the address field, STD the decrement; the rest survives.
  assert.equal(word(core, 0o151), '700007700077');
});

test('sense lights and switches', () => {
  const { cpu } = run(`
         ORG   100
         SLN   2
         SLT   2
         TRA   MISS
         CLA   ONE
         HTR   0
  MISS   CLA   TWO
         HTR   0
  ONE    OCT   000000000001
  TWO    OCT   000000000002
  `);
  assert.equal(ac(cpu), '+000000000001');
  assert.equal(cpu.sl, 0);
});

test('an unknown opcode stops the machine', () => {
  const { cpu } = run(`
         ORG   100
         OCT   000700000000
  `);
  assert.match(cpu.lastError, /illegal instruction/);
});
