#!/usr/bin/env bash
set -euo pipefail

DEMO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLUTTER_ROOT="$DEMO_ROOT"
CATALOG="${OFFICIAL_DEMOS_FPS_CATALOG_ASSET:-assets/apps/official/catalog.json}"
REPORT="${OFFICIAL_DEMOS_FPS_REPORT:-$DEMO_ROOT/build/official-demos/fps-report.json}"
LOG="${OFFICIAL_DEMOS_FPS_LOG:-$DEMO_ROOT/build/official-demos/fps-profile.log}"
WINDOW_SECONDS="${OFFICIAL_DEMOS_FPS_SECONDS:-3}"
DRIVE_ARGS=()

usage() {
  cat <<'EOF'
Usage: profile_official_demos_macos.sh [--catalog ASSET_KEY] [--report PATH] [--log PATH] [-- DRIVE_ARGS...]

Build the macOS profile integration-test app once, then measure every passed
official demo in one flutter drive process. Catalog and artifact paths are
Flutter asset keys; the default catalog is assets/apps/official/catalog.json.
The script saves the machine-readable OFFICIAL_DEMO_FPS JSON to --report and
the full flutter drive output to --log.
EOF
}

while (($#)); do
  case "$1" in
    --catalog)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      CATALOG="$2"
      shift 2
      ;;
    --report)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      REPORT="$2"
      shift 2
      ;;
    --log)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      LOG="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      DRIVE_ARGS+=("$@")
      break
      ;;
    *)
      DRIVE_ARGS+=("$1")
      shift
      ;;
  esac
done

[[ -f "$DEMO_ROOT/$CATALOG" ]] || {
  echo "staged official demo FPS asset not found: $DEMO_ROOT/$CATALOG" >&2
  exit 2
}
mkdir -p "$(dirname "$REPORT")"
mkdir -p "$(dirname "$LOG")"
REPORT="$(cd "$(dirname "$REPORT")" && pwd)/$(basename "$REPORT")"
LOG="$(cd "$(dirname "$LOG")" && pwd)/$(basename "$LOG")"
cd "$FLUTTER_ROOT"

set +e
flutter drive \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/official_demos_fps_test.dart \
  -d macos \
  --profile \
  "--dart-define=OFFICIAL_DEMOS_FPS_CATALOG_ASSET=$CATALOG" \
  "--dart-define=OFFICIAL_DEMOS_FPS_SECONDS=$WINDOW_SECONDS" \
  "${DRIVE_ARGS[@]}" 2>&1 | tee "$LOG"
pipeline_status=("${PIPESTATUS[@]}")
set -e
drive_status="${pipeline_status[0]}"
tee_status="${pipeline_status[1]}"

machine_json="$(sed -n 's/^.*OFFICIAL_DEMO_FPS //p' "$LOG" | tail -n 1)"
if [[ -n "$machine_json" ]]; then
  printf '%s\n' "$machine_json" > "$REPORT"
else
  echo "flutter drive output did not contain OFFICIAL_DEMO_FPS; see $LOG" >&2
fi

if ((drive_status != 0)); then exit "$drive_status"; fi
exit "$tee_status"
