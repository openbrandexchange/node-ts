# Open Brand Exchange · Portal for Cloudflare

Your own **brand portal** for retailers, running on your own Cloudflare account. It gives your brand:

1. **A portal for your retailers** ("*Kestrel · Beeldbank*", "*Kestrel · Händlerportal*", "*Kestrel · Brand portal*"…). Retailers ask for access, log in, search and filter your products, paste a list of EANs, pick products and download images (original, web or square) and article data (CSV) as zip files.
2. **A standard API for your retailers' software.** Shops, PIMs and ERPs pull your products, EANs, images, rights and AI labels automatically, using the open [Open Brand Exchange](https://openbrandexchange.com) protocol (version 0.3). That includes the article data shops need for their product pages and filters: composition with recycled, organic and regenerative fibres (with the names of parts, materials and care instructions in English, Dutch, German and French), "contains non-textile parts of animal origin", footwear materials, care, certifications, features (wheels, lock, closure, fit …) and per size the measurements (cm, kg, litres), second size and colour family. You hand out an *API key for their software* in the admin.
3. **Automatic upload from your own systems.** Publish from your PIM, ERP, DAM or a shared folder: a nightly CSV + images from a web address or an S3/R2 bucket, the `obx` command-line tool, a GitHub Action, n8n/Make/Zapier or the upload API. Nothing is published twice: unchanged products and images cost nothing.

It is free and open source (AGPL-3.0). You own the data; there is no vendor in between.

> This repository is the TypeScript edition. The same portal also exists as
> **Portal for Google Cloud & Docker** (`node-go`) and **Portal for web hosting** (`node-php`).
> All three speak the same protocol and run the same admin screens.

---

## Quickstart (60 seconds)

### Option A: the Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/openbrandexchange/node-ts)

1. Click the button and log in to Cloudflare (or create a free account).
2. Fill in two values when asked:
   - **OBX_SECRET_KEY**: a long random text of at least 32 characters. On a Mac or Linux: `openssl rand -base64 48`.
   - **OBX_SETUP_CODE**: a code you make up, e.g. `KESTREL-2026`. You type it once in the setup wizard, so nobody else can claim your new portal.
3. Cloudflare creates the database (D1), the file storage (R2), the minute timer (Cron Trigger) and the portal, applies the database migrations, and shows you its address (`https://brand-portal.<you>.workers.dev`).
4. Open that address, enter the setup code, your company name, your languages and your admin account. Done.

> The button works once this repository is public. Until then, use option B.

### Option B: one command

```sh
git clone https://github.com/openbrandexchange/node-ts && cd node-ts
bun install
bunx wrangler login
bunx wrangler secret put OBX_SECRET_KEY      # paste: openssl rand -base64 48
bunx wrangler secret put OBX_SETUP_CODE      # a code you choose
bun run deploy                                # creates D1 + R2 + cron, deploys, applies migrations
```

Details, plans and limits: [docs/hosting-cloudflare.md](docs/hosting-cloudflare.md).

### Try it on your computer

```sh
git clone https://github.com/openbrandexchange/node-ts && cd node-ts
bun install
bun start            # http://localhost:8080 — the setup code is printed in the terminal
```

Data is stored in `./data` (SQLite database + files).

Or in the Cloudflare runtime itself (local D1 and R2 under `.wrangler/state`, nothing leaves your computer):

```sh
echo "OBX_SECRET_KEY=$(openssl rand -hex 32)" > .dev.vars
bunx wrangler dev    # http://localhost:8787
```

Open the address: as soon as the page loads, the terminal prints a line with
`First-run setup code: XXXX-XXXX-XXXX`. (Put `OBX_SETUP_CODE=…` in `.dev.vars` to choose it yourself.)
Two things work differently from a real deployment:

- The minute timer does not run by itself. Scheduled imports run with **Run now**, or when you
  trigger the timer: `curl http://localhost:8787/cdn-cgi/local/scheduled`.
- Imports and notifications refuse `http://` and addresses on your own network. To try a scheduled
  import from a file on your own computer, add `OBX_ALLOW_PRIVATE_URLS=true` to `.dev.vars` (never on
  a real portal).

**Which Cloudflare plan?** Use **Workers Paid** ($5/month). The free plan limits each request to 10 ms of CPU, which is not enough for password checks and building zip files, and its daily database allowance runs out with a real catalog. What happens at each limit: [docs/hosting-cloudflare.md](docs/hosting-cloudflare.md#which-plan-what-the-free-plan-allows-and-what-happens-when-a-limit-is-reached). Storage costs for a typical catalog are a few dollars per month (R2 has no download fees).

---

## After setup

In the admin you find, in plain words:

| Screen | What you do there |
|---|---|
| **Overview** | What needs attention: waiting access requests, articles still waiting for images, recent retailer activity. |
| **Catalog** | Your articles with their sizes (EANs) and images. Publish or take offline, edit, reorder images, add an article by hand. |
| **Imports** | Upload a CSV and images (or one zip) by hand, check first without changing anything, download the CSV template. |
| **Automatic upload** | *Scheduled imports* (a web address or an S3/R2 bucket; SFTP on the self-hosted build) that run hourly, daily or weekly; *Access keys* for your PIM, ERP or the `obx` tool (shown once); *Ready-made recipes*; *Notifications* to your own systems. |
| **Retailers** | Invite people by e-mail, choose which brands they see and whether they may download originals, block a retailer, and create an *API key for their software* (the secret is shown once; renew or switch it off at any time). |
| **Access requests** | Approve (with a portal account, an API key or both) or decline with a short reason. |
| **Statistics** | Downloads per retailer, per article and per day. |
| **Settings** | Logo, accent colour, welcome text, the name of your portal, languages, default image rights, original downloads on/off, article data export on/off, your team. |

Retailers use the same address. They see only what you published, for the brands you allowed them.

### Your own domain

Cloudflare dashboard → **Workers & Pages → brand-portal → Settings → Domains & Routes → Add → Custom domain** (e.g. `brands.yourbrand.com`). Then set the variable `OBX_PUBLIC_URL=https://brands.yourbrand.com` and deploy again, so e-mails link to the right address.

### E-mail

Invitations, password resets, "your download is ready" and "a retailer asked for access" are sent in the recipient's language through an e-mail service with an HTTPS API. Set three variables (Cloudflare: **Settings → Variables and secrets**; Docker: `.env`):

| Variable | Value |
|---|---|
| `OBX_MAIL_PROVIDER` | `resend`, `postmark`, `sendgrid`, `mailchannels` or `webhook` (POSTs the message as JSON to `OBX_MAIL_WEBHOOK_URL`, e.g. an n8n flow) |
| `OBX_MAIL_API_KEY` | the service's API key (as a secret) |
| `OBX_MAIL_FROM` | the sender, e.g. `portal@yourbrand.com` (verify it with the service) |

Without e-mail the portal still works: the admin copies invitation links by hand.

---

## Publishing automatically

Everything below works against **any** Open Brand Exchange portal, because it only uses the standard upload API and the standard CSV format. Full recipes (cron, Windows Task Scheduler, GitHub Action, n8n/Make/Zapier): [spec/docs/automation.md](https://github.com/openbrandexchange/spec/blob/main/docs/automation.md).

**The CSV (or Excel):** one row per size, product columns repeated; images named `{style}_{colour}_{position}.jpg`, e.g. `KO-1001_NVY_1.jpg`, `KO-1001_NVY_2_back.jpg`. Download the template in **Imports**.
Article data has one plain column each (spec import format 0.3): `item_subtype`, `contains_animal_origin` (`yes`/`no`),
`footwear_materials` (`upper: leather; lining_and_sock: textile; outer_sole: other`), `certifications`
(`gots:CU 123456; rws:CU 200101 (material)`), `feature:<key>` (`feature:wheels` = `4`), and per size `size_length`,
`color_family` and the measurements (`height_cm`, `weight_kg`, `strap_length_cm` = `80-130` …). Materials take one
qualifier per fibre in brackets, such as `(recycled)`, `(organic)` or `(regenerative)`: `outer: 100% polyester (recycled)`; the file
holds codes only and the portal adds the names. A column your file does not have leaves that field as it
is (per feature and per measurement). The import warns, without blocking anything, when a label would miss what EU law
requires: the fibre composition, whether there are non-textile parts of animal origin, the footwear materials, or
percentages that do not add up to 100.

**Excel:** upload the workbook (`.xlsx`) instead of the CSV — the template from the spec works as it is.
The sheet named `Products` (or `Assets` for image data) is read, otherwise the first visible sheet with a
`style_number` (`file`) column; formulas are not calculated (their saved result is used), GTINs typed as
numbers keep every digit, and problems name Excel's row and column (`row 12, column ean (C): …`). Save
the file as "Excel Workbook (.xlsx)": workbooks with macros or links to other files are refused.

**Scheduled import (no code):** Automatic upload → Scheduled imports → Add scheduled import → web address of your `products.csv`, `products.xlsx` or zip, or an S3/R2 bucket (a folder may hold `products.xlsx` and `assets.xlsx` in the place of the CSVs). Choose *Only add and update* or *Mirror* (also takes products offline that disappeared from the file — refused when more than half would disappear, so a broken export never empties your catalog).

**The `obx` tool:** create a key in **Automatic upload → Access keys** (or run `obx login https://brands.yourbrand.com` and sign in), then

```sh
export OBX_URL=https://brands.yourbrand.com OBX_TOKEN=obxi_…
obx push ./export                                  # products.csv, assets.csv and the images below it
obx push --csv products.csv --images ./images     # the same with separate files
obx watch ./outbox                                 # keeps publishing whatever lands in a folder
```

`obx` uploads only new images and makes the web versions for you. Keep `assets.csv` (image rights,
embargo dates, AI labels) next to `products.csv`: it is always sent along. An import without it keeps
what the images already have (new images get the portal's defaults).

**Straight from your PIM (developers):**

```sh
curl -X PUT -H "Authorization: Bearer $OBX_TOKEN" -H 'Content-Type: application/json' \
  "$OBX_URL/obx/v1/ingest/products/KO-1001" \
  -d '{"style_number":"KO-1001","name":{"en":"Merino Crew Sweater","nl":"Merino trui met ronde hals"}}'
```

### About web versions of images

This edition does not resize images on the server (Cloudflare Workers has no image library). The admin screens and the `obx` tool make the **web**, **square** and **thumbnail** versions on your computer and upload them with the original. The **original is always stored and served byte for byte** (so embedded C2PA content credentials survive).

When an image arrives without those versions (for example from a scheduled import or an n8n flow), it is still published and the original is served in their place. The admin marks such images with "web versions missing", and the API marks the substitute with `"x-obx-fallback": true`. Open the product in the admin (or run `obx push` once) to add them.

---

## Other ways to host this edition

The same code runs on [Bun](https://bun.sh), with SQLite and files on disk or in any S3-compatible storage.

### Docker / your own server

```sh
git clone https://github.com/openbrandexchange/node-ts && cd node-ts
docker compose up -d              # http://localhost:8080 — data in the "portal-data" volume
docker compose logs portal        # shows the setup code for the wizard
```

Optional settings (e-mail, your own setup code, public address) go in a `.env` file: `cp .env.example .env`. Port 8080 already taken on your computer? Set `OBX_PORT=8090` in `.env` and open http://localhost:8090. Without `OBX_SECRET_KEY` a key is generated into the volume on first start. For images in a bundled S3 server: set `OBX_STORAGE=s3` in `.env` and run `docker compose --profile s3 up -d`.

Put HTTPS in front (Caddy, Traefik, nginx) and set `OBX_PUBLIC_URL` and `OBX_TRUST_PROXY=true`. Back up while it runs with `docker compose exec portal bun src/adapters/bun/backup.ts backup /data/backups/$(date +%F)` (database, files and generated secret key). More: [docs/hosting-docker.md](docs/hosting-docker.md).

### Standalone binary (no Docker, no Bun)

Each release has one archive per platform (`obx-portal-<version>-linux-x64.tar.gz`, `…-linux-arm64`, `…-darwin-arm64`, `…-windows-x64.zip`) with a single executable and the web interface: unpack and run `./obx-portal`. As a systemd service: [docs/hosting-standalone.md](docs/hosting-standalone.md).

### Google Cloud Run

```sh
PROJECT=my-project REGION=europe-west4 ./deploy/cloudrun/deploy.sh
```

The script creates a Cloud Storage bucket, secrets and a service account, builds the image and deploys one always-on instance. Images go to the bucket; the SQLite database is continuously copied to the same bucket with Litestream and restored on start. (Needs `gcloud` and billing on the project.)

---

## Configuration

The most used settings are below; every setting, health checks, logs, metrics, backups and data retention are in [docs/operations.md](docs/operations.md).

| Variable | Default | Meaning |
|---|---|---|
| `OBX_SECRET_KEY` | — (required on Cloudflare; generated into `data/secret.key` on Bun) | Encrypts stored credentials and signs download links. Keep it; changing it breaks stored import credentials and webhook secrets. |
| `OBX_SETUP_CODE` | printed in the log on first start | One-time code for the setup wizard. |
| `OBX_PUBLIC_URL` | API links: the address of the request; e-mails: the address the portal was set up at | Public address used in e-mails and API links. Set it when the portal gets its own domain. |
| `OBX_ALLOW_PRIVATE_URLS` | `false` | Development only: allow `http://` and private addresses for imports and webhooks. |
| `OBX_MAIL_PROVIDER`, `OBX_MAIL_API_KEY`, `OBX_MAIL_FROM`, `OBX_MAIL_WEBHOOK_URL` | — | E-mail, see above. |
| `OBX_STORAGE` | `disk` (Bun) / R2 (Cloudflare) | `s3` for S3-compatible storage: `OBX_S3_ENDPOINT`, `OBX_S3_BUCKET`, `OBX_S3_REGION`, `OBX_S3_ACCESS_KEY_ID`, `OBX_S3_SECRET_ACCESS_KEY`, `OBX_S3_PREFIX`. |
| `PORT` | `8080` | Bun: listen port. |
| `OBX_DATA_DIR`, `OBX_DB_PATH`, `OBX_UI_DIR` | `./data`, `data/obx.sqlite`, `./public` | Bun: where things live. |
| `OBX_TRUST_PROXY` | `false` | Bun behind a reverse proxy: trust `X-Forwarded-For` / `X-Forwarded-Proto`. |
| `OBX_MAX_UPLOAD_BYTES` | 32 MiB (Cloudflare) / 100 MiB (Bun) | Largest single upload; bigger files use resumable uploads. |
| `OBX_RATE_LIMIT_API`, `OBX_RATE_LIMIT_MEDIA` | `600`, `3000` | Requests per minute per API key. |
| `OBX_METRICS_TOKEN` | — | Turns on Prometheus `GET /metrics` (Bearer token, 16+ characters). |
| `OBX_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. JSON logs with a `request_id` per request. |

---

## For developers

```sh
bun install
bun run lint                  # oxlint
bun run typecheck
bun run test                  # unit + HTTP tests (bun:sqlite, spec fixtures in test/fixtures)
bun run audit && bun run licenses   # dependency vulnerabilities and licences
sh e2e/run.sh                 # browser tests with axe and keyboard checks (needs Node.js)
bun run loadtest              # 10,000-product load test (docs/performance.md)
bun run smoke:workers         # the whole flow in the local Workers runtime (wrangler dev, D1 + R2)
bun run dev                   # Bun server with reload on http://localhost:8080
bunx wrangler dev             # Workers runtime locally
```

- `src/app.ts` — the Hono app; `src/platform.ts` — the storage/runtime interface (database, file store, mailer).
- `src/adapters/workers` — Cloudflare (D1, R2, static assets, Cron Trigger, optional Queue); `src/adapters/bun` — Bun (bun:sqlite, disk or S3, SFTP).
- `src/core` — the protocol logic: one write path for all catalog changes (`catalog.ts`), the change feed, imports, zip jobs, exports, webhooks.
- `src/routes` — OBX Protocol (`/obx/v1`), Ingest API (`/obx/v1/ingest`), Node Admin + Portal API (`/admin/api`).
- `migrations/*.sql` — one SQLite schema for D1 and bun:sqlite, applied automatically at start.
- The admin screens come from [admin-ui](https://github.com/openbrandexchange/admin-ui): `scripts/update-ui.sh` (or `bun run update-ui`) copies its committed build into `public/`, including the e-mail strings in `public/locales/`. The admin API is plain REST + JSON (session cookie, `X-CSRF-Token` header on writes, `{items, next_cursor}` lists, problem+json errors), so any SPA stack works, for example React with TanStack Query. When developing the UI, run this node on port 8080 and let the UI's dev server proxy `/admin/api`, `/obx` and `/.well-known` to it (same origin, no CORS needed).
- Contracts: [openbrandexchange/spec](https://github.com/openbrandexchange/spec) 0.3.0. Implementation notes and deviations: [NOTES.md](NOTES.md). Fixtures (including the import cases in `fixtures/imports/`) and the vocabularies (`src/vocabularies/`, bundled into both builds) are copied with `scripts/sync-fixtures.sh`.
- `src/core/article.ts` — the article data: feature registry, measurements, footwear materials, certifications, materials and care as terms with names (0.3), the products.csv cell grammar and the label completeness warnings.

## Documentation

[Hosting](docs/hosting.md) (Cloudflare, Docker, Cloud Run, standalone) · [Operations](docs/operations.md) · [Upgrading](docs/upgrading.md) · [Automatic upload](docs/automation.md) · [Security](docs/security.md) · [Performance](docs/performance.md) · [Privacy notice template](docs/privacy-notice-template.md) · [Changelog](CHANGELOG.md) · [Implementation notes](NOTES.md)

Questions: hello@openbrandexchange.com. Security problems: security@openbrandexchange.com ([SECURITY.md](SECURITY.md)). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) (Developer Certificate of Origin), [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

GNU Affero General Public License v3.0 only — see [LICENSE](LICENSE) and [NOTICE](NOTICE). If you run a modified version for others, you must offer them its source code. The protocol specification is CC-BY-4.0; the shared admin UI and the Go SDK are Apache-2.0.

Open Brand Exchange Foundation (in formation).

<sub>Works with Open Brand Exchange.</sub>
