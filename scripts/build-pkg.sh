#!/usr/bin/env bash
# Builds the Wirepane installer from this repo: an unsigned .pkg for Apple Silicon Macs that holds an
# ad-hoc signed Wirepane.app. No Apple Developer account or certificate is needed (CLAUDE.md,
# "Distribution"). Steps:
#   1. Bruno's packages (scripts/build-bruno.sh, skips what is up to date)
#   2. the server release from httptoolkit-server (scripts/build-server.sh)
#   3. the UI production build, with no telemetry keys and no update service worker
#   4. the desktop app, Wirepane.app and the .pkg (httptoolkit-desktop: npm run build)
# Every run rebuilds steps 2-4 from the current code. It prints where the .pkg is.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/httptoolkit-desktop"

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

[ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || fail "the .pkg is for Apple Silicon Macs, build it on one"
for repo in httptoolkit-server httptoolkit-ui httptoolkit-desktop; do
  [ -d "$ROOT/$repo/node_modules" ] || fail "$repo is not installed yet. Run ./setup.sh first."
done

# Nothing in the app may report to outside services: build without the keys that would turn on
# Sentry, PostHog, source map uploads or CSP reports, even if this shell has them set
unset SENTRY_DSN SENTRY_AUTH_TOKEN POSTHOG_KEY REPORT_URI ACCOUNTS_API

"$ROOT/scripts/build-bruno.sh"
"$ROOT/scripts/build-server.sh"

echo "==> Building the UI (httptoolkit-ui/dist)"
# Shown as the UI version in the app, e.g. 27a9f71fd or 27a9f71fd-dirty
ui_version=$(git -C "$ROOT" describe --always --dirty 2>/dev/null || echo unknown)
# DISABLE_UPDATES: the UI comes with the app, so no update service worker (automation/webpack.prod.ts)
(cd "$ROOT/httptoolkit-ui" && DISABLE_UPDATES=true UI_VERSION="$ui_version" npm run build) ||
  fail "the UI build failed (see above)"

echo "==> Building Wirepane.app and the .pkg (httptoolkit-desktop/dist)"
(cd "$DESKTOP" && npm run build) || fail "the desktop build failed (see above)"

version=$(node -p 'require(process.argv[1]).version' "$DESKTOP/package.json")
pkg="$DESKTOP/dist/Wirepane-$version-arm64.pkg"
[ -f "$pkg" ] || fail "the desktop build finished, but $pkg is missing"

echo
echo "Done: $pkg ($(du -h "$pkg" | cut -f1))"
echo "Install it with a double-click. Downloaded copies are blocked on the first open:"
echo "right-click > Open, or System Settings > Privacy & Security > Open Anyway."
