-- Audit log of admin actions (who changed what, when). IP addresses are cleared after 30 days;
-- whole entries are deleted after the brand's retention setting (default 365 days).
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  target_id TEXT,
  status INTEGER NOT NULL,
  request_id TEXT,
  ip TEXT,
  details TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS audit_log_actor ON audit_log(actor_id, at);
CREATE INDEX IF NOT EXISTS audit_log_action ON audit_log(action, at);
CREATE INDEX IF NOT EXISTS access_requests_retailer ON access_requests(retailer_id);
CREATE INDEX IF NOT EXISTS access_requests_decided ON access_requests(status, decided_at);
