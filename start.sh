#!/usr/bin/env bash
# Runs Wirepane from local source as one app:
#   httptoolkit-server  -> API on :45457, Mockttp admin on :45456 (restarts on code changes)
#   httptoolkit-ui      -> webpack dev server on :8080 (hot reload)
#   httptoolkit-desktop -> Electron window that loads the local UI
# Quitting the app (Cmd+Q) or pressing Ctrl+C stops everything.
# Extra arguments go to Electron, e.g. ./start.sh --remote-debugging-port=9222
# ./start.sh --no-window runs only the server and the UI, with no app window on screen: for
# headless browser checks while someone else uses the Mac. Ctrl+C or a kill stops them.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT/logs"
SERVER_PORT=45457  # desktop dev mode (HTK_DEV) always talks to these two ports
MOCKTTP_PORT=45456
UI_PORT=8080
UI_URL="http://localhost:$UI_PORT"
SERVER_TIMEOUT_SECONDS=60
UI_TIMEOUT_SECONDS=300 # the first UI build can take a few minutes
# In dev mode the desktop app spawns this placeholder instead of a real server
# (created by httptoolkit-desktop/build-setup/skip-server.ts)
DESKTOP_DEV_STUB="$ROOT/httptoolkit-desktop/httptoolkit-server/bin/httptoolkit-server"

background_pids=()

fail() {
  echo "ERROR: $1" >&2
  exit 1
}

# Prints a pid and all of its descendants
process_tree() {
  local pid=$1 child
  echo "$pid"
  for child in $(pgrep -P "$pid"); do process_tree "$child"; done
}

# Collect the whole tree before killing, so children can't get re-parented on the way
stop_process_tree() {
  local pids
  pids=$(process_tree "$1")
  kill -TERM $pids 2>/dev/null || true
}

cleanup() {
  trap - EXIT
  local pid
  for pid in ${background_pids[@]+"${background_pids[@]}"}; do
    stop_process_tree "$pid"
  done
  # desktop starts the stub detached, so it outlives Electron unless we stop it here
  pkill -f "$DESKTOP_DEV_STUB" 2>/dev/null || true
  wait 2>/dev/null
  echo "Stopped server and UI."
}

require_free_port() {
  local port=$1 owner
  owner=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}')
  [ -z "$owner" ] || fail "port $port is already used by $owner. Stop it and try again."
}

# Polls with curl until it succeeds, or shows the log and exits after the timeout
wait_until_ready() {
  local name=$1 log_file=$2 timeout=$3
  shift 3
  local deadline=$(( $(date +%s) + timeout ))
  until curl -sf -o /dev/null --max-time 5 "$@"; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      tail -20 "$log_file" >&2
      fail "$name did not start within ${timeout}s (full log: $log_file)"
    fi
    sleep 1
  done
}

NO_WINDOW=false
ELECTRON_ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--no-window" ]; then NO_WINDOW=true; else ELECTRON_ARGS+=("$arg"); fi
done

for repo in httptoolkit-server httptoolkit-ui httptoolkit-desktop; do
  [ -d "$ROOT/$repo/node_modules" ] || fail "$repo is not installed yet. Run ./setup.sh first."
done
for port in "$SERVER_PORT" "$MOCKTTP_PORT" "$UI_PORT"; do
  require_free_port "$port"
done

# Settings > Status shows Wirepane's version, which the UI build reads from here
WIREPANE_VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
export WIREPANE_VERSION

mkdir -p "$LOG_DIR"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

echo "Starting server -> logs/server.log"
(cd "$ROOT/httptoolkit-server" && exec npm start) < /dev/null > "$LOG_DIR/server.log" 2>&1 &
background_pids+=($!)

echo "Starting UI     -> logs/ui.log"
(cd "$ROOT/httptoolkit-ui" && exec npm run start:web) < /dev/null > "$LOG_DIR/ui.log" 2>&1 &
background_pids+=($!)

# The server rejects requests without an allowed Origin header, even health checks
wait_until_ready "Server" "$LOG_DIR/server.log" "$SERVER_TIMEOUT_SECONDS" \
  -H "Origin: $UI_URL" "http://127.0.0.1:$SERVER_PORT/version"
echo "Server is ready on :$SERVER_PORT"

wait_until_ready "UI" "$LOG_DIR/ui.log" "$UI_TIMEOUT_SECONDS" "$UI_URL"
echo "UI is ready on $UI_URL"

if $NO_WINDOW; then
  echo "Running without the app window. Press Ctrl+C to stop."
  wait
  exit 0
fi

echo "Opening the app..."
cd "$ROOT/httptoolkit-desktop" || fail "httptoolkit-desktop folder is missing"
./node_modules/.bin/tsx ./build-setup/skip-server.ts || fail "could not create the desktop dev server stub"
npm run --silent build:src || fail "desktop TypeScript build failed"
# The Dock and app menu show the bundle's name and icon: make the dev Electron.app say Wirepane
"$ROOT/scripts/brand-dev-electron.sh" || echo "Could not brand the dev Electron app, it will show as Electron"
HTK_DEV=true APP_URL="$UI_URL" ./node_modules/.bin/electron . ${ELECTRON_ARGS[@]+"${ELECTRON_ARGS[@]}"}
