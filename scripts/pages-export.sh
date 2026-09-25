#!/bin/sh
# Stage the Cloudflare Pages publish tree for ELIZA-2027.
#
# Usage: scripts/pages-export.sh [dest-dir]
#   Default dest is /tmp/eliza-pages-export (outside the repo on purpose).
#
# The publish set is the small static app: modes 1 (rewrite), 2 (port), 3
# (emulate) and 4 (extended). Mode 3 is the machine in the browser: a Worker
# boots CTSS from the selected packed image (~10 MB each) and the page is its
# 7750 line. The raw DASD containers never go to the client — only the two
# packs and the card deck do — so *.BIN, *.tap, dasd/ and output/ stay out.
#
# Encoder (mode 4) is optional. The vendored WebAssembly runtime and pinned
# model ship when present locally. Only the CPU runtime is vendored; a stale
# WebGPU (jsep) runtime from an older `npm run vendor` is left out, since
# nothing loads it.
#
# Pages Functions (functions/) are not copied: wrangler reads them from the
# directory it is run in. Deploy from the repo root:
#
#   scripts/pages-export.sh /tmp/eliza-pages-export
#   npx wrangler pages deploy /tmp/eliza-pages-export --project-name <name>
#
# No bundler, no CDN, no new dependency. No deploy happens here.
set -eu

DEST="${1:-/tmp/eliza-pages-export}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

if [ -e "$DEST" ]; then
  echo "ERROR: destination already exists: $DEST" >&2
  exit 1
fi
mkdir -p "$DEST/modes" "$DEST/data"

# Root files: the page, the Pages headers and routes, and robots.txt.
# package.json is NOT needed on Pages (no build step), version.json is unread
# by the page.
cp "$SRC/index.html" "$SRC/_headers" "$SRC/_routes.json" "$SRC/robots.txt" "$DEST/"

# Intro + paper UI. Test files stay home.
rsync -a --exclude '*.test.js' "$SRC/app/" "$DEST/app/"

# Modes 1 and 2, minus their node test dirs.
rsync -a --exclude 'test/' "$SRC/modes/rewrite/" "$DEST/modes/rewrite/"
rsync -a --exclude 'test/' "$SRC/modes/port/" "$DEST/modes/port/"

# Mode 4: engine + script + the complete local WASM encoder. A leftover jsep
# (WebGPU) runtime never ships. Everything else under vendor/
# rides along when present locally (library, manifest, family vectors,
# pinned model and WASM-device runtime), while the page still falls back to
# its bundled lexical index wherever a piece is missing.
rsync -a \
  --exclude 'test/' \
  --exclude 'vendor/ort/*.jsep.*' \
  "$SRC/modes/extended/" "$DEST/modes/extended/"

# Mode 3: the worker, both versioned packed images and the card deck. The raw
# DASD containers stay home.
rsync -a \
  --include 'worker.js' \
  --include 'ctss-dasd.pack' \
  --include 'ctss-1966-dasd.pack' \
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
if find "$DEST" \( -name '*.BIN' -o -name '*.tap' -o -name '*.jsep.*' \) | grep -q .; then
  echo "ERROR: disks or the WebGPU runtime leaked into the export:" >&2
  find "$DEST" \( -name '*.BIN' -o -name '*.tap' -o -name '*.jsep.*' \) >&2
  exit 1
fi
# Pages rejects any single file over 25 MiB.
if find "$DEST" -type f -size +25M | grep -q .; then
  echo "ERROR: files over the 25 MiB Pages limit:" >&2
  find "$DEST" -type f -size +25M >&2
  exit 1
fi
