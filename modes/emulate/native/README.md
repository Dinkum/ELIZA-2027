# Inferred 1966 MAD build

`eliza-1966.mad` is an inferred native continuation of the recovered 1965b
listing. It keeps the recovered MAD/SLIP list routines and changes the driver
where the January 1966 CACM paper requires a 128-entry keyword directory,
ranked keystack, `NEWKEY`, reassembly links, and `PRE`. The original 1966 MAD
listing has not been found. The program is therefore a reconstruction, not a
transcription.

`change-1966.mad` extends the recovered script editor to the wider directory.
`tape.100` is the paper's DOCTOR script in the CTSS-ready transcription carried
as `tape.200` by the pinned CTSS reconstruction. The two files differ only by
name here so each mode-3 disk can use script number 100 for its own program.

Primary evidence: `references/1966-Weizenbaum-CACM-ELIZA.pdf`, pages 38-45.
Recovered starting point: `references/1965b-CTSS-reconstruction/eliza/src/ELIZA/`.
The numbered MAD source stays in printout/card-column form for the CTSS MAD
compiler. See `references/1966-program-evidence.md` for source limitations.

## Build the separate disk

The raw 1965b CTSS disk tree is a build input, not a committed artifact. On
macOS, clone it with `cp -c` so subsequent writes to the 1966 tree cannot
change the 1965b tree:

```sh
mkdir -p tmp/mode3-1966-dasd tmp/mode3-1966-build
cp -c tmp/mode3-dasd/*.BIN tmp/mode3-1966-dasd/
python3 modes/emulate/native/derive-source.py
```

The output directory must be empty before copying. `derive-source.py` reads
the unchanged listing in `references/`, writes the two MAD source files and
copies the CTSS-ready 1966 DOCTOR transcription into `tape.100`. On another
filesystem, a normal copy of the five `.BIN` files serves the same purpose.

Convert the two MAD files to CTSS card images with the pinned reconstruction's
`eliza/bin/mad-text-to-cards` and `obj2img` tools. Upload them to the cloned
ELIZA account as `ELIZA MAD` and `CHANGE MAD`; upload `tape.100` as `.TAPE. 100`.
The CTSS reconstruction's `eliza/bin/upload` documents the card-image format
and the offline `setupctss` job. Keep the source names on disk: the existing
`ELIZA MAKE RUNCOM` refers to those names.

Boot CTSS from the cloned five-container tree, log in to its ELIZA account,
and run `RUNCOM MAKE`. A successful build reports:

```text
$ COMPILING ELIZA
LENGTH 02365.  TV SIZE 00042.  ENTRY 00706.
$ ==== LOADING ELIZA
$ PROGRAM WRITTEN TO  ELIZA SAVED
$ MAKE HAS BEEN RUN SHOULD BE PRINTED FINALLY
```

After a clean CTSS shutdown, pack that tree for the browser:

```sh
DASD_DIR=tmp/mode3-1966-dasd \
PACK_OUT=modes/emulate/ctss-1966-dasd.pack \
node modes/emulate/pack.mjs
```

The 1965b pack is `modes/emulate/ctss-dasd.pack`. The two images are distinct
and the version choice in `app/main.js` selects one before the 7094 boots.
Nothing in the browser patches an executable or interprets a 1966 rule for
mode 3.

The checked-in 1966 pack has SHA-256
`5c7e997967d4d119dcd4edd3419df04b2f0137736dedf6b4eabd2d6ab94ce0ba`.
The inferred main MAD source has SHA-256
`6d41f5bb5d74e4847c922ec1327a00fdfa794a79cc57c3ac2b1eb02462c03003`.
The pinned recovered starting file has SHA-256
`737e99d5bb37b03686c28e159896c2eb922cf8de592eaa1f14ba0b088706e334`.

## Native checks

On the compiled 1966 disk, `R ELIZA` followed by `100` prints the CACM
greeting. A native s709 terminal run matched `ElizaPort1966` on `HELLO`,
`I AM SAD`, `MEN ARE ALL ALIKE`, `I'M UNHAPPY`, `YOU'RE KIND`, and seven
repetitions of `I DREAMT MY MOTHER`. Those cases exercise ordinary rules,
reassembly links, both `PRE` sites, ranking, and `NEWKEY` falling through to a
lower-ranked keyword. This validates these observed paths, not the missing
listing's exact source structure or every possible conversation.
