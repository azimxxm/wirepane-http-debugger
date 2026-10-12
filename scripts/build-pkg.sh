#!/usr/bin/env bash
# Builds the macOS installer: an unsigned .pkg for Apple Silicon Macs holding an ad-hoc signed
# Wirepane.app, plus the same app as a .zip. No Apple Developer account or certificate is needed
# (CLAUDE.md, "Distribution"). The macOS shortcut for scripts/build-release.sh mac, which does
# the work and prints where the files are (httptoolkit-desktop/dist/Wirepane-<version>-mac-arm64.pkg).
set -euo pipefail

exec "$(cd "$(dirname "$0")" && pwd)/build-release.sh" mac
