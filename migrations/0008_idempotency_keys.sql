-- OBX 0.3 (spec ingest.md §3.5, protocol.md §7 exports): an Idempotency-Key replays only the same request.
-- The keys move to a table that keeps the sha256 of the request (for imports: of every part); the same key
-- with another request is 409 idempotency_key_reused. The old table only expires (cron, 24 hours).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created ON idempotency_keys(created_at);
