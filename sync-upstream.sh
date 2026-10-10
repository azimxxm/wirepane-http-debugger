#!/usr/bin/env bash
# Pulls the latest upstream HTTP Toolkit code into this repo (git subtree, one squashed commit per repo).
# Needs a clean working tree. Your own changes are kept, conflicts are fixed like in a normal git merge.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
UPSTREAM_URL="https://github.com/httptoolkit"
UPSTREAM_BRANCH=main
REPOS=(httptoolkit-server httptoolkit-ui httptoolkit-desktop)

cd "$ROOT"
for repo in "${REPOS[@]}"; do
  echo "==> Syncing $repo with $UPSTREAM_URL/$repo"
  git subtree pull --prefix="$repo" "$UPSTREAM_URL/$repo.git" "$UPSTREAM_BRANCH" --squash \
    -m "synced $repo with upstream"
done

echo "Done. Run ./setup.sh to update dependencies, then ./start.sh"
