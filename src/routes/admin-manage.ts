// Admin API for the brand: settings, catalog, imports, scheduled imports, retailers, access requests,
// accounts, API keys, automatic-upload tokens, webhooks and statistics.
import { Hono } from "hono";
import type { AppEnv, C } from "./common";
import { ctxOf, json, noContent, readObject, readOptionalObject, intQuery, idParam, encodeListCursor, decodeListCursor } from "./common";
import { requireAdmin } from "./admin-auth";
import { ObxError, fieldError } from "../lib/problem";
import { SPEC_DEFAULT_RIGHTS, RETENTION_LIMITS, defaultSettings, type SettingsData } from "../core/ctx";
import { V, LANG_RE, CHANNELS, COUNTRY_RE, INGEST_SCOPES, PROTOCOL_SCOPES, validExternalId } from "../core/validate";
import { isPlainObject, mergePatch, newId, safeJsonParse, canonicalJson } from "../lib/util";
import { grantChangeAllStmt } from "../core/changes";
import { enqueueJob, getJob, jobItems, type JobRow } from "../core/jobs";
import { readBody, storeBlob } from "../core/blobs";
import { ADMIN_WRITER, handleAssetOrder, handleBlobHead, handleBlobPut, handleFilePut, handleImport, handleRecordWrite } from "./ingest";
import { CatalogSession, type Kind } from "../core/catalog";
import { renditionUrl, signedExpiry, placeholders } from "../core/read";
import { renditionMeta, type Files } from "../core/reps";
import { importRunOf, importRunWithPreview, startImport } from "../core/importjob";
import { importTemplate } from "../core/importformat";
import { writeCsv } from "../lib/csv";
import { assertSafeUrl } from "../lib/ssrf";
import { nextRunAt, testSource, validTimezone, type SourceRow } from "../core/sources";
import {
  adminAccessRequestJson,
  approveAccessRequest,
  clientJson,
  clientWithSecret,
  createClient,
  createRetailer,
  deleteRetailer,
  getRetailer,
  inviteUser,
  patchRetailer,
  rejectAccessRequest,
  resendInvite,
  retailerJson,
  retailerCounts,
  rotateClient,
  userJson,
  type AccessRequestRow,
} from "../core/accounts";
import { newIngestToken, grantOf, type ClientRow, type IngestTokenRow, type RetailerRow, type UserRow } from "../core/auth";
import { createWebhook, deliveryJson, emitClientEvent, testWebhook, webhookJson, BRAND_EVENTS, type DeliveryRow, type WebhookRow } from "../core/notify";
import { stats } from "../core/stats";
import { eraseUserStmts } from "../core/privacy";
import { sniffType } from "../lib/image";

export const adminManage = new Hono<AppEnv>();

// ------------------------------------------------------------------ settings

async function settingsJson(c: C, s: SettingsData) {
  const ctx = ctxOf(c);
  const base = await ctx.baseUrl();
  const { logoUrl } = await import("./protocol");
  return {
    company: s.company,
    branding: {
      display_name: s.branding.display_name,
      logo_url: await logoUrl(c),
      accent_color: s.branding.accent_color,
      welcome_text: s.branding.welcome_text,
      portal_name: s.branding.portal_name,
    },
    portal: s.portal,
    defaults: s.defaults,
    retention: s.retention,
    node: {
      public_url: base,
      discovery_url: `${base}/.well-known/obx`,
      software: ctx.config.software,
      version: ctx.config.version,
      email_configured: ctx.p.mailer.configured,
      renditions_server_generated: false,
      max_upload_bytes: ctx.config.maxUploadBytes,
      custom_domain_help: ctx.config.customDomainHelp,
    },
  };
}

adminManage.get("/admin/api/settings", async (c) => {
  requireAdmin(c);
  return json(c, await settingsJson(c, await ctxOf(c).settings()));
});

adminManage.patch("/admin/api/settings", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const body = await readObject(c);
  const cur = await ctx.settings();
  const patch: Record<string, unknown> = {};
  for (const k of ["company", "branding", "portal", "defaults", "retention"]) if (k in body) patch[k] = body[k];
  if (isPlainObject(patch.branding)) delete (patch.branding as Record<string, unknown>).logo_url;
  const next = mergePatch(cur, patch) as SettingsData;
  const v = new V();
  next.company.name = v.str(next.company.name, "/company/name", { required: true, min: 1, max: 200 }) ?? cur.company.name;
  next.company.website = v.url(next.company.website, "/company/website");
  next.company.contact_email = v.email(next.company.contact_email, "/company/contact_email");
  next.company.country = v.str(next.company.country, "/company/country", { pattern: COUNTRY_RE, msg: "Use a two-letter country code." });
  next.branding.display_name = v.str(next.branding.display_name, "/branding/display_name", { required: true, min: 1, max: 200 }) ?? cur.branding.display_name;
  next.branding.accent_color = v.str(next.branding.accent_color, "/branding/accent_color", { pattern: /^#[0-9a-fA-F]{6}$/, msg: "Use a colour like #1F4E5F." });
  next.branding.welcome_text = v.localized(next.branding.welcome_text, "/branding/welcome_text");
  next.branding.portal_name = v.localized(next.branding.portal_name, "/branding/portal_name");
  for (const k of ["access_requests_enabled", "allow_original_download", "allow_article_data_export", "retailer_api_self_service"] as const)
    if (typeof next.portal[k] !== "boolean") v.err(`/portal/${k}`, "Must be true or false.");
  if (!Array.isArray(next.portal.languages) || !next.portal.languages.length || next.portal.languages.some((l) => typeof l !== "string" || !LANG_RE.test(l))) v.err("/portal/languages", "List at least one language tag.");
  if (typeof next.portal.default_language !== "string" || !LANG_RE.test(next.portal.default_language)) v.err("/portal/default_language", "Use a language tag.");
  else if (Array.isArray(next.portal.languages) && !next.portal.languages.includes(next.portal.default_language)) next.portal.languages = [next.portal.default_language, ...next.portal.languages];
  if (!["published", "unpublished"].includes(next.defaults.ingest_status)) v.err("/defaults/ingest_status", 'Use "published" or "unpublished".');
  const rdef = defaultSettings().retention;
  const ret = isPlainObject(next.retention) ? (next.retention as Record<string, unknown>) : {};
  next.retention = { ...rdef };
  for (const k of Object.keys(rdef) as (keyof SettingsData["retention"])[]) {
    const val = ret[k] ?? rdef[k];
    if (typeof val !== "number" || !Number.isInteger(val) || val < RETENTION_LIMITS.min || val > RETENTION_LIMITS.max) v.err(`/retention/${k}`, `A whole number of days from ${RETENTION_LIMITS.min} to ${RETENTION_LIMITS.max}.`);
    else next.retention[k] = val;
  }
  const r = isPlainObject(next.defaults.rights) ? (next.defaults.rights as Record<string, unknown>) : { ...SPEC_DEFAULT_RIGHTS };
  if (!["retailer-use", "custom"].includes(r.license as string)) v.err("/defaults/rights/license", 'Use "retailer-use" or "custom".');
  if (!Array.isArray(r.channels) || r.channels.some((ch) => !CHANNELS.includes(ch as string))) v.err("/defaults/rights/channels", `Channels are: ${CHANNELS.join(", ")}.`);
  if (r.territories !== null && r.territories !== undefined && (!Array.isArray(r.territories) || r.territories.some((t) => !COUNTRY_RE.test(String(t))))) v.err("/defaults/rights/territories", "Use two-letter country codes or null.");
  if (!v.ok) throw new ObxError("validation_failed", "Some settings are invalid.", v.errors);
  next.defaults.rights = {
    license: r.license as "retailer-use" | "custom",
    license_text: (r.license_text as string) ?? null,
    channels: [...new Set(r.channels as string[])],
    territories: (r.territories as string[] | null) ?? null,
    embargo_until: (r.embargo_until as string) ?? null,
    expires_at: (r.expires_at as string) ?? null,
    credit: (r.credit as string) ?? null,
    model_release: (r.model_release as boolean) ?? null,
  };
  const stmts = [ctx.metaStmt("settings", JSON.stringify(next))];
  const originalsToggled = cur.portal.allow_original_download !== next.portal.allow_original_download;
  if (originalsToggled) stmts.push(grantChangeAllStmt(ctx, true));
  await ctx.db.batch(stmts);
  ctx.invalidateSettings();
  if (canonicalJson(cur.defaults.rights) !== canonicalJson(next.defaults.rights)) await enqueueJob(ctx, { kind: "maintenance", owner: "admin", input: { task: "rights" } });
  if (originalsToggled) {
    const rs = await ctx.db.all<RetailerRow>("SELECT * FROM retailers WHERE status = 'active'");
    for (const rt of rs) await emitClientEvent(ctx, { retailerId: rt.id }, "grant.updated", { grant: await grantOf(ctx, rt, null) });
  }
  return json(c, await settingsJson(c, await ctx.settings()));
});

adminManage.put("/admin/api/settings/logo", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const bytes = await readBody(c.req.raw, 5 * 1048576);
  const type = sniffType(bytes);
  if (!type) throw new ObxError("unsupported_media_type", "Upload a PNG, JPEG or WebP logo (no SVG).");
  const { row } = await storeBlob(ctx, bytes);
  const s = await ctx.settings();
  s.branding.logo_sha = row.sha256;
  s.branding.logo_type = row.content_type;
  await ctx.saveSettings(s);
  return json(c, await settingsJson(c, s));
});

adminManage.delete("/admin/api/settings/logo", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const s = await ctx.settings();
  s.branding.logo_sha = null;
  s.branding.logo_type = null;
  await ctx.saveSettings(s);
  return json(c, await settingsJson(c, s));
});

// ------------------------------------------------------------------ catalog (ingest semantics)

adminManage.get("/admin/api/catalog/brands", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const rows = await ctx.db.all<{ external_id: string }>("SELECT external_id FROM brands ORDER BY external_id");
  const s = await new CatalogSession(ctx, { allowedBrands: null, canDelete: false }).init();
  const items = [];
  for (const r of rows) items.push(await s.record((await s.load("brand", r.external_id))!));
  return json(c, { items });
});

for (const [path, kind] of [
  ["brands", "brand"],
  ["products", "product"],
  ["variants", "variant"],
  ["assets", "asset"],
] as const) {
  adminManage.put(`/admin/api/catalog/${path}/:external_id`, async (c) => (requireAdmin(c), handleRecordWrite(c, ADMIN_WRITER, kind, "PUT")));
  adminManage.patch(`/admin/api/catalog/${path}/:external_id`, async (c) => (requireAdmin(c), handleRecordWrite(c, ADMIN_WRITER, kind, "PATCH")));
  adminManage.delete(`/admin/api/catalog/${path}/:external_id`, async (c) => (requireAdmin(c), handleRecordWrite(c, ADMIN_WRITER, kind, "DELETE")));
}
adminManage.put("/admin/api/catalog/products/:external_id/asset-order", async (c) => (requireAdmin(c), handleAssetOrder(c, ADMIN_WRITER)));
adminManage.put("/admin/api/catalog/assets/:external_id/files/:rendition", async (c) => (requireAdmin(c), handleFilePut(c, ADMIN_WRITER)));
adminManage.get("/admin/api/catalog/blobs/:sha256", async (c) => (requireAdmin(c), handleBlobHead(c, ADMIN_WRITER)));
adminManage.put("/admin/api/catalog/blobs/:sha256", async (c) => (requireAdmin(c), handleBlobPut(c, ADMIN_WRITER)));

adminManage.get("/admin/api/catalog/products", async (c) => {
  const sess = requireAdmin(c);
  const ctx = ctxOf(c);
  const limit = intQuery(c, "limit", 50, 1, 200);
  const s = await ctx.settings();
  const where: string[] = ["1 = 1"];
  const params: (string | number)[] = [];
  const q = c.req.query("q");
  if (q?.trim()) {
    const digits = q.replace(/\s+/g, "");
    where.push("(p.search_text LIKE ? ESCAPE '\\' OR p.external_id = ?" + (/^\d{8,14}$/.test(digits) ? " OR p.search_text LIKE ?" : "") + ")");
    params.push(`%${q.trim().toLowerCase().replace(/[%_\\]/g, (m) => "\\" + m)}%`, q.trim());
    if (/^\d{8,14}$/.test(digits)) params.push(`%${digits.padStart(14, "0")}%`);
  }
  const brand = c.req.query("brand");
  if (brand) {
    where.push("b.external_id = ?");
    params.push(brand);
  }
  const status = c.req.query("status");
  if (status === "published" || status === "unpublished") {
    where.push("p.status = ?");
    params.push(status);
  }
  const vis = c.req.query("visibility");
  if (vis === "visible") where.push("p.status = 'published' AND b.status = 'published'");
  if (vis === "hidden") where.push("NOT (p.status = 'published' AND b.status = 'published')");
  if (vis === "pending_files") where.push("EXISTS (SELECT 1 FROM assets x WHERE x.product_id = p.id AND (x.has_original = 0 OR x.missing_renditions > 0))");
  const sort = c.req.query("sort") ?? "updated_desc";
  const lang = s.portal.default_language;
  const order =
    sort === "style_number"
      ? "p.style_number COLLATE NOCASE, p.id"
      : sort === "name"
        ? "lower(COALESCE(json_extract(p.stored, '$.name.\"" + lang.replace(/[^a-zA-Z-]/g, "") + "\"'), p.style_number)), p.id"
        : "p.modified_at DESC, p.id DESC";
  const off = (await decodeListCursor<number>(ctx, "admin-products", c.req.query("cursor") || undefined)) ?? 0;
  const whereSql = where.join(" AND ");
  const total = (await ctx.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM products p JOIN brands b ON b.id = p.brand_id WHERE ${whereSql}`, params))?.n ?? 0;
  // Page first (sort + filter on the products table only), then count children for that page only.
  const rows = await ctx.db.all<Record<string, unknown>>(
    `SELECT p.id, p.external_id, p.style_number, p.stored, p.status, p.modified_at, b.external_id AS brand_external_id, b.status AS brand_status,
       (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id) AS variant_count,
       (SELECT COUNT(*) FROM assets a WHERE a.product_id = p.id) AS asset_count,
       (SELECT COUNT(*) FROM assets a WHERE a.product_id = p.id AND (a.has_original = 0 OR a.missing_renditions > 0)) AS pending_asset_count,
       (SELECT a.id || '|' || a.files FROM assets a WHERE a.product_id = p.id AND a.has_original = 1 ORDER BY CASE WHEN a.color_code IS NULL THEN 0 ELSE 1 END, a.color_code, a.position LIMIT 1) AS first_asset
     FROM (SELECT p.id AS pid FROM products p JOIN brands b ON b.id = p.brand_id WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?) pg
     JOIN products p ON p.id = pg.pid JOIN brands b ON b.id = p.brand_id ORDER BY ${order}`,
    [...params, limit + 1, off],
  );
  const base = await ctx.baseUrl();
  const exp = signedExpiry(ctx.now());
  const items = [];
  for (const r of rows.slice(0, limit)) {
    let thumb: string | null = null;
    if (r.first_asset) {
      const [aid] = String(r.first_asset).split("|");
      thumb = await renditionUrl(ctx, base, aid, "thumb", `p.${sess.user.id}`, exp);
    }
    const stored = safeJsonParse<Record<string, unknown>>(r.stored as string, {});
    items.push({
      id: r.id,
      external_id: r.external_id,
      brand_external_id: r.brand_external_id,
      style_number: r.style_number,
      name: stored.name ?? {},
      status: r.status,
      visibility: r.status === "published" && r.brand_status === "published" ? "visible" : "hidden",
      variant_count: r.variant_count,
      asset_count: r.asset_count,
      pending_asset_count: r.pending_asset_count,
      thumb_url: thumb,
      updated_at: r.modified_at,
    });
  }
  return json(c, { items, next_cursor: rows.length > limit ? await encodeListCursor(ctx, "admin-products", off + limit) : null, total });
});

adminManage.get("/admin/api/catalog/products/:external_id", async (c) => {
  const sess = requireAdmin(c);
  const ctx = ctxOf(c);
  const ext = validExternalId(c.req.param("external_id") ?? "");
  if (!ext) throw new ObxError("not_found", "Unknown product.");
  const s = await new CatalogSession(ctx, { allowedBrands: null, canDelete: false }).init();
  const p = await s.load("product", ext);
  if (!p) throw new ObxError("not_found", "Unknown product.");
  const variants = await ctx.db.all<{ external_id: string }>("SELECT external_id FROM variants WHERE product_id = ? ORDER BY external_id", [p.id]);
  const assets = await ctx.db.all<{ external_id: string; id: string; files: string }>(
    "SELECT external_id, id, files FROM assets WHERE product_id = ? ORDER BY CASE WHEN color_code IS NULL THEN 0 ELSE 1 END, color_code, position",
    [p.id],
  );
  const base = await ctx.baseUrl();
  const exp = signedExpiry(ctx.now());
  const out = { record: await s.record(p), variants: [] as unknown[], assets: [] as unknown[] };
  for (const v of variants) out.variants.push(await s.record((await s.load("variant", v.external_id))!));
  for (const a of assets) {
    const meta = renditionMeta(safeJsonParse<Files>(a.files, {}));
    const renditions: Record<string, unknown> = {};
    for (const [n, m] of Object.entries(meta)) {
      if (!m) continue;
      renditions[n] = {
        name: n,
        url: await renditionUrl(ctx, base, a.id, n as never, `p.${sess.user.id}`, exp),
        url_expires_at: new Date(exp * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        content_type: m.content_type,
        width: m.width,
        height: m.height,
        bytes: m.bytes,
        sha256: m.sha256,
        ...(m.fallback ? { "x-obx-fallback": true } : {}),
      };
    }
    out.assets.push({ record: await s.record((await s.load("asset", a.external_id))!), renditions });
  }
  return json(c, out);
});

// ------------------------------------------------------------------ imports

adminManage.get("/admin/api/imports", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const limit = intQuery(c, "limit", 50, 1, 200);
  const cur = await decodeListCursor<{ t: string; id: string }>(ctx, "imports", c.req.query("cursor") || undefined);
  const params: string[] = [];
  let where = "kind = 'import'";
  const src = c.req.query("source_id");
  if (src) {
    where += " AND source_id = ?";
    params.push(src);
  }
  if (cur) {
    where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
    params.push(cur.t, cur.t, cur.id);
  }
  const rows = await ctx.db.all<JobRow>(`SELECT * FROM jobs WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, [...params, limit + 1] as never);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return json(c, { items: page.map(importRunOf), next_cursor: rows.length > limit ? await encodeListCursor(ctx, "imports", { t: last.created_at, id: last.id }) : null });
});

adminManage.post("/admin/api/imports", async (c) => {
  requireAdmin(c);
  const { job } = await handleImport(c, ADMIN_WRITER, "upload");
  return json(c, importRunOf(job), 202, { location: `/admin/api/imports/${job.id}` });
});

async function importJob(c: C) {
  const job = await getJob(ctxOf(c), idParam(c));
  if (!job || job.kind !== "import") throw new ObxError("not_found", "Unknown import.");
  return job;
}

adminManage.get("/admin/api/imports/:id", async (c) => {
  requireAdmin(c);
  return json(c, await importRunWithPreview(ctxOf(c), await importJob(c)));
});

adminManage.get("/admin/api/imports/:id/errors", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const job = await importJob(c);
  const limit = intQuery(c, "limit", 50, 1, 200);
  const after = (await decodeListCursor<number>(ctx, "import-errors", c.req.query("cursor") || undefined)) ?? 0;
  const items = await jobItems(ctx, job.id, "row", after, limit + 1);
  const page = items.slice(0, limit);
  return json(c, { items: page.map((x) => x.item), next_cursor: items.length > limit ? await encodeListCursor(ctx, "import-errors", page[page.length - 1].idx) : null });
});

adminManage.get("/admin/api/import-template.csv", async (c) => {
  requireAdmin(c);
  const s = await ctxOf(c).settings();
  return new Response(writeCsv(importTemplate(s.portal.languages), ",", true), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="products-template.csv"', "cache-control": "no-store" },
  });
});

// ------------------------------------------------------------------ scheduled imports

async function sourceJson(c: C, s: SourceRow) {
  const ctx = ctxOf(c);
  const last = s.last_run_id ? await getJob(ctx, s.last_run_id) : null;
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    enabled: !!s.enabled,
    schedule: safeJsonParse(s.schedule, { frequency: "manual" }),
    mode: s.mode,
    allow_mass_unpublish: !!s.allow_mass_unpublish,
    config: { kind: s.kind, ...safeJsonParse<Record<string, unknown>>(s.config, {}) },
    credentials_set: safeJsonParse(s.credentials_set, {}),
    last_run: last ? importRunOf(last) : null,
    next_run_at: s.next_run_at,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

async function validateSource(c: C, input: Record<string, unknown>, existing: SourceRow | null) {
  const ctx = ctxOf(c);
  const v = new V();
  const kind = existing?.kind ?? v.enumv(input.kind, "/kind", ["https_url", "sftp", "s3"] as const, true);
  if (existing && input.kind !== undefined && input.kind !== existing.kind) v.err("/kind", "The kind of a source cannot change. Create a new one.");
  const name = v.str(input.name, "/name", { required: true, min: 1, max: 200 });
  const sch = isPlainObject(input.schedule) ? input.schedule : { frequency: "manual" };
  const frequency = v.enumv(sch.frequency, "/schedule/frequency", ["manual", "hourly", "daily", "weekly"] as const, true);
  const time = v.str(sch.time, "/schedule/time", { pattern: /^([01][0-9]|2[0-3]):[0-5][0-9]$/, msg: "Use HH:MM." });
  const weekday = v.int(sch.weekday, "/schedule/weekday", 1, 7);
  const tz = typeof sch.timezone === "string" && sch.timezone ? sch.timezone : "Europe/Amsterdam";
  if (!validTimezone(tz)) v.err("/schedule/timezone", "Unknown time zone.");
  const mode = v.enumv(input.mode ?? "upsert", "/mode", ["upsert", "mirror"] as const) ?? "upsert";
  const cfg = isPlainObject(input.config) ? { ...input.config } : {};
  delete cfg.kind;
  const config: Record<string, unknown> = {};
  if (kind === "https_url") {
    config.url = v.url(cfg.url, "/config/url");
    if (!config.url) v.err("/config/url", "Enter the web address of the CSV or zip.");
    config.images_url = v.url(cfg.images_url, "/config/images_url");
  } else if (kind === "sftp") {
    config.host = v.str(cfg.host, "/config/host", { required: true, min: 1, max: 255 });
    config.port = v.int(cfg.port ?? 22, "/config/port", 1, 65535) ?? 22;
    config.username = v.str(cfg.username, "/config/username", { required: true, min: 1, max: 200 });
    config.path = v.str(cfg.path, "/config/path", { required: true, min: 1, max: 1024 });
    config.host_key_fingerprint = v.str(cfg.host_key_fingerprint, "/config/host_key_fingerprint", { max: 200 });
  } else if (kind === "s3") {
    config.endpoint = v.url(cfg.endpoint, "/config/endpoint");
    config.region = v.str(cfg.region, "/config/region", { required: true, min: 1, max: 64 });
    config.bucket = v.str(cfg.bucket, "/config/bucket", { required: true, min: 3, max: 63 });
    config.prefix = typeof cfg.prefix === "string" ? cfg.prefix.slice(0, 1024) : "";
    config.path_style = typeof cfg.path_style === "boolean" ? cfg.path_style : null;
  }
  if (!v.ok) throw new ObxError("validation_failed", "The scheduled import is invalid.", v.errors);
  // SSRF: the addresses must be public https (unless OBX_ALLOW_PRIVATE_URLS).
  if (kind === "https_url") {
    await assertSafeUrl(config.url as string, ctx.urlPolicy());
    if (config.images_url) await assertSafeUrl(config.images_url as string, ctx.urlPolicy());
  }
  if (kind === "s3" && config.endpoint) await assertSafeUrl(config.endpoint as string, ctx.urlPolicy());
  if (kind === "sftp") await assertSafeUrl(`https://${config.host}/`, ctx.urlPolicy());
  return { kind: kind!, name: name!, schedule: { frequency: frequency!, time, weekday, timezone: tz }, mode, config };
}

async function mergeCredentials(c: C, existing: SourceRow | null, input: unknown) {
  const ctx = ctxOf(c);
  let cur: Record<string, unknown> = {};
  if (existing?.credentials_enc) cur = JSON.parse(await ctx.keys.decrypt(existing.credentials_enc));
  if (input === undefined) return { enc: existing?.credentials_enc ?? null, set: existing ? safeJsonParse(existing.credentials_set, {}) : {} };
  if (input === null) return { enc: null, set: {} };
  if (!isPlainObject(input)) throw new ObxError("validation_failed", "credentials must be an object.");
  const next = mergePatch(cur, input) as Record<string, unknown>;
  for (const k of ["password", "private_key", "access_key_id", "secret_access_key"]) if (next[k] !== undefined && next[k] !== null && typeof next[k] !== "string") throw new ObxError("validation_failed", `credentials.${k} must be text.`);
  if (next.headers !== undefined && next.headers !== null) {
    if (!isPlainObject(next.headers) || Object.keys(next.headers).length > 10 || Object.values(next.headers).some((x) => typeof x !== "string")) throw new ObxError("validation_failed", "credentials.headers: up to 10 text headers.");
  }
  const set = {
    password: !!next.password,
    private_key: !!next.private_key,
    access_key_id: !!next.access_key_id,
    secret_access_key: !!next.secret_access_key,
    headers: next.headers ? Object.keys(next.headers as object) : [],
  };
  return { enc: await ctx.keys.encrypt(JSON.stringify(next)), set };
}

adminManage.get("/admin/api/import-sources", async (c) => {
  requireAdmin(c);
  const rows = await ctxOf(c).db.all<SourceRow>("SELECT * FROM import_sources ORDER BY created_at");
  const items = [];
  for (const r of rows) items.push(await sourceJson(c, r));
  return json(c, { items });
});

adminManage.post("/admin/api/import-sources", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const body = await readObject(c);
  const f = await validateSource(c, body, null);
  const cred = await mergeCredentials(c, null, body.credentials ?? null);
  const enabled = body.enabled !== false;
  const next = enabled ? nextRunAt(f.schedule, ctx.now()) : null;
  const id = newId("src");
  const now = ctx.iso();
  await ctx.db.run(
    "INSERT INTO import_sources (id, name, kind, enabled, schedule, mode, allow_mass_unpublish, config, credentials_enc, credentials_set, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, f.name, f.kind, enabled ? 1 : 0, JSON.stringify(f.schedule), f.mode, body.allow_mass_unpublish === true ? 1 : 0, JSON.stringify(f.config), cred.enc, JSON.stringify(cred.set), next ? new Date(next).toISOString() : null, now, now],
  );
  return json(c, await sourceJson(c, (await ctx.db.first<SourceRow>("SELECT * FROM import_sources WHERE id = ?", [id]))!), 201);
});

async function source(c: C): Promise<SourceRow> {
  const s = await ctxOf(c).db.first<SourceRow>("SELECT * FROM import_sources WHERE id = ?", [idParam(c)]);
  if (!s) throw new ObxError("not_found", "Unknown scheduled import.");
  return s;
}

adminManage.get("/admin/api/import-sources/:id", async (c) => {
  requireAdmin(c);
  return json(c, await sourceJson(c, await source(c)));
});

adminManage.patch("/admin/api/import-sources/:id", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const s = await source(c);
  const body = await readObject(c);
  const current = {
    name: s.name,
    kind: s.kind,
    schedule: safeJsonParse(s.schedule, {}),
    mode: s.mode,
    config: safeJsonParse(s.config, {}),
  };
  const patch: Record<string, unknown> = {};
  for (const k of ["name", "schedule", "mode", "config", "kind"]) if (body[k] !== undefined) patch[k] = body[k];
  const merged = mergePatch(current, patch) as Record<string, unknown>;
  const f = await validateSource(c, merged, s);
  const cred = await mergeCredentials(c, s, body.credentials);
  const enabled = body.enabled === undefined ? !!s.enabled : body.enabled === true;
  const next = enabled ? nextRunAt(f.schedule, ctx.now()) : null;
  const amu = body.allow_mass_unpublish === undefined ? s.allow_mass_unpublish : body.allow_mass_unpublish === true ? 1 : 0;
  await ctx.db.run(
    "UPDATE import_sources SET name = ?, enabled = ?, schedule = ?, mode = ?, allow_mass_unpublish = ?, config = ?, credentials_enc = ?, credentials_set = ?, next_run_at = ?, updated_at = ?, fingerprint = CASE WHEN config = ? THEN fingerprint ELSE NULL END WHERE id = ?",
    [f.name, enabled ? 1 : 0, JSON.stringify(f.schedule), f.mode, amu, JSON.stringify(f.config), cred.enc, JSON.stringify(cred.set), next ? new Date(next).toISOString() : null, ctx.iso(), JSON.stringify(f.config), s.id],
  );
  return json(c, await sourceJson(c, (await ctx.db.first<SourceRow>("SELECT * FROM import_sources WHERE id = ?", [s.id]))!));
});

adminManage.delete("/admin/api/import-sources/:id", async (c) => {
  requireAdmin(c);
  const s = await source(c);
  await ctxOf(c).db.batch([
    { sql: "DELETE FROM import_sources WHERE id = ?", params: [s.id] },
    { sql: "DELETE FROM source_files WHERE source_id = ?", params: [s.id] },
  ]);
  return noContent(c);
});

adminManage.post("/admin/api/import-sources/:id/run", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const s = await source(c);
  const body = await readOptionalObject(c);
  const running = await ctx.db.first("SELECT 1 AS x FROM jobs WHERE source_id = ? AND status IN ('queued', 'running')", [s.id]);
  if (running) throw new ObxError("conflict", "This import is already running.");
  const job = await startImport(
    ctx,
    { trigger: "manual_run", mode: s.mode, dry_run: body.dry_run === true, allow_mass_unpublish: !!s.allow_mass_unpublish, default_language: null, allowed_brands: null, source_id: s.id, force: body.force === true, started_by: "admin" },
    { owner: "admin" },
  );
  return json(c, importRunOf(job), 202);
});

adminManage.post("/admin/api/import-sources/:id/test", async (c) => {
  requireAdmin(c);
  return json(c, await testSource(ctxOf(c), await source(c)));
});

// ------------------------------------------------------------------ retailers

function retailerInput(v: V, body: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || "name" in body) out.name = v.str(body.name, "/name", { required: true, min: 1, max: 200 });
  if ("reference" in body) out.reference = v.str(body.reference, "/reference", { max: 100 });
  if ("website" in body) out.website = v.url(body.website, "/website");
  if ("vat_number" in body) out.vat_number = v.str(body.vat_number, "/vat_number", { max: 32 });
  if ("country" in body) out.country = v.country(body.country, "/country");
  if ("notes" in body) out.notes = v.str(body.notes, "/notes", { max: 5000 });
  if ("status" in body) out.status = v.enumv(body.status, "/status", ["active", "blocked"] as const, true);
  if ("brand_ids" in body) {
    if (body.brand_ids === null) out.brand_ids = null;
    else if (!Array.isArray(body.brand_ids) || body.brand_ids.some((x) => typeof x !== "string")) v.err("/brand_ids", "A list of brand ids, or null for all brands.");
    else out.brand_ids = [...new Set(body.brand_ids as string[])];
  }
  if ("allow_original" in body) {
    if (body.allow_original !== null && typeof body.allow_original !== "boolean") v.err("/allow_original", "true, false or null.");
    else out.allow_original = body.allow_original;
  }
  return out;
}

adminManage.get("/admin/api/retailers", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const limit = intQuery(c, "limit", 50, 1, 200);
  const where: string[] = ["1 = 1"];
  const params: string[] = [];
  const q = c.req.query("q");
  if (q?.trim()) {
    where.push("(lower(name) LIKE ? OR lower(IFNULL(reference, '')) LIKE ?)");
    params.push(`%${q.trim().toLowerCase()}%`, `%${q.trim().toLowerCase()}%`);
  }
  const st = c.req.query("status");
  if (st === "active" || st === "blocked") {
    where.push("status = ?");
    params.push(st);
  }
  const cur = await decodeListCursor<{ n: string; id: string }>(ctx, "retailers", c.req.query("cursor") || undefined);
  if (cur) {
    where.push("(lower(name) > ? OR (lower(name) = ? AND id > ?))");
    params.push(cur.n, cur.n, cur.id);
  }
  const rows = await ctx.db.all<RetailerRow>(`SELECT * FROM retailers WHERE ${where.join(" AND ")} ORDER BY lower(name), id LIMIT ?`, [...params, limit + 1] as never);
  const page = rows.slice(0, limit);
  const items = [];
  const counts = await retailerCounts(ctx, page.map((r) => r.id));
  for (const r of page) items.push(await retailerJson(ctx, r, counts.get(r.id)));
  const last = page[page.length - 1];
  return json(c, { items, next_cursor: rows.length > limit ? await encodeListCursor(ctx, "retailers", { n: last.name.toLowerCase(), id: last.id }) : null });
});

adminManage.post("/admin/api/retailers", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const v = new V();
  const f = retailerInput(v, await readObject(c), false);
  if (!v.ok) throw new ObxError("validation_failed", "Some fields are invalid.", v.errors);
  const r = await createRetailer(ctx, f as never);
  if (f.status === "blocked") await patchRetailer(ctx, r, { status: "blocked" });
  return json(c, await retailerJson(ctx, await getRetailer(ctx, r.id)), 201);
});

adminManage.get("/admin/api/retailers/:id", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  return json(c, await retailerJson(ctx, await getRetailer(ctx, idParam(c))));
});

adminManage.patch("/admin/api/retailers/:id", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const r = await getRetailer(ctx, idParam(c));
  const v = new V();
  const f = retailerInput(v, await readObject(c), true);
  if (!v.ok) throw new ObxError("validation_failed", "Some fields are invalid.", v.errors);
  return json(c, await retailerJson(ctx, await patchRetailer(ctx, r, f)));
});

adminManage.delete("/admin/api/retailers/:id", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  await deleteRetailer(ctx, await getRetailer(ctx, idParam(c)));
  return noContent(c);
});

// ------------------------------------------------------------------ access requests

adminManage.get("/admin/api/access-requests", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const limit = intQuery(c, "limit", 50, 1, 200);
  const params: string[] = [];
  let where = "1 = 1";
  const st = c.req.query("status");
  if (st && ["pending", "approved", "rejected"].includes(st)) {
    where += " AND status = ?";
    params.push(st);
  }
  const cur = await decodeListCursor<{ t: string; id: string }>(ctx, "access-requests", c.req.query("cursor") || undefined);
  if (cur) {
    where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
    params.push(cur.t, cur.t, cur.id);
  }
  const rows = await ctx.db.all<AccessRequestRow>(`SELECT * FROM access_requests WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, [...params, limit + 1] as never);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return json(c, { items: page.map(adminAccessRequestJson), next_cursor: rows.length > limit ? await encodeListCursor(ctx, "access-requests", { t: last.created_at, id: last.id }) : null });
});

async function accessRequest(c: C) {
  const r = await ctxOf(c).db.first<AccessRequestRow>("SELECT * FROM access_requests WHERE id = ?", [idParam(c)]);
  if (!r) throw new ObxError("not_found", "Unknown access request.");
  return r;
}

adminManage.get("/admin/api/access-requests/:id", async (c) => {
  requireAdmin(c);
  return json(c, adminAccessRequestJson(await accessRequest(c)));
});

adminManage.post("/admin/api/access-requests/:id/approve", async (c) => {
  requireAdmin(c);
  const body = await readOptionalObject(c);
  const v = new V();
  if (body.brand_ids !== undefined && body.brand_ids !== null && (!Array.isArray(body.brand_ids) || body.brand_ids.some((x) => typeof x !== "string"))) v.err("/brand_ids", "A list of brand ids or null.");
  if (!v.ok) throw new ObxError("validation_failed", "Invalid approval.", v.errors);
  return json(
    c,
    await approveAccessRequest(ctxOf(c), await accessRequest(c), {
      retailer_id: typeof body.retailer_id === "string" ? body.retailer_id : null,
      brand_ids: body.brand_ids === undefined ? undefined : (body.brand_ids as string[] | null),
      invite_portal_user: typeof body.invite_portal_user === "boolean" ? body.invite_portal_user : undefined,
      create_api_client: typeof body.create_api_client === "boolean" ? body.create_api_client : undefined,
    }),
  );
});

adminManage.post("/admin/api/access-requests/:id/reject", async (c) => {
  requireAdmin(c);
  const body = await readOptionalObject(c);
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 2000) : null;
  return json(c, await rejectAccessRequest(ctxOf(c), await accessRequest(c), reason));
});

// ------------------------------------------------------------------ accounts

adminManage.get("/admin/api/users", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const limit = intQuery(c, "limit", 50, 1, 200);
  const where: string[] = ["1 = 1"];
  const params: string[] = [];
  const role = c.req.query("role");
  if (role === "admin" || role === "retailer") {
    where.push("role = ?");
    params.push(role);
  }
  const rid = c.req.query("retailer_id");
  if (rid) {
    where.push("retailer_id = ?");
    params.push(rid);
  }
  const cur = await decodeListCursor<{ e: string }>(ctx, "users", c.req.query("cursor") || undefined);
  if (cur) {
    where.push("email > ?");
    params.push(cur.e);
  }
  const rows = await ctx.db.all<UserRow>(`SELECT * FROM users WHERE ${where.join(" AND ")} ORDER BY email LIMIT ?`, [...params, limit + 1] as never);
  const page = rows.slice(0, limit);
  return json(c, { items: page.map(userJson), next_cursor: rows.length > limit ? await encodeListCursor(ctx, "users", { e: page[page.length - 1].email }) : null });
});

adminManage.post("/admin/api/users/invites", async (c) => {
  const sess = requireAdmin(c);
  const ctx = ctxOf(c);
  const body = await readObject(c);
  const v = new V();
  const email = v.email(body.email, "/email", true);
  const name = v.str(body.name, "/name", { max: 200 });
  const role = v.enumv(body.role, "/role", ["admin", "retailer"] as const, true);
  const lang = v.str(body.language, "/language", { pattern: LANG_RE, msg: "Use a language tag." });
  let retailerId: string | null = null;
  if (role === "retailer") {
    if (typeof body.retailer_id !== "string") v.err("/retailer_id", "Choose the retailer this person works for.");
    else retailerId = body.retailer_id;
  }
  if (!v.ok) throw new ObxError("validation_failed", "Some fields are invalid.", v.errors);
  if (retailerId) await getRetailer(ctx, retailerId);
  return json(c, await inviteUser(ctx, { email: email!, name, role: role!, retailerId, language: lang, inviterName: sess.user.name }), 201);
});

async function userRow(c: C): Promise<UserRow> {
  const u = await ctxOf(c).db.first<UserRow>("SELECT * FROM users WHERE id = ?", [idParam(c)]);
  if (!u) throw new ObxError("not_found", "Unknown account.");
  return u;
}

async function assertNotLastAdmin(c: C, u: UserRow) {
  const sess = requireAdmin(c);
  if (u.id === sess.user.id) throw new ObxError("conflict", "You cannot block or delete your own account.");
  if (u.role === "admin" && u.status === "active") {
    const n = await ctxOf(c).db.first<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'");
    if ((n?.n ?? 0) <= 1) throw new ObxError("conflict", "This is the last active administrator.");
  }
}

adminManage.patch("/admin/api/users/:id", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const u = await userRow(c);
  const body = await readObject(c);
  const v = new V();
  const name = v.str(body.name, "/name", { max: 200 });
  const status = v.enumv(body.status, "/status", ["active", "blocked"] as const);
  if (!v.ok) throw new ObxError("validation_failed", "Some fields are invalid.", v.errors);
  if (status === "blocked" && u.status !== "blocked") await assertNotLastAdmin(c, u);
  let nextStatus = u.status;
  if (status === "blocked") nextStatus = "blocked";
  if (status === "active" && u.status === "blocked") nextStatus = u.password_hash ? "active" : "invited";
  const stmts = [{ sql: "UPDATE users SET name = COALESCE(?, name), status = ? WHERE id = ?", params: [name, nextStatus, u.id] as (string | null)[] }];
  if (nextStatus === "blocked") stmts.push({ sql: "DELETE FROM sessions WHERE user_id = ?", params: [u.id] });
  await ctx.db.batch(stmts);
  return json(c, userJson((await ctx.db.first<UserRow>("SELECT * FROM users WHERE id = ?", [u.id]))!));
});

adminManage.delete("/admin/api/users/:id", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const u = await userRow(c);
  await assertNotLastAdmin(c, u);
  await ctx.db.batch(eraseUserStmts(u));
  return noContent(c);
});

adminManage.post("/admin/api/users/:id/resend-invite", async (c) => {
  requireAdmin(c);
  return json(c, await resendInvite(ctxOf(c), await userRow(c)));
});

// ------------------------------------------------------------------ API keys for retailers' software

function scopesInput(v: V, raw: unknown, allowed: string[]): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || !raw.length || raw.some((s) => !allowed.includes(s as string))) {
    v.err("/scopes", `Scopes: ${allowed.join(", ")}.`);
    return null;
  }
  return [...new Set(raw as string[])];
}

adminManage.get("/admin/api/api-clients", async (c) => {
  requireAdmin(c);
  const rid = c.req.query("retailer_id");
  const rows = rid
    ? await ctxOf(c).db.all<ClientRow>("SELECT * FROM api_clients WHERE retailer_id = ? ORDER BY created_at", [rid])
    : await ctxOf(c).db.all<ClientRow>("SELECT * FROM api_clients ORDER BY created_at");
  return json(c, { items: rows.map(clientJson) });
});

adminManage.post("/admin/api/api-clients", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const body = await readObject(c);
  const v = new V();
  const name = v.str(body.name, "/name", { required: true, min: 1, max: 200 });
  const scopes = scopesInput(v, body.scopes, PROTOCOL_SCOPES);
  if (typeof body.retailer_id !== "string") v.err("/retailer_id", "Choose the retailer.");
  if (!v.ok) throw new ObxError("validation_failed", "Some fields are invalid.", v.errors);
  const r = await getRetailer(ctx, body.retailer_id as string).catch(() => {
    throw new ObxError("validation_failed", "Unknown retailer.", [fieldError("/retailer_id", "Unknown retailer.")]);
  });
  const { row, secret } = await createClient(ctx, r, name!, scopes, "admin");
  return json(c, await clientWithSecret(ctx, row, secret), 201);
});

async function apiClient(c: C, retailerId?: string): Promise<ClientRow> {
  const cl = await ctxOf(c).db.first<ClientRow>("SELECT * FROM api_clients WHERE id = ?", [idParam(c)]);
  if (!cl || (retailerId && cl.retailer_id !== retailerId)) throw new ObxError("not_found", "Unknown API key.");
  return cl;
}

adminManage.post("/admin/api/api-clients/:id/rotate", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const cl = await apiClient(c);
  if (cl.status !== "active") throw new ObxError("conflict", "This API key was revoked.");
  const { row, secret } = await rotateClient(ctx, cl);
  return json(c, await clientWithSecret(ctx, row, secret));
});

adminManage.delete("/admin/api/api-clients/:id", async (c) => {
  requireAdmin(c);
  const cl = await apiClient(c);
  await ctxOf(c).db.batch([
    { sql: "UPDATE api_clients SET status = 'revoked' WHERE id = ?", params: [cl.id] },
    { sql: "UPDATE webhooks SET status = 'disabled' WHERE api_client_id = ?", params: [cl.id] },
  ]);
  return noContent(c);
});

// ------------------------------------------------------------------ automatic upload (ingest) tokens

function ingestTokenJson(t: IngestTokenRow, now: number) {
  const expired = t.status === "active" && t.expires_at && Date.parse(t.expires_at) <= now;
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scopes: safeJsonParse<string[]>(t.scopes, []),
    brand_external_ids: safeJsonParse<string[] | null>(t.brand_external_ids, null),
    status: expired ? "expired" : t.status,
    expires_at: t.expires_at,
    created_at: t.created_at,
    last_used_at: t.last_used_at,
  };
}

adminManage.get("/admin/api/ingest-tokens", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const rows = await ctx.db.all<IngestTokenRow>("SELECT * FROM ingest_tokens ORDER BY created_at");
  return json(c, { items: rows.map((t) => ingestTokenJson(t, ctx.now())) });
});

adminManage.post("/admin/api/ingest-tokens", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const body = await readObject(c);
  const v = new V();
  const name = v.str(body.name, "/name", { required: true, min: 1, max: 200 });
  const scopes = scopesInput(v, body.scopes, INGEST_SCOPES);
  if (!scopes) v.err("/scopes", "Choose at least one scope.");
  let brands: string[] | null = null;
  if (body.brand_external_ids !== undefined && body.brand_external_ids !== null) {
    if (!Array.isArray(body.brand_external_ids) || body.brand_external_ids.some((x) => typeof x !== "string" || !validExternalId(x))) v.err("/brand_external_ids", "A list of brand ids, or null for all.");
    else brands = body.brand_external_ids as string[];
  }
  const expires = v.dateTime(body.expires_at, "/expires_at");
  if (!v.ok) throw new ObxError("validation_failed", "Some fields are invalid.", v.errors);
  const t = await newIngestToken();
  const id = newId("itk");
  await ctx.db.run(
    "INSERT INTO ingest_tokens (id, name, prefix, token_hash, scopes, brand_external_ids, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)",
    [id, name, t.prefix, t.hash, JSON.stringify(scopes), brands ? JSON.stringify(brands) : null, expires, ctx.iso()],
  );
  const row = (await ctx.db.first<IngestTokenRow>("SELECT * FROM ingest_tokens WHERE id = ?", [id]))!;
  return json(c, { token: ingestTokenJson(row, ctx.now()), secret: t.secret, ingest_url: `${await ctx.baseUrl()}/obx/v1/ingest` }, 201);
});

async function ingestToken(c: C) {
  const t = await ctxOf(c).db.first<IngestTokenRow>("SELECT * FROM ingest_tokens WHERE id = ?", [idParam(c)]);
  if (!t) throw new ObxError("not_found", "Unknown token.");
  return t;
}

adminManage.post("/admin/api/ingest-tokens/:id/rotate", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const t0 = await ingestToken(c);
  if (t0.status !== "active") throw new ObxError("conflict", "This token was revoked.");
  const t = await newIngestToken();
  await ctx.db.run("UPDATE ingest_tokens SET token_hash = ?, prefix = ? WHERE id = ?", [t.hash, t.prefix, t0.id]);
  const row = (await ctx.db.first<IngestTokenRow>("SELECT * FROM ingest_tokens WHERE id = ?", [t0.id]))!;
  return json(c, { token: ingestTokenJson(row, ctx.now()), secret: t.secret, ingest_url: `${await ctx.baseUrl()}/obx/v1/ingest` });
});

adminManage.delete("/admin/api/ingest-tokens/:id", async (c) => {
  requireAdmin(c);
  const t = await ingestToken(c);
  await ctxOf(c).db.run("UPDATE ingest_tokens SET status = 'revoked' WHERE id = ?", [t.id]);
  return noContent(c);
});

// ------------------------------------------------------------------ brand webhooks

adminManage.get("/admin/api/webhooks", async (c) => {
  requireAdmin(c);
  const rows = await ctxOf(c).db.all<WebhookRow>("SELECT * FROM webhooks WHERE owner = 'brand' ORDER BY created_at");
  return json(c, { items: rows.map((w) => webhookJson(w)) });
});

adminManage.post("/admin/api/webhooks", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const body = await readObject(c);
  const v = new V();
  const url = v.url(body.url, "/url");
  if (!url) v.err("/url", "Enter the address that should receive the events.");
  if (!Array.isArray(body.events) || !body.events.length || body.events.some((e) => !BRAND_EVENTS.includes(e as string))) v.err("/events", `Events: ${BRAND_EVENTS.join(", ")}.`);
  if (!v.ok) throw new ObxError("validation_failed", "The webhook is invalid.", v.errors);
  await assertSafeUrl(url!, ctx.urlPolicy());
  const { row, secret } = await createWebhook(ctx, "brand", null, url!, body.events as string[]);
  return json(c, webhookJson(row, secret), 201);
});

async function brandHook(c: C) {
  const w = await ctxOf(c).db.first<WebhookRow>("SELECT * FROM webhooks WHERE id = ? AND owner = 'brand'", [idParam(c)]);
  if (!w) throw new ObxError("not_found", "Unknown webhook.");
  return w;
}

adminManage.patch("/admin/api/webhooks/:id", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const w = await brandHook(c);
  const body = await readObject(c);
  let events = safeJsonParse<string[]>(w.events, []);
  if (body.events !== undefined) {
    if (!Array.isArray(body.events) || !body.events.length || body.events.some((e) => !BRAND_EVENTS.includes(e as string))) throw new ObxError("validation_failed", `Events: ${BRAND_EVENTS.join(", ")}.`);
    events = [...new Set(body.events as string[])];
  }
  let status = w.status;
  if (body.status === "active" || body.status === "disabled") status = body.status;
  await ctx.db.run("UPDATE webhooks SET events = ?, status = ?, failing_since = CASE WHEN ? = 'active' THEN NULL ELSE failing_since END WHERE id = ?", [JSON.stringify(events), status, status, w.id]);
  return json(c, webhookJson((await ctx.db.first<WebhookRow>("SELECT * FROM webhooks WHERE id = ?", [w.id]))!));
});

adminManage.delete("/admin/api/webhooks/:id", async (c) => {
  requireAdmin(c);
  const w = await brandHook(c);
  await ctxOf(c).db.batch([
    { sql: "DELETE FROM webhook_deliveries WHERE webhook_id = ?", params: [w.id] },
    { sql: "DELETE FROM webhooks WHERE id = ?", params: [w.id] },
  ]);
  return noContent(c);
});

adminManage.post("/admin/api/webhooks/:id/test", async (c) => {
  requireAdmin(c);
  return json(c, deliveryJson(await testWebhook(ctxOf(c), await brandHook(c))));
});

adminManage.get("/admin/api/webhooks/:id/deliveries", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const w = await brandHook(c);
  const limit = intQuery(c, "limit", 50, 1, 200);
  const cur = await decodeListCursor<{ t: string; id: string }>(ctx, "deliveries", c.req.query("cursor") || undefined);
  const rows = await ctx.db.all<DeliveryRow>(
    `SELECT * FROM webhook_deliveries WHERE webhook_id = ? AND created_at > ?${cur ? " AND (created_at < ? OR (created_at = ? AND id < ?))" : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [w.id, ctx.iso(-7 * 24 * 3600 * 1000), ...(cur ? [cur.t, cur.t, cur.id] : []), limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return json(c, { items: page.map(deliveryJson), next_cursor: rows.length > limit ? await encodeListCursor(ctx, "deliveries", { t: last.created_at, id: last.id }) : null });
});

// ------------------------------------------------------------------ statistics

adminManage.get("/admin/api/stats", async (c) => {
  requireAdmin(c);
  const d = Number(c.req.query("days") ?? 30);
  if (![7, 30, 90, 365].includes(d)) throw new ObxError("invalid_request", "days must be 7, 30, 90 or 365.");
  return json(c, await stats(ctxOf(c), d));
});

adminManage.get("/admin/api/stats/events", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const limit = intQuery(c, "limit", 50, 1, 200);
  const where: string[] = ["1 = 1"];
  const params: string[] = [];
  const rid = c.req.query("retailer_id");
  if (rid) {
    where.push("retailer_id = ?");
    params.push(rid);
  }
  const kind = c.req.query("kind");
  if (kind) {
    where.push("kind = ?");
    params.push(kind);
  }
  const cur = await decodeListCursor<{ t: string; id: string }>(ctx, "events", c.req.query("cursor") || undefined);
  if (cur) {
    where.push("(at < ? OR (at = ? AND id < ?))");
    params.push(cur.t, cur.t, cur.id);
  }
  const rows = await ctx.db.all<Record<string, unknown>>(`SELECT * FROM download_events WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`, [...params, limit + 1] as never);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return json(c, {
    items: page.map((e) => ({
      id: e.id,
      at: e.at,
      kind: e.kind,
      retailer_id: e.retailer_id,
      retailer_name: e.retailer_name,
      actor_type: e.actor_type,
      actor_name: e.actor_name,
      variant: e.variant,
      product_id: e.product_id,
      asset_id: e.asset_id,
      usage_event: e.usage_event,
      files: e.files,
      bytes: e.bytes,
    })),
    next_cursor: rows.length > limit ? await encodeListCursor(ctx, "events", { t: last.at as string, id: last.id as string }) : null,
  });
});

export { placeholders, type Kind };
