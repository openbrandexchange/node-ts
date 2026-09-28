#!/usr/bin/env sh
# Starts a fresh node-ts (Bun) on a temporary data directory and walks the brand admin and the
# retailer portal in a headless browser, with axe accessibility and keyboard checks.
#   e2e/run.sh              (needs Bun, Node.js and zip; installs Playwright on first run)
#   e2e/run.sh -g "axe"     (extra arguments go to playwright test)
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-18090}"
TMP="$HERE/tmp"
FIX="$ROOT/test/fixtures/kestrel"
rm -rf "$TMP" "$HERE/screenshots"
mkdir -p "$TMP/data" "$HERE/screenshots"
(cd "$FIX" && zip -qr "$TMP/images.zip" images)
# A "nightly export" for the scheduled import: the same catalog with one renamed article.
mkdir -p "$TMP/export"
cp -R "$FIX/." "$TMP/export/"
sed 's/Merino Crew Sweater/Merino Crew Jumper/' "$FIX/products.csv" >"$TMP/export/products.csv"
(cd "$TMP/export" && zip -qr "$TMP/package.zip" products.csv assets.csv images)
[ -d "$HERE/node_modules" ] || (cd "$HERE" && npm ci)
(cd "$HERE" && npx playwright install chromium >/dev/null)

URL="http://localhost:$PORT"
OBX_DATA_DIR="$TMP/data" PORT="$PORT" HOST=127.0.0.1 OBX_PUBLIC_URL="$URL" \
  OBX_SETUP_CODE=SETUP-1234 OBX_ALLOW_PRIVATE_URLS=true OBX_MAIL_PROVIDER=console \
  bun "$ROOT/src/adapters/bun/main.ts" >"$TMP/node.log" 2>&1 &
NODE_PID=$!
trap 'kill "$NODE_PID" 2>/dev/null || true' EXIT INT TERM
i=0
until curl -sf "http://127.0.0.1:$PORT/readyz" >/dev/null; do
  i=$((i + 1)); [ "$i" -lt 60 ] || { cat "$TMP/node.log"; exit 1; }
  sleep 1
done
cd "$HERE"
OBX_E2E_URL="$URL" OBX_E2E_NODE_LOG="$TMP/node.log" OBX_E2E_FIXTURES="$FIX" OBX_E2E_IMAGES_ZIP="$TMP/images.zip" OBX_E2E_PACKAGE_ZIP="$TMP/package.zip" \
  npx playwright test "$@"
