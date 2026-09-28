-- Indexes for the minute tick and the 10-minute housekeeping, so an idle portal does not scan whole
-- tables (on D1 every row a query reads is billed). Found with EXPLAIN QUERY PLAN on the load-test catalog.
CREATE INDEX IF NOT EXISTS assets_staged ON assets(staged_at) WHERE staged IS NOT NULL;
CREATE INDEX IF NOT EXISTS import_sources_due ON import_sources(next_run_at) WHERE enabled = 1 AND next_run_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS password_resets_expires ON password_resets(expires_at);
CREATE INDEX IF NOT EXISTS idempotency_created ON idempotency(created_at);
CREATE INDEX IF NOT EXISTS rate_limits_window ON rate_limits(window_start);
CREATE INDEX IF NOT EXISTS webhook_deliveries_created ON webhook_deliveries(created_at);
CREATE INDEX IF NOT EXISTS uploads_open ON uploads(expires_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS jobs_finished ON jobs(finished_at) WHERE finished_at IS NOT NULL;
