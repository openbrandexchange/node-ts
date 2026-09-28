# Changelog

All notable changes to the Portal for Cloudflare (`node-ts`) are listed here. The project follows
[Semantic Versioning](https://semver.org/): the major version changes when an upgrade needs more
than replacing the software (see [docs/upgrading.md](docs/upgrading.md)); database migrations are
always forward-only and applied automatically.

## [Unreleased]

### Changed

- The web interface is admin-ui 0.1.1 (commit dabdcd0): the zip dialog downloads the version you
  picked, website fields accept an address without `https://`, an approved API key can be shown when
  the retailer asked on the web form, the "Get started" list asks to set up e-mail while none is
  configured, and on Cloudflare the scheduled-import form no longer offers SFTP (the node reports
  `settings.node.source_kinds`).
- The start-up log and the setup-code line name the address to open (`OBX_PUBLIC_URL`), not only the
  port inside the container. Docker Compose derives the default public address from `OBX_PORT`.
- The web interface is served under admin-ui's strict Content-Security-Policy: no inline styles.

### Fixed

- A missing file under `/assets/` or `/locales/` is a 404, also when the browser accepts HTML, so a
  tab left open during an upgrade reloads once instead of reading the start page as code.
- `LICENSE` and `NOTICE` of the web interface are served as plain text.
- A chosen `OBX_SETUP_CODE` is accepted in any case (`kestrel-2026` for `KESTREL-2026`), like the
  generated one.
- An import no longer takes away what it does not state about an image (spec import rule 8): the
  images alone, or with an assets.csv that has no row for them, keep their embargo, credit, alt text
  and AI label, also when those were set in the admin. Before, every such import reset them to the
  defaults, which lifted embargoes.
- Discovery reports `spec_version` 0.1.0 instead of 0.1.0-draft.
- `Settings.retention.download_stats_days` is now `download_events_days`, the name the other two
  portals use; a value stored under the old name is read as the new one.
- Renewing the secret of an API key that was created on approval retires the secret still waiting
  for the requester's software, so that software gets "already collected" instead of a dead secret.

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
