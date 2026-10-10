#!/usr/bin/env bash
# Installs dependencies for the server, UI and desktop app.
# Run it once after cloning, and again when a package-lock.json changes (e.g. after ./sync-upstream.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
REPOS=(httptoolkit-server httptoolkit-ui httptoolkit-desktop)
MIN_NODE_MAJOR=22 # httptoolkit-desktop needs Node 22+

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  echo "ERROR: Node.js $MIN_NODE_MAJOR+ is required (found: $(node -v 2>/dev/null || echo none))" >&2
  exit 1
fi

# The UI uses puppeteer 5 only for its integration tests, and that version has no
# Chromium download for Apple Silicon, so npm ci fails without this. The app itself doesn't need it.
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1

for repo in "${REPOS[@]}"; do
  echo "==> Installing dependencies: $repo"
  (cd "$ROOT/$repo" && npm ci --no-audit --no-fund)
done

echo "Done. Start the app with ./start.sh"
