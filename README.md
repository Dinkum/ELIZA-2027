# ELIZA 2027

Software archaeology project of Joseph Weizenbaum’s ELIZA. The goal is to emulate the original behavior and the experience of the program. The stack we mimic, which ELIZA would have ran on, is a IBM 7094 mainframe interacted with through a IBM 1050 typewriter.

## Terminology

* **ELIZA** — 1965 1966 language processing program, one of the first chatbots.
* **MAD** - Programming language ELIZA is written in.
* **SLIP** — List processing library used in MAD
* **MIT CTSS** — operating system the IBM 7094 runs
* **IBM 7094** — The mainframe computer ELIZA originally ran on
* **IBM 7750** — intermediary communication computer which sits between the mainframe and keyboard
* **IBM 1050 / 1052 Printer-Keyboard** — Physical paper-based terminal.

## MODES

- **JS Rewrite** — ELIZA’s behavior rewritten in modern JavaScript.
- **JS Port** — a JavaScript translation of the recovered 1965b program, plus a reconstruction of the 1966 program.
- **IBM 7094 Emulation** — in browser emulation of a IBM 7094 mainframe running CTSS and loading MAD compiled ELIZA programs.
- **ELIZA Extended** — Expanding ELIZA while keeping the fundamental mechanics. More rules, conversation context, and in browser semantic model matching.

## VERSIONS

### 1965b

#### ELIZA PROGRAM

Recovered from a printout in the MIT Weizenbaum archive.

#### Script:

Recovered from a printout in the MIT Weizenbaum archive.

### 1966

#### ELIZA Program

**Reconstructed from:**

Weizenbaum’s January 1966 paper which describes the program and provides sample outputs. We reconstruct the missing program from its description and the recovered 1965b source, then check its behavior against the published conversation.

#### Script:

DOCTOR script published in Weizenbaum’s 1966 paper.

## UI

- **Typeface** - built a font from scans of impressions made by the IBM **938 correspondence type element**
- **Keyboard behavior** - Keys are ignored while the machine is printing or returning the carrier. Backspace moves the carrier back **without erasing ink**.
- **Paper and ribbon** - Fixed character columns (10 character per inch) and 6 lines per inch. Tractor feed edges.
- **Character printing** - Characters appear one at a time, maximum of **14.8 characters per second**. Carrier return time depends on how far it has travelled. A bell signals twelve positions before the margin.
