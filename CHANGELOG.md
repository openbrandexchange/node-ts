# Changelog

All notable changes to the Portal for Cloudflare (`node-ts`) are listed here. The project follows
[Semantic Versioning](https://semver.org/): the major version changes when an upgrade needs more
than replacing the software (see [docs/upgrading.md](docs/upgrading.md)); database migrations are
always forward-only and applied automatically.

## [0.2.0] - 2026-11-12

Implements Open Brand Exchange spec 0.2.0: article data for fashion, shoes, bags and luggage (spec
proposal 0002). Additive: retailers' software written for 0.1 keeps working, it ignores the new fields.
Passes `obx-conformance all` built from obx-go 0.2.0 (64 of 65 tests: all 47 required and 17 optional; the
optional S-RATE-2 runs only with `--rate-limit-test`) on Bun and in the Cloudflare
Workers runtime, including the new tests P-CAT-5, P-CAT-6, I-IMP-7 and I-IMP-8.

### Upgrading
- Nothing to do: migration `0005_fibre_flags.sql` runs at start (on Cloudflare also with `npm run deploy`).
  It rewrites the 0.1 fibre keys `recycled_polyester`, `recycled_polyamide`, `recycled_cotton` and
  `organic_cotton` in stored products to the fibre with the flag `recycled` or `organic`. The new article
  data needs no new columns.
- Retailers' software sees `OBX-Version: 0.2` and, in discovery, `obx_version` 0.2 and `spec_version` 0.2.0.

### Added
- **Article data** in the protocol, the Ingest API, the admin screens and exports (protocol.md §5.9):
  product `item_subtype`, `contains_animal_origin`, `footwear_materials`, `certifications` and `features`
  (the typed registry: shell, wheels, lock, expandable, closure, laptop compartment, water resistance,
  detachable and adjustable parts, fit, sleeve length, neckline; other keys kept as sent); variant
  `size_length`, `measurements` (cm, kg, l, inch) and `color.family`; fibre flags `recycled` and `organic`.
  Every product and variant carries the new properties, `null` when not stated; inside `measurements` and
  `features` only stated members appear, and the fibre flags only when true.
- **Imports** read the 0.2 columns (import-format.md §1.6): `item_subtype`, `contains_animal_origin`,
  `footwear_materials`, `certifications` (with `(material)`), `feature:<key>`, `color_family`
  (`colour_family`), `size_length` and the measurement columns (decimal comma accepted, `strap_length_cm`
  as `min-max`), and `(recycled)` / `(organic)` in materials. A column the file does not have keeps the
  field, per feature key and per measurement (rule 9). Values outside the rules are row errors with the
  column.
- **Label completeness warnings** (rule 10) with stable codes `fibre_composition_missing`,
  `animal_origin_unknown`, `footwear_materials_missing` and `fibre_percentages_not_100`: in import results
  (also dry runs) and in the Ingest API's `warning_details`. They never block publishing.
- The retailers' **article data CSV** (`data.csv`, selection CSV, background zips) has the 0.2 columns in
  the order of the import format, a column per registry feature, and stays re-importable.
- The web interface is admin-ui 0.2.0 (commit 2582973): label information, measurements and features on
  the article pages, the article and size forms edit them, label warnings in import results.

### Changed
- The 0.1 fibre keys `recycled_*` / `organic_*` are accepted on every write path and normalised; the node
  never returns them.
- A products.csv row with an error is skipped as a whole: its product values are not applied either (in
  0.1 a row whose variant part failed still updated the product).
- Percentages that do not add up to 100 are no longer a generic warning for every product; they are the
  label warning `fibre_percentages_not_100` for textile item types.
- Through the Ingest API, a registry feature outside its values, a measurement that is not a positive
  number, a `strap_length_cm` whose `min` is above its `max`, and a footwear material or colour family
  outside its list answer `422 validation_failed`. Empty `features` and `measurements` objects and an empty
  `certifications` list are stored as `null`.
- Test fixtures follow spec 0.2.0 (11 products, 46 variants, 35 images) and include `fixtures/imports/`.

### Fixed
- CI and `bun run smoke:workers` trigger the Cron handler of `wrangler dev` through
  `/cdn-cgi/handler/scheduled`: since wrangler 4.160 `/__scheduled` is answered by the static assets'
  single-page fallback, so background jobs on the local Workers runtime only ran inside requests and a
  conformance import could stall. The smoke test now checks that the trigger reaches the Worker.

## [0.1.0] - 2026-11-12

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

### Also in this release

#### Changed

- The web interface is admin-ui 0.1.1 (commit d3ee574): the zip dialog downloads the version you
  picked, website fields accept an address without `https://`, an approved API key can be shown when
  the retailer asked on the web form, the "Get started" list asks to set up e-mail while none is
  configured, and on Cloudflare the scheduled-import form no longer offers SFTP (the node reports
  `settings.node.source_kinds`).
- The start-up log and the setup-code line name the address to open (`OBX_PUBLIC_URL`), not only the
  port inside the container. Docker Compose derives the default public address from `OBX_PORT`.
- The web interface is served under admin-ui's strict Content-Security-Policy: no inline styles.

#### Fixed

- A missing file under `/assets/` or `/locales/` is a 404, also when the browser accepts HTML, so a
  tab left open during an upgrade reloads once instead of reading the start page as code.
- `LICENSE` and `NOTICE` of the web interface are served as plain text.
- A chosen `OBX_SETUP_CODE` is accepted in any case (`kestrel-2026` for `KESTREL-2026`), like the
  generated one.
- An import no longer takes away what it does not state about an image (spec import rule 8): the
  images alone, or with an assets.csv that has no row for them, keep their embargo, credit, alt text
  and AI label, also when those were set in the admin. Before, every such import reset them to the
  defaults, which lifted embargoes.
- Every zip a retailer downloads (one product, the selection, a background download) holds an
  `assets.csv` with one row per image: its usage rights, embargo and AI provenance in the import
  format's columns (spec import-format.md §2.3). Before, a zip held only the files, so a shop could
  publish an embargoed image without seeing the embargo. The background download's article data is
  now `data.csv` (was `products.csv`), as on the other portals.
- A column that a products.csv does not have leaves that field of an existing product or variant as
  it is (spec import rule 9, per language for texts): a file with only `style_number` and `name:nl`
  changes only the Dutch names. Before, it removed the descriptions, materials, care codes and the
  other languages. An empty cell in a column the file has still removes the value.
- Discovery reports `spec_version` 0.1.0 instead of 0.1.0-draft.
- `Settings.retention.download_stats_days` is now `download_events_days`, the name the other two
  portals use; a value stored under the old name is read as the new one.
- Renewing the secret of an API key that was created on approval retires the secret still waiting
  for the requester's software, so that software gets "already collected" instead of a dead secret.

[0.2.0]: https://github.com/openbrandexchange/node-ts/releases/tag/v0.2.0
[0.1.0]: https://github.com/openbrandexchange/node-ts/releases/tag/v0.1.0
