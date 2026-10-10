#!/usr/bin/env bash
# Pulls the latest upstream code into this repo (git subtree, one squashed commit per folder):
# HTTP Toolkit's server, UI and desktop app, plus Bruno (its packages power collections & sharing).
# Needs a clean working tree. Your own changes are kept, conflicts are fixed like in a normal git merge.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
UPSTREAM_BRANCH=main
# "<folder in this repo> <upstream git URL>"
SUBTREES=(
  "httptoolkit-server https://github.com/httptoolkit/httptoolkit-server.git"
  "httptoolkit-ui https://github.com/httptoolkit/httptoolkit-ui.git"
  "httptoolkit-desktop https://github.com/httptoolkit/httptoolkit-desktop.git"
  "bruno https://github.com/usebruno/bruno.git"
)

cd "$ROOT"
for entry in "${SUBTREES[@]}"; do
  read -r prefix url <<< "$entry"
  echo "==> Syncing $prefix with $url"
  git subtree pull --prefix="$prefix" "$url" "$UPSTREAM_BRANCH" --squash \
    -m "synced $prefix with upstream"
done

echo "Done. Run ./setup.sh to update dependencies, then ./start.sh"
