#!/usr/bin/env sh
# Vendors the admin-ui build (brand admin + retailer portal) into public/, where both editions serve it.
# Usage: scripts/vendor-admin-ui.sh [path-to-admin-ui]   (default ../admin-ui; builds it when dist/ is missing)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UI="${1:-$ROOT/../admin-ui}"
if [ ! -f "$UI/dist/index.html" ]; then
  echo "Building admin-ui in $UI ..."
  (cd "$UI" && npm ci && npm run build)
fi
KEEP="$(mktemp)"
cp "$ROOT/public/_headers" "$KEEP"
rm -rf "$ROOT/public"
mkdir -p "$ROOT/public"
cp -R "$UI/dist/." "$ROOT/public/"
cp "$KEEP" "$ROOT/public/_headers"
rm -f "$KEEP"
echo "admin-ui vendored into public/ ($(find "$ROOT/public" -type f | wc -l | tr -d ' ') files)"
