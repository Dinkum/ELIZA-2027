/**
 * pack.mjs — pack the five CTSS containers into one browser-loadable image.
 *
 * Format "PTK1" (all big-endian):
 *
 *     u32 magic 'PTK1'
 *     u32 version 1
 *     u32 container count N
 *     N x:
 *       u16 name length, name bytes (ASCII)
 *       u16 access count          (from geometry header)
 *       u16 module count
 *       u16 cylinder count
 *       u16 head count
 *       u16 bytes per track
 *       u32 format-pool byte length, then the pool:
 *         u32 count, then count x:
 *           u32 byte length, bytes (one cylinder's head-0 format track, trimmed)
 *       u32 format index count (= modules*accesses*cylinders), then count x:
 *         u32 pool index for that (module, access, cylinder)
 *       u32 track count, then tracks in (m,a,cyl,head) order (head 1..):
 *         u32 track index         (access * tracksPerAccess + number)
 *         u16 stored bytes        (RLE byte length of the 6-bit surface)
 *         bytes[stored]           the six-bit surface, RLE'd: 0x00 <u16 len> =
 *                                 len zero bytes, 0x01 <u16 len> <bytes> =
 *                                 nonzero run
 *
 * Every data track is emitted (trackHasData accepts all of them in this kit)
 * but only its nonzero prefix rides along; the loader re-zero-fills the rest,
 * which is what readTrack/loadContainer would have produced anyway. Format
 * tracks are deduped into the pool (they are a few dozen bytes of codes + a
 * zero tail, and nearly every cylinder of a disk shares the same shape).
 *
 * The packer reads the original .BIN tree read-only. That tree stays the
 * source of truth; this file is regenerable from it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGeometry, trackOffset, trackHasData } from './src/devices/dasd.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = process.env.DASD_DIR ?? 'tmp/mode3-dasd';
const OUT = process.env.PACK_OUT ?? 'tmp/PACK/ctss-dasd.pack';

const MAGIC = 0x50544b31; // 'PTK1'
const VERSION = 2;

/** RLE of a Uint8Array: 0x00 <len:u16 BE> = len zero bytes, 0x01 <len:u16 BE>
 *  <bytes> = len nonzero bytes. A surface byte can never be 0x00: BCD blank
 *  is stored literal, so 0x00 only ever opens a zero run. */
function rle(raw) {
  const out = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === 0) {
      let j = i;
      while (j < raw.length && raw[j] === 0) j++;
      const len = j - i;
      out.push(0, (len >>> 8) & 0xff, len & 0xff);
      i = j;
    } else {
      let j = i;
      while (j < raw.length && raw[j] !== 0) j++;
      const len = j - i;
      out.push(1, (len >>> 8) & 0xff, len & 0xff);
      for (let k = i; k < j; k++) out.push(raw[k]);
      i = j;
    }
  }
  return Uint8Array.from(out);
}

/** The head-0 format track, full length. */
function formatBytes(bytes, g, m, a, c) {
  const at = trackOffset(g, { module: m, access: a, cylinder: c, head: 0 });
  return bytes.subarray(at, at + g.bytesPerTrack);
}

function build() {
  const names = process.env.PACK_NAMES ? process.env.PACK_NAMES.split(',') : ['DISK1', 'DISK2', 'DRUM1', 'DRUM2', 'DRUM3'];
  const containers = [];
  let totalTrackRecords = 0;

  for (const name of names) {
    const bytes = readFileSync(join(root, DIR, `${name}.BIN`));
    const g = readGeometry(bytes);
    const { cylinders, heads, accesses, modules, bytesPerTrack } = g;
    const tracksPerAccess = (heads - 1) * cylinders;

    // Format pool with dedup.
    const pool = [];
    const poolIndex = new Map();
    const cylFormatIndex = [];
    for (let m = 0; m < modules; m++) {
      for (let a = 0; a < accesses; a++) {
        for (let c = 0; c < cylinders; c++) {
          const fmt = formatBytes(bytes, g, m, a, c);
          // Dedup on the meaningful part only (the code region); store full.
          let end = fmt.length;
          while (end > 0 && fmt[end - 1] === 0) end--;
          const key = Buffer.from(fmt.subarray(0, end)).toString('hex');
          let poolKey = poolIndex.get(key);
          if (poolKey === undefined) {
            poolKey = pool.length;
            poolIndex.set(key, poolKey);
            pool.push(fmt);
          }
          cylFormatIndex.push(poolKey);
        }
      }
    }

    // Tracks: all of them, nonzero prefix only.
    const tracks = [];
    let kept = 0;
    let prefixBytes = 0;
    let totalSurface = 0;
    for (let m = 0; m < modules; m++) {
      for (let a = 0; a < accesses; a++) {
        for (let c = 0; c < cylinders; c++) {
          for (let h = 1; h < heads; h++) {
            const index = a * tracksPerAccess + c * (heads - 1) + (h - 1);
            const place = { module: m, access: a, cylinder: c, head: h };
            let surface = new Uint8Array(0);
            if (trackHasData(bytes, g, place)) {
              const at = trackOffset(g, place);
              let end = at + bytesPerTrack;
              while (end > at && bytes[end - 1] === 0) end--;
              surface = bytes.subarray(at, end);
              prefixBytes += surface.length;
              kept++;
            }
            totalSurface += bytesPerTrack;
            tracks.push({ index, surface });
          }
        }
      }
    }
    totalTrackRecords += tracks.length;

    containers.push({
      name,
      geometry: { accesses, modules, cylinders, heads, bytesPerTrack },
      pool,
      cylFormatIndex,
      tracks,
      kept,
      prefixBytes,
      totalSurface,
    });
    console.log(`pack ${name}: ${tracks.length} tracks (${kept} kept), ${(prefixBytes / 1e6).toFixed(2)} MB nonzero-prefix bytes of ${(totalSurface / 1e6).toFixed(0)} MB surface`);
  }

  // Serialize.
  const chunks = [];
  const push32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); chunks.push(b); };
  const push16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); chunks.push(b); };
  push32(MAGIC);
  push32(VERSION);
  push32(containers.length);
  for (const c of containers) {
    push16(c.name.length);
    chunks.push(Buffer.from(c.name, 'ascii'));
    push16(c.geometry.accesses);
    push16(c.geometry.modules);
    push16(c.geometry.cylinders);
    push16(c.geometry.heads);
    push16(c.geometry.bytesPerTrack);
    push32(c.pool.length);
    for (const fmt of c.pool) {
      const enc = rle(fmt);
      push32(enc.length);
      chunks.push(enc);
    }
    push32(c.cylFormatIndex.length);
    for (const idx of c.cylFormatIndex) push32(idx);
    push32(c.tracks.length);
    for (const t of c.tracks) {
      push32(t.index);
      if (t.surface.length) {
        const enc = rle(t.surface);
        push16(enc.length);
        chunks.push(enc);
      } else {
        push16(0);
      }
    }
  }
  const out = Buffer.concat(chunks);
  writeFileSync(join(root, OUT), out);
  console.log(`PACK ${out.length} bytes (${(out.length / 1e6).toFixed(2)} MB) -> ${OUT}`);
  console.log(`  track records: ${totalTrackRecords}`);
  return out.length;
}

build();