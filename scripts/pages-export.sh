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
# Pages Functions (functions/) are not copied: Pages reads them from the repo
# root. With Git integration, the Pages project builds with
#
#   build command     npm run build:pages   (vendor, then stage into dist/)
#   output directory  dist
#
# A local deploy does the same by hand, from the repo root:
#
#   npm run build:pages
#   npx wrangler pages deploy dist --project-name <name>
#
# No bundler, no CDN, no new dependency. No deploy happens here.
set -eu

DEST="${1:-/tmp/eliza-pages-export}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

if [ -e "$DEST" ]; then
  echo "ERROR: destination already exists: $DEST" >&2
  exit 1
fi
mkdir -p "$DEST"

# Root files: the page, the Pages headers and routes, and robots.txt.
# package.json is NOT needed on Pages (no build step), version.json is unread
# by the page.
cp "$SRC/index.html" "$SRC/_headers" "$SRC/_routes.json" "$SRC/robots.txt" "$DEST/"

# Copy paths under $SRC into $DEST, keeping their layout. tar rather than
# rsync: the Cloudflare Pages build image does not list rsync, and every Linux
# image has tar. Extra arguments before the paths are tar --exclude options.
copy() {
  tar -C "$SRC" -cf - "$@" | tar -C "$DEST" -xf -
}

# Intro + paper UI. Test files stay home.
copy --exclude='*.test.js' app

# Modes 1 and 2, minus their node test dirs.
copy --exclude='modes/rewrite/test' --exclude='modes/port/test' \
  modes/rewrite modes/port

# Mode 4: engine + script + the complete local WASM encoder. A leftover jsep
# (WebGPU) runtime never ships. Everything else under vendor/
# rides along when present locally (library, manifest, family vectors,
# pinned model and WASM-device runtime), while the page still falls back to
# its bundled lexical index wherever a piece is missing.
copy \
  --exclude='modes/extended/test' \
  --exclude='modes/extended/vendor/ort/*.jsep.*' \
  modes/extended

# Mode 3: the worker, both versioned packed images and the card deck. The raw
# DASD containers stay home.
copy \
  modes/emulate/worker.js \
  modes/emulate/ctss-dasd.pack \
  modes/emulate/ctss-1966-dasd.pack \
  modes/emulate/cmd.cbn \
  modes/emulate/src \
  modes/emulate/unpack.js \
  modes/emulate/bridge.mjs

# Archive tapes the page reads.
copy data/scripts shared

# Font faces plus their stylesheet. Tooling (.venv), caches
# (__pycache__), the build script and dev artefacts (demo, specimens,
# strike lab, lockfiles) stay home.
copy $(cd "$SRC" && find font -maxdepth 1 -type f \( \
  -name '*.woff2' -o -name '*.ttf' -o -name 'font.css' \
  -o -name 'manifest.json' -o -name 'SOURCES.md' \) | sort)

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
