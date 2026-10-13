#!/usr/bin/env bash
# Builds Wirepane's VPN helper, the Rust sidecar in wirepane-tunnel/, for one target into
# build/tunnel/<target>/wirepane-tunnel (wirepane-tunnel.exe on Windows). The desktop app ships that
# folder as Resources/wirepane-tunnel (httptoolkit-desktop/build-setup/wirepane-builder.config.cjs)
# and starts the server with WIREPANE_TUNNEL_BINPATH pointing at it (httptoolkit-desktop/src/index.ts).
#
# Usage: scripts/build-tunnel.sh [<target>]
#   target: darwin-arm64, darwin-x64 (Intel Macs), win32-x64 or linux-x64, this machine's by default.
#
#   target        Rust target                built here with
#   darwin-arm64  aarch64-apple-darwin       cargo, on a Mac (Apple's SDK builds for both CPUs)
#   darwin-x64    x86_64-apple-darwin        cargo, on a Mac
#   win32-x64     x86_64-pc-windows-msvc     cargo on Windows x64, cargo-xwin anywhere else
#   linux-x64     x86_64-unknown-linux-musl  cargo on Linux x64, cargo-zigbuild anywhere else
#
# Linux gets the static musl build, so the one binary runs from the AppImage, the .deb and the .rpm
# on any distribution, whatever its glibc. The Windows build links the C runtime in, so it starts on
# a PC without the Visual C++ Redistributable. A cross build is built and checked but not started,
# like scripts/build-server.sh does: scripts/build-tunnel.sh win32-x64 works on a Mac as a dry check
# (cargo-xwin also needs LLVM there for the dependencies' C code: brew install llvm). The Intel Mac
# helper is started on an Apple Silicon Mac too when Rosetta 2 is installed.
#
# WIREPANE_TUNNEL_CRATE=<folder> builds another crate than wirepane-tunnel/ (its binary has to be
# called wirepane-tunnel too), to try this script without the real one. Needs Rust (rustup.rs) with
# the target added: rustup target add <Rust target>. ./scripts/build-release.sh runs it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE=${WIREPANE_TUNNEL_CRATE:-$ROOT/wirepane-tunnel}
# One cargo output folder for all targets (cargo keeps each target's files apart), so a release
# build never touches the crate's own target/ that development builds use
CARGO_OUT="$ROOT/build/tunnel-cargo"
SUPPORTED_TARGETS="darwin-arm64 darwin-x64 win32-x64 linux-x64"
BINARY_NAME=wirepane-tunnel
RUN_CHECK_SECONDS=10

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

# This machine as a Node.js platform-arch pair, e.g. darwin-arm64
host_target() {
  local os arch
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN*) os=win32 ;;
    *) fail "unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) fail "unsupported CPU: $(uname -m)" ;;
  esac
  echo "$os-$arch"
}

HOST=$(host_target)
TARGET=${1:-$HOST}
case " $SUPPORTED_TARGETS " in
  *" $TARGET "*) ;;
  *) fail "unknown target '$TARGET', expected one of: $SUPPORTED_TARGETS" ;;
esac
TARGET_OS=${TARGET%-*}
TARGET_ARCH=${TARGET#*-}

# Whether this machine runs the target's programs: its own target, or an Intel Mac's on an Apple
# Silicon Mac with Rosetta 2 (arch -x86_64 fails when Rosetta isn't installed)
can_run_target() {
  [ "$HOST" = "$TARGET" ] ||
    { [ "$HOST" = darwin-arm64 ] && [ "$TARGET" = darwin-x64 ] && arch -x86_64 /usr/bin/true 2>/dev/null; }
}

case "$TARGET" in
  darwin-arm64) TRIPLE=aarch64-apple-darwin ;;
  darwin-x64) TRIPLE=x86_64-apple-darwin ;;
  win32-x64) TRIPLE=x86_64-pc-windows-msvc ;;
  linux-x64) TRIPLE=x86_64-unknown-linux-musl ;;
esac
BINARY=$BINARY_NAME
[ "$TARGET_OS" != win32 ] || BINARY=$BINARY_NAME.exe
OUT_DIR="$ROOT/build/tunnel/$TARGET"
OUT="$OUT_DIR/$BINARY"

[ -f "$CRATE/Cargo.toml" ] ||
  fail "the VPN helper's crate is missing: there is no Cargo.toml in $CRATE (it should be wirepane-tunnel/ in the repo)"
[ -f "$CRATE/Cargo.lock" ] ||
  fail "$CRATE has no Cargo.lock. Run cargo build in it once and commit the lock file, so a release builds the dependency versions that were tested."
command -v cargo >/dev/null 2>&1 ||
  fail "Rust is not installed (no cargo in PATH). Install it from https://rustup.rs and run this again."

# Plain cargo when the target is this machine's own OS, a cross tool otherwise. The array is never
# empty, which macOS's bash 3.2 needs under set -u.
if [ "$HOST" = "$TARGET" ]; then
  BUILD=(cargo build)
else
  case "$TARGET_OS" in
    win32)
      command -v cargo-xwin >/dev/null 2>&1 ||
        fail "building for $TARGET on $HOST needs cargo-xwin: cargo install --locked cargo-xwin"
      BUILD=(cargo xwin build)
      # C code in the dependencies (ring) is compiled with clang-cl and llvm-lib. Homebrew's LLVM is
      # keg-only, so look for it there when it isn't in PATH.
      have_llvm() { command -v clang-cl >/dev/null 2>&1 && command -v llvm-lib >/dev/null 2>&1; }
      if ! have_llvm; then
        for llvm_bin in /opt/homebrew/opt/llvm/bin /opt/homebrew/opt/llvm@*/bin /usr/local/opt/llvm/bin /usr/local/opt/llvm@*/bin; do
          if [ -x "$llvm_bin/clang-cl" ] && [ -x "$llvm_bin/llvm-lib" ]; then
            PATH="$llvm_bin:$PATH"
            break
          fi
        done
      fi
      have_llvm ||
        fail "building for $TARGET on $HOST needs LLVM (clang-cl and llvm-lib, for the dependencies' C code): brew install llvm"
      ;;
    linux)
      command -v cargo-zigbuild >/dev/null 2>&1 ||
        fail "building for $TARGET on $HOST needs cargo-zigbuild: cargo install --locked cargo-zigbuild"
      command -v zig >/dev/null 2>&1 ||
        fail "building for $TARGET on $HOST needs zig (cargo-zigbuild links with it): brew install zig"
      BUILD=(cargo zigbuild)
      ;;
    darwin)
      # The other Mac CPU: Apple's toolchain builds for both
      [ "${HOST%-*}" = darwin ] ||
        fail "the $TARGET helper has to be built on a Mac (this is $HOST): macOS programs need Apple's SDK"
      BUILD=(cargo build)
      ;;
  esac
fi

# rustup looks at the crate's folder (it may pin a toolchain there), so ask from inside it
if command -v rustup >/dev/null 2>&1; then
  installed=$(cd "$CRATE" && rustup target list --installed 2>/dev/null | tr -d '\r') || installed=
  grep -qx "$TRIPLE" <<< "$installed" ||
    fail "the Rust target $TRIPLE is not installed. Run: rustup target add $TRIPLE"
fi

if [ "$TARGET_OS" = win32 ]; then
  # Overrides any rustflags the crate sets for this target. Read by cargo-xwin as well.
  export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS="-C target-feature=+crt-static"
fi

echo "==> Building the VPN helper for $TARGET ($TRIPLE) from $CRATE"
# --locked: the dependencies stay at the versions in Cargo.lock. The cargo output folder goes in as
# an argument, not an environment variable, because Git Bash converts paths only in arguments.
(cd "$CRATE" && "${BUILD[@]}" --release --locked --bin "$BINARY_NAME" --target "$TRIPLE" --target-dir "$CARGO_OUT") ||
  fail "building the VPN helper failed (see above). If cargo says Cargo.lock needs an update: run cargo update --workspace in $CRATE and commit Cargo.lock."

BUILT="$CARGO_OUT/$TRIPLE/release/$BINARY"
[ -f "$BUILT" ] || fail "cargo finished, but $BUILT is missing. Is the crate's binary called $BINARY_NAME?"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp "$BUILT" "$OUT"
chmod +x "$OUT"
# Apple Silicon only runs signed code, and stripping or copying can leave the linker's signature
# invalid. electron-builder signs the helper again inside the app.
if [ "$TARGET_OS" = darwin ] && command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$OUT" 2>/dev/null || fail "could not ad-hoc sign the helper ($OUT)"
fi

# Reads the file's header: the program has to be for the target's OS and CPU
node -e '
  const fs = require("fs");
  const [file, wantOs, wantArch] = process.argv.slice(1);
  const fd = fs.openSync(file, "r");
  const read = (position, length) => {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, position);
    return buffer;
  };
  const head = read(0, 64);
  let found = "an unknown kind of file";
  if (head.readUInt32LE(0) === 0xfeedfacf) {
    // Mach-O, 64 bit
    const cpu = head.readUInt32LE(4);
    found = "darwin-" + (cpu === 0x0100000c ? "arm64" : cpu === 0x01000007 ? "x64" : "cpu " + cpu);
  } else if (head.toString("latin1", 0, 4) === "\x7fELF") {
    const machine = head.readUInt16LE(18);
    found = "linux-" + (machine === 0x3e ? "x64" : machine === 0xb7 ? "arm64" : "machine " + machine);
  } else if (head.toString("latin1", 0, 2) === "MZ") {
    const pe = read(head.readUInt32LE(0x3c), 6);
    const machine = pe.toString("latin1", 0, 4) === "PE\0\0" ? pe.readUInt16LE(4) : 0;
    found = "win32-" + (machine === 0x8664 ? "x64" : machine === 0xaa64 ? "arm64" : "machine " + machine);
  }
  if (found !== wantOs + "-" + wantArch) {
    console.error("is " + found + ", not " + wantOs + "-" + wantArch);
    process.exit(1);
  }
' "$OUT" "$TARGET_OS" "$TARGET_ARCH" || fail "the built helper is not a $TARGET program (see above)"

# On a target this machine runs (not Windows, where a background program is hard to stop from Git
# Bash) the helper is started once: macOS kills a program with a broken signature straight away, and
# a missing library shows as exit code 127. --help is only a way to start it: a program that keeps
# running past the time limit has started too, and is stopped.
if can_run_target && [ "$TARGET_OS" != win32 ]; then
  echo "==> Checking that the helper starts"
  check_dir=$(mktemp -d)
  "$OUT" --help < /dev/null > "$check_dir/output" 2>&1 &
  pid=$!
  deadline=$(( $(date +%s) + RUN_CHECK_SECONDS ))
  while kill -0 "$pid" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  else
    status=0
    wait "$pid" || status=$?
    # 126 and 127: it could not be run. Above 128: a signal ended it.
    if [ "$status" -ge 126 ]; then
      tail -c 600 "$check_dir/output" >&2
      rm -rf "$check_dir"
      fail "the built helper does not run (exit code $status)"
    fi
  fi
  rm -rf "$check_dir"
fi

echo "VPN helper: $OUT ($(du -h "$OUT" | cut -f1), $TRIPLE)"
