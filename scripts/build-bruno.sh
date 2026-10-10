#!/usr/bin/env bash
# Installs and builds our copy of Bruno (bruno/, a git subtree of usebruno/bruno).
# httptoolkit-server depends on five of its packages through file: links:
#   bruno-lang, bruno-schema                          plain CommonJS, run straight from src/
#   bruno-common, bruno-converters, bruno-filestore   built with rollup into dist/
# Those packages load their own dependencies from bruno/node_modules, which this installs.
# Run it after cloning and after every Bruno sync (./setup.sh runs it for you).
# Re-runs skip the install and every build whose inputs haven't changed. --force redoes everything.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRUNO="$ROOT/bruno"
MIN_NODE_MAJOR=22 # Bruno's .nvmrc pins Node 22

# The workspaces the server uses. Installing only these leaves out the dependencies of
# Bruno's Electron app, web UI and CLI.
WORKSPACES=(bruno-common bruno-lang bruno-schema bruno-converters bruno-filestore)

# Build order. bruno-schema-types holds only TypeScript types (a devDependency of converters
# and filestore, never loaded by the server), but filestore's build type-checks against it
# and fails without it. Bruno's own scripts/setup.js builds it before filestore too.
BUILDS=(bruno-common bruno-schema-types bruno-converters bruno-filestore)

# --include-workspace-root: Bruno declares some build tools of these packages only in its root
# package.json (rimraf for the clean step before every build, @types/lodash-es for bruno-common's
# .d.ts build), so without the root's devDependencies `npm run build` fails. They add ~135 MB
# (ESLint, Playwright, Jest), but Bruno's build scripts then run exactly as upstream.
# --ignore-scripts: these packages need no install scripts, and the root's `prepare` (husky)
# would point our repo's git hooks at bruno/.husky.
NPM_CI_ARGS=(ci --include-workspace-root --ignore-scripts --no-audit --no-fund)
for workspace in "${WORKSPACES[@]}"; do
  NPM_CI_ARGS+=("--workspace=packages/$workspace")
done

INSTALL_STAMP="$BRUNO/node_modules/.wirepane-install-stamp"
BUILD_STAMP=.wirepane-build-stamp # written into each package's dist/

force=false
case "${1:-}" in
  "") ;;
  --force) force=true ;;
  *)
    echo "Usage: $0 [--force]" >&2
    exit 2
    ;;
esac

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

if command -v shasum >/dev/null 2>&1; then
  SHA256=(shasum -a 256)
else
  SHA256=(sha256sum)
fi

hash_stdin() {
  "${SHA256[@]}" | cut -d ' ' -f 1
}

# One checksum over the names and contents of the given files and folders (paths relative
# to bruno/, node_modules and dist skipped), so a stamp changes whenever an input changes
checksum() {
  (cd "$BRUNO" && find "$@" -type d \( -name node_modules -o -name dist \) -prune -o -type f -print0 |
    LC_ALL=C sort -z | xargs -0 "${SHA256[@]}") | hash_stdin
}

# True when the stamp file exists and holds the expected checksum
is_up_to_date() {
  local stamp_file=$1 expected=$2
  ! $force && [ -f "$stamp_file" ] && [ "$(cat "$stamp_file")" = "$expected" ]
}

install_dependencies() {
  local inputs=(package.json package-lock.json) workspace expected
  for workspace in "${WORKSPACES[@]}"; do
    inputs+=("packages/$workspace/package.json")
  done
  expected=$(printf '%s %s' "$(checksum "${inputs[@]}")" "${NPM_CI_ARGS[*]}" | hash_stdin)

  if is_up_to_date "$INSTALL_STAMP" "$expected"; then
    echo "==> Bruno dependencies are up to date"
    return
  fi

  echo "==> Installing Bruno dependencies for ${WORKSPACES[*]}"
  (cd "$BRUNO" && npm "${NPM_CI_ARGS[@]}") ||
    fail "npm ci failed in bruno/ (see above). Its package-lock.json must match the package.json files, as upstream."
  echo "$expected" >"$INSTALL_STAMP"
}

# A package is rebuilt when one of its files or the installed dependencies changed
build_package() {
  local package=$1
  local dist="$BRUNO/packages/$package/dist" expected
  expected=$(printf '%s %s' "$(checksum "packages/$package")" "$(cat "$INSTALL_STAMP")" | hash_stdin)

  if is_up_to_date "$dist/$BUILD_STAMP" "$expected"; then
    echo "==> $package is up to date"
    return
  fi

  echo "==> Building $package"
  (cd "$BRUNO" && npm run build --workspace="packages/$package") || fail "building $package failed (see above)"
  [ -d "$dist" ] || fail "building $package produced no dist/ folder"
  echo "$expected" >"$dist/$BUILD_STAMP"
}

# Loads every package the way the server does, so a broken build fails here and not on the
# first collections request
check_packages_load() {
  local dirs=() workspace
  for workspace in "${WORKSPACES[@]}"; do
    dirs+=("$BRUNO/packages/$workspace")
  done
  echo "==> Checking that the packages load"
  node -e 'for (const dir of process.argv.slice(1)) require(dir)' "${dirs[@]}" ||
    fail "a Bruno package failed to load (see above). Try: $0 --force"
}

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  fail "Node.js $MIN_NODE_MAJOR+ is required (found: $(node -v 2>/dev/null || echo none))"
fi
[ -f "$BRUNO/package-lock.json" ] || fail "bruno/package-lock.json is missing. Is the bruno/ subtree checked out?"

install_dependencies
for package in "${BUILDS[@]}"; do
  build_package "$package"
done
check_packages_load

echo "==> Bruno's packages are ready for httptoolkit-server"
