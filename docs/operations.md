# Operations

Everything a person running a portal needs day to day: configuration, health checks, logs, metrics,
backups, restores, data retention and what to do when something goes wrong. Hosting-specific steps
are in [hosting.md](hosting.md); updates in [upgrading.md](upgrading.md).

## Configuration

All settings are environment variables (Cloudflare: **Settings → Variables and secrets**; Docker:
`.env`; systemd: `EnvironmentFile`). They are checked when the portal starts: a wrong value stops the
Bun process with exit code 78 and one sentence per problem, and makes the Worker answer `503` with the
same sentences. Empty values count as "not set".

| Variable | Default | Meaning |
|---|---|---|
| `OBX_SECRET_KEY` | required on Cloudflare; on Bun generated into `<data>/secret.key` | 32+ characters. Encrypts stored credentials, signs download links and tokens. Never change it casually: stored import credentials and webhook secrets become unreadable and signed links change. |
| `OBX_SETUP_CODE` | a code printed in the log | 6+ characters; needed once in the setup wizard. |
| `OBX_PUBLIC_URL` | request address (API links); set-up address (e-mails) | Scheme and host only, e.g. `https://brands.yourbrand.com`. |
| `OBX_MAIL_PROVIDER` | e-mail off | `resend`, `postmark`, `sendgrid`, `mailchannels`, `webhook` (or `console` for development). Needs `OBX_MAIL_FROM` and `OBX_MAIL_API_KEY` (or `OBX_MAIL_WEBHOOK_URL`). |
| `OBX_STORAGE` | `disk` (Bun) / R2 (Cloudflare) | `s3` with `OBX_S3_ENDPOINT`, `OBX_S3_BUCKET`, `OBX_S3_REGION`, `OBX_S3_ACCESS_KEY_ID`, `OBX_S3_SECRET_ACCESS_KEY`, optional `OBX_S3_PREFIX`, `OBX_S3_PATH_STYLE`, `OBX_S3_CREATE_BUCKET`. |
| `OBX_TRUST_PROXY` | `false` | Bun behind a reverse proxy: use `X-Forwarded-For` / `X-Forwarded-Proto`. |
| `OBX_ALLOW_PRIVATE_URLS` | `false` | Development only: imports and webhooks may use `http://`, localhost and private addresses. Link-local and cloud-metadata addresses stay refused. A warning is logged at start. |
| `OBX_METRICS_TOKEN` | metrics off | 16+ characters; enables `GET /metrics` with `Authorization: Bearer <token>`. |
| `OBX_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `OBX_ACCESS_LOG` | on for Bun, off for Workers | One JSON line per API request. |
| `OBX_MAX_UPLOAD_BYTES` | 32 MiB (Workers) / 100 MiB (Bun) | Largest single upload; larger files use resumable uploads. |
| `OBX_RATE_LIMIT_API`, `OBX_RATE_LIMIT_MEDIA` | `600`, `3000` | Requests per minute per API key (protocol / image downloads). |
| `OBX_SYNC_BATCH_MAX` | `50` (Workers) / `200` (Bun) | Batches with more operations run as a background job. |
| `OBX_JOB_STEP_MS` | `20000` (Workers) / `60000` (Bun) | How long one background step runs before it checkpoints. |
| `OBX_D1_QUERY_BUDGET` | `800` | Workers: queries per invocation before a background step checkpoints (D1 allows 1,000). |
| `OBX_SHUTDOWN_TIMEOUT_MS` | `20000` | Bun: how long a graceful stop waits for running work. |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Bun: where to listen. |
| `OBX_DATA_DIR`, `OBX_DB_PATH`, `OBX_FILES_DIR`, `OBX_UI_DIR` | `./data`, `<data>/obx.sqlite`, `<data>/files`, `./public` | Bun: where things live. |
| `LITESTREAM_REPLICA_URL` | off | Docker image: restore the database from and replicate it to object storage (used on Cloud Run). |

## Health, readiness and graceful shutdown

- `GET /healthz` → `200 {"ok":true}` when the process (or Worker) answers. It touches no database, so a
  slow database never gets a healthy instance restarted. Use it for liveness probes and Docker's `HEALTHCHECK`.
- `GET /readyz` → `200` with `checks.database` (reachable, all migrations applied, not newer than the
  software), `checks.storage` (reachable) and, while stopping, `checks.process`; `503` when any check
  fails. Use it for load balancers and uptime monitors.
- On `SIGTERM`/`SIGINT` (Bun) the portal stops taking new job steps, `/readyz` turns `503`, in-flight
  requests and the running job step finish, then it exits `0` (at most `OBX_SHUTDOWN_TIMEOUT_MS`).
  A step cut off by the timeout is resumed after the next start: every background job keeps a
  lease and a checkpoint in the database, so jobs survive restarts, deploys and crashes.

## Logs and request ids

Logs are JSON lines on stdout/stderr (Workers Logs on Cloudflare): `time`, `level`, `msg` and fields.
Every API response has an `X-Request-Id` header; a well-formed incoming `X-Request-Id` (8–128 of
`A-Z a-z 0-9 . _ : -`) is kept, so your proxy's id links its logs to ours, otherwise the portal makes
one. Every log line written while handling that request carries the same `request_id`. With the
access log on, each API request adds `{"msg":"request","request_id",…,"method","path","status","ms"}`.
Logs never contain passwords, tokens, request bodies, query strings or IP addresses.

## Metrics

With `OBX_METRICS_TOKEN` set, `GET /metrics` serves Prometheus text:

| Metric | Type | What |
|---|---|---|
| `obx_build_info{software,version,runtime}` | gauge | always 1 |
| `obx_http_requests_total{group,method,status}` | counter | API requests per route group (`protocol`, `media`, `ingest`, `admin`, `portal`, `ops`) and status class; per process (per isolate on Workers) |
| `obx_http_request_duration_seconds{group}` | histogram | request duration |
| `obx_catalog_products`, `_variants`, `_assets`, `obx_blobs`, `obx_blob_bytes` | gauge | catalog size (refreshed hourly; `obx_catalog_counts_age_seconds` says how old) |
| `obx_changes_latest_seq` | gauge | newest change-feed entry |
| `obx_retailers_active`, `obx_api_clients_active`, `obx_access_requests_pending` | gauge | relationships |
| `obx_jobs{kind,status}` | gauge | queued, running and failed background jobs |
| `obx_webhooks_failing`, `obx_webhook_deliveries_pending` | gauge | webhook health |
| `obx_downloads_24h` | gauge | retailer downloads in the last day |

Example scrape config:

```yaml
- job_name: brand-portal
  scheme: https
  metrics_path: /metrics
  authorization: { credentials: "<OBX_METRICS_TOKEN>" }
  static_configs: [{ targets: ["brands.yourbrand.com"] }]
```

Useful alerts: `/readyz` not 200 for 5 minutes; `obx_jobs{status="failed"}` increasing;
`obx_webhooks_failing > 0` for an hour; `obx_access_requests_pending > 0` for 3 days (someone is waiting).

## Database migrations and versions

- Migrations are SQL files in `migrations/`, **forward-only**: a released file never changes, a change
  is a new file. They are applied automatically when the portal starts (Bun) or at the first request
  of a Worker; on Cloudflare `npm run deploy` also applies them with `wrangler d1 migrations apply`.
  Both record what ran in the table `d1_migrations`, so nothing runs twice.
- A database that was migrated by a **newer** release is refused: the Bun process exits with
  "The database was upgraded by a newer version…", the Worker answers `503` with the same text and
  `/readyz` reports it. Downgrades are not supported; restore the backup taken before the upgrade.

## Backup and restore

What to keep: the **database**, the **files** (images, when stored on disk) and the **secret key**.

### Bun, Docker, standalone binary

```sh
# while the portal runs (consistent snapshot; files are content-addressed and never rewritten)
bun src/adapters/bun/backup.ts backup ./backups/2026-09-28                     # from source
docker compose exec portal bun src/adapters/bun/backup.ts backup /data/backups/2026-09-28   # Docker
./obx-portal-backup backup ./backups/2026-09-28                                  # standalone
```

A backup folder has `obx.sqlite` (a `VACUUM INTO` snapshot), `files/`, `secret.key` (when the key was
generated into the data folder; otherwise keep `OBX_SECRET_KEY` with the backup yourself) and
`manifest.json` (checksum, schema, counts). `backup.ts verify <dir>` checks a copy without touching
the portal. Copy backups off the machine (another disk, a bucket, a backup service); keep a daily one
for two weeks and a monthly one for a year, or as your policy says.

Restore:

```sh
docker compose stop portal
docker compose run --rm portal bun src/adapters/bun/backup.ts restore /data/backups/2026-09-28
docker compose start portal
# when everything works:
docker compose exec portal bun src/adapters/bun/backup.ts cleanup      # removes the *.before-restore-* copies
```

The restore checks the checksum, the database integrity and that the schema is not newer than the
software, and keeps the current data next to it as `*.before-restore-<time>`.

This procedure is tested on every CI run (`scripts/backup-restore-test.sh`: a running portal in Docker
is backed up, restored into a new volume and must still sign in, show the article and accept the old
access key) and by `test/backup.test.ts` (catalog, images and keys identical after restore).

When images are in S3-compatible storage, `backup` saves the database and key only: turn on object
versioning or replication at the storage provider for the files.

### Cloudflare

D1 Time Travel (always on, 30 days on Workers Paid) plus a regular `wrangler d1 export`; R2 copied with
an S3 tool. Details: [hosting-cloudflare.md](hosting-cloudflare.md#backups-on-cloudflare).

### Moving between hosting options

The database is SQLite in every option, and files are stored under the same keys
(`blobs/<xx>/<sha256>`), so a portal can move:

- **Bun → Cloudflare:** stop the portal, `sqlite3 obx.sqlite .dump | grep -v -e '^BEGIN TRANSACTION;' -e '^COMMIT;' -e '^PRAGMA' > portal.sql`
  (D1 imports run in their own transaction), then `bunx wrangler d1 execute brand-portal-db --remote --file portal.sql`
  into a new, empty database; copy `files/` into the R2
  bucket with an S3 tool; set the same `OBX_SECRET_KEY`. Passwords made on Bun (argon2id) cannot be
  checked on Workers (bcrypt only): people use "Forgot your password?" once.
- **Cloudflare → Bun:** `bunx wrangler d1 export brand-portal-db --remote --output portal.sql`,
  `sqlite3 data/obx.sqlite < portal.sql`, copy the bucket into `data/files/`, same key. Both password
  formats work on Bun.

## Data retention and personal data

Settings → the `retention` group (admin API `PATCH /admin/api/settings`):

| Setting | Default | What is removed |
|---|---|---|
| `download_events_days` | 730 | download statistics older than this; names of the people who downloaded are removed after 400 days (or sooner) |
| `audit_log_days` | 365 | audit entries |
| `ip_days` | 30 (1–30) | IP addresses in audit entries |
| `access_requests_days` | 365 | approved or declined access requests with their contact details |

Always removed on their own schedule: sessions when they expire, password-reset links after a day,
change-feed history after 100 days, finished import jobs after 14 days, exports and zips 48 hours
after they are ready, webhook delivery logs after 7 days, unused files a day after they became unused.

Requests from people about their data:

- **Access / portability:** Retailers → the retailer → export (`GET /admin/api/retailers/{id}/export`),
  or per person `GET /admin/api/users/{id}/export`; signed-in people can download their own data
  (`GET /admin/api/me/export`).
- **Erasure:** deleting a person or a retailer removes accounts, sessions, selections, API keys,
  webhooks and access requests; statistics keep only the company name; audit entries keep the account
  id but lose name and IP. A retailer's person can delete their own account (`DELETE /admin/api/me`).

A template for the privacy notice brands show retailers: [privacy-notice-template.md](privacy-notice-template.md).

## Audit log

Every change made in the admin (settings, catalog, imports, retailers, access decisions, accounts,
API keys, access keys, webhooks), every sign-in attempt, setup, password reset, invitation
acceptance, self-service API key and personal-data export is recorded with who, what, the target,
the result and the request id: `GET /admin/api/audit-log` (filters: `action`, `actor_id`, `target_id`,
`outcome=failed`). Bodies, passwords and secrets are never recorded.

## Rate limits

| What | Limit |
|---|---|
| Protocol API per API key | `OBX_RATE_LIMIT_API` per minute (600), image downloads `OBX_RATE_LIMIT_MEDIA` (3000); `RateLimit-*` headers, `429` with `Retry-After` |
| Failed sign-ins | 10 per 15 minutes per address and per account (successful sign-ins do not count) |
| Setup attempts, password-reset requests, invitation links, token requests, access requests | per address, stored in the database (they hold across Workers isolates) |

## CI secrets (repository owner)

| Secret | Used by | What |
|---|---|---|
| `OBX_READ_TOKEN` | CI job "OBX conformance" | A fine-grained GitHub token with **read** access to `openbrandexchange/obx-go`, needed while that repository is private. Without it the job only prints a warning. |
| `GITHUB_TOKEN` (automatic) | release workflow | Draft release and the image at `ghcr.io/openbrandexchange/node-ts`. |

## When something goes wrong

1. `GET /readyz`: which check fails?
2. Logs: search for `"level":"error"`; take the `request_id` from the failing response's `X-Request-Id`.
3. Background work stuck: `obx_jobs` in `/metrics` or the imports screen. A job whose worker died is
   picked up again automatically when its lease runs out (1–2 minutes).
4. Cloudflare `503` with "free plan's daily database allowance" / "database is full": see the limits
   table in [hosting-cloudflare.md](hosting-cloudflare.md#which-plan-what-the-free-plan-allows-and-what-happens-when-a-limit-is-reached).
5. Security incident (leaked key, account misuse): revoke the key or block the account in the admin
   (takes effect at the next request), check the audit log, rotate `OBX_METRICS_TOKEN`/mail keys as
   needed, and tell security@openbrandexchange.com if the portal software itself is at fault.
