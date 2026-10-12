#!/usr/bin/env bash
# Builds Wirepane's server release from our own source into build/server/httptoolkit-server. The
# desktop app ships that folder (httptoolkit-desktop/build-setup/wirepane-builder.config.cjs), where
# upstream would download the official httptoolkit-server release from GitHub.
#   1. lib/ (tsc), oclif.manifest.json and bundle/ (rspack), like upstream's build:release. The
#      bundle includes our Bruno packages and the dependencies they load from bruno/node_modules.
#   2. Node.js for the release, the version upstream's releases use (oclif.update.node.version),
#      downloaded once from nodejs.org, checked against its SHA-256 and cached in build/cache.
#   3. scripts/assemble-server.cjs lays out the release folder.
#   4. The result is started once in a throwaway folder, so a broken release fails here, not in the app.
# For Apple Silicon Macs only. ./scripts/build-pkg.sh runs it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$ROOT/httptoolkit-server"
OUT="$ROOT/build/server/httptoolkit-server"
CACHE="$ROOT/build/cache"
TARGET=darwin-arm64
START_TIMEOUT_SECONDS=60

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

[ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || fail "this builds the macOS arm64 server, run it on an Apple Silicon Mac"
[ -d "$SERVER/node_modules" ] || fail "httptoolkit-server is not installed yet. Run ./setup.sh first."

NODE_VERSION=$(node -p 'require(process.argv[1]).oclif.update.node.version' "$SERVER/package.json")
NODE_DIR="$CACHE/node-v$NODE_VERSION-$TARGET"

# With this set, rspack.config.js would upload the source maps to HTTP Toolkit's Sentry
unset SENTRY_AUTH_TOKEN

echo "==> Building the server (lib/, oclif manifest, bundle/)"
(cd "$SERVER" && npm run build:src && npm run build:manifest && npm run build:bundle) ||
  fail "building httptoolkit-server failed (see above)"

download_node() {
  local name="node-v$NODE_VERSION-$TARGET" download
  download=$(mktemp -d)
  echo "==> Downloading Node.js v$NODE_VERSION for $TARGET"
  curl -fsSL --retry 3 -o "$download/$name.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.xz" &&
    curl -fsSL --retry 3 -o "$download/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" ||
    fail "could not download Node.js v$NODE_VERSION from nodejs.org"
  (cd "$download" && grep "  $name.tar.xz\$" SHASUMS256.txt | shasum -a 256 -c -) ||
    fail "the Node.js download doesn't match its SHA-256 in SHASUMS256.txt"
  tar -xJf "$download/$name.tar.xz" -C "$download" "$name/bin/node" "$name/LICENSE"
  rm -rf "$NODE_DIR"
  mkdir -p "$CACHE"
  mv "$download/$name" "$NODE_DIR"
  rm -rf "$download"
}

if [ -x "$NODE_DIR/bin/node" ] && [ "$("$NODE_DIR/bin/node" --version)" = "v$NODE_VERSION" ]; then
  echo "==> Using the cached Node.js v$NODE_VERSION"
else
  download_node
fi

echo "==> Assembling the release"
node "$ROOT/scripts/assemble-server.cjs" "$SERVER" "$OUT" "$NODE_DIR"

# Starts the release with its own home, temp and config folders (so it touches none of yours, and
# its CLI socket doesn't replace a running dev server's), then checks that it answers the bundled
# UI's origin, refuses others, and shuts down.
check_release() {
  local tmp ports api_port admin_port token pid deadline origin_status
  # A short path: the CLI socket inside it has to fit the 104 character limit of macOS
  tmp=$(mktemp -d /tmp/wirepane-server-check.XXXXXX)
  mkdir -p "$tmp/home" "$tmp/tmp"
  ports=$(node -e '
    const net = require("net");
    const free = () => new Promise((resolve) => {
      const server = net.createServer().listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    });
    Promise.all([free(), free()]).then((ports) => console.log(ports.join(" ")));
  ')
  read -r api_port admin_port <<< "$ports"
  token=$(node -p 'require("crypto").randomBytes(20).toString("hex")')

  HOME="$tmp/home" TMPDIR="$tmp/tmp" HTK_SERVER_TOKEN="$token" \
    "$OUT/bin/httptoolkit-server" start --config "$tmp/config" \
    --server-port "$api_port" --mockttp-port "$admin_port" > "$tmp/server.log" 2>&1 &
  pid=$!

  deadline=$(( $(date +%s) + START_TIMEOUT_SECONDS ))
  until curl -sf -o /dev/null --max-time 5 -H "Origin: wirepane://app" \
    -H "Authorization: Bearer $token" "http://127.0.0.1:$api_port/version"; do
    if ! kill -0 "$pid" 2>/dev/null || [ "$(date +%s)" -ge "$deadline" ]; then
      kill "$pid" 2>/dev/null || true
      tail -30 "$tmp/server.log" >&2
      rm -rf "$tmp"
      fail "the built server did not start (log above)"
    fi
    sleep 1
  done

  origin_status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Origin: https://app.httptoolkit.tech" \
    -H "Authorization: Bearer $token" "http://127.0.0.1:$api_port/version")

  curl -s -o /dev/null --max-time 5 -X POST -H "Origin: wirepane://app" \
    -H "Authorization: Bearer $token" "http://127.0.0.1:$api_port/shutdown" || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -rf "$tmp"

  [ "$origin_status" = 403 ] || fail "the built server accepted another origin (HTTP $origin_status), it must only accept wirepane://app"
}

echo "==> Checking that the release starts"
check_release

echo "Server release: $OUT ($(du -sh "$OUT" | cut -f1), Node.js v$NODE_VERSION)"
