# Changelog

All notable changes to the Portal for Cloudflare (`node-ts`) are listed here. The project follows
[Semantic Versioning](https://semver.org/): the major version changes when an upgrade needs more
than replacing the software (see [docs/upgrading.md](docs/upgrading.md)); database migrations are
always forward-only and applied automatically.

## [Unreleased]

## [0.3.1] - 2026-11-21

Implements Open Brand Exchange spec 0.3.1: portal appearance (Node Admin API: theme, login page, start page,
branding images, favicon) and the MAISON NOOR test data. Also fewer D1 round trips per request, and self-hosting with
the one-line installer. The web interface is admin-ui 0.3.1. Nothing changes under `/obx/v1`.

### Added
- The web interface is admin-ui 0.3.1 (its mock on MAISON NOOR): the showroom redesign (theme engine, Appearance editor, start page, quick
  view), so the demo opens on the MAISON NOOR start page.
- **Portal appearance** (spec node-admin.yaml, docs/node-admin.md "Portal appearance"): `branding.theme`
  (colour scheme, five colours, fonts, radius, grid density, card style, image fit and background),
  `branding.login` (centered or split layout with an image, title, text) and `branding.home` (start page of up to
  30 blocks: hero, tiles, text, image_text, products, announcement, contact). Unknown members and block types are
  stored and returned unchanged. Branding images (`POST/GET /admin/api/settings/images`, `DELETE …/{id}` with `409`
  while used, public `GET /admin/api/public/images/{id}` cached for a year), favicon (`PUT/DELETE
  /admin/api/settings/favicon`). Public branding adds `favicon_url`, `theme` and `login`; the portal viewer adds
  `home` with image URLs. Migration `0009_branding_images.sql`.
- Demo: the MAISON NOOR showroom (theme, login page, start page) and drawn product shots in the seed
  (`scripts/demo-art.ts`, `scripts/demo-showroom.ts`); the demo brand can try out the appearance (at most 20
  images, 2 MiB per upload).

### Changed
- Demo and test data follow spec 0.3.1 (spec 7a4c9ef): the fixtures' fictional brand is now MAISON NOOR instead of
  Kestrel (brands `maison-noor` and `noor-atelier`, article numbers MN-/NA-, `test/fixtures/maison-noor`). The demo
  brand is `brd_demo_maison_noor` with external id `maison-noor`, its admin `brand@maison-noor.example`; `bun run dev`
  logs in as `admin@maison-noor.example` with setup code `NOOR-LOCAL`. CI runs the conformance suite of obx-go v0.3.1.
- Fewer database round trips per request (on D1 each one is a network call): the session, its user and retailer in
  one batch; settings, setup flag and demo state shared by the requests of an isolate for 5 seconds; facets,
  product list, viewer and signed renditions read in one or two batches; public reads skip the session. Portal
  facets went from 14 queries to 2 round trips, the product list from 9 to 3, the viewer from 7 to 2.
- Demo: a demo nobody changed is no longer reset every hour (an idle demo wrote ~10,000 D1 rows a day); it resets
  after a visitor's change, once a day, or when the seed archive changes.
- Cloudflare docs use `bun run deploy` and `bunx wrangler`.

### Documentation
- Self-hosting on your own server is now one command: `curl -fsSL https://openbrandexchange.com/install.sh | sudo sh -s -- --edition ts --domain portal.yourbrand.com`
  (the node-go installer with `--edition ts`: the standalone binary as the `obx-portal` service, HTTPS through
  Caddy). [docs/hosting-standalone.md](docs/hosting-standalone.md) explains DNS, updating, backups, uninstalling
  and running behind your own proxy, and keeps the manual install as an appendix.
- The Cloudflare guide explains the DNS for your own domain.
- Docker and Google Cloud Run are no longer production routes: `docs/hosting-docker.md`, `docs/hosting-cloud-run.md`
  and `deploy/cloudrun/deploy.sh` are removed; the `Dockerfile` and `compose.yaml` are for local development and
  CI ([docs/development/docker.md](docs/development/docker.md)). The other editions are now called "Portal for
  your own server" (node-go) and "Portal for web hosting" (node-php).

## [0.3.0] - 2026-11-17

Implements Open Brand Exchange spec 0.3.0: materials and care as terms with names (spec proposal 0004,
[openbrandexchange/spec#3](https://github.com/openbrandexchange/spec/pull/3)), with a list of qualifiers per fibre
(`recycled` + `post_consumer`), a `percentage` that may be `null`, stable default variant ids, extension members
kept everywhere, and the behaviours every node now shares (spec e74ccb2). Also: demo mode, a one-command local run,
and the retailer portal filter on qualifiers. **Breaking for retailers' software that reads `materials` or
`care`**; everything else is unchanged. From 0.3.0 on, `/obx/v1` changes only by addition (spec versioning.md).

### Upgrading
- Migrations run at start (on Cloudflare also with `npm run deploy`). `0006_terms.sql` rewrites stored 0.2
  materials to the 0.3 form: the part and the material become `{"code": …}`, the flags `recycled: true` /
  `organic: true` become a qualifier. `0007_qualifiers.sql` turns the single `qualifier` of a fibre (stored by
  0006 and by builds of this branch before the release) into the list `qualifiers`. Care needs no change.
  `0008_idempotency_keys.sql` adds the table that keeps Idempotency-Keys with the hash of their request.
- **Variant ids in imports**: a CSV/Excel row without `variant_id` now makes the variant
  `<style>-<color>-<size>[-<size_length>]` instead of using the GTIN. Existing variants keep their ids (a row
  finds them by GTIN first), so nothing changes for a catalog that is already there; new variants get the new id.
- Retailers' software sees `OBX-Version: 0.3` and, in discovery, `obx_version` 0.3 and `spec_version` 0.3.0. It
  must read `part.code`, `fibers[].material.code` and `fibers[].qualifiers[].code` instead of `part`, `fiber` and
  the flags, and can show the `name` in the shopper's language.
- Every `/changes` cursor issued before the upgrade (also an export's `changes_cursor`) is `410 cursor_expired`
  (spec protocol.md §6.4, conformance P-FEED-7): retailers' software restarts without a cursor and gets a snapshot
  in the 0.3 shapes. Cursors now carry a cursor epoch (2; pre-release 0.3 builds issued epoch 1, which expires too).
- Brands' own systems that write through the Ingest API must send the 0.3 shapes (see Changed); CSV files keep
  working as they are, except that a percentage with a decimal comma (`95,5% cotton`) is now a row error (write
  `95.5%`).

### Added
- **Variant identity in imports** (spec import-format.md §1.2.1, conformance I-IMP-12): `variant_id`, else the
  variant of this product that has the row's GTIN (it keeps its external id and protocol id, also when its size
  changes), else the default id `<style>-<color>-<size>[-<size_length>]` (`/` and control characters as `_`). A
  GTIN of another product's variant, or a GTIN already used on an earlier row of the file, is the row error
  `gtin_conflict` (column `gtin`); a second row of the file for the same variant is `validation_failed` on
  `variant_id`. A GTIN can arrive or change later without a new
  variant. The Ingest API's `gtin_conflict` names the variant that has the GTIN and its product.
- **A fibre without a percentage** (`percentage: null`, `outer: leather` in the CSV); `fibre_percentages_not_100`
  only when every fibre of the part states one, or the stated ones exceed 100.
- **Warnings `material_unknown`** (a material code outside the vocabulary, once per code; imports with the code
  as `value`, Ingest API `warning_details` with the pointer to the fibre) and **`qualifier_deprecated`**.
- **Extension members** (`x-<vendor>-<name>`) are stored and returned on every object the schemas allow,
  including inside `color`, material terms, fibres, care entries and certifications; imports keep them.
- **Idempotency-Key with the body compared** on `POST /batch`, `POST /imports` (sha256 of every part) and
  `POST /exports` (same export, also while it runs): another body with the same key is `409
  idempotency_key_reused`.
- **Language tags with script and numeric region** (`zh-Hant`, `sr-Latn-RS`, `es-419`); `name:<lang>` columns
  are matched case-insensitively with `_` read as `-` and stored in canonical case.
- **Names for parts, materials, qualifiers and care instructions** in English, Dutch, German and French, from
  the spec's vocabularies (`src/vocabularies/`, copied by `scripts/sync-fixtures.sh` and bundled into the Bun
  and Workers builds), including the new qualifier codes `in_conversion`, `pre_consumer` and `post_consumer`.
  Every care entry has its ISO 3758 `category` and its GINETEX `symbol` (e.g. `1_D_30`). Codes outside the
  vocabularies keep the name, category and symbol that were written, or `null`.
- **Several qualifiers per fibre**: `qualifiers` is a list of terms in the brand's order, `[]` when none; a repeated
  code counts once. Imports: one code per bracket, as many brackets as needed, e.g.
  `100% polyester (recycled) (post_consumer)`; `(organic, recycled)` is a row error.
- **Retailer portal filter on qualifiers** (Node Admin API): `qualifier` (repeatable, or comma-separated) on
  `/admin/api/portal/products`, `/admin/api/portal/facets`, the article data CSV and `DownloadJobInput.filter`;
  a product matches when any fibre of any part has any of the codes (OR within the parameter, AND with the
  others). New facet `qualifiers` (`value` the code, `label` the name per language, `count` the products).
- **Run it locally with one command**: `bun run dev` starts the portal with SQLite in `./data-dev`, the setup code
  `KESTREL-LOCAL`, the admin screens, the Kestrel example catalog with images, a brand admin and a retailer
  account, and prints the address and logins (README, "Run it locally"). `bun run dev:demo` does the same in demo
  mode (`./data-demo`). The previous `bun run dev` (Bun with reload, nothing seeded) is what `bun run dev` does
  after the first run.
- **Demo mode** (`OBX_DEMO=true`, off by default; [docs/demo.md](docs/demo.md)): a public demo portal
  with a one-click sign-in as a fixed demo retailer or a fixed demo brand admin (optionally behind
  Cloudflare Turnstile), the banner "Demo, fictional data" (admin-ui), a public read-only API key,
  and an automatic reset to the Kestrel fixtures (every `OBX_DEMO_RESET_MINUTES`, default 60, and on
  demand). Passwords, e-mail, API and upload keys, webhooks, scheduled pulls, the shared accounts and
  large uploads are refused or neutralised; per-address rate limits (Workers rate limiting bindings).
  `scripts/demo-seed.ts` builds the seed archive; `deploy/demo/wrangler.jsonc` is the Open Brand
  Exchange demo deployment. Problems may carry `x-obx-…` extension members.

### Changed
- `materials`: `{"part": {"code", "name"}, "fibers": [{"material": {"code", "name"}, "percentage",
  "qualifiers": [{"code", "name"}, …]}]}`; `fiber` and the flags `recycled`/`organic` are gone. The part
  `main` has the name `null`.
- `care`: every entry is `{"code", "category", "symbol", "name", "text"}`; `text` is the brand's own extra text.
- Ingest API and admin: `name`, `category` and `symbol` may be left out on write, and so may `qualifiers`
  (= none); names of known codes are not stored, so PUTting back a record's `data` is `unchanged`. The 0.2 shapes
  (a string `part`, `fiber`, `recycled`, `organic`) and a single `qualifier` are `422 validation_failed`; the 0.1
  keys `recycled_*` / `organic_*` still become the material with that qualifier, first in the list.
- Imports: the label warning `animal_origin_unknown` is decided on the material code. Exports write every
  qualifier in its own brackets, and always fill `variant_id`.
- **Unknown members never fail a write** (ingest.md §3.1): any unknown member, at any depth (a fibre, a term, a
  care entry, a certification, `color`, `rights`, `provenance`, `measurements`, `footwear_materials`), is ignored
  with a warning naming its JSON Pointer; before, unknown members inside materials, care, certifications,
  measurements and footwear materials were `422`. The 0.2 members `fiber`, `recycled` and `organic` are such
  unknown members now.
- **The draft single `qualifier`** of a fibre is read as `qualifiers: [it]` (`null` = none; `qualifiers` wins when
  both are sent) with one warning `qualifier_deprecated` per write, on every JSON write path (I-MAT-1); it is
  never stored or returned. It was a `422` before.
- **`limit` above the maximum is clamped** on every list (protocol, Ingest, admin, portal); not a whole number or
  below 1 is `400 invalid_request`.
- **Signed rendition URLs**: a tampered or expired link (also an expiry without its signature) is `403 forbidden`;
  neither signature nor token is `401 unauthorized`; a valid Bearer token is served whatever the signature says.
- Test fixtures follow spec 0.3.0 (spec commit e74ccb2): Kestrel variant ids `KO-1001-NVY-M` …, KO-1005's
  outer part `leather` without a percentage, the import fixtures `id-1` … `id-4`, `5-invalid.csv` and
  `label-warnings.csv`.

### Web interface
- admin-ui 0.3.0 (`5ad8f05`): several sustainability claims per fibre and the portal filter on them, an empty
  percentage in the materials editor, the default variant id in the new-variant form, extension members kept when
  a form is saved, the warnings `material_unknown`, `qualifier_deprecated` and `idempotency_key_reused`, and
  language tags with script and numeric region.

### Fixed
- `GET /obx/v1/products/{id}` with `If-None-Match` uses the weak comparison (RFC 9110 §13.1.2), so it
  answers `304` behind Cloudflare, which sends the ETag as `W/"…"` when it compresses the answer
  (conformance P-CAT-1 against a deployed Worker).

## [0.2.1] - 2026-11-12

Excel workbooks next to CSV files (spec import-format.md §5). Passes `obx-conformance all` built from
obx-go 0.2.1 in the Cloudflare Workers runtime, including the optional Excel tests I-IMP-9 and I-IMP-10.

### Upgrading
- Nothing to do: no migration; take the new release as described in [docs/upgrading.md](docs/upgrading.md).
  Retailers' software sees no change.

### Added
- **Excel import** (spec import-format.md §5, a node feature; conformance I-IMP-9 and I-IMP-10): an
  Excel workbook (`.xlsx`) is accepted wherever a CSV is: the admin upload and the Ingest API's `csv` /
  `assets_csv` parts (a file name ending in `.xlsx`, or a part without a name with the xlsx content type),
  `products.xlsx` / `assets.xlsx` in a package zip and in a scheduled pull folder, and a web address ending
  in `.xlsx`. The sheet `Products` (`Assets`) is read, else the first visible sheet with the key column;
  only stored values (no formula is calculated), numbers exactly as stored (GTINs keep every digit), dates
  as ISO dates; the rows are then imported as `products.csv` / `assets.csv`, unchanged. Errors carry
  Excel's row numbers and a `row 12, column ean (C): ` locator. The templates import as they are.
- New error codes `workbook_invalid`, `workbook_unsafe` (macros, ActiveX, external links, data
  connections), `workbook_sheet_missing` and `workbook_too_large` (fixed limits against zip bombs and
  oversized sheets): a refused workbook (also `payload_too_large` above the 64 MB CSV limit) fails the
  import run with that code and one ImportRowError (row and column null), and nothing of the import is
  written; `.xlsm`, `.xls`, `.xlsb`, `.ods` and `.numbers` uploads are answered with
  `unsupported_media_type`. A package or folder with both `products.csv` and `products.xlsx` (or both
  assets files) is `import_invalid`.
- The web interface is admin-ui 0.2.1 (commit 271150c): imports take `products.xlsx` and `assets.xlsx` and
  link the Excel templates; import problems read "Row 12, column EAN (C)", sorted by row or by problem, with
  a CSV download of the whole list; a refused workbook is explained in plain words. Retailers get "Article
  data (Excel)" next to the CSV, and the article page shows the brand's own extra fields. The language files
  the browser loads no longer carry the e-mail texts (the node still reads them from `public/locales/`).

### Changed
- Header names (spec import-format.md §1.1): only space, tab, CR and LF are trimmed, each run of them and
  `-` counts as one `_`, and an empty header name is no column (no "Unknown column" warning).

### Fixed
- An `assets.csv` row whose image is neither in the import nor in the `images_manifest` is the error
  `files_missing` (spec import-format.md §2.2); it was silently ignored.

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

[0.3.1]: https://github.com/openbrandexchange/node-ts/releases/tag/v0.3.1
[0.3.0]: https://github.com/openbrandexchange/node-ts/releases/tag/v0.3.0
[0.2.1]: https://github.com/openbrandexchange/node-ts/releases/tag/v0.2.1
[0.2.0]: https://github.com/openbrandexchange/node-ts/releases/tag/v0.2.0
[0.1.0]: https://github.com/openbrandexchange/node-ts/releases/tag/v0.1.0
