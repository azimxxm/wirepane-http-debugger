#!/usr/bin/env bash
# Installs dependencies for the server, UI and desktop app, after building the Bruno
# packages the server runs from bruno/ (scripts/build-bruno.sh). Last, it builds the VPN helper
# (wirepane-tunnel/, Rust) when Rust is installed, so VPN mode works in ./start.sh.
# Run it once after cloning, and again when a package-lock.json changes (e.g. after ./sync-upstream.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REPOS=(httptoolkit-server httptoolkit-ui httptoolkit-desktop)
MIN_NODE_MAJOR=22 # httptoolkit-desktop and Bruno need Node 22+

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  echo "ERROR: Node.js $MIN_NODE_MAJOR+ is required (found: $(node -v 2>/dev/null || echo none))" >&2
  exit 1
fi

# httptoolkit-server depends on bruno/packages through file: links, so those are built first
# (build-bruno.sh skips whatever is already up to date)
"$ROOT/scripts/build-bruno.sh"

# The UI uses puppeteer 5 only for its integration tests, and that version has no
# Chromium download for Apple Silicon, so npm ci fails without this. The app itself doesn't need it.
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1

for repo in "${REPOS[@]}"; do
  echo "==> Installing dependencies: $repo"
  (cd "$ROOT/$repo" && npm ci --no-audit --no-fund)
done

# VPN mode runs on a small Rust helper, wirepane-tunnel/, which the dev server finds in its
# target/release folder. Everything else works without it, so a missing Rust or a failed build
# only leaves VPN mode off: this function never makes setup fail.
build_vpn_helper() {
  local crate="$ROOT/wirepane-tunnel"

  # The release workflow builds the helper for each installer itself (scripts/build-tunnel.sh),
  # so a dev build there would only compile everything twice
  if [ "${CI:-}" = "true" ]; then
    echo "==> Skipping the VPN helper in CI: scripts/build-tunnel.sh builds the one the installers ship"
    return 0
  fi

  if ! command -v cargo >/dev/null 2>&1; then
    echo "==> VPN mode stays off until Rust is installed: get it from https://rustup.rs, open a new terminal and run ./setup.sh again"
    return 0
  fi

  # cargo knows what changed (sources, Cargo.lock, toolchain) and finishes in a second when
  # nothing did. --locked keeps the dependencies at the versions in Cargo.lock that were tested.
  # --target-dir puts the helper where the server looks, even if CARGO_TARGET_DIR is set.
  echo "==> Building the VPN helper (the first build takes a few minutes, later runs skip what is up to date)"
  if ! (cd "$crate" && cargo build --release --locked --target-dir "$crate/target"); then
    echo "WARNING: building the VPN helper failed (see above), so VPN mode stays off. The rest of Wirepane is ready." >&2
    echo "If cargo says it needs a newer rustc: rustup update stable. Then run ./setup.sh again." >&2
  fi
}

build_vpn_helper

echo "Done. Start the app with ./start.sh"
