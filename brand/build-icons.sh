#!/usr/bin/env bash
# Builds every Wirepane icon and logo file from brand/icon.svg:
#   httptoolkit-desktop/src/icons/  icon.icns (macOS), icon.ico (Windows), icon.svg + icon.png (Linux, window)
#   httptoolkit-ui/src/images/      logo-icon.svg (sidebar, favicon), loading-logo.png (loading screen)
# Needs rsvg-convert (brew install librsvg), iconutil (macOS) and ./setup.sh (Electron renders the wordmark).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRAND="$ROOT/brand"
DESKTOP_ICONS="$ROOT/httptoolkit-desktop/src/icons"
UI_IMAGES="$ROOT/httptoolkit-ui/src/images"
ELECTRON="$ROOT/httptoolkit-desktop/node_modules/.bin/electron"

command -v rsvg-convert >/dev/null || { echo "ERROR: rsvg-convert is missing (brew install librsvg)" >&2; exit 1; }
[ -x "$ELECTRON" ] || { echo "ERROR: Electron is missing, run ./setup.sh first" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Renders brand/icon.svg as a square PNG: render <out.png> <size>
render() {
  rsvg-convert -w "$2" -h "$2" "$BRAND/icon.svg" -o "$1"
}

echo "==> macOS icon.icns"
ICONSET="$WORK/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  render "$ICONSET/icon_${size}x${size}.png" "$size"
  render "$ICONSET/icon_${size}x${size}@2x.png" $((size * 2))
done
iconutil -c icns -o "$DESKTOP_ICONS/icon.icns" "$ICONSET"

echo "==> Windows icon.ico"
ICO_SIZES=(16 24 32 48 64 128 256)
for size in "${ICO_SIZES[@]}"; do
  render "$WORK/ico-$size.png" "$size"
done
# An .ico file is a small header plus one PNG per size
python3 - "$DESKTOP_ICONS/icon.ico" "$WORK" "${ICO_SIZES[@]}" <<'PY'
import struct, sys
from pathlib import Path

out_path, work_dir, sizes = sys.argv[1], Path(sys.argv[2]), [int(s) for s in sys.argv[3:]]
images = [(size, (work_dir / f"ico-{size}.png").read_bytes()) for size in sizes]

offset = 6 + 16 * len(images)
entries, blobs = b"", b""
for size, data in images:
    dimension = 0 if size >= 256 else size  # 0 means 256 in the ICO format
    entries += struct.pack("<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(data), offset)
    blobs += data
    offset += len(data)

Path(out_path).write_bytes(struct.pack("<HHH", 0, 1, len(images)) + entries + blobs)
PY

echo "==> Linux icon.svg and icon.png"
cp "$BRAND/icon.svg" "$DESKTOP_ICONS/icon.svg"
render "$DESKTOP_ICONS/icon.png" 260

echo "==> UI logo-icon.svg (the icon cropped to its tile)"
sed 's/viewBox="0 0 1024 1024" width="1024" height="1024"/viewBox="100 100 824 824"/' \
  "$BRAND/icon.svg" > "$UI_IMAGES/logo-icon.svg"

echo "==> UI loading-logo.png"
"$ELECTRON" "$BRAND/render-wordmark.cjs" "$BRAND/wordmark.html" "$UI_IMAGES/loading-logo.png" 1200 184

echo "Done."
