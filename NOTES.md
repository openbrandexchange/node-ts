# Implementation notes (node-ts)

Decisions taken where the spec (v0.1.0, and since node-ts 0.2.0 spec v0.2.0) was silent, ambiguous or in tension with the project requirements. Each is the simplest reading that works on both runtimes; they are also reported to the spec maintainers.

## Protocol and ingest

1. **Missing renditions fall back to the original (requirement: "serve the original and flag it in the admin").** The spec makes an asset visible only when the original *and* all renditions exist. This node has no image library, and scheduled imports (URL/S3) or n8n flows deliver originals only, so strict visibility would leave those images unpublished forever. Here an asset is visible once its **original** exists; a missing `web`/`square`/`thumb` is served from the original bytes, the Rendition carries the original's type/size/hash and `"x-obx-fallback": true`, and the admin sees it (`IngestRecord.missing_files`, `AdminProductSummary.pending_asset_count`, filter `visibility=pending_files`). `IngestInfo.renditions` still says `server_generated: false` and lists all four as required, so clients (admin UI, `obx`) keep uploading them. When a rendition arrives later it is an ordinary asset upsert. Conformance runs are unaffected because the runner uploads renditions.
2. **`pending_files`** therefore means "no original yet".
3. **Replacing an original with `PUT …/files/original`** while the asset has all renditions stages the new original; the previous files keep being served until all three renditions uploaded afterwards are present, then it swaps (one upsert). If they never arrive, the staged original is promoted after 15 minutes (renditions fall back). With `PUT /assets/{id}` and `files` containing a new `original` but not all renditions, the renditions that belonged to the old original are dropped.
4. **Change entries are computed by diffing visibility and a representation hash** of every object a write loaded (parent, then variants by external_id, then assets by colour/position). Brand (un)publishing uses set-based SQL for the cascade. `updated_at` of an object changes whenever an upsert entry is written for it or its representation changes.
5. **Batch replay and the omission rule.** `/changes` omits upserts of objects that are invisible at read time (protocol §6.2). A consumer that reads only after a whole batch therefore sees fewer entries than `expected-changes.json` lists for the one-at-a-time replay (only deletes and still-visible objects). Our I-REPLAY-2 test checks exactly that; `obx-conformance` should do the same or read per operation.
6. **Cursors** are sealed (HMAC) JSON with the node id: snapshot cursors expire after 24 h, live cursors below the retention floor get `cursor_expired`. History older than 100 days is pruned.
7. **Access tokens** are stateless sealed tokens (1 h) that carry the client's secret version; every request re-checks the client and retailer rows, so revoking, blocking and rotating take effect immediately.
8. **Rendition URLs** are signed per viewer (`a=c.<client>` / `u.<user>` / `p.<admin preview>`), valid 60–90 minutes (rounded to 30-minute buckets so browsers can cache thumbnails). Each download re-checks that the actor is still active and still allowed to see the asset.
9. **Images of all colours** (import-format.md, "all colours"): the colour part `ALL` in a file name, or an empty `color_code` in `assets.csv`, gives `color_code: null` and the external id `{style}_ALL_{position}`. File-name qualifiers follow the spec: two-part keys (`size_chart`, `tilted_left`, `tilted_right`) first, the rightmost role and view win, `other` is the view when the name also has another role.
10. **`changes.available` webhooks** are sent at most every 30 seconds per subscription (minute tick plus right after writes). Retries: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, then given up; a subscription failing for 3 days is disabled.
11. **Exports** keep one running export per API key; parts are ≤ 2 GiB, the manifest is streamed from stored lines (header counts are final). Exports expire 48 h after finishing.

## Article data (spec 0.2.0)

Article data: protocol.md §5.9, import-format.md §1.6 and rules 9 and 10, ingest.md §3.4. Code: `src/core/article.ts`.

A1. **Storage.** The 0.2 fields live in the stored JSON document of the product or variant, like every other
    field, so D1 and bun:sqlite need no new columns. They are stored only when stated (a 0.1 document and a
    0.2 document without article data compare equal, so upgrading does not make every product "updated"),
    and the representations return each of them, `null` when not stated, with `color.family` added to
    every colour. `migrations/0005_fibre_flags.sql` rewrites the four documented 0.1 fibre keys
    (`recycled_polyester`, `recycled_polyamide`, `recycled_cotton`, `organic_cotton`) in stored products;
    any other `recycled_<fibre>` / `organic_<fibre>` is normalised when it is read (protocol, admin record,
    CSV) and stored normalised on the next write. A re-import of a 0.1 file is therefore `unchanged`.
A2. **A row with an error is skipped as a whole** (its product values and its variant). `fixtures/imports/5-invalid.csv`
    needs this (a bad `height_cm` on a variant row leaves the product uncounted); in 0.1 this node still
    applied the product part of a row whose variant part failed.
A3. **Label warnings** (rule 10) are computed on every accepted product write on the product as stored (rule 9
    kept values included): in an IngestResult as `warning_details` (only when there are any) and as
    `"<code>: <detail>"` in `warnings`; in an import once per product, at its first row, with the code in
    `obx_error` and the column of rule 10. They count in `counts.warnings` and are reported by dry runs too.
    `fibre_percentages_not_100` is for textile item types only (spec 43fa091; the materials parser no longer
    warns about the sum for every product). Animal fibres: rule 10's list plus every key ending in `_wool`
    (as obx-go).
A4. **Ingest API strictness.** The 0.2 sub-schemas are closed: an unknown member of `footwear_materials`, a
    certification or `measurements` (other than `x-…`) is `422`, a registry list with a duplicate is `422`
    (schema `uniqueItems`; the CSV drops duplicates instead), `color.family` must be one of the families
    (`gray`/`multicolor` are accepted only in CSV cells), and `strap_length_cm` with `min` above `max` is `422`
    (spec 43fa091). Empty `features`/`measurements` objects and an empty `certifications` list are stored as
    `null`; so is a `footwear_materials` object without any part (see open question S2).
A5. **Warnings without a code of their own** use `validation_failed` with severity `warning`: an unknown
    `feature:<key>` column (once, on the header, `row: null`; its cells are stored as text), a `color_family`
    that differs between rows of one colour, and a `color_family`, `size_length` or measurement cell on a row
    without variant columns (ignored, one warning per cell). A feature that differs between rows of one product
    keeps the first value with a warning, per key.
A6. **Article data CSV** (portal `data.csv`, selection CSV, background zips) has the columns of import-format.md §1.2
    in order: `item_subtype` after `item_type`; `contains_animal_origin` and `footwear_materials` after
    `materials`; `certifications` after `country_of_origin`; after `status` a `feature:<key>` column for each
    registry key and then the other keys the exported products have (sorted), then `attr:<key>`;
    `color_family` after the colour names, `size_length` after `size`, the twelve measurement columns after
    `size_system`. Booleans are `yes`/`no`, lists `|`-separated, `strap_length_cm` is `min-max` (one number when
    equal). It keeps `product_id`, `status` and `variant_status` as in 0.1 (see S3). Re-importing it is unchanged.

Open questions reported to the spec maintainers (0.2.0):

- S1. **Whole-row rejection** (A2) follows from `fixtures/imports/expected.json` ("every row is skipped") but
  import-format.md §1.6 only says "an error `validation_failed` for that row"; rule text for "a row with an
  error writes nothing of that row" would make it explicit for every node.
- S2. **`footwear_materials` with no part stated** (`{}` or all three `null`) via the Ingest API: protocol.md §5.9.2
  says a part that is not stated is `null` and responses include all three parts, but not whether such an object
  is `null` as a whole (as `measurements`/`features` are). This node stores `null`.
- S3. **Export columns and status:** §1.2 says exports use "the same columns in the order of the tables", which
  includes `status` and `variant_status`; obx-go's `canonicalcsv` export and the admin-ui mock leave them (and the
  mock also `product_id`) out. This node keeps them (they are importable and were in 0.1).
- S4. **`licence_number`** is not required by Certifications.json; this node always returns it (`null` when not
  stated), as the expected fixtures show it.

## Admin and portal API

12. **Settings extension:** `branding.portal_name` (LocalizedText or null, in Settings and PublicBranding) lets a brand override the local word in "<Brand> · <word>"; it is the field the admin UI edits (admin-ui NOTES item 2). Fallback per language: the brand's text for the language, then its `en`, then its first text, then the vendored `glossary.portal`, then `PORTAL_WORD` in `src/core/mail.ts`.
13. **Public logo** is served at `/admin/api/public/logo?v=<hash>` and used in discovery and branding. A brand's `logo_url` from ingest is published as given (not mirrored).
14. **Portal product list** accepts `cursor` and `limit` (default 48, max 200), ordered by style number. Facet counts exclude the facet's own filter (so several values of one facet can be combined).
15. **EAN paste** (`text`) splits on every non-digit, including spaces (as the admin spec says); the protocol lookup (`gtins`) keeps inner spaces inside one code.
16. **Admin product list** `visibility=pending_files` = products with images that miss an original or a web version.
17. **Cookies:** `obx_session` and `obx_csrf` are `Secure` when the request came over HTTPS (on Bun, `X-Forwarded-Proto` counts only with `OBX_TRUST_PROXY=true`). A portal served over plain `http://` on a LAN would otherwise be unable to log in.
18a. **API keys** made in the admin (or on approval of an access request) get `catalog:read` + `media:read` (+ `media:original` when the retailer may download originals); `usage:write` only when the admin asks for it. What a key can see is always limited by the retailer's grant at request time.
18b. **Wrong methods** on an existing path answer `405 method_not_allowed` with an `Allow` header; unknown paths answer `404 not_found`.
18. **Links in e-mails** go to real UI routes: `/invite/{token}`, `/reset-password/{token}`, `/downloads` (zip ready), `/admin/requests` (new access request), `/login` (approved without a portal invitation; with one, the invitation e-mail is the way in).

## Privacy, audit log and retention (admin API extensions, not yet in node-admin.yaml)

- `GET /admin/api/audit-log?limit&cursor&action&actor_id&target_id&outcome=succeeded|failed` (admins): `{items, next_cursor}`; each item `{id, at, actor {type, id, name, role}, action, target {type, id} | null, status, detail, ip, request_id}` (the fields node-php also returns) plus `method`, `route`, `target_id` and `succeeded`. Every non-GET admin API request is recorded after it ran (also failures), plus sign-ins (the attempted account, also when it fails), setup, password resets, invitation acceptance, retailers' self-service API keys and personal-data exports. Retailer browsing, selections and downloads are not audit entries (they are download statistics). Request bodies are never stored. `action` is derived from the route: `PATCH /admin/api/retailers/:id` → `retailers.update`, `POST …/:id/approve` → `access-requests.approve`.
- `GET /admin/api/retailers/{id}/export` and `GET /admin/api/users/{id}/export` (admins), `GET /admin/api/me/export` (anyone signed in): a JSON attachment (`format: "obx-personal-data-export/1"`) with everything stored about that company or person: accounts, API keys (never secrets), webhooks, access requests, selection, download events, audit entries and the retention periods. `DELETE /admin/api/me`: a retailer's person deletes their own account (administrators are removed by another administrator).
- Deleting a retailer or a person erases the personal data: accounts, sessions, selections, password resets, API keys, webhooks and access requests are deleted; download statistics keep only the company name; audit entries keep the account id but lose name and IP.
- `Settings.retention` = `{download_events_days: 730, audit_log_days: 365, ip_days: 30, access_requests_days: 365}` (30–3650 days; `ip_days` 1–30; unknown keys are refused), the same keys and ranges as node-php. Housekeeping (every 10 minutes) deletes older download events, audit entries and decided access requests, removes people's names from download events after 400 days (or the shorter retention) and clears audit IPs after `ip_days` (at most 30, security.md §9).

## E-mail strings

The node renders e-mails from the vendored admin-ui locale files `public/locales/<lang>.json` (the admin-ui owns the texts; `scripts/update-ui.sh` refreshes them), then the English file, then a built-in copy of the English strings. Placeholders are `{{name}}`. Templates and the keys used, all under `email.`:

- common: `greeting` / `greetingNoName`, `signoff`, `footer`, `linkFallback`
- `invite` (heading, body, button, expiry, ignore), `passwordReset` (same)
- `accessRequestReceived` (to the requester), `accessRequestNew` (to the brand's admins)
- `accessApproved` (heading, body, button, apiNote when an API key was created), `accessRejected` (heading, body, reason when given, contact)
- `zipReady` (heading, body, button, expiry)

The recipient's language is the user's language, the requester's `contact.language` (or, when the request did not send one, the best match of its `Accept-Language` header), or the portal's default language.

## Runtime differences

19. **Passwords:** argon2id (m = 19 MiB, t = 2) via Bun's native implementation on Bun; bcrypt cost 10 on Workers (no native argon2 there). Bun verifies both formats; a database moved from Bun to Workers needs password resets.
20. **Workers limits:** single uploads are capped at 32 MiB (larger files use resumable uploads); Cloudflare limits request bodies to 100 MB (Free/Pro) or 500 MB (Enterprise), below the advertised `max_import_bytes` (2 GiB). Large imports should use the `images_manifest` path (what `obx push` does). The Workers Paid plan is needed for real use (10 ms CPU on Free is not enough for password checks and zips); `wrangler.jsonc` sets no `limits` (the Paid default of 30 s CPU covers every step, and a `limits` entry is refused on Free, which would break the Deploy button there). D1 allows 1,000 queries per invocation on Paid (50 on Free): background steps count their queries and checkpoint at `OBX_D1_QUERY_BUDGET` (default 800). D1 limit errors (daily free allowance, database full, too many queries) answer `503 service_unavailable` with a sentence the brand can act on. See docs/hosting-cloudflare.md.
21. **Background work on Workers** runs in `waitUntil` right after the request (20 s budget), in the minute Cron Trigger (25 s) and, when the optional Queue is bound, in queue consumers that re-queue themselves until a job is done. Each job step checkpoints (zip tail parked in R2, multipart upload resumed), so long zips survive CPU limits.
22. **SSRF:** URLs are checked before every request and every redirect hop; link-local and cloud-metadata addresses are refused even with `OBX_ALLOW_PRIVATE_URLS=true`. On Bun the connection goes to the address that passed the check (the URL's host is replaced by that IP, IPv4 preferred; the `Host` header and the TLS server name keep the original name, so certificates are still verified against it), and SFTP connects to the checked address too, so DNS rebinding between check and connect is not possible. On Workers, hosts are resolved with DNS-over-HTTPS for the check; Workers cannot reach private networks at all.
23. **SFTP** scheduled imports need the Bun build (`ssh2-sftp-client`, optional dependency); the Workers build answers `not_implemented` for SFTP sources.
24. **Setup code on Workers** is generated and logged on the first request when `OBX_SETUP_CODE` is not set (view it with `wrangler tail` or in the dashboard logs). On Bun a fresh code is printed at every start until setup is done.
25. **D1 batches** larger than 500 statements are split (each part atomic). Catalog writes stay well below that; brand cascades are set-based.
26. **Web interface files on Workers** are served by Cloudflare's asset router, not by the Worker, so they cost no Worker requests. Two consequences, both accepted: a missing file under `/assets/` gets the SPA page (the router's `single-page-application` fallback) instead of the 404 admin-ui's integration guide asks for — the browser refuses it as a script (wrong MIME type) and admin-ui reloads the tab once, which is the behaviour the 404 is for; and hashed assets keep Cloudflare's default `max-age=0, must-revalidate` (answered with 304) instead of `immutable`, because an `immutable` rule on `/assets/*` would also pin that fallback page under an old asset URL for a year and break a rollback. On Bun both follow the guide exactly (`src/adapters/bun/static.ts`). Routing `/assets/*` through the Worker (`run_worker_first`) would fix both at the cost of one Worker request per file.

## Integration (2026-09-28)

- Walked with Playwright against the vendored admin-ui on Bun, Docker Compose and `wrangler dev`: setup wizard, zip import, access request → approve → invitation → retailer login, catalog, article page, single-image download, EAN list, selection zip + CSV, background zip, API key and access key creation, scheduled import from a web address (run now and by the schedule).
- Found and fixed on the way: zip downloads stalled after the first file on Bun (a stream `pull()` that returned without output); a repeated `PUT /blobs/{sha256}` hung on Bun because the request body was cancelled (now read and hash-checked); link-local and metadata addresses were allowed in development mode; header import problems used row 0 (now null).
- `obx-conformance all` passed 47/47 on Bun and on `wrangler dev` then; after hardening (see below) 57/57 on both, 58/58 on Bun with `--rate-limit-test`. `obx push` of `fixtures/kestrel` then a second push (nothing uploaded, all unchanged) and `obx pull` (originals byte-identical, deletes mirrored) work.

## Spec 0.2.0 (2026-11-12)

- `obx-conformance all` built from obx-go 626b3a7 (spec 43fa091): 64 passed, 0 failed, 1 skipped (S-RATE-2,
  optional, needs `--rate-limit-test`) on Bun and on `wrangler dev` with local D1 and R2; all 47 required
  tests pass, including P-CAT-5, P-CAT-6, I-IMP-7 and I-IMP-8 and the 0.2 checks in P-CAT-1.
- Found on the way: with wrangler 4.160 `GET /__scheduled` (the `--test-scheduled` trigger CI used) is
  answered by the assets' `single-page-application` fallback, so the Cron handler never ran in `wrangler
  dev` and the conformance import stalled after its last request-driven step. CI and the smoke test use
  `/cdn-cgi/handler/scheduled`, which wrangler handles before the asset router; production is unaffected
  (Cloudflare calls the Cron Trigger directly).
- Browser tests: the admin-ui 0.2 article page shows the label information above the images, which are
  `loading="lazy"`; the image check scrolls them into view. A new walk opens KO-1010 as a Dutch retailer and
  checks the footwear materials and heel height (with axe).

## Excel import (spec import-format.md §5, unreleased)

- Code: `src/lib/xlsx.ts` (the conversion, a port of the spec's reference `tools/xlsx.mjs`),
  `src/lib/xml.ts` (a streaming XML tokenizer), wiring in `src/core/importjob.ts` (`workbookToCsv`,
  Excel row numbers in `ErrSink.add`), `src/routes/ingest.ts` (upload parts) and `src/core/sources.ts`
  (pull folders, web addresses). Tests: `test/xlsx.test.ts` runs every case of the vendored
  `test/fixtures/imports/xlsx/expected.json` and the number/date/format vectors.
- No dependency: the zip is read with the existing `src/lib/zip.ts` reader (range reads, so a stored
  workbook is never loaded whole) and inflated with `DecompressionStream("deflate-raw")`; the XML is
  tokenized as bytes while it inflates (no DOCTYPE, only the five XML entities and character references,
  well-formedness checked). The chosen worksheet is never held as text: converted rows go straight into
  ~1 MiB UTF-8 chunks of the canonical CSV, which is streamed to storage (`jobs/<id>/csv.csv`) and then
  imported by the unchanged CSV import. Workbook parts are never written anywhere; a workbook inside a
  package zip is inflated into memory (at most the 64 MB CSV limit).
- Merged ranges come after the cells in the sheet XML, so a sheet that has merges is streamed twice (the
  second pass knows which cells to hide); rows or cells out of order (Excel never writes them) fall back to
  the reference algorithm in memory. A part read twice counts once toward the 256 MiB inflated limit.
- Measured (generated workbook, 100 000 data rows; Node 26 / V8, the engine of Workers): 30 columns
  (107 MB sheet XML, 12 MB file) convert in 3.6 s CPU with a JS heap peak of ~16 MB (plus the 37 MB CSV
  output in byte chunks and the file); 12 columns (45 MB XML) in 1.6 s CPU, heap peak ~22 MB. In
  `wrangler dev` (workerd, R2 simulated) they convert in 6.6 s and 3.3 s wall, and the whole import job succeeds. The template converts
  in a few milliseconds. The CSV import of such a file afterwards costs what the same CSV costs.
- Aligned with the spec's later decisions (import-format.md §5.5, §5.6, NOTES 36–42), as node-go and
  node-php: a workbook that cannot be imported (and one above the 64 MB CSV limit, `payload_too_large`)
  fails the import run with its code (`ImportRun.error`) and one ImportRowError with row and column null,
  recorded before the failure so `/results` and `errors_preview` show it; nothing of the import is written,
  also with `dry_run`. A folder workbook above the limit is not downloaded; the job refuses it. Unsafe entry
  names are checked before `[Content_Types].xml` is read. A non-zero number outside 1E-308 to below 1E+308
  (after rounding to 15 digits) is `workbook_invalid`, checked from the decimal text (an exponent of more
  than 9 digits is refused before anything is built), also in date cells; a date after 9999-12-31 is a
  conversion error. A column whose header is empty after trimming (also one emptied by a conversion error in
  row 1) gets one warning when it holds values in rows 2 to R, and its cells are located as
  `row <n>, column <letter>: `; the CSV import ignores empty header names without a warning. Header names
  are normalised as §1.1 now says (only space/tab/CR/LF trimmed, each run of them and `-` one `_`), for CSV
  headers and the sheet choice alike. CDATA sections count as text. In a pull folder `products.xlsx` wins
  over the "only `*.csv`" fallback, which never picks a workbook. `.xlsm`, `.xls`, `.xlsb`, `.xltx`,
  `.xltm`, `.ods` and `.numbers` uploads are answered 415. Zip CRCs are not checked (a corrupt deflate stream
  still fails). The ImportRun `files` list shows the uploaded file name; ImportRowErrors use
  `products.xlsx` / `assets.xlsx`.
- `assets.csv` rows whose image is neither in the import nor in the `images_manifest` are `files_missing`
  (§2.2), checked once the job knows every image name.

## Production hardening (2026-09-28)

- Ops: `/readyz`, request ids in every log line, Bun access log, Prometheus `/metrics` behind
  `OBX_METRICS_TOKEN`, configuration checked at start (exit 78), graceful shutdown, migrations
  recorded in `d1_migrations` (shared with `wrangler d1 migrations apply`) and a refusal of databases
  from newer versions, backup/restore commands (tested in `test/backup.test.ts` and, with Docker, by
  `scripts/backup-restore-test.sh`), security headers (HSTS behind TLS, COOP, Permissions-Policy,
  `default-src 'none'` on API responses), 405 with `Allow` for wrong methods.
- Sign-in throttling counts failed attempts only (the e2e walk locked itself out after ten
  successful sign-ins from one address before).
- Load test (`scripts/loadtest.ts`, docs/performance.md): HMAC via node:crypto, page-first list
  queries, indexes for lists, facets and every periodic query; the blob clean-up is one set-based
  pass per day. D1 bills rows read, so periodic full-table scans (staged originals every minute,
  per-blob LIKE scans) were the most expensive part of an idle portal.
- Cloudflare: `npm run deploy` = `wrangler deploy && wrangler d1 migrations apply DB --remote`; no
  `limits` block; background steps stop at 800 D1 queries per invocation; D1 limit errors answer 503
  with an actionable sentence.

## Open items (tracked here, with the reason they are open)

1. **Admin API extensions not yet in the spec or the admin screens:** `GET /admin/api/audit-log`,
   `GET /admin/api/retailers/{id}/export`, `GET /admin/api/users/{id}/export`,
   `GET /admin/api/me/export`, `DELETE /admin/api/me` and `Settings.retention` (shapes in the section
   "Privacy, audit log and retention" above). They work over the API; node-admin.yaml and admin-ui
   need to add them so brands see them in the screens. The paths are the same in node-php and node-go;
   node-php uses the same `Settings.retention` keys, node-go sets retention through environment
   variables (`OBX_STATS_RETENTION_DAYS` …); node-php names actions `METHOD /route`, node-go and this
   node `retailers.update`. The spec should settle one shape. Reason: other repositories.
2. **Deploy to Cloudflare button** needs the repository to be public; until then option B of the README.
   Reason: the owner decides when repositories go public.
3. **Not run against real cloud accounts:** a real Cloudflare deploy (verified: `wrangler deploy
   --dry-run`, the prebuilt bundle in `wrangler dev`, the whole flow in `bun run smoke:workers`,
   conformance on `wrangler dev`) and `deploy/cloudrun/deploy.sh` (shellcheck only; gcloud is not
   installed here). Reason: no cloud accounts may be used from this environment.
4. **D1 row estimates** in docs/hosting-cloudflare.md are estimates from query plans and table sizes,
   not measured on D1 (the local simulator does not bill). Reason: needs a real account; the D1
   dashboard shows the real numbers.
5. **Passwords** are argon2id on Bun and bcrypt on Workers; a database moved from Bun to Workers
   needs password resets (documented in operations.md). Reason: Workers has no native argon2.
6. **No server-side image resizing** (by design of this edition, see item 1 at the top).
7. **Protocol API rate limits** are in memory per process or Workers isolate (best effort); the
   security-sensitive limits (sign-in, setup, resets, access requests, tokens) are in the database.
   Reason: a per-request D1 write for every API call would cost more than it protects.
8. **Streamed zip downloads on Bun** go out chunked without `Content-Length`, so browsers show no
   download progress. Reason: Bun.serve drops the header on streamed bodies; harmless.
