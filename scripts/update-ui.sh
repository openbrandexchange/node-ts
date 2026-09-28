#!/usr/bin/env sh
# Re-copies the admin-ui build (brand admin + retailer portal + e-mail strings) into public/.
# Usage: scripts/update-ui.sh [path-to-admin-ui] [git-ref]
#   path     default ../admin-ui
#   git-ref  optional (e.g. v0.1.1 or origin/main): take dist/ as committed at that ref, so local
#            uncommitted work in the admin-ui checkout is never vendored by accident
# The admin-ui repo commits its built dist/, so no build is needed; without a ref and without dist/
# it is built first. public/_headers (this node's security headers) is kept.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UI="${1:-$ROOT/../admin-ui}"
REF="${2:-}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM
if [ -n "$REF" ]; then
  git -C "$UI" archive "$REF" dist | tar -x -C "$TMP"
  DIST="$TMP/dist"
  VERSION="$(git -C "$UI" describe --tags --always "$REF" 2>/dev/null || echo "$REF")"
else
  if [ ! -f "$UI/dist/index.html" ]; then
    echo "Building admin-ui in $UI ..."
    (cd "$UI" && npm ci && npm run build)
  fi
  DIST="$UI/dist"
  VERSION="$(cd "$UI" && git describe --tags --always --dirty 2>/dev/null || echo unknown)"
fi
if [ ! -f "$DIST/index.html" ] || [ ! -f "$DIST/locales/en.json" ]; then
  echo "error: $DIST has no index.html or locales/en.json; is this an admin-ui build?" >&2
  exit 1
fi
cp "$ROOT/public/_headers" "$TMP/_headers.keep"
rm -rf "$ROOT/public"
mkdir -p "$ROOT/public"
cp -R "$DIST/." "$ROOT/public/"
cp "$TMP/_headers.keep" "$ROOT/public/_headers"
printf '%s\n' "$VERSION" > "$ROOT/public/UI_VERSION"
echo "admin-ui $VERSION vendored into public/ ($(find "$ROOT/public" -type f | wc -l | tr -d ' ') files)"
