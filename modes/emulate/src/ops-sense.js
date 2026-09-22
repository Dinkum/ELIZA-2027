/**
 * The sense group: opcode 0760, positive (PSE) and negative (MSE).
 *
 * One opcode, dozens of instructions. The effective address selects which, so
 * this is the only group where the address field is an extension of the opcode
 * rather than a place in core. Addresses above 0170 name a channel in bits 9-12,
 * which is how BTT, ETT, RIC, RDC and SPR reach the I/O side.
 *
 * Several of these are privileged: under CTSS a user program that executes one
 * takes a protection trap instead, so the supervisor can simulate it.
 */

import { HALF, AC_P, AC_HI } from './word.js';
import { TRAP } from './cpu.js';
import { round } from './arith.js';

/** In CTSS user mode a privileged instruction traps. Returns true if it did. */
function privileged(cpu) {
  if (cpu.userMode) {
    cpu.settrap(TRAP.PROTECTION, cpu.ic, 0);
    return true;
  }
  return false;
}

/** Skip the next instruction — how the sense group answers a yes/no question. */
function skip(cpu) {
  cpu.ic = (cpu.ic + 1) & 0o77777;
}

export function executeSense(cpu) {
  const y = cpu.y;
  if ((cpu.op & 0o100000) === 0) executePSE(cpu, y);
  else executeMSE(cpu, y);
}

function executePSE(cpu, y) {
  switch (y) {
    case 0o0000:   // CLM — clear magnitude, leave the sign
      cpu.acHi = 0;
      cpu.acLo = 0;
      break;
    case 0o0001:   // LBT — low order bit test
      if (cpu.acLo & 1) skip(cpu);
      break;
    case 0o0002:   // CHS — change sign
      cpu.acS ^= 1;
      break;
    case 0o0003:   // SSP — set sign plus
      cpu.acS = 0;
      break;
    case 0o0004:   // ENK — enter keys
      cpu.mqHi = cpu.keysHi;
      cpu.mqLo = cpu.keysLo;
      break;
    case 0o0005:   // IOT — I/O check test
      if (privileged(cpu)) break;
      if (cpu.ioCheck) cpu.ioCheck = false;
      else skip(cpu);
      break;
    case 0o0006:   // COM — complement magnitude
      cpu.acHi = ~cpu.acHi & AC_HI;
      cpu.acLo = ~cpu.acLo & HALF;
      break;
    case 0o0007:   // ETM — enter trapping mode
      if (privileged(cpu)) break;
      cpu.trapMode = true;
      break;
    case 0o0010:   // RND — round
      round(cpu, true);
      break;
    case 0o0011:   // FRN — floating round
      cpu.floatingRound();
      break;
    case 0o0012:   // DCT — divide check test
      if (cpu.divideCheck) cpu.divideCheck = false;
      else skip(cpu);
      break;
    case 0o0014:   // RCT — restore channel traps
      // A trap turns further traps off; this is what turns them back on, and
      // it is the last thing a trap handler does.
      cpu.trapEnable = true;
      cpu.trapInhibit = 1;
      break;
    case 0o0016:   // LMTM — leave multiple tag mode
      cpu.multipleTagMode = false;
      break;
    case 0o0140:   // SLF — sense lights off
      cpu.sl = 0;
      break;
    case 0o0141: case 0o0142: case 0o0143: case 0o0144:   // SLN — light on
      cpu.sl |= 1 << (0o144 - y);
      break;
    case 0o0161: case 0o0162: case 0o0163:
    case 0o0164: case 0o0165: case 0o0166:                // SWT — sense switch
      if (cpu.ssw & (1 << (0o166 - y))) skip(cpu);
      break;
    default:
      executeChannelSense(cpu, y, false);
      break;
  }
}

function executeMSE(cpu, y) {
  switch (y) {
    case 0o0000:   // CLM — same as PSE
      cpu.acHi = 0;
      cpu.acLo = 0;
      break;
    case 0o0001:   // PBT — P bit test
      if (cpu.acHi & AC_P) skip(cpu);
      break;
    case 0o0002:   // EFTM — enter floating trap mode
      if (privileged(cpu)) break;
      cpu.fpTrap = true;
      cpu.mqOverflow = false;
      break;
    case 0o0003:   // SSM — set sign minus
      cpu.acS = 1;
      break;
    case 0o0004:   // LFTM — leave floating trap mode
      if (privileged(cpu)) break;
      cpu.fpTrap = false;
      break;
    case 0o0005:   // ESTM — enter select trap mode: no effect on this machine
      break;
    case 0o0006:   // ECTM — enter copy trap mode: no effect on this machine
      break;
    case 0o0007:   // LTM — leave trapping mode
      if (privileged(cpu)) break;
      cpu.trapMode = false;
      break;
    case 0o0010:   // LSNM — leave sense indicator normal mode
      break;
    case 0o0016:   // EMTM — enter multiple tag mode
      cpu.multipleTagMode = true;
      break;
    case 0o0140:   // SLF — sense lights off
      cpu.sl = 0;
      break;
    case 0o0141: case 0o0142: case 0o0143: case 0o0144: { // SLT — test and clear
      const bit = 1 << (0o144 - y);
      if (cpu.sl & bit) {
        cpu.sl &= ~bit;
        skip(cpu);
      }
      break;
    }
    case 0o0161: case 0o0162: case 0o0163:
    case 0o0164: case 0o0165: case 0o0166:                // SWT — sense switch
      if (cpu.ssw & (1 << (0o166 - y))) skip(cpu);
      break;
    default:
      executeChannelSense(cpu, y, true);
      break;
  }
}

/**
 * The channel-addressed part of the sense group. Bits 9-12 of the effective
 * address name the channel, A through H; the low bits say what to ask it.
 */
function executeChannelSense(cpu, y, negative) {
  const select = ((y & 0o17000) >> 9) - 1;
  if (select < 0) return;                       // not a channel select: no-op

  const channel = cpu.channels[select];

  if ((y & 0o777) === 0o000) {                  // BTT / ETT
    if (privileged(cpu)) return;
    if (!channel) { cpu.machineCheck = true; cpu.halt(); return; }
    if (negative) {                             // ETT — end of tape test
      if (channel.endOfTape) channel.endOfTape = false;
      else skip(cpu);
    } else {                                    // BTT — beginning of tape test
      if (channel.beginningOfTape) channel.beginningOfTape = false;
      else skip(cpu);
    }
    return;
  }
  if (negative) return;

  if ((y & 0o777) === 0o350) {                  // RIC — reset 7909 channel
    if (privileged(cpu)) return;
    if (channel && channel.is7909) channel.reset();
    return;
  }
  if ((y & 0o777) === 0o352) {                  // RDC — reset 7607 channel
    if (privileged(cpu)) return;
    if (channel && !channel.is7909) channel.reset();
    return;
  }
  if ((y & 0o760) === 0o360) {                  // SPR — set peripheral code
    if (privileged(cpu)) return;
    if (channel) channel.spraCode = y & 0o17;
    return;
  }
  // Everything else in the group is a no-op on this configuration.
}
