#!/usr/bin/env sh
# End-to-end test of the documented backup and restore procedure with the Docker image:
# a running portal is backed up, the backup is restored into a brand-new volume, and the restored
# portal still has the account and the article. Removes only the containers and volumes it made.
#   scripts/backup-restore-test.sh [image]      (default: brand-portal:latest; build it first)
set -eu
IMAGE="${1:-brand-portal:latest}"
ID="obxbk-$$"
SRC="$ID-src"
DST="$ID-dst"
WORK="$(mktemp -d)"
PORT_A="${PORT_A:-18181}"
PORT_B="${PORT_B:-18182}"
cleanup() {
  docker rm -f "$SRC" "$DST" >/dev/null 2>&1 || true
  docker volume rm "$SRC" "$DST" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

wait_ready() {
  i=0
  until curl -fs "http://127.0.0.1:$1/readyz" >/dev/null; do
    i=$((i + 1)); [ "$i" -lt 60 ] || { docker logs "$2" | tail -50; exit 1; }
    sleep 1
  done
}

echo "1. start a portal and put an article in it"
docker volume create "$SRC" >/dev/null
docker run -d --name "$SRC" -p "127.0.0.1:$PORT_A:8080" -v "$SRC:/data" -e OBX_SETUP_CODE=BACKUP-TEST-1 "$IMAGE" >/dev/null
wait_ready "$PORT_A" "$SRC"
A="http://127.0.0.1:$PORT_A"
JAR="$WORK/jar"
csrf() { curl -fs -c "$JAR" -b "$JAR" "$1/admin/api/session" | sed -E 's/.*"csrf_token":"([^"]+)".*/\1/'; }
T="$(csrf "$A")"
curl -fs -c "$JAR" -b "$JAR" -H "x-csrf-token: $T" -H 'content-type: application/json' "$A/admin/api/setup" \
  -d '{"setup_code":"BACKUP-TEST-1","company":{"name":"Kestrel Outfitters","first_brand_name":"Kestrel","default_language":"en","languages":["en"]},"admin":{"name":"Ada Admin","email":"admin@kestrel.example","password":"backup test password 1"}}' >/dev/null
T="$(csrf "$A")"
TOKEN="$(curl -fs -c "$JAR" -b "$JAR" -H "x-csrf-token: $T" -H 'content-type: application/json' "$A/admin/api/ingest-tokens" \
  -d '{"name":"backup test","scopes":["ingest:read","ingest:write"]}' | sed -E 's/.*"secret":"([^"]+)".*/\1/')"
curl -fs -X PUT -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$A/obx/v1/ingest/products/KO-1001" \
  -d '{"style_number":"KO-1001","name":{"en":"Merino Crew Sweater"}}' >/dev/null

echo "2. back it up while it runs"
docker exec "$SRC" bun src/adapters/bun/backup.ts backup /data/backups/b1
docker cp "$SRC:/data/backups/b1" "$WORK/b1"
docker exec "$SRC" bun src/adapters/bun/backup.ts verify /data/backups/b1

echo "3. restore into a new, empty volume and start a portal on it"
docker volume create "$DST" >/dev/null
chmod -R a+rX "$WORK/b1"
docker run --rm -v "$DST:/data" -v "$WORK/b1:/backup:ro" "$IMAGE" bun src/adapters/bun/backup.ts restore /backup
docker run -d --name "$DST" -p "127.0.0.1:$PORT_B:8080" -v "$DST:/data" "$IMAGE" >/dev/null
wait_ready "$PORT_B" "$DST"

echo "4. the restored portal has the account, the article and the same secret key"
B="http://127.0.0.1:$PORT_B"
JAR="$WORK/jar2"
T="$(csrf "$B")"
curl -fs -c "$JAR" -b "$JAR" -H "x-csrf-token: $T" -H 'content-type: application/json' "$B/admin/api/session/login" \
  -d '{"email":"admin@kestrel.example","password":"backup test password 1"}' | grep -q '"authenticated":true'
curl -fs -b "$JAR" "$B/admin/api/catalog/products/KO-1001" | grep -q 'Merino Crew Sweater'
curl -fs -H "authorization: Bearer $TOKEN" "$B/obx/v1/ingest" >/dev/null
curl -fs "$B/admin/api/setup" | grep -q '"required":false'
echo "backup and restore: ok"
