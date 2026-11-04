#!/bin/sh
# Manage the local Pocket Studio editor as a temporary per-user launchd job.
#
# `launchctl submit` deliberately does not install a LoginItem or a permanent
# plist. The job lives in the current user's GUI session, survives the shell
# that started it, and is removed explicitly by `stop` (or by logout/reboot).
# The label includes this checkout's absolute path hash so this script cannot
# remove an editor job belonging to another checkout.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
SERVER="$ROOT/editor/server.ts"
HOST=${POCKET_EDITOR_HOST:-127.0.0.1}
PORT=${POCKET_EDITOR_PORT:-8790}
WORKSPACE="$ROOT/.pocket-build/editor-workspace"
LOG="$ROOT/.pocket-build/editor-service.log"
if [ "$PORT" != 8790 ]; then
  WORKSPACE="${WORKSPACE}-${PORT}"
  LOG="$ROOT/.pocket-build/editor-service-${PORT}.log"
fi
PROJECT_ROOT=${POCKET_EDITOR_PROJECT_ROOT:-}
FLUTTER_ROOT=${POCKET_EDITOR_FLUTTER_ROOT:-}
BUN=${POCKET_EDITOR_BUN:-$(command -v bun 2>/dev/null || true)}
LAUNCH_PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}
LAUNCH_HOME=${HOME:-}

if [ "$(uname -s)" != "Darwin" ]; then
  echo "editor_service.sh requires macOS launchctl" >&2
  exit 2
fi
if ! command -v launchctl >/dev/null 2>&1; then
  echo "launchctl is unavailable" >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for the health check" >&2
  exit 2
fi
if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  echo "bun executable not found; set POCKET_EDITOR_BUN to its absolute path" >&2
  exit 2
fi
if [ -z "$LAUNCH_HOME" ]; then
  echo "HOME is required by Bun/launchd" >&2
  exit 2
fi
if [ ! -f "$SERVER" ]; then
  echo "editor/server.ts is missing under $ROOT" >&2
  exit 2
fi
case "$HOST" in
  127.0.0.1|localhost) ;;
  *) echo "editor service must bind to loopback (127.0.0.1 or localhost)" >&2; exit 2 ;;
esac
case "$PORT" in
  ''|*[!0-9]*) echo "POCKET_EDITOR_PORT must be numeric" >&2; exit 2 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "POCKET_EDITOR_PORT must be between 1 and 65535" >&2
  exit 2
fi

PATH_HASH=$(printf '%s' "$ROOT" | shasum -a 256 | awk '{print substr($1, 1, 16)}')
LABEL="com.pocket.editor.${PATH_HASH}.${PORT}"
HEALTH_URL="http://${HOST}:${PORT}/health"
RUNTIME_LOG="/tmp/pocket-editor-${PATH_HASH}.log"
if [ "$PORT" != 8790 ]; then
  RUNTIME_LOG="/tmp/pocket-editor-${PATH_HASH}-${PORT}.log"
fi

job_loaded() {
  launchctl list "$LABEL" >/dev/null 2>&1
}

health_ok() {
  curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null |
    grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'
}

wait_for_health() {
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    if health_ok; then return 0; fi
    attempts=$((attempts + 1))
    sleep 0.25
  done
  return 1
}

prepare_log_path() {
  mkdir -p "$ROOT/.pocket-build"
  # The checkout is on an external volume on this machine. launchd can run
  # Bun from that volume but cannot open a StandardOutPath there directly.
  # Keep the documented .pocket-build path as a symlink to a path launchd can
  # write; the target is still unique to this checkout and port.
  if [ -L "$LOG" ]; then
    if [ "$(readlink "$LOG")" != "$RUNTIME_LOG" ]; then
      echo "refusing unexpected editor log symlink: $LOG" >&2
      return 1
    fi
  elif [ -e "$LOG" ]; then
    echo "refusing to replace existing editor log file: $LOG" >&2
    return 1
  else
    ln -s "$RUNTIME_LOG" "$LOG"
  fi
}

start_service() {
  if job_loaded; then
    if health_ok; then
      echo "editor already running: label=$LABEL url=$HEALTH_URL"
      return 0
    fi
    echo "editor job is loaded but unhealthy; restarting label=$LABEL" >&2
    launchctl remove "$LABEL" >/dev/null 2>&1 || true
    sleep 0.25
  elif health_ok; then
    echo "refusing to take over $HEALTH_URL: an unmanaged listener is already running" >&2
    echo "stop that listener first, then run this command again" >&2
    return 1
  fi

  prepare_log_path
  # The command is submitted with absolute paths so launchd does not depend
  # on the caller's cwd. stdout and stderr share one diagnostic log.
  launchctl submit \
    -l "$LABEL" \
    -p /usr/bin/env \
    -o "$RUNTIME_LOG" \
    -e "$RUNTIME_LOG" \
    -- /usr/bin/env \
      "PATH=$LAUNCH_PATH" \
      "HOME=$LAUNCH_HOME" \
      "POCKET_EDITOR_PROJECT_ROOT=$PROJECT_ROOT" \
      "POCKET_EDITOR_FLUTTER_ROOT=$FLUTTER_ROOT" \
      "POCKET_EDITOR_UPDATE_HOST=${POCKET_EDITOR_UPDATE_HOST:-}" \
      "POCKET_EDITOR_UPDATE_PORT=${POCKET_EDITOR_UPDATE_PORT:-}" \
      "$BUN" "$SERVER" \
      --host="$HOST" \
      --port="$PORT" \
      --workspace="$WORKSPACE"
  if ! wait_for_health; then
    echo "editor did not become healthy at $HEALTH_URL; see $LOG" >&2
    launchctl remove "$LABEL" >/dev/null 2>&1 || true
    return 1
  fi
  echo "editor started: label=$LABEL url=$HEALTH_URL log=$LOG"
}

stop_service() {
  if job_loaded; then
    launchctl remove "$LABEL"
    echo "editor stopped: label=$LABEL"
  else
    echo "editor job is not loaded: label=$LABEL"
  fi
}

status_service() {
  if job_loaded; then
    echo "label=$LABEL"
    launchctl list "$LABEL"
    if health_ok; then
      echo "health=ok url=$HEALTH_URL"
      return 0
    fi
    echo "health=down url=$HEALTH_URL log=$LOG" >&2
    return 1
  fi
  if health_ok; then
    echo "managed=stopped but unmanaged listener is healthy at $HEALTH_URL" >&2
  else
    echo "managed=stopped health=down label=$LABEL"
  fi
  return 1
}

command_name=${1:-status}
case "$command_name" in
  start) start_service ;;
  stop) stop_service ;;
  status) status_service ;;
  *)
    echo "usage: $0 {start|stop|status}" >&2
    exit 2
    ;;
esac
