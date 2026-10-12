#!/usr/bin/env bash
# Builds Wirepane's server release from our own source into build/server/<target>/httptoolkit-server.
# The desktop app ships that folder (httptoolkit-desktop/build-setup/wirepane-builder.config.cjs),
# where upstream would download the official httptoolkit-server release from GitHub.
#   1. lib/ (tsc), oclif.manifest.json and bundle/ (rspack), like upstream's build:release. The
#      bundle includes our Bruno packages and the dependencies they load from bruno/node_modules.
#   2. Node.js for the release, the version upstream's releases use (oclif.update.node.version):
#      downloaded once per OS from nodejs.org, checked against its SHA-256 and cached in build/cache.
#   3. The release's node_modules, only what the bundle can't hold (oclif.dependenciesToPackage:
#      oclif, the native modules): npm ci in build/server-deps/<target> with that Node.js and its
#      npm, at the versions in httptoolkit-server/package-lock.json (scripts/stage-server-deps.cjs),
#      then each native module's prebuilt binary for the target. The system Node.js isn't used, so
#      tls-impersonate (needs Node.js 24.19+) is always there.
#   4. scripts/assemble-server.cjs lays out the release folder and checks every native binary.
#   5. When the target is this machine, the release is started once in a throwaway folder, has to
#      read and import a collection, and is stopped, so a broken release fails here, not in the app.
# Usage: scripts/build-server.sh [<target>]
#   target: darwin-arm64, win32-x64 or linux-x64, this machine's by default. Another target is
#   assembled and checked but not started. Runs in macOS, Linux and Git Bash on Windows.
# ./scripts/build-release.sh runs it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$ROOT/httptoolkit-server"
CACHE="$ROOT/build/cache"
SUPPORTED_TARGETS="darwin-arm64 win32-x64 linux-x64"
START_TIMEOUT_SECONDS=60

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
OUT="$ROOT/build/server/$TARGET/httptoolkit-server"
DEPS="$ROOT/build/server-deps/$TARGET"

[ -d "$SERVER/node_modules" ] || fail "httptoolkit-server is not installed yet. Run ./setup.sh first."

NODE_VERSION=$(node -p 'require(process.argv[1]).oclif.update.node.version' "$SERVER/package.json")

if command -v sha256sum >/dev/null 2>&1; then
  SHA256_CHECK=(sha256sum -c -)
else
  SHA256_CHECK=(shasum -a 256 -c -)
fi

# With this set, rspack.config.js would upload the source maps to HTTP Toolkit's Sentry
unset SENTRY_AUTH_TOKEN

echo "==> Building the server (lib/, oclif manifest, bundle/)"
(cd "$SERVER" && npm run build:src && npm run build:manifest && npm run build:bundle) ||
  fail "building httptoolkit-server failed (see above)"

# nodejs.org's names: node-v24.19.0-darwin-arm64.tar.xz, -linux-x64.tar.xz, -win-x64.zip
node_dist_name() {
  case "$1" in
    win32-*) echo "node-v$NODE_VERSION-win-${1#win32-}" ;;
    *) echo "node-v$NODE_VERSION-$1" ;;
  esac
}

# Paths inside an extracted Node.js download: <target> <folder>
node_binary() {
  case "$1" in
    win32-*) echo "$2/node.exe" ;;
    *) echo "$2/bin/node" ;;
  esac
}
npm_cli() {
  case "$1" in
    win32-*) echo "$2/node_modules/npm/bin/npm-cli.js" ;;
    *) echo "$2/lib/node_modules/npm/bin/npm-cli.js" ;;
  esac
}

extract_zip() {
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$1" -d "$2"
  elif command -v 7z >/dev/null 2>&1; then
    7z x -y -bd -o"$2" "$1" >/dev/null
  else
    powershell.exe -NoProfile -NonInteractive -Command \
      "Expand-Archive -LiteralPath '$(cygpath -w "$1")' -DestinationPath '$(cygpath -w "$2")'"
  fi
}

# Prints the folder of Node.js for a target, downloading it into the cache first if needed.
# Progress goes to stderr.
fetch_node() {
  local target=$1 name dir archive download
  name=$(node_dist_name "$target")
  dir="$CACHE/$name"
  if [ -f "$(node_binary "$target" "$dir")" ] && [ -f "$(npm_cli "$target" "$dir")" ] && [ -f "$dir/LICENSE" ]; then
    echo "==> Using the cached Node.js v$NODE_VERSION for $target" >&2
    echo "$dir"
    return
  fi

  case "$target" in
    win32-*) archive="$name.zip" ;;
    *) archive="$name.tar.xz" ;;
  esac
  download=$(mktemp -d)
  echo "==> Downloading Node.js v$NODE_VERSION for $target" >&2
  curl -fsSL --retry 3 -o "$download/$archive" "https://nodejs.org/dist/v$NODE_VERSION/$archive" &&
    curl -fsSL --retry 3 -o "$download/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" ||
    fail "could not download Node.js v$NODE_VERSION from nodejs.org"
  (cd "$download" && grep "  $archive\$" SHASUMS256.txt | "${SHA256_CHECK[@]}") >&2 ||
    fail "the Node.js download doesn't match its SHA-256 in SHASUMS256.txt"
  # Node.js itself, its license and npm (for installing the release's node_modules)
  case "$target" in
    win32-*) extract_zip "$download/$archive" "$download" ;;
    *) tar -xJf "$download/$archive" -C "$download" "$name/bin/node" "$name/LICENSE" "$name/lib/node_modules/npm" ;;
  esac
  rm -rf "$dir"
  mkdir -p "$CACHE"
  mv "$download/$name" "$dir"
  rm -rf "$download"
  echo "$dir"
}

RELEASE_NODE_DIR=$(fetch_node "$TARGET")
# npm runs with this machine's Node.js of the same version
if [ "$HOST" = "$TARGET" ]; then
  HOST_NODE_DIR=$RELEASE_NODE_DIR
else
  HOST_NODE_DIR=$(fetch_node "$HOST")
fi
HOST_NODE=$(node_binary "$HOST" "$HOST_NODE_DIR")
HOST_NODE_BIN_DIR=$(dirname "$HOST_NODE")
NPM=("$HOST_NODE" "$(npm_cli "$HOST" "$HOST_NODE_DIR")")

# The native modules among the release's dependencies, and how each gets its binary for a target.
# A new one (e.g. after an upstream sync) fails the build until it's added here.
#   node-datachannel   prebuild-install downloads the target's binary (its install script)
#   registry-js        the same, for Windows only: it loads its binary only there
#   tls-impersonate,   ship prebuilt binaries for every OS inside the package (prebuilds/), so
#   win-version-info   no install script is needed
KNOWN_NATIVE_MODULES=" node-datachannel registry-js tls-impersonate win-version-info "
NATIVE_MODULES_TO_FETCH="node-datachannel"
[ "$TARGET_OS" != win32 ] || NATIVE_MODULES_TO_FETCH="$NATIVE_MODULES_TO_FETCH registry-js"

echo "==> Installing the release's node_modules for $TARGET (Node.js v$NODE_VERSION)"
rm -rf "$DEPS"
scripted=$(node "$ROOT/scripts/stage-server-deps.cjs" "$SERVER" "$DEPS") ||
  fail "could not stage the release's dependencies (see above)"
for package in $scripted; do
  case "$KNOWN_NATIVE_MODULES" in
    *" $package "*) ;;
    *) fail "$package has an install script (a new native module?). Decide in scripts/build-server.sh how it gets its binary for each target." ;;
  esac
done
# --ignore-scripts: install scripts build or download binaries for this machine, not the target
(cd "$DEPS" && PATH="$HOST_NODE_BIN_DIR:$PATH" "${NPM[@]}" ci --ignore-scripts --no-audit --no-fund) ||
  fail "npm ci of the release's dependencies failed (see above)"

echo "==> Getting the $TARGET binaries of $NATIVE_MODULES_TO_FETCH"
# prebuild-install and node-gyp-build read the target from these, as in upstream's build-release.sh.
# The module names have no spaces, so the list is split into arguments on purpose.
# shellcheck disable=SC2086
(cd "$DEPS" &&
  PATH="$HOST_NODE_BIN_DIR:$PATH" \
    npm_config_platform="$TARGET_OS" npm_config_arch="$TARGET_ARCH" \
    npm_config_target_platform="$TARGET_OS" npm_config_target_arch="$TARGET_ARCH" \
    "${NPM[@]}" rebuild $NATIVE_MODULES_TO_FETCH --foreground-scripts --no-audit --no-fund) ||
  fail "getting the native modules' binaries for $TARGET failed (see above)"

echo "==> Assembling the release"
node "$ROOT/scripts/assemble-server.cjs" "$SERVER" "$OUT" "$RELEASE_NODE_DIR" "$TARGET" "$DEPS"

# A tiny collection in Bruno's folder format, for the release check: reading it runs the bundled
# Bruno packages (the .bru parser), which only work if the bundle resolved their dependencies
# like Node does. Its id has to be a Bruno uid (21 letters and digits).
CHECK_COLLECTION_ID=WirepaneReleaseCheck1
write_check_collection() {
  local dir="$1/collections/$CHECK_COLLECTION_ID"
  mkdir -p "$dir/Things" "$dir/environments"
  printf '%s\n' '{ "version": "1", "name": "Release check", "type": "collection", "ignore": ["node_modules", ".git"] }' > "$dir/bruno.json"
  printf '%s\n' 'meta {' '  name: Release check' '}' '' 'auth {' '  mode: none' '}' '' 'docs {' '  Checks that a release reads .bru files.' '}' > "$dir/collection.bru"
  printf '%s\n' 'meta {' '  name: Things' '  seq: 1' '}' > "$dir/Things/folder.bru"
  printf '%s\n' 'meta {' '  name: Get thing' '  type: http' '  seq: 1' '}' '' 'get {' '  url: {{baseUrl}}/things/1' '  body: none' '  auth: inherit' '}' > "$dir/Things/Get thing.bru"
  printf '%s\n' 'vars {' '  baseUrl: http://localhost:1234' '}' > "$dir/environments/Local.bru"
}
# A Postman v2.1 collection, to check the bundled converters through an import
CHECK_POSTMAN_JSON='{"info":{"name":"Release check import","schema":"https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},"item":[{"name":"Get thing","request":{"method":"GET","url":"http://localhost:1234/things/1"}}]}'

# Checks a JSON API answer on stdin with a JavaScript condition on `answer`: <condition> <what>.
# MSYS2_ARG_CONV_EXCL: Git Bash on Windows would otherwise rewrite arguments that look like paths.
expect_answer() {
  MSYS2_ARG_CONV_EXCL='*' node -e '
    let input = "";
    process.stdin.on("data", (data) => (input += data)).on("end", () => {
      let answer;
      try { answer = JSON.parse(input); } catch (e) { answer = { error: { message: "not JSON: " + input.slice(0, 300) } }; }
      if (!new Function("answer", "return " + process.argv[1])(answer)) {
        console.error(process.argv[2] + " failed:", JSON.stringify(answer).slice(0, 1500));
        process.exit(1);
      }
    });
  ' "$1" "$2"
}

# Starts the release with its own home, temp and config folders (so it touches none of yours, and
# its CLI socket doesn't replace a running app's), then checks that it answers the bundled UI's
# origin, refuses others, reads and imports collections, and shuts down.
check_release() {
  local tmp ports api_port admin_port token pid deadline origin_status launcher release_node body
  # A short path: the CLI socket inside it has to fit the 104 character limit of macOS
  tmp=$(mktemp -d /tmp/wirepane-server-check.XXXXXX)
  mkdir -p "$tmp/home" "$tmp/tmp" "$tmp/config"
  write_check_collection "$tmp/config"
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
  if [ "$TARGET_OS" = win32 ]; then
    launcher="$OUT/bin/httptoolkit-server.cmd"
    release_node="$OUT/bin/node.exe"
  else
    launcher="$OUT/bin/httptoolkit-server"
    release_node="$OUT/bin/node"
  fi

  stop_server() {
    curl -s -o /dev/null --max-time 5 -X POST -H "Origin: wirepane://app" \
      -H "Authorization: Bearer $token" "http://127.0.0.1:$api_port/shutdown" || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      # On Windows the launcher runs node.exe through cmd.exe, so stop the whole tree
      if [ "$TARGET_OS" = win32 ] && [ -r "/proc/$pid/winpid" ]; then
        taskkill //F //T //PID "$(cat "/proc/$pid/winpid")" >/dev/null 2>&1 || true
      fi
      kill "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  }
  check_failed() {
    stop_server
    tail -30 "$tmp/server.log" >&2
    rm -rf "$tmp"
    fail "$1"
  }

  # Resolved exactly as the bundle does (upstream's test/distributables-test/unix.sh)
  echo "Checking that TLS fingerprint mirroring (tls-impersonate) loads with the release's Node.js"
  "$release_node" -e '
    const tls = require(require.resolve("tls-impersonate", { paths: [process.argv[1]] }));
    if (!tls.isSupported()) { console.error("tls-impersonate loads, but says it is unsupported"); process.exit(1); }
  ' "$OUT/bundle" || fail "tls-impersonate doesn't load in the release (needed for TLS fingerprint mirroring)"

  HOME="$tmp/home" TMPDIR="$tmp/tmp" HTK_SERVER_TOKEN="$token" \
    "$launcher" start --config "$tmp/config" \
    --server-port "$api_port" --mockttp-port "$admin_port" > "$tmp/server.log" 2>&1 &
  pid=$!

  deadline=$(( $(date +%s) + START_TIMEOUT_SECONDS ))
  until curl -sf -o /dev/null --max-time 5 -H "Origin: wirepane://app" \
    -H "Authorization: Bearer $token" "http://127.0.0.1:$api_port/version"; do
    if ! kill -0 "$pid" 2>/dev/null || [ "$(date +%s)" -ge "$deadline" ]; then
      check_failed "the built server did not start (log above)"
    fi
    sleep 1
  done

  origin_status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Origin: https://app.httptoolkit.tech" \
    -H "Authorization: Bearer $token" "http://127.0.0.1:$api_port/version")
  [ "$origin_status" = 403 ] ||
    check_failed "the built server accepted another origin (HTTP $origin_status), it must only accept wirepane://app"

  echo "Checking that the release reads a .bru collection and imports a Postman one"
  curl -s --max-time 30 -H "Origin: wirepane://app" -H "Authorization: Bearer $token" \
    "http://127.0.0.1:$api_port/collections/$CHECK_COLLECTION_ID" |
    expect_answer '!answer.error && answer.warnings.length === 0 && answer.collection.environments.length === 1 &&
      answer.collection.items.flatMap((item) => item.items || [item]).length === 1' "Reading the check collection" ||
    check_failed "the built server can't read .bru collections"
  body=$(MSYS2_ARG_CONV_EXCL='*' node -p 'JSON.stringify({ fileName: "check.postman_collection.json", content: process.argv[1] })' "$CHECK_POSTMAN_JSON")
  curl -s --max-time 30 -X POST -H "Origin: wirepane://app" -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" --data-binary "$body" "http://127.0.0.1:$api_port/collections/import" |
    expect_answer '!answer.error && answer.format === "postman" && !!answer.collection' "Importing the Postman check collection" ||
    check_failed "the built server can't import Postman collections"

  stop_server
  rm -rf "$tmp"
}

if [ "$HOST" = "$TARGET" ]; then
  echo "==> Checking that the release starts"
  check_release
else
  echo "==> Not starting the release: it's for $TARGET, and this machine is $HOST"
fi

echo "Server release: $OUT ($(du -sh "$OUT" | cut -f1), Node.js v$NODE_VERSION)"
