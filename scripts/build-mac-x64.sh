#!/usr/bin/env bash
# Builds Wirepane's installers for Intel Macs (x64): .pkg and .zip. On an Apple Silicon Mac it needs Rosetta 2.
# A shortcut for scripts/build-release.sh mac-x64, which does the work and lists the files it made.
set -euo pipefail

exec "$(cd "$(dirname "$0")" && pwd)/build-release.sh" mac-x64
