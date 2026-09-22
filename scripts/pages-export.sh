#!/bin/sh
# Stage the Cloudflare Pages publish tree for ELIZA-2027.
#
# Usage: scripts/pages-export.sh [dest-dir]
#   Default dest is /tmp/eliza-pages-export (outside the repo on purpose).
#
# The publish set is the small static app: modes 1 (rewrite), 2 (port), 3
# (emulate) and 4 (extended). Mode 3 is the machine in the browser: a Worker
# boots CTSS from a packed image (~10 MB) and the page is its 7750 line. The
# raw DASD containers never go to the client — only the pack and the card
# deck do — so *.BIN, *.tap, dasd/ and output/ are still excluded, and the
# pack is the only artifact that ships.
#
# Encoder (mode 4) is optional. The vendored WebAssembly runtime and pinned
# model ship when present locally, EXCEPT ort-wasm-simd-threaded.jsep.wasm:
# at 26.1 MB it sits on the 25 MiB per-file limit and is WebGPU-only anyway,
# so it never ships. The WASM path remains the portable runtime.
#
# No bundler, no CDN, no new dependency. No deploy happens here; point a
# Pages project at the staged dir (or replicate the include/exclude list in
# the project's build step) and stop.
set -eu

DEST="${1:-/tmp/eliza-pages-export}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

rm -rf "$DEST"
mkdir -p "$DEST/modes" "$DEST/data"

# Root files: the page and the Pages headers. package.json is NOT needed on
# Pages (no build step), version.json is unread by the page.
cp "$SRC/index.html" "$SRC/_headers" "$DEST/"

# Intro + paper UI. Test files stay home.
rsync -a --exclude '*.test.js' "$SRC/app/" "$DEST/app/"

# Modes 1 and 2, minus their node test dirs.
rsync -a --exclude 'test/' "$SRC/modes/rewrite/" "$DEST/modes/rewrite/"
rsync -a --exclude 'test/' "$SRC/modes/port/" "$DEST/modes/port/"

# Mode 4: engine + script + the complete local WASM encoder. jsep.wasm never
# ships (25 MiB per-file limit, WebGPU-only). Everything else under vendor/
# rides along when present locally (library, manifest, family vectors,
# pinned model and WASM-device runtime), while the page still falls back to
# its bundled lexical index wherever a piece is missing.
rsync -a \
  --exclude 'test/' \
  --exclude 'vendor/ort/*.jsep.wasm' \
  "$SRC/modes/extended/" "$DEST/modes/extended/"

# Mode 3: the worker, the packed image and the card deck. The raw DASD
# containers stay home; the pack is the only artifact the page fetches.
rsync -a \
  --include 'worker.js' \
  --include 'ctss-dasd.pack' \
  --include 'cmd.cbn' \
  --include 'src/***' \
  --include 'unpack.js' \
  --include 'bridge.mjs' \
  --exclude '*' \
  "$SRC/modes/emulate/" "$DEST/modes/emulate/"

# Archive tapes the page reads.
rsync -a "$SRC/data/scripts/" "$DEST/data/scripts/"
rsync -a "$SRC/shared/" "$DEST/shared/"

# Font faces plus their stylesheet. Tooling (.venv), caches
# (__pycache__), the build script and dev artefacts (demo, specimens,
# strike lab, lockfiles) stay home.
rsync -a \
  --include '*/' \
  --include '*.woff2' \
  --include '*.ttf' \
  --include 'font.css' \
  --include 'manifest.json' \
  --include 'SOURCES.md' \
  --exclude '*' \
  "$SRC/font/" "$DEST/font/"

echo "Staged $DEST"
du -sh "$DEST"
if find "$DEST" \( -name '*.BIN' -o -name '*.tap' -o -name '*jsep.wasm' \) | grep -q .; then
  echo "ERROR: disks or jsep.wasm leaked into the export:" >&2
  find "$DEST" \( -name '*.BIN' -o -name '*.tap' -o -name '*jsep.wasm' \) >&2
  exit 1
fi
