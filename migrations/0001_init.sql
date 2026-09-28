-- Open Brand Exchange node (TypeScript): initial schema.
-- One SQLite dialect for Cloudflare D1 and bun:sqlite. Statements end with ";" at line end.

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  stored TEXT NOT NULL,
  rep_hash TEXT NOT NULL,
  etag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  modified_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  brand_id TEXT NOT NULL,
  style_number TEXT NOT NULL,
  status TEXT NOT NULL,
  stored TEXT NOT NULL,
  rep_hash TEXT NOT NULL,
  etag TEXT NOT NULL,
  item_type TEXT,
  target_group TEXT,
  season TEXT,
  collection TEXT,
  own_search TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  content_updated_at TEXT NOT NULL,
  modified_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS products_brand ON products(brand_id, status);
CREATE INDEX IF NOT EXISTS products_style ON products(style_number COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  status TEXT NOT NULL,
  gtin14 TEXT,
  color_code TEXT,
  search_bits TEXT NOT NULL DEFAULT '',
  stored TEXT NOT NULL,
  rep_hash TEXT NOT NULL,
  etag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  modified_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS variants_gtin ON variants(gtin14) WHERE gtin14 IS NOT NULL;
CREATE INDEX IF NOT EXISTS variants_product ON variants(product_id);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  status TEXT NOT NULL,
  color_code TEXT,
  position INTEGER NOT NULL,
  stored TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '{}',
  staged TEXT,
  staged_at TEXT,
  has_original INTEGER NOT NULL DEFAULT 0,
  missing_renditions INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  expiry_tombstoned INTEGER NOT NULL DEFAULT 0,
  rep_hash TEXT NOT NULL,
  etag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  modified_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS assets_position ON assets(product_id, IFNULL(color_code, ''), position);
CREATE INDEX IF NOT EXISTS assets_product ON assets(product_id);
CREATE INDEX IF NOT EXISTS assets_expiry ON assets(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  crc32 INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  op TEXT NOT NULL,
  obj_id TEXT NOT NULL,
  external_id TEXT,
  brand_id TEXT,
  product_id TEXT,
  retailer_id TEXT,
  resync INTEGER,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_obj ON changes(obj_id, seq);
CREATE INDEX IF NOT EXISTS changes_created ON changes(created_at);

CREATE TABLE IF NOT EXISTS retailers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  reference TEXT,
  website TEXT,
  vat_number TEXT,
  country TEXT,
  notes TEXT,
  status TEXT NOT NULL,
  brand_ids TEXT,
  allow_original INTEGER,
  grant_updated_at TEXT NOT NULL,
  last_activity_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  retailer_id TEXT,
  status TEXT NOT NULL,
  language TEXT NOT NULL,
  password_hash TEXT,
  invite_token_hash TEXT,
  invite_expires_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS users_invite ON users(invite_token_hash);
CREATE INDEX IF NOT EXISTS users_retailer ON users(retailer_id);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS api_clients (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  secret_version INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  retailer_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS api_clients_retailer ON api_clients(retailer_id);

CREATE TABLE IF NOT EXISTS ingest_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  brand_external_ids TEXT,
  status TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  retailer TEXT NOT NULL,
  contact TEXT NOT NULL,
  access TEXT NOT NULL,
  requested_brand_ids TEXT,
  message TEXT,
  request_token_hash TEXT NOT NULL,
  reason TEXT,
  retailer_id TEXT,
  api_client_id TEXT,
  pending_secret TEXT,
  claimed INTEGER NOT NULL DEFAULT 0,
  portal_invited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  api_client_id TEXT,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  status TEXT NOT NULL,
  notified_seq INTEGER NOT NULL DEFAULT 0,
  notified_at TEXT,
  failing_since TEXT,
  last_delivery_at TEXT,
  last_status INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  body TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  next_attempt_at TEXT,
  status_code INTEGER,
  duration_ms INTEGER,
  error TEXT,
  at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_hook ON webhook_deliveries(webhook_id, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER,
  summary TEXT,
  result TEXT,
  error TEXT,
  source_id TEXT,
  idempotency_key TEXT,
  lease_until TEXT,
  run_after TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner, kind, created_at);

CREATE TABLE IF NOT EXISTS job_items (
  job_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,
  is_error INTEGER NOT NULL DEFAULT 0,
  item TEXT NOT NULL,
  PRIMARY KEY (job_id, kind, idx)
);

CREATE TABLE IF NOT EXISTS import_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  schedule TEXT NOT NULL,
  mode TEXT NOT NULL,
  allow_mass_unpublish INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL,
  credentials_enc TEXT,
  credentials_set TEXT NOT NULL DEFAULT '{}',
  fingerprint TEXT,
  last_run_id TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_files (
  source_id TEXT NOT NULL,
  path TEXT NOT NULL,
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (source_id, path)
);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  part_bytes INTEGER NOT NULL,
  parts_total INTEGER NOT NULL,
  received TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS selections (
  user_id TEXT PRIMARY KEY,
  product_ids TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS download_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  retailer_id TEXT,
  retailer_name TEXT,
  actor_type TEXT NOT NULL,
  actor_name TEXT,
  variant TEXT,
  product_id TEXT,
  asset_id TEXT,
  usage_event TEXT,
  files INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER
);
CREATE INDEX IF NOT EXISTS download_events_at ON download_events(at);
CREATE INDEX IF NOT EXISTS download_events_retailer ON download_events(retailer_id, at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
