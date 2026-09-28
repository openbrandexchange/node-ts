# Changelog

All notable changes to the Portal for Cloudflare (`node-ts`) are listed here. The project follows
[Semantic Versioning](https://semver.org/): the major version changes when an upgrade needs more
than replacing the software (see [docs/upgrading.md](docs/upgrading.md)); database migrations are
always forward-only and applied automatically.

## [Unreleased]

## [0.1.0] - 2026-09-28

First release. Implements Open Brand Exchange protocol 0.1 (read API, ingest API, node admin and
portal API) and passes `obx-conformance all` (58 tests, including the rate-limit test) on Bun and in
the Cloudflare Workers runtime.

### For brands
- A portal for retailers ("<Brand> · <portal word>" in 25 languages): request access, sign in, search
  and filter, paste EANs, download images (original, web, square) and article data (CSV) as zips,
  background zips for whole catalogs.
- Admin screens (from admin-ui) for the catalog, imports (CSV + images or one zip, dry run),
  scheduled imports (web address, S3/R2, SFTP on the self-hosted build), access keys for the `obx`
  tool and PIM/ERP flows, retailers and their API keys, access requests, statistics, settings.
- E-mails in the recipient's language (Resend, Postmark, SendGrid, MailChannels or a webhook).
- Audit log of admin actions; personal-data export per retailer, per person and "download my
  data"; erasure of retailers and people; retention settings for statistics, the audit log and
  decided access requests; a privacy-notice template (docs/privacy-notice-template.md).

### For retailers' software
- OAuth2 client credentials, `/changes` feed with snapshot and live phases, product and GTIN
  lookups, signed image links, exports, webhooks, usage events.

### Hosting
- Cloudflare Workers + D1 + R2 with a Deploy to Cloudflare button (resources created, migrations
  applied), a minute Cron Trigger and an optional Queue.
- Bun: Docker image (multi-arch), Docker Compose, Google Cloud Run script (Litestream), standalone
  binaries for Linux, macOS and Windows that need no runtime.
- Operations: `/healthz`, `/readyz`, Prometheus `/metrics` (with a token), JSON logs with request
  ids, graceful shutdown, configuration checked at start, schema version check, backup and
  restore commands, security headers (CSP, HSTS behind TLS), rate limits.

### Known limitations
- The node does not resize images; the admin UI and `obx` make the web, square and thumbnail
  versions. Images that arrive without them are published with the original in their place
  (marked `x-obx-fallback`).
- The Cloudflare free plan is not enough for daily use (10 ms CPU per request); see
  docs/hosting-cloudflare.md.

[Unreleased]: https://github.com/openbrandexchange/node-ts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/openbrandexchange/node-ts/releases/tag/v0.1.0
