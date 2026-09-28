// OBX Ingest API (write side) for the brand's own automation. Admin catalog endpoints reuse these
// handlers with session auth (same semantics, same results).
import { Hono } from "hono";
import type { AppEnv, C } from "./common";
import { ctxOf, json, noContent, readObject, readJson, intQuery, idParam, encodeListCursor, decodeListCursor } from "./common";
import { ObxError } from "../lib/problem";
import { authenticateIngest, type IngestAuth } from "../core/auth";
import { CatalogSession, applyOne, resultStatus, errorResult, type Kind } from "../core/catalog";
import { validExternalId, RENDITIONS, type RenditionName } from "../core/validate";
import { readBody, storeBlob, getBlob, blobJson, fileRef, createUpload, getUpload, putUploadPart, completeUpload, abortUpload, uploadJson, PART_BYTES, MAX_OBJECT_BYTES } from "../core/blobs";
import { ACCEPTED_TYPES } from "../lib/image";
import { parseOps, runOp, summarize, type BatchOptions } from "../core/batch";
import { enqueueJob, getJob, jobItems, type JobRow } from "../core/jobs";
import { importRunOf, startImport, storeRequestBody, type ImportInputs } from "../core/importjob";
import { boundaryOf, scanMultipart } from "../lib/multipart";
import { storeReader, readText } from "../core/storeio";
import { newId, safeJsonParse, isPlainObject } from "../lib/util";
import { sha256Hex } from "../lib/crypto";
import { memLimit, limitHeaders, enforce } from "../core/ratelimit";

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;

/** Who is writing: an ingest token, or an admin session (admin catalog endpoints). */
export interface Writer {
  owner: string;
  scopes: string[];
  brands: string[] | null;
  label: string;
  trigger: "api" | "upload" | "cli";
}

export function writerFromToken(a: IngestAuth, userAgent: string | undefined): Writer {
  return { owner: `ingest:${a.token.id}`, scopes: a.scopes, brands: a.brands, label: a.token.name, trigger: /obx-cli|^obx\//i.test(userAgent ?? "") ? "cli" : "api" };
}

export const ADMIN_WRITER: Writer = { owner: "admin", scopes: ["ingest:read", "ingest:write", "ingest:delete"], brands: null, label: "admin", trigger: "upload" };

function need(w: Writer, scope: string) {
  if (!w.scopes.includes(scope)) throw new ObxError("insufficient_scope", `This call needs the ${scope} scope.`);
}

function extParam(c: C): string {
  const raw = c.req.param("external_id") ?? "";
  const ext = validExternalId(raw);
  if (!ext) throw new ObxError("validation_failed", "external_id must be 1-200 characters without control characters or '/'.");
  return ext;
}

// ------------------------------------------------------------------ handlers shared with the admin API

export async function handleRecordGet(c: C, w: Writer, kind: Kind) {
  need(w, "ingest:read");
  const ctx = ctxOf(c);
  const s = await new CatalogSession(ctx, { allowedBrands: w.brands, canDelete: false }).init();
  const o = await s.load(kind, extParam(c));
  if (!o) throw new ObxError("not_found", `No ${kind} with this external id.`);
  const rec = await s.record(o);
  return json(c, rec, 200, { etag: rec.etag as string });
}

export async function handleRecordWrite(c: C, w: Writer, kind: Kind, method: "PUT" | "PATCH" | "DELETE") {
  const ctx = ctxOf(c);
  const ext = extParam(c);
  const ifMatch = c.req.header("if-match") ?? null;
  const opts = { allowedBrands: w.brands, canDelete: w.scopes.includes("ingest:delete") };
  let r;
  if (method === "DELETE") {
    need(w, "ingest:delete");
    r = await applyOne(ctx, opts, "delete", kind, ext, null, ifMatch);
  } else {
    need(w, "ingest:write");
    if (method === "PATCH") {
      const ct = c.req.header("content-type") ?? "";
      if (ct && !/json/.test(ct)) throw new ObxError("unsupported_media_type", "Send a JSON merge patch (application/merge-patch+json).");
    }
    const body = await readJson(c);
    if (!isPlainObject(body)) throw new ObxError("invalid_request", "The body must be a JSON object.");
    r = await applyOne(ctx, opts, method === "PUT" ? "upsert" : "patch", kind, ext, body, ifMatch);
  }
  if (r.result === "error") {
    const e = r.error as { status: number; obx_error: string; detail: string; errors?: never[] };
    throw new ObxError(e.obx_error as never, e.detail, e.errors ?? [], { status: e.status });
  }
  const headers: Record<string, string> = {};
  if (r.etag) headers.etag = r.etag;
  if (r.result === "created") headers.location = c.req.path;
  return json(c, r, resultStatus(r), headers);
}

export async function handleAssetOrder(c: C, w: Writer) {
  need(w, "ingest:write");
  const ctx = ctxOf(c);
  const body = await readObject(c);
  const color = body.color_code === null || body.color_code === undefined ? null : typeof body.color_code === "string" ? body.color_code : undefined;
  if (color === undefined || body.color_code === undefined) throw new ObxError("validation_failed", "color_code is required (null = images for all colours).");
  const ids = body.asset_external_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 999 || ids.some((x) => typeof x !== "string")) throw new ObxError("validation_failed", "asset_external_ids must list 1-999 image ids.");
  const s = await new CatalogSession(ctx, { allowedBrands: w.brands, canDelete: false }).init();
  const results = await s.assetOrder(extParam(c), color, ids as string[]);
  if (results.some((r) => r.result === "updated")) await s.commit();
  return json(c, results);
}

export async function handleFilePut(c: C, w: Writer) {
  need(w, "ingest:write");
  const ctx = ctxOf(c);
  const ext = extParam(c);
  const rendition = c.req.param("rendition") as RenditionName;
  if (!(RENDITIONS as readonly string[]).includes(rendition)) throw new ObxError("not_found", "Unknown rendition (original, web, square, thumb).");
  const s = await new CatalogSession(ctx, { allowedBrands: w.brands, canDelete: false }).init();
  if (!(await s.load("asset", ext))) throw new ObxError("not_found", `No asset "${ext}". Create the asset metadata first.`);
  const ct = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (ct && !ct.startsWith("image/") && ct !== "application/octet-stream") throw new ObxError("unsupported_media_type", `Send the image bytes with its image content type (${ACCEPTED_TYPES.join(", ")}).`);
  const bytes = await readBody(c.req.raw, ctx.config.maxUploadBytes);
  const declared = c.req.header("obx-content-sha256") ?? null;
  if (declared && !/^[a-f0-9]{64}$/i.test(declared)) throw new ObxError("invalid_request", "OBX-Content-SHA256 must be 64 hex characters.");
  const { row } = await storeBlob(ctx, bytes, declared);
  const r = await s.attachFile(ext, rendition, fileRef(row));
  if (r.result === "updated") await s.commit();
  return json(c, r, 200, r.etag ? { etag: r.etag } : {});
}

export async function handleBlobHead(c: C, w: Writer) {
  need(w, "ingest:read");
  const sha = (c.req.param("sha256") ?? "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) return new Response(null, { status: 404 });
  const b = await getBlob(ctxOf(c), sha);
  if (!b) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(null, { status: 200, headers: { "content-length": "0", "obx-blob-bytes": String(b.bytes), "cache-control": "no-store" } });
}

async function drainBody(req: Request, max: number) {
  if (!req.body) return;
  const r = req.body.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) return;
    n += value.length;
    if (n > max) {
      await r.cancel().catch(() => {});
      throw new ObxError("payload_too_large", "The file is larger than this node accepts.");
    }
  }
}

export async function handleBlobPut(c: C, w: Writer) {
  need(w, "ingest:write");
  const ctx = ctxOf(c);
  const sha = (c.req.param("sha256") ?? "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new ObxError("validation_failed", "The path must be the lowercase hex sha256 of the bytes.");
  const existing = await getBlob(ctx, sha);
  if (existing) {
    // Read and discard the upload: cancelling a request body makes Bun hang the response.
    await drainBody(c.req.raw, ctx.config.maxUploadBytes);
    return json(c, blobJson(existing, false), 200);
  }
  const bytes = await readBody(c.req.raw, ctx.config.maxUploadBytes);
  const { row, created } = await storeBlob(ctx, bytes, sha);
  return json(c, blobJson(row, created), created ? 201 : 200);
}

/** Stores the multipart import request and starts the import job (always 202). */
export async function handleImport(c: C, w: Writer, trigger: Writer["trigger"]) {
  need(w, "ingest:write");
  const ctx = ctxOf(c);
  const boundary = boundaryOf(c.req.header("content-type"));
  if (!boundary) throw new ObxError("unsupported_media_type", "Send the import as multipart/form-data (fields: package, csv, assets_csv, images, images_manifest, options).");
  const idem = c.req.header("idempotency-key");
  if (idem) {
    const prev = await ctx.db.first<{ id: string }>("SELECT id FROM jobs WHERE idempotency_key = ? AND owner = ? AND created_at > ?", [idem, w.owner, ctx.iso(-24 * 3600 * 1000)]);
    if (prev) return { job: (await getJob(ctx, prev.id))!, reused: true };
  }
  const jobId = newId("job");
  const key = `imports/${jobId}/request`;
  const size = await storeRequestBody(ctx, key, c.req.raw, MAX_IMPORT_BYTES);
  let parts;
  try {
    parts = await scanMultipart(storeReader(ctx, key), size, boundary);
  } catch (e) {
    throw new ObxError("invalid_request", `The multipart body could not be read: ${e instanceof Error ? e.message : "malformed"}.`);
  }
  const inputs: ImportInputs = { csv: null, assets: null, zips: [], files: [], manifest: null };
  let options: Record<string, unknown> = {};
  for (const p of parts) {
    const loc = { key, offset: p.offset, length: p.length, name: p.filename ?? p.name };
    if (p.name === "options") {
      const txt = await readText(ctx, key, p.offset, p.length, 65536);
      const o = safeJsonParse<unknown>(txt, null);
      if (!isPlainObject(o)) throw new ObxError("invalid_request", "options must be a JSON object.");
      options = o;
    } else if (p.name === "images_manifest") inputs.manifest = { key, offset: p.offset, length: p.length };
    else if (p.name === "csv" || p.name === "products_csv") inputs.csv = { ...loc, name: p.filename ?? "products.csv" };
    else if (p.name === "assets_csv") inputs.assets = { ...loc, name: p.filename ?? "assets.csv" };
    else if (p.name === "package") inputs.zips.push({ ...loc, name: p.filename ?? "package.zip" });
    else if (p.name === "images" || p.name === "images[]") {
      const head = await ctx.blobs.getRange(key, p.offset, 4);
      if (head && head[0] === 0x50 && head[1] === 0x4b) inputs.zips.push({ ...loc, name: p.filename ?? "images.zip" });
      else inputs.files.push({ ...loc, name: p.filename ?? `image-${inputs.files.length + 1}` });
    }
  }
  const mode = options.mode === undefined ? "upsert" : options.mode;
  if (mode !== "upsert" && mode !== "mirror") throw new ObxError("validation_failed", 'options.mode must be "upsert" or "mirror".');
  if (mode === "mirror") need(w, "ingest:delete");
  const lang = options.default_language;
  if (lang !== undefined && lang !== null && (typeof lang !== "string" || !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(lang))) throw new ObxError("validation_failed", "options.default_language must be a language tag like nl.");
  if (!inputs.csv && !inputs.zips.length && !inputs.files.length && !inputs.manifest) throw new ObxError("invalid_request", "Nothing to import: send package, csv, images or images_manifest.");
  const job = await startImport(
    ctx,
    {
      trigger,
      mode,
      dry_run: options.dry_run === true,
      allow_mass_unpublish: options.allow_mass_unpublish === true,
      default_language: (lang as string) ?? null,
      allowed_brands: w.brands,
      inputs,
      started_by: w.owner,
    },
    { owner: w.owner, idempotencyKey: idem ?? null, id: jobId },
  );
  return { job, reused: false };
}

// ------------------------------------------------------------------ IngestJob representation

export async function ingestJobJson(c: C, job: JobRow) {
  const ctx = ctxOf(c);
  const base = await ctx.baseUrl();
  const summary = safeJsonParse<Record<string, number> | null>(job.summary, null);
  return {
    id: job.id,
    kind: job.kind,
    status: job.status === "expired" ? "succeeded" : job.status,
    created_at: job.created_at,
    finished_at: job.finished_at,
    progress: { done: job.progress_done, total: job.progress_total },
    summary: summary ? { created: summary.created ?? 0, updated: summary.updated ?? 0, unchanged: summary.unchanged ?? 0, deleted: summary.deleted ?? 0, errors: summary.errors ?? 0 } : null,
    import_run: job.kind === "import" ? importRunOf(job) : null,
    results_url: `${base}/obx/v1/ingest/jobs/${job.id}/results`,
  };
}

// ------------------------------------------------------------------ routes

export const ingest = new Hono<AppEnv>();

async function writer(c: C): Promise<Writer> {
  const ctx = ctxOf(c);
  if (!(await ctx.isSetUp())) throw new ObxError("setup_required", "This node has not been set up yet.", [], { status: 503 });
  const a = await authenticateIngest(ctx, c.req.header("authorization"));
  const rl = memLimit(ctx.now(), `ingest:${a.token.id}`, 1200);
  c.set("rl", limitHeaders(rl));
  enforce(rl);
  return writerFromToken(a, c.req.header("user-agent"));
}

ingest.get("/", async (c) => {
  const w = await writer(c);
  const ctx = ctxOf(c);
  const a = await authenticateIngest(ctx, c.req.header("authorization"));
  const s = await ctx.settings();
  const brands = await ctx.db.all<{ external_id: string; stored: string }>("SELECT external_id, stored FROM brands ORDER BY external_id");
  return json(c, {
    token: { id: a.token.id, name: a.token.name, scopes: w.scopes, brand_external_ids: w.brands, expires_at: a.token.expires_at },
    limits: {
      max_upload_bytes: Math.max(ctx.config.maxUploadBytes, 26214400),
      max_object_bytes: MAX_OBJECT_BYTES,
      part_bytes: PART_BYTES,
      max_batch_operations: 1000,
      max_import_bytes: MAX_IMPORT_BYTES,
    },
    renditions: { server_generated: false, required: ["original", "web", "square", "thumb"] },
    accepted_content_types: [...ACCEPTED_TYPES],
    default_status: s.defaults.ingest_status,
    brands: brands.filter((b) => !w.brands || w.brands.includes(b.external_id)).map((b) => ({ external_id: b.external_id, name: String(safeJsonParse<Record<string, unknown>>(b.stored, {}).name ?? b.external_id) })),
    languages: [s.portal.default_language, ...s.portal.languages.filter((l) => l !== s.portal.default_language)],
  });
});

for (const [path, kind] of [
  ["brands", "brand"],
  ["products", "product"],
  ["variants", "variant"],
  ["assets", "asset"],
] as const) {
  ingest.get(`/${path}/:external_id`, async (c) => handleRecordGet(c, await writer(c), kind));
  ingest.put(`/${path}/:external_id`, async (c) => handleRecordWrite(c, await writer(c), kind, "PUT"));
  ingest.patch(`/${path}/:external_id`, async (c) => handleRecordWrite(c, await writer(c), kind, "PATCH"));
  ingest.delete(`/${path}/:external_id`, async (c) => handleRecordWrite(c, await writer(c), kind, "DELETE"));
}
ingest.put("/products/:external_id/asset-order", async (c) => handleAssetOrder(c, await writer(c)));
ingest.put("/assets/:external_id/files/:rendition", async (c) => handleFilePut(c, await writer(c)));
// Hono answers HEAD with the GET route (body stripped).
ingest.get("/blobs/:sha256", async (c) => handleBlobHead(c, await writer(c)));
ingest.put("/blobs/:sha256", async (c) => handleBlobPut(c, await writer(c)));

ingest.post("/uploads", async (c) => {
  const w = await writer(c);
  need(w, "ingest:write");
  const r = await createUpload(ctxOf(c), w.owner, await readObject(c));
  if ("blob" in r && r.blob) return json(c, blobJson(r.blob, false), 200);
  return json(c, uploadJson(r.upload!), 201);
});
ingest.get("/uploads/:id", async (c) => {
  const w = await writer(c);
  need(w, "ingest:read");
  return json(c, uploadJson(await getUpload(ctxOf(c), w.owner, idParam(c))));
});
ingest.delete("/uploads/:id", async (c) => {
  const w = await writer(c);
  need(w, "ingest:write");
  await abortUpload(ctxOf(c), await getUpload(ctxOf(c), w.owner, idParam(c)));
  return noContent(c);
});
ingest.put("/uploads/:id/parts/:number", async (c) => {
  const w = await writer(c);
  need(w, "ingest:write");
  const ctx = ctxOf(c);
  const u = await getUpload(ctx, w.owner, idParam(c));
  const data = await readBody(c.req.raw, u.part_bytes);
  return json(c, uploadJson(await putUploadPart(ctx, u, Number(c.req.param("number")), data)));
});
ingest.post("/uploads/:id/complete", async (c) => {
  const w = await writer(c);
  need(w, "ingest:write");
  const ctx = ctxOf(c);
  const { row, created } = await completeUpload(ctx, await getUpload(ctx, w.owner, idParam(c)));
  return json(c, blobJson(row, created), 200);
});

ingest.post("/batch", async (c) => {
  const w = await writer(c);
  const ctx = ctxOf(c);
  const idem = c.req.header("idempotency-key");
  const idemKey = idem ? `batch:${w.owner}:${idem}` : null;
  if (idemKey) {
    const prev = await ctx.db.first<{ status: number; body: string }>("SELECT status, body FROM idempotency WHERE key = ?", [idemKey]);
    if (prev) return new Response(prev.body, { status: prev.status, headers: { "content-type": "application/json" } });
  }
  const text = await c.req.text();
  if (text.length > 64 * 1048576) throw new ObxError("payload_too_large", "The batch body is too large.");
  const ops = parseOps(text, c.req.header("content-type") ?? null);
  if (ops.length > 1000) throw new ObxError("limit_exceeded", "At most 1000 operations per batch.");
  const opts: BatchOptions = { allowedBrands: w.brands, canDelete: w.scopes.includes("ingest:delete"), canWrite: w.scopes.includes("ingest:write") };
  if (!opts.canWrite && !opts.canDelete) throw new ObxError("insufficient_scope", "This call needs the ingest:write scope.");
  const async = /respond-async/i.test(c.req.header("prefer") ?? "") || ops.length > ctx.config.syncBatchMax;
  let status: number;
  let body: unknown;
  if (async) {
    const id = newId("job");
    await ctx.blobs.put(`jobs/${id}/ops.json`, new TextEncoder().encode(JSON.stringify(ops)), "application/json");
    const job = await enqueueJob(ctx, { kind: "batch", owner: w.owner, input: { opts, count: ops.length }, idempotencyKey: idem ?? null, total: ops.length, id });
    status = 202;
    body = await ingestJobJson(c, job);
  } else {
    const results = [];
    for (let i = 0; i < ops.length; i++) results.push(await runOp(ctx, opts, ops[i], i));
    status = 200;
    body = { results, summary: summarize(results) };
  }
  const text2 = JSON.stringify(body);
  if (idemKey) await ctx.db.run("INSERT OR IGNORE INTO idempotency (key, status, body, created_at) VALUES (?, ?, ?, ?)", [idemKey, status, text2, ctx.iso()]);
  const headers: Record<string, string> = { "content-type": "application/json", ...(c.get("rl") ?? {}) };
  if (status === 202) headers.location = `/obx/v1/ingest/jobs/${(body as { id: string }).id}`;
  return new Response(text2, { status, headers });
});

ingest.post("/imports", async (c) => {
  const w = await writer(c);
  const { job } = await handleImport(c, w, w.trigger);
  return json(c, await ingestJobJson(c, job), 202, { location: `/obx/v1/ingest/jobs/${job.id}` });
});

ingest.get("/jobs", async (c) => {
  const w = await writer(c);
  need(w, "ingest:read");
  const ctx = ctxOf(c);
  const limit = intQuery(c, "limit", 25, 1, 100);
  const status = c.req.query("status");
  const cur = await decodeListCursor<{ t: string; id: string }>(ctx, "jobs", c.req.query("cursor") || undefined);
  const params: (string | number)[] = [];
  let where = "kind IN ('batch', 'import')";
  if (status) {
    if (!["queued", "running", "succeeded", "failed"].includes(status)) throw new ObxError("invalid_request", "Unknown status filter.");
    where += " AND status = ?";
    params.push(status);
  }
  if (cur) {
    where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
    params.push(cur.t, cur.t, cur.id);
  }
  const rows = await ctx.db.all<JobRow>(`SELECT * FROM jobs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, [...params, limit + 1]);
  const page = rows.slice(0, limit);
  const items = [];
  for (const j of page) items.push(await ingestJobJson(c, j));
  const last = page[page.length - 1];
  return json(c, { items, next_cursor: rows.length > limit ? await encodeListCursor(ctx, "jobs", { t: last.created_at, id: last.id }) : null });
});

async function visibleJob(c: C, w: Writer): Promise<JobRow> {
  const job = await getJob(ctxOf(c), idParam(c));
  if (!job || (job.kind !== "batch" && job.kind !== "import")) throw new ObxError("not_found", "Unknown job.");
  void w;
  return job;
}

ingest.get("/jobs/:id", async (c) => {
  const w = await writer(c);
  need(w, "ingest:read");
  return json(c, await ingestJobJson(c, await visibleJob(c, w)));
});

ingest.get("/jobs/:id/results", async (c) => {
  const w = await writer(c);
  need(w, "ingest:read");
  const ctx = ctxOf(c);
  const job = await visibleJob(c, w);
  const limit = intQuery(c, "limit", 100, 1, 1000);
  const errorsOnly = c.req.query("errors_only") === "true";
  const after = (await decodeListCursor<number>(ctx, "results", c.req.query("cursor") || undefined)) ?? 0;
  const items = await jobItems(ctx, job.id, job.kind === "batch" ? "result" : "row", after, limit + 1, errorsOnly);
  const page = items.slice(0, limit);
  return json(c, { items: page.map((x) => x.item), next_cursor: items.length > limit ? await encodeListCursor(ctx, "results", page[page.length - 1].idx) : null });
});

export { errorResult, sha256Hex };
