#!/usr/bin/env bash
# Builds Wirepane's installers for one OS from this repo, on that OS. Nothing is signed (CLAUDE.md,
# "Distribution"), so no certificates or accounts are needed.
#   scripts/build-release.sh mac     on an Apple Silicon Mac: .pkg and .zip (arm64)
#   scripts/build-release.sh win     on Windows x64, in Git Bash: NSIS installer .exe and .zip
#   scripts/build-release.sh linux   on Linux x64: .AppImage, .deb and .rpm (the .rpm needs rpmbuild)
# Steps:
#   1. Bruno's packages (scripts/build-bruno.sh, skips what is up to date)
#   2. the server release for this OS (scripts/build-server.sh)
#   3. the VPN helper, the Rust sidecar in wirepane-tunnel/ (scripts/build-tunnel.sh, needs Rust)
#   4. the UI production build, with no telemetry keys and no update service worker, then
#      build/ui with its API specs compressed (scripts/assemble-ui.cjs)
#   5. the desktop app and its installers (httptoolkit-desktop: npm run build), in
#      httptoolkit-desktop/dist
# Every run rebuilds steps 2-5 from the current code. File names carry Wirepane's version, the
# VERSION file at the repo root (or $WIREPANE_VERSION), e.g. Wirepane-1.0.0-mac-arm64.pkg.
# It ends by listing the files it made. .github/workflows/release.yml runs it on each OS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/httptoolkit-desktop"

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

usage() {
  echo "Usage: $0 <mac|win|linux>" >&2
  exit 2
}

[ $# -eq 1 ] || usage
platform=$1
os="$(uname -s)-$(uname -m)"
case "$platform" in
  mac)
    target=darwin-arm64
    [ "$os" = "Darwin-arm64" ] || fail "the mac build is for Apple Silicon, build it on an Apple Silicon Mac (this is $os)"
    ;;
  win)
    target=win32-x64
    case "$os" in
      MINGW*-x86_64 | MSYS*-x86_64 | CYGWIN*-x86_64) ;;
      *) fail "the Windows build has to run on Windows x64, in Git Bash (this is $os)" ;;
    esac
    ;;
  linux)
    target=linux-x64
    [ "$os" = "Linux-x86_64" ] || fail "the Linux build has to run on Linux x64 (this is $os)"
    command -v rpmbuild >/dev/null 2>&1 || fail "the .rpm needs rpmbuild: install the rpm package (e.g. sudo apt-get install rpm)"
    ;;
  *) usage ;;
esac

for repo in httptoolkit-server httptoolkit-ui httptoolkit-desktop; do
  [ -d "$ROOT/$repo/node_modules" ] || fail "$repo is not installed yet. Run ./setup.sh first."
done

version=${WIREPANE_VERSION:-$(tr -d '[:space:]' < "$ROOT/VERSION")}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
  fail "the version must look like 1.2.3, not '$version' (the VERSION file or WIREPANE_VERSION)"
# The UI (Settings > Status) and the desktop config read it from here
export WIREPANE_VERSION=$version

# Nothing in the app may report to outside services: build without the keys that would turn on
# Sentry, PostHog, source map uploads or CSP reports, even if this shell has them set
unset SENTRY_DSN SENTRY_AUTH_TOKEN POSTHOG_KEY REPORT_URI ACCOUNTS_API

echo "==> Building Wirepane $version for $platform ($target)"
"$ROOT/scripts/build-bruno.sh"
"$ROOT/scripts/build-server.sh" "$target"
# Before the long UI build, so a Rust problem shows up early
"$ROOT/scripts/build-tunnel.sh" "$target"

echo "==> Building the UI (httptoolkit-ui/dist)"
# Shown as the UI version in the app, e.g. 27a9f71fd or 27a9f71fd-dirty
ui_version=$(git -C "$ROOT" describe --always --dirty 2>/dev/null || echo unknown)
# DISABLE_UPDATES: the UI comes with the app, so no update service worker (automation/webpack.prod.ts)
(cd "$ROOT/httptoolkit-ui" && DISABLE_UPDATES=true UI_VERSION="$ui_version" npm run build) ||
  fail "the UI build failed (see above)"
node "$ROOT/scripts/assemble-ui.cjs" "$ROOT/httptoolkit-ui/dist" "$ROOT/build/ui"

echo "==> Building the desktop app and its installers (httptoolkit-desktop/dist)"
# Only this build's files in dist/, so nothing stale gets uploaded with them
rm -rf "$DESKTOP/dist"
(cd "$DESKTOP" && WIREPANE_SERVER_TARGET="$target" npm run build) || fail "the desktop build failed (see above)"

case "$platform" in
  mac) artifacts=("mac-arm64.pkg" "mac-arm64.zip") ;;
  win) artifacts=("win-x64-setup.exe" "win-x64.zip") ;;
  linux) artifacts=("linux-x86_64.AppImage" "linux-amd64.deb" "linux-x86_64.rpm") ;;
esac

echo
echo "Done:"
for artifact in "${artifacts[@]}"; do
  file="$DESKTOP/dist/Wirepane-$version-$artifact"
  [ -f "$file" ] || fail "the desktop build finished, but $file is missing"
  echo "  $file ($(du -h "$file" | cut -f1))"
done
case "$platform" in
  mac) echo "Install the .pkg with a double-click. Downloaded copies are blocked on the first open: right-click > Open, or System Settings > Privacy & Security > Open Anyway." ;;
  win) echo "Run the setup .exe. SmartScreen warns about unsigned apps: More info > Run anyway." ;;
  linux) echo "Install the .deb or .rpm, or chmod +x the .AppImage and run it." ;;
esac
