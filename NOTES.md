# Implementation notes (node-ts)

Decisions taken where the spec (v0.1.0-draft) was silent, ambiguous or in tension with the brief. Each is the simplest reading that works on both runtimes; they are also reported to the spec maintainers.

## Protocol and ingest

1. **Missing renditions fall back to the original (brief: "serve the original and flag it in the admin").** The spec makes an asset visible only when the original *and* all renditions exist. This node has no image library, and scheduled imports (URL/S3) or n8n flows deliver originals only, so strict visibility would leave those images unpublished forever. Here an asset is visible once its **original** exists; a missing `web`/`square`/`thumb` is served from the original bytes, the Rendition carries the original's type/size/hash and `"x-obx-fallback": true`, and the admin sees it (`IngestRecord.missing_files`, `AdminProductSummary.pending_asset_count`, filter `visibility=pending_files`). `IngestInfo.renditions` still says `server_generated: false` and lists all four as required, so clients (admin UI, `obx`) keep uploading them. When a rendition arrives later it is an ordinary asset upsert. Conformance runs are unaffected because the runner uploads renditions.
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
20. **Workers limits:** single uploads are capped at 32 MiB (larger files use resumable uploads); Cloudflare limits request bodies to 100 MB (Free/Pro) or 500 MB (Enterprise), below the advertised `max_import_bytes` (2 GiB). Large imports should use the `images_manifest` path (what `obx push` does). The Workers Paid plan is needed (CPU for password hashing and zips); `wrangler.jsonc` raises `limits.cpu_ms`.
21. **Background work on Workers** runs in `waitUntil` right after the request (20 s budget), in the minute Cron Trigger (25 s) and, when the optional Queue is bound, in queue consumers that re-queue themselves until a job is done. Each job step checkpoints (zip tail parked in R2, multipart upload resumed), so long zips survive CPU limits.
22. **SSRF:** URLs are checked before every request and every redirect hop; link-local and cloud-metadata addresses are refused even with `OBX_ALLOW_PRIVATE_URLS=true`. On Bun the connection goes to the address that passed the check (the URL's host is replaced by that IP, IPv4 preferred; the `Host` header and the TLS server name keep the original name, so certificates are still verified against it), and SFTP connects to the checked address too, so DNS rebinding between check and connect is not possible. On Workers, hosts are resolved with DNS-over-HTTPS for the check; Workers cannot reach private networks at all.
23. **SFTP** scheduled imports need the Bun build (`ssh2-sftp-client`, optional dependency); the Workers build answers `not_implemented` for SFTP sources.
24. **Setup code on Workers** is generated and logged on the first request when `OBX_SETUP_CODE` is not set (view it with `wrangler tail` or in the dashboard logs). On Bun a fresh code is printed at every start until setup is done.
25. **D1 batches** larger than 500 statements are split (each part atomic). Catalog writes stay well below that; brand cascades are set-based.

## Integration (2026-09-28)

- Walked with Playwright against the vendored admin-ui on Bun, Docker Compose and `wrangler dev`: setup wizard, zip import, access request → approve → invitation → retailer login, catalog, article page, single-image download, EAN list, selection zip + CSV, background zip, API key and access key creation, scheduled import from a web address (run now and by the schedule).
- Found and fixed on the way: zip downloads stalled after the first file on Bun (a stream `pull()` that returned without output); a repeated `PUT /blobs/{sha256}` hung on Bun because the request body was cancelled (now read and hash-checked); link-local and metadata addresses were allowed in development mode; header import problems used row 0 (now null).
- `obx-conformance all` passes 47/47 on Bun and on `wrangler dev`. `obx push` of `fixtures/kestrel` then a second push (nothing uploaded, all unchanged) and `obx pull` (originals byte-identical, deletes mirrored) work.
