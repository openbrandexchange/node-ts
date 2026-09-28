#!/usr/bin/env sh
# Re-copies the admin-ui build (brand admin + retailer portal + e-mail strings) into public/.
# Usage: scripts/update-ui.sh [path-to-admin-ui]   (default ../admin-ui)
# The admin-ui repo commits its built dist/, so no build is needed; when dist/ is missing it is built first.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UI="${1:-$ROOT/../admin-ui}"
if [ ! -f "$UI/dist/index.html" ]; then
  echo "Building admin-ui in $UI ..."
  (cd "$UI" && npm ci && npm run build)
fi
if [ ! -f "$UI/dist/locales/en.json" ]; then
  echo "error: $UI/dist has no locales/en.json; is this an admin-ui build?" >&2
  exit 1
fi
KEEP="$(mktemp)"
cp "$ROOT/public/_headers" "$KEEP"
rm -rf "$ROOT/public"
mkdir -p "$ROOT/public"
cp -R "$UI/dist/." "$ROOT/public/"
cp "$KEEP" "$ROOT/public/_headers"
rm -f "$KEEP"
VERSION="$(cd "$UI" && git describe --tags --always 2>/dev/null || echo unknown)"
printf '%s\n' "$VERSION" > "$ROOT/public/UI_VERSION"
echo "admin-ui $VERSION vendored into public/ ($(find "$ROOT/public" -type f | wc -l | tr -d ' ') files)"
