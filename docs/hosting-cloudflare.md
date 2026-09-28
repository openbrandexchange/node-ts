# Hosting on Cloudflare

The Portal for Cloudflare runs as one Cloudflare Worker with:

| Cloudflare product | Used for | Created by |
|---|---|---|
| Workers | the portal, the admin screens (static assets) and the APIs | the Deploy button or `wrangler deploy` |
| D1 (`brand-portal-db`, binding `DB`) | the database (SQLite) | created automatically on the first deploy |
| R2 (`brand-portal-files`, binding `FILES`) | images, zips, exports | created automatically on the first deploy |
| Cron Trigger (every minute) | scheduled imports, background jobs, webhooks, housekeeping | `triggers.crons` in `wrangler.jsonc` |
| Queues (optional) | lets long background jobs continue right away instead of once a minute | you, see below |

## Option A: the Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/openbrandexchange/node-ts)

1. Click the button and sign in to Cloudflare.
2. Cloudflare copies this repository into your own GitHub or GitLab account (so you own the code and
   can update it) and shows the resources it will create: the Worker, the D1 database and the R2
   bucket. You may rename them.
3. Fill in the two secrets it asks for (they come from `.dev.vars.example`):
   - `OBX_SECRET_KEY`: a random text of at least 32 characters (`openssl rand -base64 48`). Keep a copy:
     it encrypts stored credentials and signs download links.
   - `OBX_SETUP_CODE`: a code you choose (6+ characters) for the setup wizard.
4. Cloudflare builds and deploys with `npm run deploy`, which runs `wrangler deploy` (Worker, D1, R2,
   cron) and then `wrangler d1 migrations apply DB --remote` (the database tables). The Worker also
   applies any missing migration itself at its first request, so the portal is always on the schema
   of the code it runs.
5. Open `https://brand-portal.<your-subdomain>.workers.dev`, enter the setup code, your company, your
   languages and your admin account.

> The button can only copy a **public** repository. While `openbrandexchange/node-ts` is private, use option B.

Every later push to your copy of the repository deploys again (Workers Builds). To take a new
release, merge the upstream tag into your copy (`git pull https://github.com/openbrandexchange/node-ts v0.1.1`)
and push; read [upgrading.md](upgrading.md) first.

## Option B: from your computer

```sh
git clone https://github.com/openbrandexchange/node-ts && cd node-ts
bun install
bunx wrangler login
bunx wrangler secret put OBX_SECRET_KEY      # paste the output of: openssl rand -base64 48
bunx wrangler secret put OBX_SETUP_CODE      # a code you choose
bun run deploy                               # Worker + D1 + R2 + cron, then the migrations
```

Without Bun: download `obx-node-ts-cloudflare-<version>.tar.gz` from the release, unpack it and run
`npx wrangler login`, the two `secret put` commands and `npm run deploy` there. That bundle contains
the prebuilt Worker, so nothing is compiled on your computer.

## Which plan: what the free plan allows, and what happens when a limit is reached

**Use Workers Paid ($5 per month per account) for a portal that people use.** The free plan is fine
for a look around, but a sign-in (password check) or a zip already needs more CPU time than the
free plan gives one request.

| Limit | Workers Free | Workers Paid | When it is reached |
|---|---|---|---|
| CPU time per request | 10 ms | 30 s default (up to 5 min) | Cloudflare stops the request with **error 1102** "Worker exceeded resource limits". On Free this hits sign-in, password resets, zip downloads and larger imports. Background steps stop after 20–25 s and checkpoint, so on Paid they never reach 30 s. |
| Cron Trigger CPU | 10 ms | 30 s (interval < 1 h) | On Free the minute tick is cut off: scheduled imports, zips and webhooks barely progress. |
| Requests | 100,000 per day | no limit | Free: visitors get **error 1027** until midnight UTC. |
| D1 rows read | 5 million per day | 25 billion per month included, then $0.001 per million | Free: every database query fails until midnight UTC; the portal answers **503** "The Cloudflare free plan's daily database allowance is used up…". The minute tick and housekeeping only use indexes, so an idle portal reads little; a full sync of a 10,000-product catalog by one retailer reads a few hundred thousand rows (estimate; the D1 dashboard shows the real numbers under Metrics → Row metrics). |
| D1 rows written | 100,000 per day | 50 million per month included, then $1 per million | Free: writes fail until midnight UTC (same 503). A first import of 10,000 products with 60,000 EANs and 40,000 images writes 110,000 objects plus as many change-feed entries, and D1 counts index updates as written rows too, so it does not fit in one free day. |
| D1 database size | 500 MB | 10 GB | New writes fail; the portal answers **503** "The portal's database is full…"; reading keeps working. The load-test catalog (10,000 products, 60,000 variants, 40,000 images, 110,000 change entries) takes about 110 MB. |
| D1 storage per account | 5 GB | 1 TB | As above. |
| D1 queries per request | 50 | 1,000 | Background steps count their queries and checkpoint at 800 (`OBX_D1_QUERY_BUDGET`), so they never reach the cap; an interactive request that needs more than 50 on Free answers **503** "…more database queries than the Cloudflare plan allows…". |
| Subrequests per request | 50 | 10,000 | Free: webhooks and imports that fetch many files stop early and resume in the next tick. |
| Request body | 100 MB (Free and Pro zones), 500 MB+ Enterprise | same | Uploads above it are refused by Cloudflare. The portal caps single uploads at 32 MiB (`OBX_MAX_UPLOAD_BYTES`); larger files use resumable uploads, and big imports use the images manifest (what the admin screens and `obx push` do). |
| Static assets | 20,000 files | 100,000 files | Not a concern: the admin screens are about 100 files. |
| R2 | 10 GB-month storage, 1 million writes, 10 million reads per month free | $0.015 per GB-month, $4.50 per million writes, $0.36 per million reads | Billed beyond the free amount (R2 has no download fees). Storage depends on your photos: 40,000 originals of 2–3 MB plus their web versions are roughly 100–150 GB. |

Numbers from Cloudflare's documentation on 2026-09-28 (Workers limits, D1 limits and pricing, R2
pricing). Check the current pages before you choose: <https://developers.cloudflare.com/workers/platform/limits/>,
<https://developers.cloudflare.com/d1/platform/limits/>, <https://developers.cloudflare.com/r2/pricing/>.

`wrangler.jsonc` sets no `limits` block on purpose: a CPU limit entry is refused on the free plan,
which would break the Deploy button there, and the Paid default of 30 s is enough.

## Your own domain

**Workers & Pages → brand-portal → Settings → Domains & Routes → Add → Custom domain**, for example
`brands.yourbrand.com` (the domain must be on Cloudflare). Then set the variable
`OBX_PUBLIC_URL=https://brands.yourbrand.com` (**Settings → Variables and secrets**) and deploy again,
so e-mails and API links use it. The `workers.dev` address keeps working unless you turn it off
(`"workers_dev": false`).

## E-mail

Set `OBX_MAIL_PROVIDER` (`resend`, `postmark`, `sendgrid`, `mailchannels` or `webhook`),
`OBX_MAIL_FROM` and the secret `OBX_MAIL_API_KEY` (or `OBX_MAIL_WEBHOOK_URL`). See the README.

## The optional Queue

With a Queue bound as `JOBS`, a long background job (a whole-catalog zip, a big import) continues
immediately after each step instead of waiting for the next minute. Uncomment the `queues` block
in `wrangler.jsonc`, then:

```sh
bunx wrangler queues create brand-portal-jobs
bun run deploy
```

Queues need the Workers Paid plan.

## Logs, health and metrics

- **Logs:** Workers Logs are on (`observability.enabled`). Every line is JSON and carries the
  `request_id` that the response header `X-Request-Id` shows. `bunx wrangler tail` streams them.
- **Health:** `GET /healthz` (the Worker answers) and `GET /readyz` (D1 reachable and migrated, R2
  reachable). Point an uptime check at `/readyz`.
- **Metrics:** set the secret `OBX_METRICS_TOKEN` (16+ characters) and scrape `GET /metrics` with
  `Authorization: Bearer <token>`. Request counters are per Worker isolate on Cloudflare, so use the
  dashboard's Workers analytics for traffic and `/metrics` for catalog, jobs and webhooks.

## Backups on Cloudflare

- **Database:** D1 Time Travel is always on and keeps 30 days on Workers Paid (7 days on Free). To go
  back to a moment: `bunx wrangler d1 time-travel restore brand-portal-db --timestamp=<unix time>`.
  For a copy outside Cloudflare, export regularly: `bunx wrangler d1 export brand-portal-db --remote --output=portal-$(date +%F).sql`.
- **Files:** R2 has no versioning. Images are stored by their SHA-256 and never overwritten; files
  nobody uses are removed a day after they became unused. For an off-site copy, sync the bucket with
  any S3 tool (R2 → Manage R2 API tokens), for example `rclone sync r2:brand-portal-files backup:portal-files`.
- **Secret key:** keep `OBX_SECRET_KEY` in your password manager. Without it, stored import
  credentials and webhook secrets cannot be read and download links change.

Restoring the database to an earlier moment is safe for images: a restored database only refers to
files that existed then, and files are only deleted a day after they became unused, so restore
within a day of an image being replaced, or restore the bucket copy as well.

See [operations.md](operations.md) for the full backup and restore procedure and [upgrading.md](upgrading.md) for updates.
