#!/usr/bin/env sh
# Builds the release files of this edition into dist/release/ (used by .github/workflows/release.yml,
# and runnable locally to check a release before tagging):
#   obx-portal-<version>-<os>-<arch>.tar.gz|.zip   standalone portal (no Bun, Node or npm needed) + web interface
#   obx-node-ts-cloudflare-<version>.tar.gz         prebuilt Worker for `npx wrangler deploy` (no build step)
#   obx-node-ts-source-<version>.tar.gz             source of the tagged version
#   SHA256SUMS
# Usage: scripts/build-release.sh [version]   (default: version in package.json; a leading "v" is dropped)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PKG_VERSION="$(bun -e 'console.log(require("./package.json").version)')"
VERSION="${1:-$PKG_VERSION}"
VERSION="${VERSION#v}"
CODE_VERSION="$(sed -n 's/^export const VERSION = "\(.*\)";$/\1/p' src/adapters/shared/config.ts)"
if [ "$VERSION" != "$PKG_VERSION" ] || [ "$VERSION" != "$CODE_VERSION" ]; then
  echo "version mismatch: requested $VERSION, package.json $PKG_VERSION, src/adapters/shared/config.ts $CODE_VERSION" >&2
  exit 1
fi
OUT="$ROOT/dist/release"
WORK="$ROOT/dist/release-work"
rm -rf "$OUT" "$WORK"
mkdir -p "$OUT" "$WORK"

bun scripts/gen-migrations.ts >/dev/null

# 1. Standalone portal binaries (bun build --compile). SFTP, disk and S3 storage all work.
for target in linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64; do
  name="obx-portal-$VERSION-$target"
  dir="$WORK/$name"
  mkdir -p "$dir"
  exe="obx-portal"
  [ "$target" = windows-x64 ] && exe="obx-portal.exe"
  bun build src/adapters/bun/main.ts --compile --minify --sourcemap --target "bun-$target" --outfile "$dir/$exe" >/dev/null
  bun build src/adapters/bun/backup.ts --compile --minify --target "bun-$target" --outfile "$dir/obx-portal-backup$( [ "$target" = windows-x64 ] && echo .exe)" >/dev/null
  cp -R public "$dir/public"
  cp LICENSE NOTICE CHANGELOG.md .env.example "$dir/"
  cat >"$dir/README.txt" <<EOF
Open Brand Exchange - Portal for Cloudflare, standalone build $VERSION ($target)

Run:      ./$exe                    (then open http://localhost:8080; the setup code is printed)
Data:     ./data (SQLite database, images, generated secret key); change with OBX_DATA_DIR
Settings: environment variables, see .env.example and https://github.com/openbrandexchange/node-ts#configuration
Backup:   ./obx-portal-backup backup ./backups/today    (restore: stop the portal, then ... restore <dir>)
Licence:  GNU AGPL-3.0 (LICENSE). Source: obx-node-ts-source-$VERSION.tar.gz or the GitHub repository.
EOF
  if [ "$target" = windows-x64 ]; then
    (cd "$WORK" && zip -qr "$OUT/$name.zip" "$name")
  else
    tar -C "$WORK" -czf "$OUT/$name.tar.gz" "$name"
  fi
done

# 2. Prebuilt Cloudflare Worker: wrangler uploads it as it is (no_bundle), creates D1 + R2, applies migrations.
cf="obx-node-ts-cloudflare-$VERSION"
dir="$WORK/$cf"
mkdir -p "$dir/worker"
bunx wrangler deploy --dry-run --outdir "$WORK/wrangler-out" >/dev/null
cp "$WORK/wrangler-out/index.js" "$dir/worker/index.js"
cp -R public migrations "$dir/"
cp LICENSE NOTICE CHANGELOG.md .dev.vars.example "$dir/"
# shellcheck disable=SC2016 # JavaScript, not shell
bun -e '
  const fs = require("node:fs");
  let t = fs.readFileSync("wrangler.jsonc", "utf8");
  t = t.replace(/"\$schema": "[^"]*",\n\s*/, "");
  t = t.replace("\"main\": \"src/adapters/workers/index.ts\",", "\"main\": \"worker/index.js\",\n  \"no_bundle\": true,\n  \"rules\": [{ \"type\": \"ESModule\", \"globs\": [\"**/*.js\"] }],");
  if (!t.includes("worker/index.js")) throw new Error("wrangler.jsonc: main not found");
  fs.writeFileSync(process.argv[1], t);
' "$dir/wrangler.jsonc"
cat >"$dir/package.json" <<EOF
{
  "name": "obx-node-ts-cloudflare",
  "version": "$VERSION",
  "private": true,
  "license": "AGPL-3.0-only",
  "scripts": {
    "deploy": "wrangler deploy && wrangler d1 migrations apply DB --remote"
  },
  "devDependencies": {
    "wrangler": "^4.142.0"
  }
}
EOF
cat >"$dir/README.md" <<EOF
# Open Brand Exchange · Portal for Cloudflare $VERSION (prebuilt)

\`\`\`sh
npx wrangler login
npx wrangler secret put OBX_SECRET_KEY    # openssl rand -base64 48
npx wrangler secret put OBX_SETUP_CODE    # a code you choose
npm run deploy                            # creates D1 + R2, deploys, applies migrations
\`\`\`

Plans and limits: https://github.com/openbrandexchange/node-ts/blob/v$VERSION/docs/hosting-cloudflare.md
EOF
tar -C "$WORK" -czf "$OUT/$cf.tar.gz" "$cf"

# 3. Source of this version (what AGPL-3.0 section 6 asks us to offer with the binaries).
git archive --format=tar.gz --prefix="obx-node-ts-$VERSION/" -o "$OUT/obx-node-ts-source-$VERSION.tar.gz" HEAD

(cd "$OUT" && shasum -a 256 ./* | sed 's#\./##' >SHA256SUMS)
rm -rf "$WORK"
echo "release files in $OUT:"
ls -1 "$OUT"
