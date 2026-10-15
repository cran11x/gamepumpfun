#!/usr/bin/env bash
# AMONG RUGS brand build. Renders every export into brand/ (the parent folder of this script).
#   ./build.sh            render all PNGs + logo.svg
#   ./build.sh --retrace  also re-trace the logo die-cut (diecut.js) from logo.html#mask
#   ./build.sh --glyphs   also regenerate glyphs.js from Bungee (needs: pip install fonttools)
# Needs Node + the repo's Playwright (node_modules/playwright, Chromium preinstalled) and network
# access to Google Fonts (Bungee, Space Grotesk, JetBrains Mono). Python 3 + Pillow for the check sheets.
set -euo pipefail
cd "$(dirname "$0")"
OUT=..
TMP="${TMPDIR:-/tmp}/among-rugs-brand"; mkdir -p "$TMP"
for a in "$@"; do
  if [ "$a" = "--glyphs" ]; then
    curl -sS -o "$TMP/Bungee-Regular.ttf" "$(curl -sS 'https://fonts.googleapis.com/css2?family=Bungee' | grep -o 'https://[^)]*\.ttf' | head -1)"
    python3 make_glyphs.py "$TMP/Bungee-Regular.ttf" glyphs.js
  fi
  if [ "$a" = "--retrace" ]; then
    node render.mjs "logo.html#mask" 1024 1024 "$TMP/logo-mask.png" 1 2
    python3 trace_diecut.py "$TMP/logo-mask.png" 2 diecut.js
  fi
done
node render.mjs avatar.html 400 400 "$OUT/x-avatar-400.png"
node render.mjs banner.html 1500 500 "$OUT/x-banner-1500x500.png"
node render.mjs logo.html 1024 1024 "$OUT/logo-1024.png" 1 1 "$OUT/logo.svg"
node render.mjs "logo.html#bg=07090d" 1024 1024 "$OUT/logo-1024-dark.png"
node render.mjs og.html 1200 630 "$OUT/og-image-1200x630.png"
# verification sheets (written to $TMP): avatar at 96/48/32 + circle crop, banner safe zones, logo on 4 backgrounds
if python3 -c "import PIL" 2>/dev/null; then
  node render.mjs "avatar.html#art" 400 400 "$TMP/avatar-art.png" 1
  python3 avcheck.py "$TMP/check-avatar.png" "$OUT/x-avatar-400.png"
  python3 bmock.py "$OUT/x-banner-1500x500.png" "$OUT/x-avatar-400.png" "$TMP/check-banner.png"
  python3 logocheck.py "$OUT/logo-1024.png" "$TMP/check-logo.png"
  node svgcheck.mjs "$OUT/logo.svg" 1024 1024 "$TMP/check-logo-svg.png"
  echo "check sheets in $TMP"
fi
