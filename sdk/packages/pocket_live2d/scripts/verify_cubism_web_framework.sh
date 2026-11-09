#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
FRAMEWORK_ROOT=$(sh "$SCRIPT_DIR/bootstrap_cubism_web_framework.sh")
MANIFEST="$SCRIPT_DIR/cubism-web-framework-5-r5.sha256"

file_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

while read -r kind expected path relationship; do
  case "$kind" in
    ''|'#'*) continue ;;
    upstream) file="$FRAMEWORK_ROOT/$path" ;;
    local) file="$PACKAGE_DIR/$path" ;;
    *) echo "Unknown provenance row kind: $kind" >&2; exit 2 ;;
  esac
  if [ ! -f "$file" ]; then
    echo "Provenance source is missing: $file" >&2
    exit 1
  fi
  actual=$(file_hash "$file")
  if [ "$actual" != "$expected" ]; then
    echo "SHA-256 mismatch for $file" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
  printf '%-8s %s  %s' "$kind" "$actual" "$path"
  if [ -n "${relationship:-}" ]; then printf '  [%s]' "$relationship"; fi
  printf '\n'
done < "$MANIFEST"

printf 'verified CubismWebFramework 5-r.5 at %s\n' "$(git -C "$FRAMEWORK_ROOT" rev-parse HEAD)"
