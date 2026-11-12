# Automatic upload

How a brand publishes to this portal without clicking: the recipes (scheduled imports, `obx push`
and `obx watch`, cron, the GitHub Action, n8n/Make/Zapier, the direct API) are the same for every
Open Brand Exchange portal and are described in the spec:
**[spec/docs/automation.md](https://github.com/openbrandexchange/spec/blob/main/docs/automation.md)**.
This page lists what is specific to this edition.

## Keys

Admin → **Automatic upload → Access keys → Create access key**. The key (`obxi_…`) is shown once;
store it as a secret. Give every system its own key and limit it to the brands it publishes. Keys
work only on the upload API (`/obx/v1/ingest`), never on the admin screens or the retailers' API.

## Scheduled imports on this edition

| Source | Cloudflare | Bun (Docker, standalone, Cloud Run) |
|---|---|---|
| Web address (HTTPS, optional login header) | yes | yes |
| S3-compatible bucket (S3, R2, MinIO, B2 …) | yes | yes |
| SFTP folder (password or key; server key pinned on first connection) | no (Workers cannot open SSH connections) | yes |

What a run reads: a web address points at a `products.csv`, a package zip or a `products.xlsx` (the file
name decides); a bucket or folder is read like an unpacked package: `products.csv` or `products.xlsx`
(not both), optional `assets.csv` or `assets.xlsx`, and the images below it (spec import-format.md §3, §5).

Frequencies: hourly, daily at a time, weekly on a day at a time (in the brand's time zone), or manual.
Runs start from the minute timer (the Cron Trigger on Cloudflare); an unchanged file is not imported
again. **Mirror** mode refuses to take more than half of the catalog offline unless you allow it.

## Web versions of images

This edition does not resize images on the server (`GET /obx/v1/ingest` answers
`"server_generated": false`). `obx push`, the admin screens and the GitHub Action make the web,
square and thumbnail versions on the uploading computer. Images that arrive without them (a scheduled
import, an n8n flow) are published with the original in their place and marked in the admin; run
`obx push` once or open the article in the admin to add them.

## Limits

| What | Cloudflare | Bun |
|---|---|---|
| One upload request (a file, or a CSV + images form) | 32 MiB (`OBX_MAX_UPLOAD_BYTES`); Cloudflare refuses bodies over 100 MB on Free/Pro zones | 100 MiB (`OBX_MAX_UPLOAD_BYTES`) |
| Larger files | resumable multipart uploads (`obx` does this) | same |
| Whole imports | use an images manifest: upload new images as blobs, then one import with the CSV (what `obx push` and the admin do) | same, or one zip |
| Batch | up to 1,000 operations; more than 50 run as a background job | more than 200 run as a background job |
| Requests per minute per key | 600 (`OBX_RATE_LIMIT_API`) | same |

## Being told when an import finished

Admin → **Automatic upload → Notifications**: webhooks for `import_run.completed`,
`ingest_job.completed` and `access_request.created`, signed with `OBX-Webhook-Signature`. Failed
deliveries are retried after 1 min, 5 min, 30 min, 2 h, 6 h and 12 h; a webhook failing for 3 days is
switched off (the admin shows it).

## Checking it end to end

```sh
export OBX_URL=https://brands.yourbrand.com OBX_TOKEN=obxi_…
obx info                                  # key, limits, brands, languages
obx push ./export --dry-run               # what would change, without changing anything
obx push ./export                         # publish; exit code 0 = all good, 2 = some rows had errors
obx status                                # recent imports and their problems
```
