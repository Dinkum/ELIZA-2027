/**
 * Reading a real CTSS disk.
 *
 * The 7631 in `disk.js` keeps a track as a list of records, which is how SIMH
 * models it and how a program thinks about it. A real disk does not have
 * records on it; it has a magnetised surface, and the records are a pattern the
 * program wrote there. The container files the CTSS reconstruction builds keep
 * that distinction, because they are written by a simulator that models the
 * surface character by character — so reading one in means recovering the
 * records from the pattern, which is what this module does.
 *
 * A container is a header and then a run of fixed size tracks:
 *
 *     header     four 32-bit big-endian words:
 *                cylinders, heads, access<<16 | modules, bytes per track
 *     tracks     cylinders * heads * access * modules of them, in that order,
 *                each exactly `bytes per track` long
 *
 * The heads of a cylinder are not all alike. Head 0 is the **format track**: it
 * holds no data at all, but two bits for every character position on the other
 * tracks, saying what that position is for. The data tracks are heads 1 upward,
 * so a "41 head" 1301 has forty tracks you can write on. Those two facts
 * together are why a disk formatted by one of these tools looks like nothing at
 * all until the format track is read first.
 *
 * Format codes, two bits each, four to a byte, least significant pair first:
 *
 *     0  data             part of a record's data
 *     1  header           part of a record's address
 *     2  home address 2   the track's own identifier
 *     3  end              past the last record
 *
 * Data characters are six bits, one per byte, six to a 36-bit word.
 *
 * Reference: `mkdasd.c` and `dasd.h` from the CTSS reconstruction's utilities
 * for the container, and s709's `chan7909.c` for the track layout within it.
 */

/** What a format code means. */
export const FMT_DATA = 0;
export const FMT_HEADER = 1;
export const FMT_HOME_ADDRESS = 2;
export const FMT_END = 3;

/** The container's fixed size header. */
const HEADER_BYTES = 16;

/**
 * Read the four header words. `bytes` is the whole container as a Uint8Array
 * or a Buffer.
 */
export function readGeometry(bytes) {
  if (bytes.length < HEADER_BYTES) throw new Error('not a disk container: too short');
  const word = (at) => (bytes[at] << 24 | bytes[at + 1] << 16 | bytes[at + 2] << 8 | bytes[at + 3]) >>> 0;
  const cylinders = word(0);
  const heads = word(4);
  const packed = word(8);
  const bytesPerTrack = word(12);
  const geometry = {
    cylinders,
    heads,
    accesses: packed >>> 16,
    modules: packed & 0xffff,
    bytesPerTrack,
    /** Head 0 of every cylinder is the format track, so the rest carry data. */
    dataTracksPerCylinder: heads - 1,
  };
  const expected = HEADER_BYTES
    + geometry.cylinders * geometry.heads * geometry.accesses * geometry.modules * bytesPerTrack;
  if (bytes.length < expected) {
    throw new Error(`disk container is short: ${bytes.length} bytes, expected ${expected}`);
  }
  return geometry;
}

/**
 * Where one track starts, in bytes.
 *
 * The ordering is the one s709 seeks with: modules contain accesses, accesses
 * contain cylinders, cylinders contain heads.
 */
export function trackOffset(geometry, { module = 0, access = 0, cylinder = 0, head = 0 }) {
  const { cylinders, heads, accesses, bytesPerTrack } = geometry;
  const cylinderIndex = access * cylinders + module * cylinders * accesses + cylinder;
  return HEADER_BYTES + bytesPerTrack * head + bytesPerTrack * heads * cylinderIndex;
}

/** Unpack a cylinder's format track into one code per character position. */
export function readFormat(bytes, geometry, { module = 0, access = 0, cylinder = 0 } = {}) {
  const at = trackOffset(geometry, { module, access, cylinder, head: 0 });
  const count = geometry.bytesPerTrack;
  const codes = new Uint8Array((count >>> 2) * 4);
  for (let i = 0; i < codes.length; i += 4) {
    const byte = bytes[at + (i >>> 2)];
    codes[i] = byte & 3;
    codes[i + 1] = (byte >>> 2) & 3;
    codes[i + 2] = (byte >>> 4) & 3;
    codes[i + 3] = (byte >>> 6) & 3;
  }
  return codes;
}

/**
 * The format track as runs, which is the shape the records are really in:
 * a home address, then header and data alternating, then the end.
 */
export function formatRuns(codes) {
  const runs = [];
  let previous = -1;
  let length = 0;
  for (const code of codes) {
    if (code === previous) {
      length += 1;
      continue;
    }
    if (previous >= 0) runs.push({ code: previous, length });
    previous = code;
    length = 1;
  }
  if (previous >= 0) runs.push({ code: previous, length });
  return runs;
}

/**
 * The cylinder's record layout in the shape `disk.js` keeps it: how many
 * characters the home address and the headers take, and how many each
 * record's data takes. Returns null when the format declares no records.
 */
export function layoutFromRuns(runs) {
  if (!runs.length || runs[0].code !== FMT_HOME_ADDRESS) return null;
  const dataChars = [];
  let hdrChars = 0;
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].code === FMT_END) break;
    if (runs[i].code === FMT_HEADER) {
      if (!hdrChars) hdrChars = runs[i].length;
    } else if (runs[i].code === FMT_DATA) {
      dataChars.push(runs[i].length);
    }
  }
  if (!dataChars.length) return null;
  return { ha2Chars: runs[0].length, hdrChars, dataChars };
}

/**
 * Read one data track into the record structure `disk.js` works in:
 *
 *     word 0            home address 2
 *     then per record   length in words, the record address, then the data
 *     end               a record of length zero
 *
 * Returns null for a track whose format says it holds nothing.
 */
export function readTrack(bytes, geometry, codes, { module = 0, access = 0, cylinder = 0, head = 1 }) {
  const at = trackOffset(geometry, { module, access, cylinder, head });
  const runs = formatRuns(codes);

  const hi = [];
  const lo = [];
  const pushWords = (from, characterCount) => {
    // Six six-bit characters to a word, high half first.
    for (let i = 0; i + 6 <= characterCount; i += 6) {
      const c = from + i;
      hi.push(((bytes[at + c] & 0o77) << 12) | ((bytes[at + c + 1] & 0o77) << 6) | (bytes[at + c + 2] & 0o77));
      lo.push(((bytes[at + c + 3] & 0o77) << 12) | ((bytes[at + c + 4] & 0o77) << 6) | (bytes[at + c + 5] & 0o77));
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
      // Only the first word of the home address is kept: a 7631 compares two
      // characters of it and CTSS writes one word.
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

    // Data. Without a header before it there is no record to attach it to.
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
  track.hi.push(0);                     // a zero length ends the track
  track.lo.push(0);
  return track;
}

/** True when anything at all has been written on a track. */
export function trackHasData(bytes, geometry, place) {
  const at = trackOffset(geometry, place);
  const end = at + geometry.bytesPerTrack;
  for (let i = at; i < end; i++) if (bytes[i] !== 0) return true;
  return false;
}

/**
 * Load a container into `DiskModule`s, ready for the 7631 to read.
 *
 * Only tracks that actually hold a record are created, so an empty formatted
 * disk costs nothing: the modules stay sparse exactly as they do when the
 * emulated machine writes them.
 */
export function loadContainer(bytes, makeModule, { module = 0, access = 0 } = {}) {
  const geometry = readGeometry(bytes);
  const target = makeModule(geometry);
  let loaded = 0;

  for (let cylinder = 0; cylinder < geometry.cylinders; cylinder++) {
    const codes = readFormat(bytes, geometry, { module, access, cylinder });
    // The format belongs to the whole cylinder whether or not any of its
    // tracks hold data yet — a formatted track keeps its record slots.
    if (target.formats instanceof Map) {
      const layout = layoutFromRuns(formatRuns(codes));
      if (layout) target.formats.set(access * geometry.cylinders + cylinder, layout);
    }
    for (let head = 1; head < geometry.heads; head++) {
      // A formatted track always yields a record — the format says where one
      // goes — so emptiness has to be judged from the media itself, before it
      // is interpreted. It is also much the cheaper test: a 1302 has forty
      // thousand tracks and almost none of them are ever written on.
      if (!trackHasData(bytes, geometry, { module, access, cylinder, head })) continue;
      const track = readTrack(bytes, geometry, codes, { module, access, cylinder, head });
      if (!track) continue;
      const number = cylinder * geometry.dataTracksPerCylinder + (head - 1);
      const into = target.ensureTrack(access, number);
      for (let i = 0; i < track.hi.length && i < into.hi.length; i++) {
        into.hi[i] = track.hi[i];
        into.lo[i] = track.lo[i];
      }
      loaded += 1;
    }
  }
  return { geometry, module: target, tracksLoaded: loaded };
}

/**
 * Write a `DiskModule` back into its container image.
 *
 * The module's record structure is turned back into surface data the same
 * way `readTrack` found it: one word of home address, then each record as
 * six characters of header and six characters a word of data, and the end
 * code everywhere the records do not reach. Head 0 of the cylinder gets the
 * matching format track, so the image still reads the way it was written.
 * Tracks the module does not hold are left exactly as they were.
 */
export function storeContainer(bytes, module, { module: moduleNumber = 0, access = 0 } = {}) {
  const geometry = readGeometry(bytes);
  const perCylinder = geometry.dataTracksPerCylinder;
  const written = new Set();
  for (const [key, track] of module.tracks) {
    if (!track.dirty) continue;
    if (Math.floor(key / module.tracksPerAccess) !== access) continue;
    const number = key % module.tracksPerAccess;
    const cylinder = Math.floor(number / perCylinder);
    const head = (number % perCylinder) + 1;

    // Lay the track out as format codes and surface characters together:
    // six of home address, then six of header and six a word of data for
    // every record, and the end code for whatever is left over.
    const codes = [];
    const chars = [];
    const pushChars = (hi, lo) => {
      chars.push((hi >>> 12) & 0o77, (hi >>> 6) & 0o77, hi & 0o77,
                 (lo >>> 12) & 0o77, (lo >>> 6) & 0o77, lo & 0o77);
    };
    codes.push(...new Array(6).fill(FMT_HOME_ADDRESS));
    pushChars(track.hi[0] ?? 0, track.lo[0] ?? 0);
    let at = 1;
    while (at + 1 < track.hi.length && track.hi[at] !== 0) {
      const length = track.hi[at];
      codes.push(...new Array(6).fill(FMT_HEADER));
      pushChars(track.hi[at + 1] ?? 0, track.lo[at + 1] ?? 0);
      codes.push(...new Array(length * 6).fill(FMT_DATA));
      for (let w = 0; w < length; w++) pushChars(track.hi[at + 2 + w] ?? 0, track.lo[at + 2 + w] ?? 0);
      at += 2 + length;
    }
    while (codes.length < geometry.bytesPerTrack) codes.push(FMT_END);
    while (chars.length < geometry.bytesPerTrack) chars.push(0);

    // Head 0 of the cylinder is the format for every track in it. When a
    // format order declared this cylinder's layout while running, that
    // declaration is written below instead; otherwise the track's own
    // records define it.
    if (!module.dirtyFormats?.has(access * geometry.cylinders + cylinder)) {
      const fmtAt = trackOffset(geometry, { module: moduleNumber, access, cylinder, head: 0 });
      for (let i = 0; i < geometry.bytesPerTrack; i += 4) {
        bytes[fmtAt + (i >>> 2)] = (codes[i] & 3) | ((codes[i + 1] & 3) << 2)
          | ((codes[i + 2] & 3) << 4) | ((codes[i + 3] & 3) << 6);
      }
    }
    const dataAt = trackOffset(geometry, { module: moduleNumber, access, cylinder, head });
    for (let i = 0; i < geometry.bytesPerTrack; i++) bytes[dataAt + i] = chars[i] & 0o77;
    written.add(key);
  }

  // Formats declared while running go back onto their head-0 tracks,
  // including cylinders whose data tracks were never touched — a format
  // write is a change to the media even when no record has been written
  // yet. Cylinders whose format only came from loading the image keep
  // their original head 0.
  if (module.dirtyFormats instanceof Set) {
    for (const key of module.dirtyFormats) {
      const format = module.formats.get(key);
      if (!format) continue;
      const fmtAccess = Math.floor(key / geometry.cylinders);
      if (fmtAccess !== access) continue;
      const cylinder = key % geometry.cylinders;
      const codes = new Array(format.ha2Chars).fill(FMT_HOME_ADDRESS);
      for (const chars of format.dataChars) {
        codes.push(...new Array(format.hdrChars).fill(FMT_HEADER));
        codes.push(...new Array(chars).fill(FMT_DATA));
      }
      while (codes.length < geometry.bytesPerTrack) codes.push(FMT_END);
      const fmtAt = trackOffset(geometry, { module: moduleNumber, access, cylinder, head: 0 });
      for (let i = 0; i < geometry.bytesPerTrack; i += 4) {
        bytes[fmtAt + (i >>> 2)] = (codes[i] & 3) | ((codes[i + 1] & 3) << 2)
          | ((codes[i + 2] & 3) << 4) | ((codes[i + 3] & 3) << 6);
      }
    }
  }
  return written.size;
}
