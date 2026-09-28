// Test harness: a real node (Bun adapter, in-memory SQLite, temp-dir files) driven through app.request().
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createWorker } from "../src/app";
import { createBunPlatform } from "../src/adapters/bun/platform";
import type { MailMessage } from "../src/platform";
import { fakeJpeg } from "../src/lib/image";
import { sha256Hex } from "../src/lib/crypto";

export const FIX = join(import.meta.dir, "fixtures");
export const SETUP_CODE = "TEST-SETUP-1234";

export interface Res {
  status: number;
  headers: Headers;
  json: any;
  text: string;
  bytes: Uint8Array;
}

export class Browser {
  cookies = new Map<string, string>();
  csrf = "";
  constructor(private node: TestNode) {}

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(h: Headers) {
    for (const sc of h.getSetCookie()) {
      const [kv] = sc.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      if (/Max-Age=0/i.test(sc) || v === "") this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }

  async init() {
    const r = await this.req("GET", "/admin/api/session");
    this.csrf = r.json.csrf_token;
    return this;
  }

  async req(method: string, path: string, o: { json?: unknown; body?: BodyInit | Uint8Array; headers?: Record<string, string>; noCsrf?: boolean } = {}): Promise<Res> {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (this.cookies.size) headers.cookie = this.cookieHeader();
    if (!o.noCsrf && !["GET", "HEAD"].includes(method) && this.csrf) headers["x-csrf-token"] = this.csrf;
    let body = o.body;
    if (o.json !== undefined) {
      body = JSON.stringify(o.json);
      headers["content-type"] ??= "application/json";
    }
    const r = await this.node.request(method, path, { headers, body });
    this.absorb(r.headers);
    if (r.json && typeof r.json === "object" && typeof r.json.csrf_token === "string") this.csrf = r.json.csrf_token;
    return r;
  }
}

export class TestNode {
  platform: ReturnType<typeof createBunPlatform>;
  app: ReturnType<typeof createApp>;
  worker: ReturnType<typeof createWorker>;
  mails: MailMessage[] = [];
  clock: { offset: number } = { offset: 0 };
  dataDir: string;

  constructor(env: Record<string, string> = {}, o: { dataDir?: string; dbPath?: string } = {}) {
    const dir = o.dataDir ?? mkdtempSync(join(tmpdir(), "obx-node-ts-"));
    this.dataDir = dir;
    this.platform = createBunPlatform({
      env: { OBX_SECRET_KEY: "test-secret-key-that-is-long-enough-0123456789", OBX_SETUP_CODE: SETUP_CODE, OBX_ALLOW_PRIVATE_URLS: "true", ...env },
      dataDir: dir,
      uiDir: join(import.meta.dir, "..", "public"),
      dbPath: o.dbPath ?? ":memory:",
      quiet: process.env.OBX_TEST_LOG ? false : true,
      now: () => Date.now() + this.clock.offset,
    });
    this.platform.mailer = { configured: true, send: async (m) => void this.mails.push(m) };
    this.app = createApp(this.platform);
    this.worker = createWorker(this.platform);
  }

  async request(method: string, path: string, o: { headers?: Record<string, string>; body?: BodyInit | Uint8Array } = {}): Promise<Res> {
    const res = await this.app.request(path, { method, headers: o.headers, body: o.body as BodyInit }, {});
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(buf);
    let json: any = null;
    if ((res.headers.get("content-type") ?? "").includes("json")) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, headers: res.headers, json, text, bytes: buf };
  }

  /** Runs all background work (deferred tasks and jobs) until idle. */
  async drain() {
    for (let i = 0; i < 200; i++) {
      await Promise.allSettled([...this.platform.pending]);
      const steps = await this.worker.runJobs(120_000);
      if (!steps && !this.platform.pending.size) {
        const busy = await this.platform.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')");
        if (!busy?.n) return;
        await Bun.sleep(5);
      }
    }
    throw new Error("drain did not finish");
  }

  browser() {
    return new Browser(this).init();
  }

  async setup(): Promise<Browser> {
    const b = await this.browser();
    const r = await b.req("POST", "/admin/api/setup", {
      json: {
        setup_code: SETUP_CODE,
        company: { name: "Kestrel Outfitters", first_brand_name: "Kestrel", default_language: "nl", languages: ["nl", "en"], contact_email: "trade@kestrel.example", website: "https://kestrel.example" },
        admin: { name: "Ada Admin", email: "admin@kestrel.example", password: "correct horse battery staple" },
      },
    });
    if (r.status !== 201) throw new Error(`setup failed: ${r.status} ${r.text}`);
    return b;
  }

  async ingestToken(admin: Browser, scopes = ["ingest:read", "ingest:write", "ingest:delete"], brands: string[] | null = null): Promise<string> {
    const r = await admin.req("POST", "/admin/api/ingest-tokens", { json: { name: "test", scopes, brand_external_ids: brands } });
    if (r.status !== 201) throw new Error(`token failed: ${r.text}`);
    return r.json.secret;
  }

  async retailerClient(admin: Browser, o: { name?: string; brand_ids?: string[] | null; allow_original?: boolean | null; scopes?: string[] } = {}) {
    const r = await admin.req("POST", "/admin/api/retailers", { json: { name: o.name ?? "Test Retailer", brand_ids: o.brand_ids ?? null, allow_original: o.allow_original ?? null } });
    if (r.status !== 201) throw new Error(`retailer failed: ${r.text}`);
    const cl = await admin.req("POST", "/admin/api/api-clients", { json: { retailer_id: r.json.id, name: "Shop sync", ...(o.scopes ? { scopes: o.scopes } : {}) } });
    if (cl.status !== 201) throw new Error(`client failed: ${cl.text}`);
    return { retailer: r.json, clientId: cl.json.client.client_id as string, secret: cl.json.client_secret as string, clientRow: cl.json.client };
  }

  async accessToken(clientId: string, secret: string, scope?: string): Promise<string> {
    const body = new URLSearchParams({ grant_type: "client_credentials", ...(scope ? { scope } : {}) });
    const r = await this.request("POST", "/obx/v1/oauth/token", {
      headers: { authorization: `Basic ${btoa(`${clientId}:${secret}`)}`, "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (r.status !== 200) throw new Error(`token failed: ${r.status} ${r.text}`);
    return r.json.access_token;
  }

  api(token: string, method: string, path: string, o: { json?: unknown; headers?: Record<string, string>; body?: BodyInit | Uint8Array } = {}) {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(o.headers ?? {}) };
    let body = o.body;
    if (o.json !== undefined) {
      body = JSON.stringify(o.json);
      headers["content-type"] ??= "application/json";
    }
    return this.request(method, path, { headers, body });
  }

  /** Reads the whole change feed from `cursor` (or a fresh snapshot) until has_more is false. */
  async feed(token: string, cursor?: string, limit = 500) {
    const entries: any[] = [];
    let cur = cursor;
    let phases: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const r = await this.api(token, "GET", `/obx/v1/changes?limit=${limit}${cur ? `&cursor=${encodeURIComponent(cur)}` : ""}`);
      if (r.status !== 200) throw new Error(`changes failed: ${r.status} ${r.text}`);
      entries.push(...r.json.changes.map((c: any) => ({ ...c, _phase: r.json.phase })));
      phases.push(r.json.phase);
      cur = r.json.next_cursor;
      if (!r.json.has_more) break;
    }
    return { entries, cursor: cur!, phases };
  }
}

// ------------------------------------------------------------------ fixtures & images

export function fixtureText(path: string) {
  return readFileSync(join(FIX, path), "utf8");
}

export function fixtureBytes(path: string) {
  return new Uint8Array(readFileSync(join(FIX, path)));
}

export function kestrelImages(): { name: string; bytes: Uint8Array }[] {
  return readdirSync(join(FIX, "kestrel/images"))
    .sort()
    .map((name) => ({ name, bytes: fixtureBytes(`kestrel/images/${name}`) }));
}

/** Client-generated renditions following the rules (JPEG, web <= 2000, square, thumb <= 600). */
export function renditionsFor(w: number, h: number, seed: number) {
  const fit = (max: number) => {
    const s = Math.min(1, max / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  };
  const web = fit(2000);
  const thumb = fit(600);
  const side = Math.max(web.w, web.h);
  return {
    web: { ...web, bytes: fakeJpeg(web.w, web.h, seed * 3 + 1) },
    square: { w: side, h: side, bytes: fakeJpeg(side, side, seed * 3 + 2) },
    thumb: { ...thumb, bytes: fakeJpeg(thumb.w, thumb.h, seed * 3 + 3) },
  };
}

export async function uploadBlob(node: TestNode, token: string, bytes: Uint8Array): Promise<string> {
  const sha = await sha256Hex(bytes);
  const r = await node.api(token, "PUT", `/obx/v1/ingest/blobs/${sha}`, { body: bytes, headers: { "content-type": "image/jpeg" } });
  if (r.status !== 200 && r.status !== 201) throw new Error(`blob failed ${r.status} ${r.text}`);
  return sha;
}

/** Multipart form body built by hand (same as a browser or curl -F would send). */
export function formData(parts: { name: string; filename?: string; type?: string; data: Uint8Array | string }[]): { body: Uint8Array; contentType: string } {
  const boundary = "----obxtest" + Math.random().toString(16).slice(2);
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    let h = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ""}\r\n`;
    if (p.type) h += `Content-Type: ${p.type}\r\n`;
    chunks.push(enc.encode(h + "\r\n"), typeof p.data === "string" ? enc.encode(p.data) : p.data, enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const body = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    body.set(c, o);
    o += c.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Imports fixtures/kestrel (products.csv + assets.csv + 27 images) through the Ingest API. */
export async function importKestrel(node: TestNode, token: string, extra: { name: string; data: string; type?: string }[] = []) {
  const parts: { name: string; filename?: string; type?: string; data: Uint8Array | string }[] = [
    { name: "csv", filename: "products.csv", type: "text/csv", data: fixtureText("kestrel/products.csv") },
    { name: "assets_csv", filename: "assets.csv", type: "text/csv", data: fixtureText("kestrel/assets.csv") },
    ...kestrelImages().map((i) => ({ name: "images", filename: i.name, type: "image/png", data: i.bytes })),
    ...extra,
  ];
  const f = formData(parts);
  const r = await node.api(token, "POST", "/obx/v1/ingest/imports", { body: f.body, headers: { "content-type": f.contentType } });
  if (r.status !== 202) throw new Error(`import failed ${r.status} ${r.text}`);
  await node.drain();
  const job = await node.api(token, "GET", `/obx/v1/ingest/jobs/${r.json.id}`);
  return job.json;
}

/** Uploads client renditions for every asset that lacks them (what the admin UI / obx CLI do). */
export async function addRenditions(node: TestNode, token: string) {
  const rows = await node.platform.db.all<{ external_id: string; files: string }>("SELECT external_id, files FROM assets ORDER BY external_id");
  let seed = 1;
  for (const r of rows) {
    const files = JSON.parse(r.files);
    if (!files.original || files.web) continue;
    const rs = renditionsFor(files.original.width, files.original.height, seed++);
    for (const n of ["web", "square", "thumb"] as const) {
      const res = await node.api(token, "PUT", `/obx/v1/ingest/assets/${encodeURIComponent(r.external_id)}/files/${n}`, { body: rs[n].bytes, headers: { "content-type": "image/jpeg" } });
      if (res.status !== 200) throw new Error(`rendition failed ${res.status} ${res.text}`);
    }
  }
}

/** Structural match with the conformance placeholders ({{id}}, {{datetime}}, …). Returns a list of problems. */
export function match(expected: unknown, actual: unknown, path = "$"): string[] {
  if (typeof expected === "string" && /^\{\{.+\}\}$/.test(expected)) {
    const p = expected.slice(2, -2);
    const ok =
      p === "id"
        ? typeof actual === "string" && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(actual)
        : p === "datetime"
          ? typeof actual === "string" && !Number.isNaN(Date.parse(actual))
          : p === "datetime|null"
            ? actual === null || (typeof actual === "string" && !Number.isNaN(Date.parse(actual)))
            : p === "url"
              ? typeof actual === "string" && /^https?:\/\//.test(actual)
              : p === "sha256"
                ? typeof actual === "string" && /^[a-f0-9]{64}$/.test(actual)
                : p === "int"
                  ? Number.isInteger(actual)
                  : true;
    return ok ? [] : [`${path}: expected ${expected}, got ${JSON.stringify(actual)}`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected array`];
    if (expected.length !== actual.length) return [`${path}: expected ${expected.length} items, got ${actual.length}`];
    return expected.flatMap((e, i) => match(e, actual[i], `${path}[${i}]`));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return [`${path}: expected object, got ${JSON.stringify(actual)}`];
    const out: string[] = [];
    for (const [k, v] of Object.entries(expected)) {
      if (!(k in (actual as object))) out.push(`${path}.${k}: missing`);
      else out.push(...match(v, (actual as Record<string, unknown>)[k], `${path}.${k}`));
    }
    for (const k of Object.keys(actual as object)) if (!(k in expected) && !k.startsWith("x-")) out.push(`${path}.${k}: unexpected key`);
    return out;
  }
  return expected === actual ? [] : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}
