/**
 * unpack.js — rebuild the five CTSS containers from a PTK1 pack.
 *
 * The counterpart of `pack.mjs`, and deliberately free of `node:fs`: the
 * pack is meant to be fetched by the page, so everything here works on a
 * `Uint8Array` and nothing touches the filesystem. What comes out is the
 * same shape `loadContainer` produces from a `.BIN` tree — `DiskModule`s
 * for the 7631 file control, and raw container bytes for the 7289 drums —
 * so a machine booted from a pack is a machine booted from the tree.
 *
 * Format "PTK1" version 2 (all big-endian), as `pack.mjs` writes it:
 *
 *     u32 magic 'PTK1'
 *     u32 version 2
 *     u32 container count N
 *     N x:
 *       u16 name length, name bytes (ASCII)
 *       u16 access count, u16 module count, u16 cylinder count,
 *       u16 head count, u16 bytes per track
 *       u32 format-pool count, then count x:
 *         u32 RLE byte length, RLE bytes (one full head-0 format track)
 *       u32 format index count (= modules*accesses*cylinders), then
 *         count x u32 pool index
 *       u32 track count, then tracks in (m,a,cyl,head) order (head 1..):
 *         u32 track index, u16 RLE byte length, RLE bytes
 *
 * RLE: 0x00 <u16 len> = len zero bytes; 0x01 <u16 len> <bytes> = a nonzero
 * run. A surface byte is never 0x00 (BCD blank is stored literal), so 0x00
 * only ever opens a zero run.
 *
 * Two fidelity notes that shaped the format:
 *
 * - The format pool stores the **full** head-0 track, not a trimmed
 *   prefix. A trimmed pool would decode the same record layout but hand
 *   `readTrack` zeros where the original surface held something else, and
 *   a track tail is exactly the kind of place a stale record hides.
 * - Every data track is emitted whether or not it holds data, so the
 *   (m,a,cyl,head) walk and the track list stay in lockstep; an empty
 *   track is a zero-length RLE record.
 */
import { DiskModule, DISK_TYPES } from './src/devices/disk.js';
import { formatRuns, layoutFromRuns, FMT_END, FMT_HOME_ADDRESS, FMT_HEADER } from './src/devices/dasd.js';

const MAGIC = 0x50544b31; // 'PTK1'
const VERSION = 2;
const HEADER_BYTES = 16;

/**
 * `readTrack`'s record decode on a bare surface. The packed track is the
 * surface itself — there is no container header in front of it — so the
 * words are pulled from offset 0 rather than through `trackOffset`, which
 * would step over a header that is not there. The walk is otherwise the
 * same: home address first, then header/data pairs, ended by a zero
 * length.
 */
function surfaceToTrack(surface, codes) {
  const runs = formatRuns(codes);
  const hi = [];
  const lo = [];
  const pushWords = (from, characterCount) => {
    for (let i = 0; i + 6 <= characterCount; i += 6) {
      const c = from + i;
      hi.push(((surface[c] & 0o77) << 12) | ((surface[c + 1] & 0o77) << 6) | (surface[c + 2] & 0o77));
      lo.push(((surface[c + 3] & 0o77) << 12) | ((surface[c + 4] & 0o77) << 6) | (surface[c + 5] & 0o77));
    }
  };

  const track = { hi: [], lo: [] };
  let position = 0;
  let sawHome = false;
  let pending = null;

  for (const run of runs) {
    const start = position;
    position += run.length;
    if (run.code === FMT_END) break;

    if (run.code === FMT_HOME_ADDRESS) {
      hi.length = 0; lo.length = 0;
      pushWords(start, run.length);
      track.hi.push(hi[0] ?? 0);
      track.lo.push(lo[0] ?? 0);
      sawHome = true;
      continue;
    }
    if (run.code === FMT_HEADER) {
      hi.length = 0; lo.length = 0;
      pushWords(start, run.length);
      pending = { addressHi: hi[0] ?? 0, addressLo: lo[0] ?? 0 };
      continue;
    }
    if (!pending) continue;
    hi.length = 0; lo.length = 0;
    pushWords(start, run.length);
    track.hi.push(hi.length, pending.addressHi);
    track.lo.push(0, pending.addressLo);
    for (let i = 0; i < hi.length; i++) {
      track.hi.push(hi[i]);
      track.lo.push(lo[i]);
    }
    pending = null;
  }

  if (!sawHome) return null;
  track.hi.push(0);
  track.lo.push(0);
  return track;
}

/** Big-endian cursor over the pack. */
class Reader {
  constructor(bytes) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = 0;
  }
  u16() { const v = this.view.getUint16(this.at); this.at += 2; return v; }
  u32() { const v = this.view.getUint32(this.at); this.at += 4; return v; }
  bytes(n) {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.view.getUint8(this.at + i);
    this.at += n;
    return out;
  }
  ascii(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.view.getUint8(this.at + i));
    this.at += n;
    return s;
  }
}

/** Undo the packer's RLE into a `total`-byte surface. */
function unrle(raw, total) {
  const out = new Uint8Array(total);
  let wi = 0;
  let i = 0;
  while (i < raw.length) {
    const kind = raw[i];
    const len = (raw[i + 1] << 8) | raw[i + 2];
    i += 3;
    if (kind === 0) {
      wi += len;
    } else {
      for (let j = 0; j < len; j++) out[wi + j] = raw[i + j];
      wi += len;
      i += len;
    }
  }
  return out;
}

/** One format code per character position, four to a byte, lsb pair first. */
function codesFromFormatTrack(bytes) {
  const count = Math.floor(bytes.length / 4) * 4;
  const codes = new Uint8Array(count);
  for (let i = 0; i < codes.length; i += 4) {
    const byte = bytes[i >>> 2];
    codes[i] = byte & 3;
    codes[i + 1] = (byte >>> 2) & 3;
    codes[i + 2] = (byte >>> 4) & 3;
    codes[i + 3] = (byte >>> 6) & 3;
  }
  return codes;
}

/**
 * A 7289 drum container is word-addressed bulk memory, not a file-control
 * disk: `DrumControl` mounts the raw container bytes and never sees a
 * `DiskModule`. The pack marks one by its geometry — a single small
 * cylinder set of wide tracks — and this rebuilds the container image
 * (header + tracks) from the packed records.
 */
function isDrumContainer({ accesses, modules, heads, cylinders, bytesPerTrack }) {
  return accesses === 1 && modules === 1 && heads <= 16 && cylinders <= 6 && bytesPerTrack >= 8192;
}

/**
 * The 7631 model a container's geometry describes. A track's word capacity
 * is `bytesPerTrack / 6` six-bit characters; the 7320 drum holds 500-word
 * tracks, the 1301/1302 a thousand. The pack does not carry the model
 * number — the mounter knows it — so this only has to tell the two track
 * widths apart.
 */
function diskType({ bytesPerTrack }) {
  const words = Math.floor(bytesPerTrack / 6);
  if (words <= DISK_TYPES[7320].wordsPerTrack) return 7320;
  return 1302;
}

/**
 * A DiskModule whose tracks decode on first touch.
 *
 * The eager path below materializes every packed track up front — 80,400
 * tracks and roughly 640 MB of Int32Arrays, because `ensureTrack` gives each
 * one a full track's worth of words whether it holds a file or only its
 * format's record slots. That is fine for a one-shot diff and wrong for a
 * browser tab, so the worker mounts these instead: the pack's RLE records
 * stay packed, a track's words appear when the 7631 first seeks it, and a
 * track that is only ever formatted — never written — never exists at all,
 * which is exactly what `layOutFormat` already does for a blank surface.
 *
 * The class is a `DiskModule` so `instanceof` checks and the `type`,
 * `formats`, `position` and `inoperative` fields behave identically; only
 * `track`/`ensureTrack` differ, and both still return the same
 * `{hi, lo, dirty}` shape the file control transfers through.
 */
export class PackedDiskModule extends DiskModule {
  /**
   * @param {number} type    disk model, as `diskType` reports it
   * @param {object} store   per-module slice of the pack, built by `unpackPacked`
   */
  constructor(type, store) {
    super(type);
    this.store = store;
  }

  /** Decode one packed track into the live `{hi, lo}` pair, or null. */
  #materialize(key) {
    const entry = this.store.tracks.get(key);
    if (!entry) return null;
    const surface = unrle(entry.rle, this.store.bytesPerTrack);
    const codes = codesFromFormatTrack(this.store.pool[entry.fmtPool]);
    const track = surfaceToTrack(surface, codes);
    if (!track) return null;
    const into = {
      hi: new Int32Array(this.type.wordsPerTrack),
      lo: new Int32Array(this.type.wordsPerTrack),
      dirty: false,
    };
    for (let i = 0; i < track.hi.length && i < into.hi.length; i++) {
      into.hi[i] = track.hi[i];
      into.lo[i] = track.lo[i];
    }
    this.tracks.set(key, into);
    return into;
  }

  track(access, track) {
    const key = this.key(access, track);
    return this.tracks.get(key) ?? this.#materialize(key);
  }

  ensureTrack(access, track, { dirty = false } = {}) {
    const key = this.key(access, track);
    let found = this.tracks.get(key) ?? this.#materialize(key);
    if (!found) {
      found = { hi: new Int32Array(this.type.wordsPerTrack), lo: new Int32Array(this.type.wordsPerTrack), dirty: false };
      this.tracks.set(key, found);
    }
    if (dirty) found.dirty = true;
    return found;
  }
}

function rebuildDrumBytes(geometry, tracks, pool, fmtIndex) {
  const { cylinders, heads, accesses, modules, bytesPerTrack } = geometry;
  const total = HEADER_BYTES + cylinders * heads * accesses * modules * bytesPerTrack;
  const out = new Uint8Array(total);
  const w = (off, v) => {
    out[off] = (v >>> 24) & 0xff;
    out[off + 1] = (v >>> 16) & 0xff;
    out[off + 2] = (v >>> 8) & 0xff;
    out[off + 3] = v & 0xff;
  };
  w(0, cylinders);
  w(4, heads);
  w(8, (accesses << 16) | modules);
  w(12, bytesPerTrack);
  let ti = 0;
  for (let cyl = 0; cyl < cylinders; cyl++) {
    // Head 0 is the cylinder's format track; the pool holds it whole.
    const fmt = pool[fmtIndex[cyl]];
    if (fmt) out.set(fmt, HEADER_BYTES + cyl * heads * bytesPerTrack);
    for (let h = 1; h < heads; h++, ti++) {
      const e = tracks[ti];
      if (!e || !e.stored) continue;
      out.set(unrle(e.rle, bytesPerTrack), HEADER_BYTES + h * bytesPerTrack + cyl * heads * bytesPerTrack);
    }
  }
  return out;
}

/**
 * Parse a PTK1 pack into containers.
 *
 * Returns `{ containers }`, a Map by name. Disk containers (DISK1, DISK2,
 * DRUM1 — the 7631's media) carry `{ geometry, module, modules, tracksLoaded }`
 * where `modules` maps module number to `DiskModule`; drum containers
 * (DRUM2, DRUM3) carry `{ geometry, bytes, tracksLoaded }` with the raw
 * container image `DrumControl.mount` expects.
 *
 * With `{ lazy: true }` the disk modules are `PackedDiskModule`s: the pack's
 * track records are kept compressed and decoded on first access, so the
 * resident cost is the pack itself (~10 MB) plus only the tracks the machine
 * actually reads or writes. The default stays eager — the diff harness wants
 * every track materialized to compare it.
 */
export function unpackPacked(bytes, { lazy = false } = {}) {
  const r = new Reader(bytes);
  const magic = r.u32();
  const version = r.u32();
  if (magic !== MAGIC) throw new Error(`not a PTK1 pack: magic ${magic.toString(16)}`);
  if (version !== VERSION) throw new Error(`unsupported PTK1 version ${version}`);
  const count = r.u32();
  const containers = new Map();

  for (let c = 0; c < count; c++) {
    const name = r.ascii(r.u16());
    const accesses = r.u16();
    const modules = r.u16();
    const cylinders = r.u16();
    const heads = r.u16();
    const bytesPerTrack = r.u16();
    const geometry = {
      cylinders, heads, accesses, modules, bytesPerTrack,
      dataTracksPerCylinder: heads - 1,
    };

    const poolCount = r.u32();
    const pool = [];
    for (let p = 0; p < poolCount; p++) {
      pool.push(unrle(r.bytes(r.u32()), bytesPerTrack));
    }
    const fmtIndexCount = r.u32();
    const fmtIndex = [];
    for (let f = 0; f < fmtIndexCount; f++) fmtIndex.push(r.u32());

    const trackCount = r.u32();
    const tracks = [];
    for (let t = 0; t < trackCount; t++) {
      const index = r.u32();
      const stored = r.u16();
      tracks.push({ index, stored, rle: stored ? r.bytes(stored) : null });
    }

    if (isDrumContainer(geometry)) {
      containers.set(name, {
        geometry,
        bytes: rebuildDrumBytes(geometry, tracks, pool, fmtIndex),
        tracksLoaded: tracks.filter((t) => t.stored).length,
      });
      continue;
    }

    // A 7631 container: one DiskModule per module, every access arm in it.
    const type = diskType(geometry);
    const moduleMap = new Map();
    const dataTracksPerCylinder = heads - 1;
    let tracksLoaded = 0;

    if (lazy) {
      // Keep the RLE records packed, indexed by the key `track`/`ensureTrack`
      // will ask for: access * tracksPerAccess + track number. The format
      // layouts still land up front — they are small, and `layOutFormat`
      // consults them on every first touch of a formatted track.
      const stores = new Map();
      for (let m = 0; m < modules; m++) {
        stores.set(m, { tracks: new Map(), pool, bytesPerTrack });
        moduleMap.set(m, new PackedDiskModule(type, stores.get(m)));
      }
      let entry = 0;
      for (let m = 0; m < modules; m++) {
        const module = moduleMap.get(m);
        const store = stores.get(m);
        for (let a = 0; a < accesses; a++) {
          for (let cyl = 0; cyl < cylinders; cyl++) {
            const poolKey = fmtIndex[m * accesses * cylinders + a * cylinders + cyl];
            const codes = codesFromFormatTrack(pool[poolKey]);
            const layout = layoutFromRuns(formatRuns(codes));
            if (layout) module.formats.set(a * cylinders + cyl, layout);
            for (let h = 1; h < heads; h++, entry++) {
              const e = tracks[entry];
              if (!e || !e.stored) continue;
              const number = cyl * dataTracksPerCylinder + (h - 1);
              store.tracks.set(module.key(a, number), { rle: e.rle, fmtPool: poolKey });
              tracksLoaded++;
            }
          }
        }
      }
    } else {
      for (let m = 0; m < modules; m++) moduleMap.set(m, new DiskModule(type));
      let entry = 0;
      for (let m = 0; m < modules; m++) {
        const module = moduleMap.get(m);
        for (let a = 0; a < accesses; a++) {
          for (let cyl = 0; cyl < cylinders; cyl++) {
            const poolKey = fmtIndex[m * accesses * cylinders + a * cylinders + cyl];
            const codes = codesFromFormatTrack(pool[poolKey]);
            const layout = layoutFromRuns(formatRuns(codes));
            if (layout) module.formats.set(a * cylinders + cyl, layout);
            for (let h = 1; h < heads; h++, entry++) {
              const e = tracks[entry];
              if (!e || !e.stored) continue;
              const surface = unrle(e.rle, bytesPerTrack);
              const track = surfaceToTrack(surface, codes);
              if (!track) continue;
              const number = cyl * dataTracksPerCylinder + (h - 1);
              const into = module.ensureTrack(a, number);
              for (let i = 0; i < track.hi.length && i < into.hi.length; i++) {
                into.hi[i] = track.hi[i];
                into.lo[i] = track.lo[i];
              }
              tracksLoaded++;
            }
          }
        }
      }
    }
    containers.set(name, {
      geometry,
      module: moduleMap.get(0),
      modules: moduleMap,
      tracksLoaded,
    });
  }
  return { containers };
}
