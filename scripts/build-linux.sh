#!/usr/bin/env bash
# Builds Wirepane's installers for Linux x64: .AppImage, .deb and .rpm (needs rpmbuild).
# A shortcut for scripts/build-release.sh linux, which does the work and lists the files it made.
set -euo pipefail

exec "$(cd "$(dirname "$0")" && pwd)/build-release.sh" linux
