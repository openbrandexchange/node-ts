// Smoke test of the Cloudflare edition in the local Workers runtime (`wrangler dev`, D1 + R2 simulated).
// Usage: bun scripts/workers-smoke.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeJpeg } from "../src/lib/image";
import { sha256Hex, crc32 } from "../src/lib/crypto";
import { zipBytes } from "../src/lib/zip";

const port = 8788 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const persist = mkdtempSync(join(tmpdir(), "obx-wrangler-"));
const code = "SMOKE-CODE-1234";

const proc = Bun.spawn(
  [
    "bunx",
    "wrangler",
    "dev",
    "--local",
    "--port",
    String(port),
    "--ip",
    "127.0.0.1",
    "--test-scheduled",
    "--persist-to",
    persist,
    "--var",
    "OBX_SECRET_KEY:smoke-test-secret-key-0123456789abcdef",
    "--var",
    `OBX_SETUP_CODE:${code}`,
    "--var",
    "OBX_ALLOW_PRIVATE_URLS:true",
    "--var",
    "OBX_MAIL_PROVIDER:console",
    "--var",
    "OBX_MAIL_FROM:portal@kestrel.example",
  ],
  { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);

let log = "";
const collect = async (s: ReadableStream<Uint8Array>) => {
  const r = s.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    log += new TextDecoder().decode(value);
  }
};
collect(proc.stdout);
collect(proc.stderr);

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
}

const cookies = new Map<string, string>();
let csrf = "";
async function call(method: string, path: string, o: { json?: unknown; body?: BodyInit; headers?: Record<string, string>; bearer?: string } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (cookies.size && !o.bearer) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  if (!o.bearer && method !== "GET" && csrf) headers["x-csrf-token"] = csrf;
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  let body = o.body;
  if (o.json !== undefined) {
    body = JSON.stringify(o.json);
    headers["content-type"] ??= "application/json";
  }
  const r = await fetch(base + path, { method, headers, body, redirect: "manual" });
  for (const sc of r.headers.getSetCookie()) {
    const [kv] = sc.split(";");
    const i = kv.indexOf("=");
    cookies.set(kv.slice(0, i), kv.slice(i + 1));
  }
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  if (json?.csrf_token) csrf = json.csrf_token;
  return { status: r.status, json, text, headers: r.headers };
}

try {
  for (let i = 0; i < 120; i++) {
    if (/Ready on/i.test(log)) break;
    await Bun.sleep(500);
  }
  check(/Ready on/i.test(log), "wrangler dev started");
  check((await call("GET", "/.well-known/obx")).status === 503, "discovery answers 503 before setup");
  await call("GET", "/admin/api/session");
  const setup = await call("POST", "/admin/api/setup", {
    json: { setup_code: code, company: { name: "Kestrel Outfitters", first_brand_name: "Kestrel", default_language: "nl", languages: ["nl", "en"] }, admin: { name: "Ada", email: "admin@kestrel.example", password: "correct horse battery staple" } },
  });
  check(setup.status === 201, "setup wizard completes on D1");
  const tok = await call("POST", "/admin/api/ingest-tokens", { json: { name: "smoke", scopes: ["ingest:read", "ingest:write", "ingest:delete"] } });
  const it = tok.json.secret as string;
  check(it?.startsWith("obxi_"), "ingest token created");
  check((await call("PUT", "/obx/v1/ingest/products/KO-1001", { bearer: it, json: { style_number: "KO-1001", name: { en: "Merino Crew Sweater" } } })).status === 201, "product created via ingest");
  check((await call("PUT", "/obx/v1/ingest/variants/2000100101025", { bearer: it, json: { product_external_id: "KO-1001", gtin: "2000100101025", color: { code: "NVY" }, size: "M" } })).status === 201, "variant created");
  const files: Record<string, { sha256: string }> = {};
  for (const [name, w, h] of [
    ["original", 1200, 1500],
    ["web", 1200, 1500],
    ["square", 1500, 1500],
    ["thumb", 480, 600],
  ] as const) {
    const b = fakeJpeg(w, h, w + h + name.length);
    const sha = await sha256Hex(b);
    const up = await call("PUT", `/obx/v1/ingest/blobs/${sha}`, { bearer: it, body: b as BodyInit, headers: { "content-type": "image/jpeg" } });
    check(up.status === 201, `blob ${name} stored in R2`);
    files[name] = { sha256: sha };
  }
  check((await call("PUT", "/obx/v1/ingest/assets/KO-1001_NVY_1", { bearer: it, json: { product_external_id: "KO-1001", color_code: "NVY", role: "packshot", view: "front", position: 1, files } })).json?.visibility === "visible", "asset visible with client renditions");

  const ret = await call("POST", "/admin/api/retailers", { json: { name: "Smoke Shop" } });
  const cl = await call("POST", "/admin/api/api-clients", { json: { retailer_id: ret.json.id, name: "sync" } });
  const tr = await fetch(`${base}/obx/v1/oauth/token`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${cl.json.client.client_id}:${cl.json.client_secret}`)}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const at = ((await tr.json()) as { access_token: string }).access_token;
  check(!!at, "access token issued");
  const snap = await call("GET", "/obx/v1/changes?limit=500", { bearer: at });
  check(snap.json.changes.length === 4 && snap.json.phase === "snapshot", "snapshot lists brand, product, variant, asset");
  const asset = snap.json.changes.find((c: any) => c.type === "asset");
  const web = await fetch(asset.data.renditions.web.url.replace(/^https?:\/\/[^/]+/, base));
  check(web.status === 200 && (await sha256Hex(new Uint8Array(await web.arrayBuffer()))) === files.web.sha256, "signed rendition URL serves the bytes from R2");

  // Import job through the cron path (Workers: jobs run in waitUntil / the minute tick).
  const zip = await zipBytes(
    [
      { name: "products.csv", data: new TextEncoder().encode("style_number,name:en,gtin,color_code,size\nKO-2002,Tee,2000200101031,BLK,M\n") },
      { name: "KO-2002_BLK_1.jpg", data: fakeJpeg(800, 1000, 7) },
    ],
    crc32,
  );
  const boundary = "----smoke";
  const enc = new TextEncoder();
  const body = new Uint8Array([
    ...enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="package"; filename="p.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    ...zip,
    ...enc.encode(`\r\n--${boundary}--\r\n`),
  ]);
  const imp = await call("POST", "/obx/v1/ingest/imports", { bearer: it, body: body as BodyInit, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
  check(imp.status === 202, "import accepted (202)");
  let status = "";
  for (let i = 0; i < 40 && status !== "succeeded" && status !== "failed"; i++) {
    await fetch(`${base}/__scheduled?cron=*+*+*+*+*`);
    await Bun.sleep(500);
    status = (await call("GET", `/obx/v1/ingest/jobs/${imp.json.id}`, { bearer: it })).json?.status;
  }
  check(status === "succeeded", "import job finished via the scheduled handler");
  const job = await call("GET", `/obx/v1/ingest/jobs/${imp.json.id}`, { bearer: it });
  check(job.json.import_run.counts.created === 3, "import created product, variant and image");
  const ui = await fetch(`${base}/some/portal/route`, { headers: { accept: "text/html" } });
  check(ui.status === 200 && (await ui.text()).includes("<html"), "static UI with SPA fallback");
  console.log("\nWorkers smoke test passed.");
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  console.error("---- wrangler log ----\n" + log.slice(-4000));
  process.exitCode = 1;
} finally {
  proc.kill();
}
