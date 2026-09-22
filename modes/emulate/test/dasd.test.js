/**
 * Reading a real CTSS disk container.
 *
 * Most of these build a container in memory, because a 1302 image is a quarter
 * of a gigabyte and does not belong in a repository. The last one reads an
 * actual disk built by the reconstruction's own tools, and is skipped unless
 * you point it at one:
 *
 *     CTSS_DISK=/path/to/DISK1.BIN node --test
 *
 * The reconstruction builds that file with `make-disks`, `format-disks` and
 * `installctss`, which run the real CTSS installation under s709.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import {
  readGeometry, readFormat, formatRuns, readTrack, trackOffset, loadContainer,
  FMT_DATA, FMT_HEADER, FMT_HOME_ADDRESS, FMT_END,
} from '../src/devices/dasd.js';
import { DiskModule } from '../src/devices/disk.js';
import { textToWord, wordToText } from '../src/bcd.js';

/** The 1302-2 the reconstruction actually builds, shrunk to two cylinders. */
const GEOMETRY = {
  cylinders: 2,
  heads: 3,            // one format track and two data tracks
  accesses: 1,
  modules: 1,
  bytesPerTrack: 120,
};

function buildContainer(geometry, fill) {
  const trackCount = geometry.cylinders * geometry.heads * geometry.accesses * geometry.modules;
  const bytes = new Uint8Array(16 + trackCount * geometry.bytesPerTrack);
  const putWord = (at, value) => {
    bytes[at] = (value >>> 24) & 0xff;
    bytes[at + 1] = (value >>> 16) & 0xff;
    bytes[at + 2] = (value >>> 8) & 0xff;
    bytes[at + 3] = value & 0xff;
  };
  putWord(0, geometry.cylinders);
  putWord(4, geometry.heads);
  putWord(8, (geometry.accesses << 16) | geometry.modules);
  putWord(12, geometry.bytesPerTrack);
  if (fill) fill(bytes);
  return bytes;
}

/** Write a format track: codes packed four to a byte, low pair first. */
function writeFormat(bytes, geometry, cylinder, runs) {
  const at = trackOffset(geometry, { cylinder, head: 0 });
  const codes = [];
  for (const [code, length] of runs) for (let i = 0; i < length; i++) codes.push(code);
  while (codes.length % 4) codes.push(FMT_END);
  for (let i = 0; i < codes.length; i += 4) {
    bytes[at + (i >>> 2)] =
      codes[i] | (codes[i + 1] << 2) | (codes[i + 2] << 4) | (codes[i + 3] << 6);
  }
}

/** Write six-bit characters onto a data track. */
function writeChars(bytes, geometry, cylinder, head, offset, text) {
  const at = trackOffset(geometry, { cylinder, head });
  for (let i = 0; i < text.length; i++) {
    const [hi, lo] = textToWord(text.slice(i, i + 1).padEnd(6, ' '));
    void lo;
    bytes[at + offset + i] = (hi >>> 12) & 0o77;
  }
}

/** Write whole words as six characters each. */
function writeWords(bytes, geometry, cylinder, head, offset, words) {
  const at = trackOffset(geometry, { cylinder, head });
  words.forEach(([hi, lo], w) => {
    const c = offset + w * 6;
    bytes[at + c] = (hi >>> 12) & 0o77;
    bytes[at + c + 1] = (hi >>> 6) & 0o77;
    bytes[at + c + 2] = hi & 0o77;
    bytes[at + c + 3] = (lo >>> 12) & 0o77;
    bytes[at + c + 4] = (lo >>> 6) & 0o77;
    bytes[at + c + 5] = lo & 0o77;
  });
}

// --- the container ----------------------------------------------------------

test('the header gives the geometry, and head 0 is not a data track', () => {
  const bytes = buildContainer(GEOMETRY);
  const g = readGeometry(bytes);
  assert.equal(g.cylinders, 2);
  assert.equal(g.heads, 3);
  assert.equal(g.accesses, 1);
  assert.equal(g.modules, 1);
  assert.equal(g.bytesPerTrack, 120);
  assert.equal(g.dataTracksPerCylinder, 2, 'one head of the three holds the format');
});

test('a container shorter than its own geometry is refused', () => {
  const bytes = buildContainer(GEOMETRY).slice(0, 200);
  assert.throws(() => readGeometry(bytes), /short/);
});

test('tracks are laid out cylinder by cylinder within an access', () => {
  const g = readGeometry(buildContainer(GEOMETRY));
  assert.equal(trackOffset(g, { cylinder: 0, head: 0 }), 16);
  assert.equal(trackOffset(g, { cylinder: 0, head: 1 }), 16 + 120);
  assert.equal(trackOffset(g, { cylinder: 1, head: 0 }), 16 + 120 * 3);
});

// --- the format track -------------------------------------------------------

test('the format track unpacks four codes to a byte, low pair first', () => {
  const bytes = buildContainer(GEOMETRY);
  writeFormat(bytes, GEOMETRY, 0, [
    [FMT_HOME_ADDRESS, 6], [FMT_HEADER, 6], [FMT_DATA, 12], [FMT_END, 4],
  ]);
  const g = readGeometry(bytes);
  const runs = formatRuns(readFormat(bytes, g, { cylinder: 0 }));
  assert.equal(runs[0].code, FMT_HOME_ADDRESS);
  assert.equal(runs[0].length, 6);
  assert.equal(runs[1].code, FMT_HEADER);
  assert.equal(runs[1].length, 6);
  assert.equal(runs[2].code, FMT_DATA);
  assert.equal(runs[2].length, 12);
});

// --- recovering records -----------------------------------------------------

test('a record is recovered from the pattern the format track describes', () => {
  const bytes = buildContainer(GEOMETRY);
  writeFormat(bytes, GEOMETRY, 0, [
    [FMT_HOME_ADDRESS, 6], [FMT_HEADER, 6], [FMT_DATA, 12], [FMT_END, 4],
  ]);
  // Home address, then a record address, then two words of data.
  writeWords(bytes, GEOMETRY, 0, 1, 0, [
    textToWord('XXXXXX'),
    textToWord('REC001'),
    textToWord('HELLO '),
    textToWord('WORLD '),
  ]);

  const g = readGeometry(bytes);
  const codes = readFormat(bytes, g, { cylinder: 0 });
  const track = readTrack(bytes, g, codes, { cylinder: 0, head: 1 });

  assert.equal(wordToText(track.hi[0], track.lo[0]), 'XXXXXX', 'home address 2');
  assert.equal(track.hi[1], 2, 'the record is two words long');
  assert.equal(wordToText(track.hi[2], track.lo[2]), 'REC001', 'its address');
  assert.equal(wordToText(track.hi[3], track.lo[3]), 'HELLO ');
  assert.equal(wordToText(track.hi[4], track.lo[4]), 'WORLD ');
  assert.equal(track.hi[5], 0, 'a zero length ends the track');
});

test('a track whose format has no home address holds nothing', () => {
  const bytes = buildContainer(GEOMETRY);
  writeFormat(bytes, GEOMETRY, 0, [[FMT_END, 16]]);
  const g = readGeometry(bytes);
  const codes = readFormat(bytes, g, { cylinder: 0 });
  assert.equal(readTrack(bytes, g, codes, { cylinder: 0, head: 1 }), null);
});

test('loading a container leaves never-written tracks out of the module', () => {
  const bytes = buildContainer(GEOMETRY);
  for (const cylinder of [0, 1]) {
    writeFormat(bytes, GEOMETRY, cylinder, [
      [FMT_HOME_ADDRESS, 6], [FMT_HEADER, 6], [FMT_DATA, 12], [FMT_END, 4],
    ]);
  }
  // Only one track is actually written on.
  writeWords(bytes, GEOMETRY, 0, 2, 0, [
    textToWord('XXXXXX'), textToWord('REC002'), textToWord('DATA  '), textToWord('HERE  '),
  ]);

  const result = loadContainer(bytes, () => new DiskModule(1301));
  assert.equal(result.tracksLoaded, 1, 'the formatted but empty tracks cost nothing');
  const track = result.module.track(0, 1);          // cylinder 0, head 2
  assert.notEqual(track, null);
  assert.equal(wordToText(track.hi[2], track.lo[2]), 'REC002');
});

// --- a real disk ------------------------------------------------------------

const REAL = process.env.CTSS_DISK;

test('a real CTSS disk reads back with the record lengths CTSS writes', {
  skip: REAL && existsSync(REAL) ? false : 'set CTSS_DISK to a built DISK1.BIN to run',
}, () => {
  const bytes = readFileSync(REAL);
  const g = readGeometry(bytes);
  assert.equal(g.heads, 41, 'a 1302 cylinder is one format track and forty data tracks');
  assert.equal(g.bytesPerTrack, 5902);

  // Find a track that has been written on and check what came out of it.
  let checked = false;
  for (let cylinder = 0; cylinder < 8 && !checked; cylinder++) {
    const codes = readFormat(bytes, g, { cylinder });
    for (let head = 1; head < g.heads && !checked; head++) {
      const track = readTrack(bytes, g, codes, { cylinder, head });
      if (!track || track.hi[1] === 0) continue;
      checked = true;
      // CTSS lays one 435 word record on a track, then two short ones.
      assert.equal(track.hi[1], 435, 'the CTSS data record is 435 words');
      const second = 1 + 2 + 435;
      assert.equal(track.hi[second], 31, 'then a 31 word record');
      const third = second + 2 + 31;
      assert.equal(track.hi[third], 14, 'then a 14 word record');
      assert.equal(wordToText(track.hi[0], track.lo[0]), 'XXXXXX', 'home address 2');
    }
  }
  assert.equal(checked, true, 'no written track was found on the disk');
});
