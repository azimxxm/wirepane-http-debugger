#!/usr/bin/env bash
# Builds Wirepane's installers for Apple Silicon Macs (arm64): .pkg and .zip.
# A shortcut for scripts/build-release.sh mac, which does the work and lists the files it made.
set -euo pipefail

exec "$(cd "$(dirname "$0")" && pwd)/build-release.sh" mac
