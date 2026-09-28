# Performance

`scripts/loadtest.ts` builds a seeded catalog through the real write path (Ingest API batches of 200) and times the reads that matter for retailers and their software. Run it yourself:

```sh
bun scripts/loadtest.ts                    # 10,000 products, 60,000 variants, 40,000 images
bun scripts/loadtest.ts --products 2000    # smaller, faster
```

The images share a few small originals: the test measures metadata, signed URLs and queries, not file transfer.

## Reference run (2026-09-28, v0.1.0)

Apple M2 Pro (10 cores, 16 GB), Bun 1.3.14, bun:sqlite on a local SSD. The machine was busy with other work during the run (load average 25–54), so a quiet machine is faster. Times are measured inside the process (no network).

Catalog: 10000 products, 60000 variants, 40000 images, 110001 change entries. Seeded through the Ingest API in 39.4 s (batches of 200). Runtime: Bun 1.3.14, bun:sqlite (WAL, file on disk). Total run 57.1 s.

| Operation | n | p50 ms | p95 ms | max ms | Note |
|---|---:|---:|---:|---:|---|
| GET /changes?limit=500 (full snapshot) | 222 | 7.3 | 16.5 | 26.7 | 110001 entries in 222 pages, total 1.8 s |
| GET /changes (live, nothing new) | 50 | 0.1 | 0.1 | 0.2 |  |
| GET /obx/v1/products?limit=100 (pages across the catalog) | 100 | 11.2 | 17.5 | 22.4 |  |
| GET /obx/v1/products/{id} | 200 | 0.6 | 2.8 | 4.8 |  |
| POST /products:by-gtin (2000 GTINs) | 20 | 319.8 | 447.0 | 447.0 |  |
| GET /products:by-gtin?gtin= (100 GTINs) | 50 | 12.7 | 15.7 | 17.2 |  |
| GET /products:by-gtin?gtin= (1 GTIN) | 200 | 0.2 | 0.6 | 3.3 |  |
| portal: products (first page of 48) | 50 | 2.7 | 4.9 | 6.1 |  |
| portal: products filtered by type + season | 50 | 6.5 | 8.6 | 18.2 |  |
| portal: facets | 50 | 62.1 | 76.7 | 82.8 |  |
| portal: search text | 50 | 14.8 | 25.6 | 32.3 |  |
| portal: products page 150 (offset 7152) | 20 | 5.5 | 6.7 | 6.7 |  |
| portal: EAN list paste (200 EANs) | 20 | 26.4 | 38.2 | 38.2 |  |
| admin: catalog list (first page) | 50 | 1.0 | 1.3 | 2.7 |  |

Read the numbers like this:

- **`/changes`**: a software client that syncs the whole catalog from scratch reads 110,001 entries in 222 pages in under 2 seconds of server time; an up-to-date client that polls gets an empty live page in well under a millisecond.
- **Catalog pages** of 100 products with their variants, images and signed image links take about 11 ms, whichever page.
- **GTIN lookup**: one EAN is sub-millisecond; 100 EANs about 13 ms; the maximum of 2,000 EANs (here matching about 2,000 different products, each returned in full) about 0.3 s.
- **Portal**: product lists, filters, deep pages and EAN lists stay below 40 ms; the filter counts (facets) are the heaviest call at about 60 ms, because they count over every variant.

## What the load test changed

The first run (same machine) showed where time went; each fix is covered by the existing tests:

| Before | After | Fix |
|---|---|---|
| protocol product page 58 ms, GTIN ×2000 1.8 s | 11 ms, 0.3 s | Signed image links used WebCrypto's asynchronous HMAC (~20 µs per call, 16 per product); now `node:crypto` HMAC (on Workers through `nodejs_compat`). |
| admin catalog list 145 ms | 1 ms | The page is chosen first (index `products_modified`), then variant and image counts are computed for those 50 rows only, not for the whole catalog. |
| portal deep page 57 ms | 6 ms | Page first on narrow columns (index `products_style_id`), then read the stored documents of that page. |
| portal facets 148 ms | 62 ms | Colour names are read from one variant per colour instead of parsing the JSON of every variant; covering index `variants_facet`. |
| retailer list: one count query per row | two queries per page | `retailerCounts` groups user and API key counts. |

## On Cloudflare (D1)

The same queries run on D1, which is SQLite too. D1 adds a network round trip per query (typically 1–5 ms from the Worker) instead of an in-process call, so pages that run 3–4 queries (a catalog page: products, variants, images) add roughly 5–15 ms. D1 bills **rows read**: a full `/changes` snapshot of this catalog reads about 110,000 change rows plus the objects, well inside the Workers Paid plan's included 25 billion rows per month. See [hosting-cloudflare.md](hosting-cloudflare.md) for the plan limits.

## Limits worth knowing

- A single `POST /products:by-gtin` accepts at most 2,000 GTINs; `GET` at most 100.
- `/changes` pages are at most 500 entries; product pages at most 100.
- Portal lists page with an offset (48 per page by default); page 150 is still fast because only ids are sorted.
