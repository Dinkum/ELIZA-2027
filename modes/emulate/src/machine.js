/**
 * The machine: a processor, two banks of core, four channels and whatever is
 * plugged into them.
 *
 * This is the object the browser page and the tests both drive. It owns the
 * interleaving that makes the whole thing behave like a computer rather than a
 * pile of parts: the processor runs, the channels steal cycles from it, and the
 * interval timer interrupts sixty times a second.
 *
 * `run(budget)` executes up to a budget of instructions and returns. Nothing
 * here blocks, because in a browser nothing may: the caller decides how much
 * machine time to spend before giving the page back its thread.
 */

import { CPU, RUN } from './cpu.js';
import { Core } from './memory.js';
import { Channel } from './channel.js';
import { Channel9 } from './channel9.js';

/** 7094 cycles per interval-timer tick: 60 a second at about 350 KIPS. */
const CYCLES_PER_TICK = 5800;

export class Machine {
  /**
   * `types` names the channels that are not plain 7607s, by index: the CTSS
   * machine puts its disk on a 7909 and its communications controller on
   * another, and a 7909 is a different piece of hardware rather than a mode.
   */
  constructor({ banks = 2, channels = 4, types = {} } = {}) {
    this.core = new Core(banks);
    this.cpu = new CPU(this.core);
    this.channels = [];
    for (let i = 0; i < channels; i++) {
      const channel = types[i] === '7909' ? new Channel9(i) : new Channel(i);
      channel.connect(this.core);
      this.channels.push(channel);
    }
    this.cpu.channels = this.channels;
    this.cyclesToTick = CYCLES_PER_TICK;
    /** Set true to run the interval timer; CTSS needs it, a lone program does not. */
    this.clockRunning = false;
    /**
     * Interval-timer ticks since the machine started, at sixty a second of
     * emulated time. Devices that report a time of day — the Chronolog clock —
     * read this rather than the wall clock, because the emulator runs many
     * times faster than a real 7094 and a wall-clock reading drifts behind
     * the supervisor's own idea of the time within the first minute.
     */
    this.ticks = 0;
  }

  /** Console RESET. */
  reset() {
    this.cpu.reset();
    for (const channel of this.channels) channel.reset();
  }

  /**
   * Console START. With an address, the processor begins there. Without one
   * it resumes where it stopped — which for a machine halted by HTR is the
   * transfer address the instruction was holding, and anywhere else is the
   * instruction it would have fetched next.
   */
  start(address) {
    const cpu = this.cpu;
    cpu.ic = (address ?? (cpu.progStop ? cpu.progStopResume : cpu.ic)) & 0o77777;
    cpu.progStop = false;
    cpu.run = RUN.RUNNING;
  }

  get running() {
    return this.cpu.run === RUN.RUNNING;
  }

  /**
   * Run up to `budget` instructions, or until the machine stops. Returns how
   * many it actually executed, so a caller pacing itself against real time can
   * tell whether the machine halted early.
   */
  run(budget = 100000) {
    const cpu = this.cpu;
    const channels = this.channels;
    let executed = 0;
    let stalled = 0;
    while (executed < budget && cpu.run === RUN.RUNNING) {
      // A halted processor performs no fetch, but the machine is not stopped:
      // the channels keep moving and the clock keeps ticking, and the first
      // trap to arrive is what restarts execution — which is how the
      // supervisor waits for I/O. When no channel is in operation there is
      // nothing left to wake it, and the machine stops for the operator.
      if (cpu.progStop) {
        if (++stalled > budget) break;
        // s709 keeps cycling a PROGSTOP'd processor whenever trap_enb is
        // nonzero — programStop has already halted the machine outright in
        // the nothing-armed case, so reaching here means a trap can still
        // arrive: the channels keep moving and the interval timer keeps
        // ticking until one does, however long that takes.
        for (const channel of channels) {
          if (channel.wantsCycle) channel.step();
          if (channel.trapPending) this.takeChannelTrap(channel);
        }
        if (cpu.trapInhibit > 0) cpu.trapInhibit--;
        if (this.clockRunning) {
          this.cyclesToTick -= 1;
          if (this.cyclesToTick <= 0) {
            this.cyclesToTick += CYCLES_PER_TICK;
            this.ticks++;
            cpu.tick();
          }
        }
        // When no channel is in operation there is nothing left that could
        // restart the processor — s709's chan_in_op test — and the machine
        // stops for the operator the way the real one does at a dead halt.
        if (!cpu.progStop) continue;
        if (channels.every((channel) => !channel.inOperation && !channel.trapPending)) {
          cpu.halt();
          break;
        }
        continue;
      }

      const cycles = cpu.step();
      executed += 1;

      // Channels move one word for each processor instruction. A real channel
      // steals cycles as the device demands them; at this granularity the only
      // thing a program can tell is that transfers finish while it computes.
      //
      // A 7909 also has to be given a cycle while it is stopped, because an
      // interrupt can reach it there — that is what `request` is for.
      //
      // This runs once per instruction per channel and is the hottest code
      // here after the instruction decode. It is also the reason an eight
      // channel machine runs at roughly half the rate of a four channel one.
      // That is affordable and is left alone deliberately: see the performance
      // section of docs/DESIGN.md for the measurements.
      for (const channel of channels) {
        if (channel.wantsCycle) channel.step();
        if (channel.trapPending) this.takeChannelTrap(channel);
      }

      if (this.clockRunning) {
        this.cyclesToTick -= cycles;
        if (this.cyclesToTick <= 0) {
          this.cyclesToTick += CYCLES_PER_TICK;
          this.ticks++;
          cpu.tick();
        }
      }
    }
    return executed;
  }

  /**
   * A channel that has finished its command list interrupts, if ENB armed it.
   * Channel A traps to location 12, and each further channel two words on.
   */
  takeChannelTrap(channel) {
    const cpu = this.cpu;
    // A pending trap waits for its channel to be armed and for the inhibit
    // window after an ENB or a trap in progress to pass. s709 keeps the
    // request pending in both cases rather than dropping it, so a trap that
    // arrives early still fires when the machine is ready to take it.
    if (cpu.trapInhibit > 0) return;
    if (!cpu.trapEnable) return;
    const causes = channel.trapCauses || (channel.trapPending ? 0o1 : 0);
    // s709 delivers one trap per channel per cycle: a normal end first, then
    // end of file — both under the channel's enable bit — and a check under
    // the separate check-enable bit. The cause lands in the stored word's
    // tag field, which is what the supervisor's trap handler reads.
    const armedEnd = (cpu.enbLo >>> channel.index) & 1;
    const armedCheck = (cpu.enbHi >>> channel.index) & 1;
    let status = 0;
    if (armedEnd && (causes & 0o1)) status = 0o1;
    else if (armedEnd && (causes & 0o4)) status = 0o4;
    else if (armedCheck && (causes & 0o2)) status = 0o2;
    if (!status) return;
    if (channel.trapCauses !== undefined) {
      channel.trapCauses &= ~status;
      channel.trapPending = channel.trapCauses !== 0;
    } else {
      channel.trapPending = false;
    }
    // An end-of-file trap consumes the flag, the same place TEF does.
    if (status === 0o4) channel.endOfFile = false;
    cpu.settrap(0o12 + channel.index * 2, cpu.ic, status);
  }
}
