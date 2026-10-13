#!/usr/bin/env bash
# Builds Wirepane's installers for Windows x64, in Git Bash: setup .exe and .zip.
# A shortcut for scripts/build-release.sh win, which does the work and lists the files it made.
set -euo pipefail

exec "$(cd "$(dirname "$0")" && pwd)/build-release.sh" win
