# Demo mode

A public demo portal that people can look around in without an account: the fictional brand
Kestrel (the spec's `fixtures/kestrel`), a one-click sign-in as a retailer or as the brand's admin,
a public read-only API key, and an automatic reset to the fixtures. Open Brand Exchange runs one at
<https://obx-portal-demo.richardlindhout96.workers.dev> (planned: `https://demo.openbrandexchange.com`).

Demo mode is **off by default**. It is switched on with `OBX_DEMO=true`; never set it on a real
portal: every reset **deletes all data** (catalog, retailers, accounts, files) and puts the fixtures back.

## What it does

| | |
| --- | --- |
| Sign-in | The login page shows "View as retailer" and "View as brand" instead of the login form (`POST /admin/api/demo/login` with `{"as": "retailer" \| "brand"}`). The two accounts have no password. With a Turnstile site key the buttons wait for Cloudflare Turnstile. |
| Banner | "Demo, fictional data" on every page (admin-ui 0.2.2+, in the 25 languages); the public branding carries `x-obx-demo` (docs of admin-ui, `docs/node-integration.md` §4). |
| Data | Brand Kestrel (+ Kestrel Trail from the CSV): 11 articles, 46 variants, 35 images with real JPEG renditions; retailers Northwind Stores (the demo retailer, all brands, originals), Harbour & Co (Kestrel only, no originals) and Lumen Concept Store (blocked); one open access request; 30 days of example download statistics. |
| API | Public read-only key `obxc_demo-portal-read-only` / `obxs_demo-portal-read-only-public` (scopes `catalog:read media:read media:original`, Northwind Stores). The discovery document drops `webhooks`, `ingest` and `usage` (the key cannot write); those addresses answer `501`. |
| Reset | Every `OBX_DEMO_RESET_MINUTES` (default 60) from the minute cron, on the first visit after a deploy, and on demand with `POST /admin/api/demo/reset` (signed-in visitors, at most once per 10 minutes). Sessions of the two demo accounts survive a reset; old change-feed cursors answer `410 cursor_expired`. |

**Refused** (`403` with `"x-obx-demo": true`, the UI says "This is not possible in the demo."):
setup, password reset and change, changing the e-mail address, deleting the own account, invitations,
changes to the two demo accounts and to Northwind Stores, creating/renewing/deleting API keys and
upload keys (brand and retailer side), webhooks, scheduled imports from other servers (and their
tests), the brand's name/branding/logo, deleting catalog records (unpublishing works), approving an
access request with an API key. **Neutralised**: no e-mail is ever sent (whatever `OBX_MAIL_*` says),
scheduled imports never run, request bodies are capped at `OBX_DEMO_MAX_UPLOAD_BYTES` (default 2 MiB,
the size class of the Excel template), every answer has `X-Robots-Tag: noindex` and files are never
cached publicly (`Cache-Control: private`); uploaded images are only reachable through short-lived
signed links and are deleted at the next reset.

**Allowed**: everything a visitor needs to try the portal: search, EAN list, product pages, image,
zip, CSV and Excel downloads; as the brand: editing articles, the Excel/CSV import with the template,
access per retailer (Harbour & Co and new retailers), statistics, declining requests.

**Abuse limits** per client address and minute: 300 reads, 40 writes, 10 demo sign-ins (Workers rate
limiting bindings `DEMO_READ_LIMIT`, `DEMO_WRITE_LIMIT`, `DEMO_LOGIN_LIMIT`; an in-memory window on
other runtimes), plus 30 sign-ins per 10 minutes in the database.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `OBX_DEMO` | `false` | Demo mode on. |
| `OBX_DEMO_RESET_MINUTES` | `60` | Reset interval (5 to 10080). |
| `OBX_DEMO_MAX_UPLOAD_BYTES` | `2097152` | Largest request body. |
| `OBX_DEMO_TURNSTILE_SITE_KEY` | | Turnstile widget site key (public). |
| `OBX_DEMO_TURNSTILE_SECRET` | | Its secret key (a secret); without it no Turnstile check. |

## The seed archive

The reset imports `demo/seed.zip` from the portal's storage: `products.csv`, `assets.csv`, the
images and their web/square/thumb JPEGs (Workers has no image library, so they are made once,
beforehand). Build it from the fixtures and upload it once (again after the fixtures change):

```sh
bun scripts/demo-seed.ts demo-seed.zip          # needs macOS sips or ImageMagick
CLOUDFLARE_ACCOUNT_ID=… bunx wrangler r2 object put obx-portal-demo-files/demo/seed.zip \
  --file demo-seed.zip --jurisdiction eu --remote -c deploy/demo/wrangler.jsonc
```

On Bun/Docker put it at `<data dir>/files/demo/seed.zip`. Without the archive the demo still starts,
with accounts and retailers but an empty catalog (logged as a warning).

## Deploying the Open Brand Exchange demo (Cloudflare)

Resources (account `34a316f1061b80c0053fffe17c0413c6`, created once):

```sh
bunx wrangler d1 create obx-portal-demo-db --jurisdiction eu
bunx wrangler r2 bucket create obx-portal-demo-files --jurisdiction eu
```

Then, with `deploy/demo/wrangler.jsonc` (its own Worker `obx-portal-demo`, D1 database and R2 bucket,
`run_worker_first` so the UI pages get the demo headers and Turnstile's CSP additions):

```sh
bunx wrangler secret put OBX_SECRET_KEY -c deploy/demo/wrangler.jsonc               # openssl rand -base64 48
bunx wrangler secret put OBX_DEMO_TURNSTILE_SECRET -c deploy/demo/wrangler.jsonc    # Turnstile widget secret
bunx wrangler deploy -c deploy/demo/wrangler.jsonc
bunx wrangler d1 migrations apply DB --remote -c deploy/demo/wrangler.jsonc
```

The first request (or the next minute) seeds the demo. The Turnstile widget
"Open Brand Exchange demo portal sign-in" allows `obx-portal-demo.richardlindhout96.workers.dev` and
`demo.openbrandexchange.com`.

### Custom domain demo.openbrandexchange.com

The `openbrandexchange.com` zone is in the same account; Wrangler's login cannot write DNS, so in the
dashboard: **Workers & Pages → obx-portal-demo → Settings → Domains & Routes → Add → Custom domain**,
enter `demo.openbrandexchange.com` (Cloudflare creates the DNS record and the certificate). Then add
`"OBX_PUBLIC_URL": "https://demo.openbrandexchange.com"` to `vars` in `deploy/demo/wrangler.jsonc`,
deploy again, and change the links on the website (`src/locales/*` `demo` section, developers page).

### Costs

Within the Workers Paid plan ($5/month, already paid): about 1,500 requests/day from the cron
(1/minute), a reset reads ~2,000 and writes ~1,500 D1 rows per hour (~2.5 M reads and ~1.1 M writes a
month, inside the included 25 billion / 50 million), ~5 MB in R2 (seed + images; free tier 10 GB) and
a few hundred R2 operations per reset (free tier 1 M class A / 10 M class B). Rate limiting bindings
and Turnstile are free. Expected extra cost: $0.
