#!/bin/sh
# Starts the portal. With LITESTREAM_REPLICA_URL set (for example gs://my-bucket/portal on Cloud Run,
# or s3://bucket/portal), the SQLite database is restored from and continuously copied to object storage,
# so a container without a persistent disk keeps its data.
set -eu

DB="${OBX_DB_PATH:-${OBX_DATA_DIR:-/data}/obx.sqlite}"
export OBX_DB_PATH="$DB"

if [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
  litestream restore -if-db-not-exists -if-replica-exists -o "$DB" "$LITESTREAM_REPLICA_URL"
  exec litestream replicate -exec "$*" "$DB" "$LITESTREAM_REPLICA_URL"
fi

exec "$@"
