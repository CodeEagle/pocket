#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CACHE_DIR="$PACKAGE_DIR/.cache/cubism-web-core"
CORE_PATH="$CACHE_DIR/live2dcubismcore.min.js"
TMP_PATH="$CACHE_DIR/.live2dcubismcore.min.js.tmp.$$"
EXPECTED_SHA256=25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f
DOWNLOAD_URL=https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js

if [ -f "$CORE_PATH" ]; then
  if printf '%s  %s\n' "$EXPECTED_SHA256" "$CORE_PATH" | shasum -a 256 -c - >/dev/null 2>&1; then
    echo "Official Cubism Web Core is already installed: $CORE_PATH"
    exit 0
  fi
  echo "Refusing to overwrite a cached Cubism Web Core with an unexpected SHA-256: $CORE_PATH" >&2
  exit 2
fi

cat <<'EOF'
This downloads Live2D's proprietary Cubism Core Web runtime for local development.
Read the official licenses before accepting. This script does not determine or
grant publication, redistribution, or application eligibility.
  https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
  https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html
EOF
printf 'Type "yes" only if you accept the development terms: '
read answer
if [ "$answer" != yes ]; then
  echo "Download cancelled."
  exit 1
fi

mkdir -p "$CACHE_DIR"
trap 'if [ -f "$TMP_PATH" ]; then rm "$TMP_PATH"; fi' EXIT HUP INT TERM
curl -fL --retry 2 --connect-timeout 20 "$DOWNLOAD_URL" -o "$TMP_PATH"
printf '%s  %s\n' "$EXPECTED_SHA256" "$TMP_PATH" | shasum -a 256 -c -
mv "$TMP_PATH" "$CORE_PATH"
echo "Installed verified official Cubism Web Core: $CORE_PATH"
