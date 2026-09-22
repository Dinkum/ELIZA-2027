# IBM 7094 emulator — design and state

Mode 3 of ELIZA 2027: run the recovered MAD-SLIP ELIZA the way it actually ran,
by emulating the machine underneath it rather than the program on top of it.

## The target

The machine ELIZA ran on was not a stock 7094. It was the Project MAC 7094 with
the modifications CTSS needed:

- a second bank of core, the **B core**, so the supervisor and a swapped-in user
  program are addressable at once (`SEA`, `SEB`, `TIA`, `TIB`, `IFT`, `EFT`)
- **memory relocation and protection**, so a user program cannot see or damage
  anything outside its own block (`LRI`, `SRI`, `LPI`, `SPI`)
- an **interval timer** in location 5, so the supervisor gets control back

None of those are optional. A stock 7094 emulator cannot boot CTSS.

## What is here

```
src/word.js         the 36-bit word, carried as two 18-bit halves
src/memory.js       core, A and B banks
src/cpu.js          fetch, decode, effective address, traps, the memory box
src/ops-positive.js  } the instruction set, split the way the sign bit splits it
src/ops-negative.js  }
src/ops-sense.js    the 0760 group, where the address is part of the opcode
src/arith.js        fixed point multiply, divide, logical add, compare
src/float.js        single and double precision floating point
src/shift.js        the shift instructions
src/opcodes.js      opcode tables, generated from s709's mnemonic tables
src/bcd.js          six-bit character codes, both the IBSYS and alternate sets
src/assemble.js     a small FAP-flavoured assembler
src/channel.js      the 7607 data channel
src/channel9.js     the 7909 data channel, with its own instruction set
src/devices/tape.js a 729 tape unit reading and writing SIMH .tap images
src/devices/disk.js the 7631 file control and the 1301 disks under it
src/devices/comm.js the 7750 communications controller and its terminal lines
src/devices/chrono.js the Chronolog clock, channel A unit 7
src/devices/printer.js the on-line printer the supervisor logs to
src/devices/dasd.js reading real CTSS disk containers off the host
src/boot.js         initial program load: the loader the console deposits
src/machine.js      processor, core, channels and the interleaving between them
console.js          the operator's console, in a browser tab
programs/           sample assembler sources; also the integration tests
bench/              instruction throughput, measured against the real machine
```

Working end to end today: a FAP source assembles, runs on the emulated
processor, and moves its results through a data channel to a device. The sample
program computes Fibonacci numbers, converts them to BCD with the machine's own
divide and shift instructions, and prints them on an on-line printer.

Both channel types exist. The 7607 moves records to and from tape. The 7909
executes its own command lists, takes interrupts, and drives a device through
the select-and-copy handshake. Under a 7909 sits the 7631 file control: orders
go out as ten BCD characters, arms seek and raise attention when they arrive,
tracks and records are laid out the way a 7631 lays them out, and a record is
found by walking the track comparing identifiers rather than by arithmetic.

Beside it on another 7909 is the 7750 communications controller, which is
where a terminal attaches. A program running on the emulated processor can
turn the 7750 on, send it a message, and have the characters come out on a
line; somebody typing on a line has the characters collected into a numbered
input message that the processor reads back. `test/ctss-console.test.js` does
exactly that end to end, which is the shape of what CTSS does every time it
types at somebody, with the supervisor left out.

Real CTSS disks can be read. The reconstruction's own tools build a 1302
image and install CTSS onto it; `src/devices/dasd.js` reads that container and
recovers the records from it, and the shapes that come back are the ones CTSS
writes — a 435 word record on each track followed by a 31 and a 14, under a
home address of `XXXXXX`.

Booting is under way and does not finish, but it gets a long way. `src/boot.js`
deposits the same twenty-one word loader s709's console deposits and starts the
processor at 2. Against a real disk:

- the loader resets the channel, seeks, polls the seek with TCM, sends the read
  order, reads a seven word bootstrap into low core, and falls into the channel
  program that bootstrap *is*
- that program copies eleven thousand words of supervisor into the B core
- the processor selects the B core, transfers into it, and **runs CTSS**: it
  clears the A core with a thirty-two thousand word STZ loop, reads the date
  and time off the Chronolog clock, enables channel traps, and writes to the
  printer

and then executes a programmed halt — `HTR` at B core 35577 — during its own
initialisation. So the machine reads CTSS and starts running it, and stops
partway through startup. It does not reach `READY.`

Finding out why wants a side by side instruction trace against s709, which
boots the same disk to `READY.` on this machine. Everything up to the halt is
already known to agree, because the supervisor could not have got that far
otherwise; the question is only what it tests just before it stops.

`node --test` covers the instruction set at the places a two-half word
representation can go wrong — sign-and-magnitude arithmetic, carries across the
half boundary, the accumulator's Q and P bits, shifts that cross into the MQ,
index registers that subtract — plus the channel and tape path end to end, the
7909's instruction set against a stub adapter, the disk and the 7750 driven the
way CTSS will drive them, through channel command lists rather than by calling
into them, and one test that runs an assembled program all the way out to a
printed line.

## The representation, and why

JavaScript has no 36-bit integer and its bitwise operators truncate to 32 bits,
so every word is two 18-bit halves: `hi` is S,1-17 and `lo` is 18-35. The split
falls on the boundaries the instruction format already uses, so decoding is
masking rather than arithmetic.

The accumulator is 38 bits — S,Q,P,1-35 — and is carried as a separate sign plus
a 19-bit high half holding Q,P,1-17. That is not an arbitrary choice. It puts AC
bit P exactly where a memory word's sign bit sits, which is where the hardware
puts it, so `CAL` is a straight copy of both halves and every logical instruction
falls out for free. Getting this wrong is the single most common way a 7094
emulator produces plausible nonsense.

Floating point is the one place that uses BigInt: a 54-bit fraction squared is
108 bits, and a wrong bit in a characteristic surfaces a thousand instructions
later as a MAD program printing believable garbage. Integer work stays on plain
numbers, which is what the inner loops need.

## What is next

1. **Why the supervisor halts during startup.** Trace against s709 —
   `runctss`, then telnet to the port in `env.sh` — and find the first
   instruction where the two machines disagree. Three faithfulness bugs have
   already been found this way, and in every one of them s709 was right where
   SIMH differed: the one way BCD zero conversion, TCO on a 7909 meaning "in
   operation", and an inhibited condition still reaching the condition
   register.
2. **Wiring the 7750 to the page.** The controller is written and a line's
   printed output is a callback, so `app/`'s typewriter can be the far end of
   one: the browser typewriter becomes a real console rather than a simulation
   of one. Nothing about that is hard now; it waits on there being a CTSS to
   talk to.
3. **Booting CTSS.** Get through the disk loader and supervisor initialisation
   and reach `READY.` This is where the emulator stops being a set of parts
   that each behave correctly and starts being a machine, and it is where the
   remaining unknowns are.
4. **Building SLIP and ELIZA on it.** `runcom make` under the SLIP and ELIZA
   accounts, exactly as the reconstruction's README does it — the MAD compiler
   and FAP assembler are already on the CTSS tapes and do not need reimplementing.

## Building a real disk to test against

The disk images are not in this repository — a 1302 is a quarter of a gigabyte
empty — and they are not shipped by the reconstruction either. They are built,
by running the real CTSS installation under s709:

```
tar xzf references/1965b-CTSS-reconstruction/ctss/dist/s709-2.4.4.tar.gz && make
tar xzf references/1965b-CTSS-reconstruction/ctss/dist/utils-1.1.15.tar.gz && make
source references/1965b-CTSS-reconstruction/env.sh
make-disks && format-disks && install-disk-loader && installctss
```

That produces `dasd/DISK1.BIN` with CTSS on it. The disk test reads it when
pointed at one:

```
CTSS_DISK=path/to/DISK1.BIN npm test
```

and is skipped otherwise, the same way the model-backed tests in mode 4 are.

## Sources

The IBM 7090/7094 Principles of Operation (A22-6703) is the reference for the
instruction set. Where the manual is ambiguous, the behaviour reproduced here is
that of Dave Pitts' **s709**, because s709 is what the CTSS reconstruction in
`references/` was built and tested against: the question is not what the manual
says but what CTSS was compiled against. `src/opcodes.js` is generated from
s709's mnemonic tables so the assembler and the emulator cannot drift apart.
s709 is MIT-licensed; its source is in `references/1965b-CTSS-reconstruction/ctss/dist`.

## Limitations worth knowing

- The assembler is not FAP. No macros, no literals, no relocatable output. Its
  address field is decimal, as FAP's is, so `ORG 100` is octal 144. A label may
  not be spelled the same as an instruction.
- Channels move one word per processor instruction rather than stealing cycles
  on device demand. Nothing a program can observe through a channel depends on
  the difference, but a diagnostic that times a transfer would notice.
- The interval timer is paced against an assumed 350,000 instructions a second.
- The 7750 carries data messages and the one control message that resets a
  line. It does not do the dial-up and identification exchange a real line goes
  through when it connects, and the bit-repeat character that positions the
  carriage is skipped rather than timed.
- A 7909 transfer is driven by the device asking for each cycle. SIMH gets the
  asking from its event scheduler; there is none here, so a device that is
  mid-transfer with the channel waiting on it is handed the cycle instead. The
  handshake is the same and the order of events is the same; what is missing is
  that transfers take no time, so a program that measured one would notice.
- The 7631 does not implement write format, so a track has to be laid out
  before it can be used; seek, rotational and gap delays are all zero; and only
  the 1301's single access arm is exercised, though the two-arm geometry of the
  1302 and 2302 is there.
- A disk container is read once, into records. The 7631 here keeps a track as a
  list of records, the way SIMH does; the container keeps it as a magnetised
  surface with a separate format track saying what each character position is
  for, the way s709 does. Recovering the one from the other is exact for the
  layouts CTSS writes, but a program that reformatted a track while running
  would be writing a pattern this model cannot express.
- The 7631's six-bit mode is recorded and then ignored.
- The 7909's read-backwards, BCD-conversion and noncontiguous options are
  accepted by SMS and then ignored, as is select-second. CTSS does not use
  them; a program that did would be quietly misled.

## Performance

`npm run bench` measures instruction throughput against the real machine's
350,000 a second:

```
no channels                         55.1 M inst/s   158x a real 7094
4 channels, idle                    43.7 M inst/s   125x a real 7094
4 channels, interval timer on       43.0 M inst/s   123x a real 7094
8 channels incl. 2x 7909            24.2 M inst/s    69x a real 7094
```

The spread is the cost of polling every channel once per processor
instruction. It is real — a CTSS-shaped machine gives up more than half its
throughput to it — and it is left alone on purpose. Seventy times real time is
far more headroom than running CTSS at its own speed needs, and the alternative
is a scheme where channels tell the machine when they want a cycle, which is
more state to keep exactly right in return for speed nothing is waiting on.

For the record, the obvious micro-optimisation does not help: replacing the
`for..of` over the channel array with an indexed loop measures the same, so the
cost is the per-channel work itself and not the iterator.
