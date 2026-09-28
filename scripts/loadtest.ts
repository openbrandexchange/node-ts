// Seeded load test: builds a catalog of 10,000 products, 60,000 variants and 40,000 images through the
// real write path (Ingest API batches), then times catalog browsing, /changes paging and GTIN lookups.
// Usage: bun scripts/loadtest.ts [--products 10000] [--db path.sqlite] [--json out.json]
// Numbers are written to stdout as a Markdown table; see docs/performance.md for the reference run.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createWorker } from "../src/app";
import { createBunPlatform } from "../src/adapters/bun/platform";
import { fakeJpeg } from "../src/lib/image";
import { sha256Hex } from "../src/lib/crypto";
import { expectedCheckDigit } from "../src/lib/gtin";

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const PRODUCTS = Number(arg("products", "10000"));
const VARIANTS_PER = 6;
const ASSETS_PER = 4;
const dir = mkdtempSync(join(tmpdir(), "obx-load-"));
const dbPath = arg("db", join(dir, "obx.sqlite"));
const jsonOut = arg("json", "");

const platform = createBunPlatform({
  env: { OBX_SECRET_KEY: "load-test-secret-key-0123456789abcdefghij", OBX_SETUP_CODE: "LOAD-TEST-1", OBX_RATE_LIMIT_API: "100000000", OBX_RATE_LIMIT_MEDIA: "100000000" },
  dataDir: dir,
  uiDir: join(import.meta.dir, "..", "public"),
  dbPath,
  quiet: true,
});
const app = createApp(platform);
const worker = createWorker(platform);

async function call(method: string, path: string, o: { token?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string>; cookie?: string; csrf?: string } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.cookie = o.cookie;
  if (o.csrf) headers["x-csrf-token"] = o.csrf;
  let body = o.body;
  if (o.json !== undefined) {
    body = JSON.stringify(o.json);
    headers["content-type"] = "application/json";
  }
  const res = await app.request(`http://localhost:8080${path}`, { method, headers, body });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, json, headers: res.headers };
}

// ------------------------------------------------------------------ setup

const t0 = performance.now();
let cookie = "";
let csrf = "";
{
  const s = await app.request("http://localhost:8080/admin/api/session");
  csrf = ((await s.json()) as { csrf_token: string }).csrf_token;
  cookie = `obx_csrf=${csrf}`;
  const r = await app.request("http://localhost:8080/admin/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
    body: JSON.stringify({
      setup_code: "LOAD-TEST-1",
      company: { name: "Load Test Outfitters", first_brand_name: "Loadtest", default_language: "en", languages: ["en", "nl"] },
      admin: { name: "Load Admin", email: "admin@load.example", password: "load test admin password" },
    }),
  });
  if (r.status !== 201) throw new Error(`setup failed ${r.status} ${await r.text()}`);
  for (const sc of r.headers.getSetCookie()) {
    const [kv] = sc.split(";");
    if (kv.startsWith("obx_session=")) cookie = `${kv}; obx_csrf=${csrf}`;
    if (kv.startsWith("obx_csrf=")) {
      csrf = kv.slice("obx_csrf=".length);
      cookie = cookie.replace(/obx_csrf=[^;]*/, `obx_csrf=${csrf}`);
    }
  }
  csrf = ((await r.json()) as { csrf_token: string }).csrf_token;
}
const adminCall = (method: string, path: string, json?: unknown) => call(method, path, { cookie, csrf, json });
const ingestToken = (await adminCall("POST", "/admin/api/ingest-tokens", { name: "load", scopes: ["ingest:read", "ingest:write", "ingest:delete"] })).json.secret as string;
const retailer = (await adminCall("POST", "/admin/api/retailers", { name: "Load Retailer" })).json;
const client = (await adminCall("POST", "/admin/api/api-clients", { retailer_id: retailer.id, name: "Load sync" })).json;
const tok = await app.request("http://localhost:8080/obx/v1/oauth/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`${client.client.client_id}:${client.client_secret}`)}` },
  body: "grant_type=client_credentials",
});
const accessToken = ((await tok.json()) as { access_token: string }).access_token;

// A few distinct originals, shared by all images (metadata is what this test measures).
const blobs: string[] = [];
for (let i = 0; i < 8; i++) {
  const bytes = fakeJpeg(2400, 3000, i + 1);
  const sha = await sha256Hex(bytes);
  await call("PUT", `/obx/v1/ingest/blobs/${sha}`, { token: ingestToken, body: bytes as unknown as BodyInit, headers: { "content-type": "image/jpeg" } });
  blobs.push(sha);
}

// ------------------------------------------------------------------ seed

const COLORS = ["NVY", "BLK", "OLV", "RST", "WHT", "OAT"];
const SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
const TYPES = ["sweater", "jacket", "shirt", "trousers", "dress", "shorts"];
const gtins: string[] = [];
const ops: unknown[] = [];
for (let p = 0; p < PRODUCTS; p++) {
  const style = `LT-${String(p).padStart(5, "0")}`;
  const colors = [COLORS[p % COLORS.length], COLORS[(p + 1) % COLORS.length]];
  ops.push({
    op: "upsert",
    kind: "product",
    external_id: style,
    data: {
      style_number: style,
      name: { en: `Load test ${TYPES[p % TYPES.length]} ${p}`, nl: `Laadtest ${p}` },
      item_type: TYPES[p % TYPES.length],
      target_group: p % 2 ? "women" : "men",
      season: p % 3 ? "FW26" : "SS27",
      materials: [{ part: "main", fibers: [{ fiber: "cotton", percentage: 100 }] }],
    },
  });
  for (let v = 0; v < VARIANTS_PER; v++) {
    const body = `20${String(p).padStart(6, "0")}${String(v).padStart(4, "0")}`;
    const gtin = body + expectedCheckDigit(body + "0");
    gtins.push(gtin);
    ops.push({ op: "upsert", kind: "variant", external_id: gtin, data: { product_external_id: style, gtin, color: { code: colors[v % 2], name: { en: colors[v % 2] } }, size: SIZES[v] } });
  }
  for (let a = 0; a < ASSETS_PER; a++) {
    const color = colors[a % 2];
    const pos = Math.floor(a / 2) + 1;
    ops.push({ op: "upsert", kind: "asset", external_id: `${style}_${color}_${pos}`, data: { product_external_id: style, color_code: color, role: "packshot", view: pos === 1 ? "front" : "back", position: pos, files: { original: { sha256: blobs[(p + a) % blobs.length] } } } });
  }
}

const BATCH = 200;
const seedStart = performance.now();
for (let i = 0; i < ops.length; i += BATCH) {
  const r = await call("POST", "/obx/v1/ingest/batch", { token: ingestToken, json: ops.slice(i, i + BATCH) });
  const errors = (r.json.results as { result: string; problem?: unknown }[]).filter((x) => x.result === "error");
  if (errors.length) throw new Error(`batch at ${i}: ${JSON.stringify(errors[0])}`);
  if ((i / BATCH) % 50 === 0) process.stderr.write(`seeded ${i}/${ops.length}\r`);
}
await Promise.allSettled([...platform.pending]);
await worker.runJobs(60_000);
const seedMs = performance.now() - seedStart;
const counts = (await platform.db.first<Record<string, number>>("SELECT (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM variants) AS variants, (SELECT COUNT(*) FROM assets) AS assets, (SELECT COUNT(*) FROM changes) AS changes"))!;
process.stderr.write(`\nseeded in ${(seedMs / 1000).toFixed(1)} s: ${JSON.stringify(counts)}\n`);

// ------------------------------------------------------------------ measure

interface Result {
  name: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
  note?: string;
}
const results: Result[] = [];
async function time(name: string, n: number, f: (i: number) => Promise<unknown>, note?: string) {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    await f(i);
    ms.push(performance.now() - s);
  }
  ms.sort((a, b) => a - b);
  const q = (x: number) => ms[Math.min(ms.length - 1, Math.floor(x * ms.length))];
  results.push({ name, n, p50: q(0.5), p95: q(0.95), max: ms[ms.length - 1], note });
}

// Full snapshot of /changes at limit=500, then a live page.
let snapshotPages = 0;
let entries = 0;
{
  const ms: number[] = [];
  let cursor: string | null = null;
  for (;;) {
    const s = performance.now();
    const r: { json: { changes: unknown[]; next_cursor: string; has_more: boolean } } = await call("GET", `/obx/v1/changes?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: accessToken });
    ms.push(performance.now() - s);
    snapshotPages++;
    entries += r.json.changes.length;
    cursor = r.json.next_cursor;
    if (!r.json.has_more) break;
  }
  ms.sort((a, b) => a - b);
  results.push({ name: "GET /changes?limit=500 (full snapshot)", n: ms.length, p50: ms[Math.floor(ms.length / 2)], p95: ms[Math.floor(ms.length * 0.95)], max: ms[ms.length - 1], note: `${entries} entries in ${snapshotPages} pages, total ${(ms.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} s` });
  await time("GET /changes (live, nothing new)", 50, () => call("GET", `/obx/v1/changes?limit=500&cursor=${encodeURIComponent(cursor!)}`, { token: accessToken }));
}

// Protocol catalog browse: product pages with embedded variants and images.
{
  let cursor: string | null = null;
  const cursors: (string | null)[] = [];
  for (let i = 0; i < 100; i++) {
    cursors.push(cursor);
    const r: { json: { next_cursor: string | null } } = await call("GET", `/obx/v1/products?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: accessToken });
    cursor = r.json.next_cursor;
    if (!cursor) break;
  }
  await time("GET /obx/v1/products?limit=100 (pages across the catalog)", cursors.length, (i) => call("GET", `/obx/v1/products?limit=100${cursors[i] ? `&cursor=${encodeURIComponent(cursors[i]!)}` : ""}`, { token: accessToken }));
}
const someProduct = (await platform.db.first<{ id: string }>("SELECT id FROM products ORDER BY random() LIMIT 1"))!.id;
await time("GET /obx/v1/products/{id}", 200, () => call("GET", `/obx/v1/products/${someProduct}`, { token: accessToken }));

// GTIN lookups.
const pick = (n: number, seed: number) => Array.from({ length: n }, (_, i) => gtins[(seed * 7919 + i * 104729) % gtins.length]);
await time("POST /products:by-gtin (2000 GTINs)", 20, (i) => call("POST", "/obx/v1/products:by-gtin", { token: accessToken, json: { gtins: pick(2000, i) } }));
await time("GET /products:by-gtin?gtin= (100 GTINs)", 50, (i) => call("GET", `/obx/v1/products:by-gtin?gtin=${pick(100, i + 100).join(",")}`, { token: accessToken }));
await time("GET /products:by-gtin?gtin= (1 GTIN)", 200, (i) => call("GET", `/obx/v1/products:by-gtin?gtin=${gtins[(i * 104729) % gtins.length]}`, { token: accessToken }));

// Retailer portal (admin preview uses the same queries): list, filters, facets, search, deep page.
await time("portal: products (first page of 48)", 50, () => adminCall("GET", "/admin/api/portal/products"));
await time("portal: products filtered by type + season", 50, () => adminCall("GET", "/admin/api/portal/products?item_type=jacket&season=FW26"));
await time("portal: facets", 50, () => adminCall("GET", "/admin/api/portal/facets"));
await time("portal: search text", 50, (i) => adminCall("GET", `/admin/api/portal/products?q=${encodeURIComponent(`test ${i * 37}`)}`));
{
  let cursor: string | null = null;
  for (let i = 0; i < 150 && (i === 0 || cursor); i++) {
    const r: { json: { next_cursor: string | null } } = await adminCall("GET", `/admin/api/portal/products?limit=48${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    cursor = r.json.next_cursor;
  }
  const deep = cursor;
  await time("portal: products page 150 (offset 7152)", 20, () => adminCall("GET", `/admin/api/portal/products?limit=48${deep ? `&cursor=${encodeURIComponent(deep)}` : ""}`));
}
await time("portal: EAN list paste (200 EANs)", 20, (i) => adminCall("POST", "/admin/api/portal/gtin-lookup", { text: pick(200, i + 300).join("\n") }));
await time("admin: catalog list (first page)", 50, () => adminCall("GET", "/admin/api/catalog/products"));

const total = ((performance.now() - t0) / 1000).toFixed(1);
const lines = [
  `Catalog: ${counts.products} products, ${counts.variants} variants, ${counts.assets} images, ${counts.changes} change entries. Seeded through the Ingest API in ${(seedMs / 1000).toFixed(1)} s (batches of ${BATCH}). Runtime: Bun ${Bun.version}, bun:sqlite (WAL, file on disk). Total run ${total} s.`,
  "",
  "| Operation | n | p50 ms | p95 ms | max ms | Note |",
  "|---|---:|---:|---:|---:|---|",
  ...results.map((r) => `| ${r.name} | ${r.n} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.max.toFixed(1)} | ${r.note ?? ""} |`),
];
console.log(lines.join("\n"));
if (jsonOut) await Bun.write(jsonOut, JSON.stringify({ counts, seedMs, results }, null, 2));
process.exit(0);
