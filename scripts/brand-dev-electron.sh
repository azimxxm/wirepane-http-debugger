#!/usr/bin/env bash
# Dev mode runs the stock Electron.app from node_modules, so macOS shows "Electron" and the Electron
# icon in the Dock, the app switcher and the app menu. This renames that bundle to Wirepane and gives
# it our icon. start.sh runs it before every launch: it's quick when there's nothing to change, and
# it puts the branding back after npm ci reinstalls Electron.
set -euo pipefail

[ "$(uname)" = "Darwin" ] || exit 0

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/httptoolkit-desktop/node_modules/electron/dist/Electron.app"
PLIST="$APP/Contents/Info.plist"
ICON="$ROOT/httptoolkit-desktop/src/icons/icon.icns"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

[ -d "$APP" ] || { echo "brand-dev-electron: $APP is missing, run ./setup.sh first" >&2; exit 1; }

set_plist_name() {
  /usr/libexec/PlistBuddy -c "Set :$1 Wirepane" "$PLIST" 2>/dev/null ||
    /usr/libexec/PlistBuddy -c "Add :$1 string Wirepane" "$PLIST"
}

changed=false

for key in CFBundleName CFBundleDisplayName; do
  if [ "$(/usr/libexec/PlistBuddy -c "Print :$key" "$PLIST" 2>/dev/null)" != "Wirepane" ]; then
    set_plist_name "$key"
    changed=true
  fi
done

if ! cmp -s "$ICON" "$APP/Contents/Resources/electron.icns"; then
  cp "$ICON" "$APP/Contents/Resources/electron.icns"
  changed=true
fi

if $changed; then
  # Editing the bundle breaks its ad hoc signature, which Apple Silicon requires, so sign it again
  codesign --force --sign - "$APP" >/dev/null 2>&1
  # Make the Dock and Finder notice the new name and icon
  touch "$APP"
  "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true
  echo "Branded the dev Electron app as Wirepane"
fi
