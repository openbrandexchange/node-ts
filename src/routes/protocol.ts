// OBX Protocol (read side) for retailers' software: discovery, access, feed, catalog, media, exports,
// usage, webhooks.
import { Hono } from "hono";
import type { AppEnv, C } from "./common";
import { ctxOf, json, noContent, readObject, intQuery, clientIp, idParam, encodeListCursor, decodeListCursor } from "./common";
import { ObxError, fieldError } from "../lib/problem";
import {
  authenticateClient,
  requireScope,
  verifyClientSecret,
  issueAccessToken,
  grantOf,
  ACCESS_TOKEN_TTL,
  type ClientAuth,
  type ClientRow,
  type RetailerRow,
  type Viewer,
  type UserRow,
} from "../core/auth";
import { memLimit, dbLimit, limitHeaders, enforce } from "../core/ratelimit";
import { readChanges } from "../core/changes";
import { assetForViewer, assetVariantIds, loadAssetForViewer, productDetails, visibleBrands, verifySignedPath, placeholders, productVisibleSql } from "../core/read";
import { brandRep } from "../core/reps";
import { gtinLookup } from "../core/gtinlookup";
import { canonicalJson, newId, newSecret, safeJsonParse, isPlainObject } from "../lib/util";
import { sha256Hex, timingSafeEqualStr, tokenHash } from "../lib/crypto";
import { V, PROTOCOL_SCOPES, RENDITIONS, type RenditionName, CHANNELS } from "../core/validate";
import { serveStored } from "./files";
import { blobKey } from "../core/blobs";
import { pickFile } from "../core/bulk";
import { assetFilename, renditionFilename, type Files } from "../core/reps";
import { logDownload, downloadStmt } from "../core/stats";
import { enqueueJob, getJob } from "../core/jobs";
import { exportJson, manifestStream, type ExportInput } from "../core/bulk";
import { createWebhook, emitBrandEvent, testWebhook, webhookJson, CLIENT_EVENTS, type WebhookRow } from "../core/notify";
import { assertSafeUrl } from "../lib/ssrf";
import { pickLanguage, sendEmail } from "../core/mail";
import { adminAccessRequestJson, type AccessRequestRow } from "../core/accounts";
import { normDateTime } from "../lib/util";

export const protocol = new Hono<AppEnv>();

const CAPABILITIES = ["changes", "products", "by_gtin", "renditions", "exports", "webhooks", "usage", "access_requests", "ingest", "portal"];

async function requireSetup(c: C) {
  if (!(await ctxOf(c).isSetUp())) throw new ObxError("setup_required", "This node has not been set up yet.", [], { status: 503 });
}

export async function logoUrl(c: C): Promise<string | null> {
  const ctx = ctxOf(c);
  const s = await ctx.settings();
  if (!s.branding.logo_sha) return null;
  return `${await ctx.baseUrl()}/admin/api/public/logo?v=${s.branding.logo_sha.slice(0, 12)}`;
}

protocol.get("/.well-known/obx", async (c) => {
  const ctx = ctxOf(c);
  await requireSetup(c);
  const s = await ctx.settings();
  const base = await ctx.baseUrl();
  const brands = (await visibleBrands(ctx, null)).map((b) => ({ id: b.id as string, name: b.name as string, logo_url: (b.logo_url as string | null) ?? null }));
  const langs = [s.portal.default_language, ...s.portal.languages.filter((l) => l !== s.portal.default_language)];
  const doc = {
    obx_version: "0.1",
    spec_version: "0.1.0",
    node: { software: ctx.config.software, version: ctx.config.version },
    publisher: {
      id: "pub_" + (await ctx.nodeId()).replace(/^node_/, ""),
      name: s.company.name || s.branding.display_name,
      logo_url: await logoUrl(c),
      accent_color: s.branding.accent_color,
      website: s.company.website,
      contact_email: s.company.contact_email,
      welcome_text: s.branding.welcome_text,
    },
    api_base: `${base}/obx/v1`,
    portal_url: `${base}/`,
    auth: {
      token_endpoint: `${base}/obx/v1/oauth/token`,
      scopes_supported: PROTOCOL_SCOPES,
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    },
    access_requests_url: s.portal.access_requests_enabled ? `${base}/obx/v1/access-requests` : null,
    ingest_url: `${base}/obx/v1/ingest`,
    capabilities: CAPABILITIES.filter((x) => x !== "access_requests" || s.portal.access_requests_enabled),
    brands,
    languages: langs,
    limits: { changes_page_max: 500, products_page_max: 100, gtin_lookup_max: 2000, tombstone_retention_days: 90 },
  };
  return json(c, doc, 200, { "access-control-allow-origin": "*", "cache-control": "public, max-age=300" });
});

protocol.options("/.well-known/obx", () => new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-max-age": "86400" } }));

// ------------------------------------------------------------------ access requests

protocol.post("/obx/v1/access-requests", async (c) => {
  const ctx = ctxOf(c);
  await requireSetup(c);
  const s = await ctx.settings();
  if (!s.portal.access_requests_enabled) throw new ObxError("forbidden", "This brand does not accept access requests.");
  const rl = await dbLimit(ctx, `ar:${clientIp(c)}`, 5, 3600);
  c.set("rl", limitHeaders(rl));
  enforce(rl, "access requests");
  const body = await readObject(c, 64 * 1024);
  const v = new V();
  const r = isPlainObject(body.retailer) ? body.retailer : {};
  const k = isPlainObject(body.contact) ? body.contact : {};
  if (!isPlainObject(body.retailer)) v.err("/retailer", "This field is required.");
  if (!isPlainObject(body.contact)) v.err("/contact", "This field is required.");
  const retailer = {
    name: v.str(r.name, "/retailer/name", { required: true, min: 1, max: 200 }),
    reference: v.str(r.reference, "/retailer/reference", { max: 100 }),
    website: v.url(r.website, "/retailer/website"),
    vat_number: v.str(r.vat_number, "/retailer/vat_number", { max: 32 }),
    country: v.country(r.country, "/retailer/country"),
  };
  const contact = {
    name: v.str(k.name, "/contact/name", { required: true, min: 1, max: 200 }),
    email: v.email(k.email, "/contact/email", true),
    phone: v.str(k.phone, "/contact/phone", { max: 40 }),
    language: v.str(k.language, "/contact/language", { pattern: /^[a-z]{2,3}(-[A-Z]{2})?$/, msg: "Use a language tag such as nl or en." }),
  };
  // No language given: remember the browser's language at request time, so later e-mails use it.
  if (!contact.language) contact.language = pickLanguage(c.req.header("accept-language"), s.portal.default_language);
  let access: string[] = ["portal"];
  if (body.access !== undefined) {
    if (!Array.isArray(body.access) || !body.access.length || body.access.some((a) => a !== "portal" && a !== "api")) v.err("/access", 'Choose "portal", "api" or both.');
    else access = [...new Set(body.access as string[])];
  }
  let brandIds: string[] | null = null;
  if (Array.isArray(body.requested_brand_ids)) brandIds = (body.requested_brand_ids as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 100);
  const message = v.str(body.message, "/message", { max: 2000 });
  if (!v.ok) throw new ObxError("validation_failed", "Some fields are invalid.", v.errors);
  const id = newId("acr");
  const token = newSecret("obxr_", 24);
  const now = ctx.iso();
  await ctx.db.run(
    "INSERT INTO access_requests (id, status, retailer, contact, access, requested_brand_ids, message, request_token_hash, created_at) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)",
    [id, JSON.stringify(retailer), JSON.stringify(contact), JSON.stringify(access), brandIds ? JSON.stringify(brandIds) : null, message, await tokenHash(token), now],
  );
  const base = await ctx.baseUrl();
  const row = (await ctx.db.first<AccessRequestRow>("SELECT * FROM access_requests WHERE id = ?", [id]))!;
  // Tell the brand (e-mail to admins + brand webhook). Never blocks the answer.
  ctx.p.defer(
    (async () => {
      const admins = await ctx.db.all<UserRow>("SELECT * FROM users WHERE role = 'admin' AND status = 'active'");
      if (contact.email) await sendEmail(ctx, { to: contact.email, lang: contact.language!, template: "accessRequestReceived", name: contact.name, vars: {} });
      for (const a of admins)
        await sendEmail(ctx, { to: a.email, lang: a.language, template: "accessRequestNew", name: a.name, vars: { retailer: retailer.name!, contact: contact.name! }, link: `${await ctx.mailBaseUrl()}/admin/requests` });
      await emitBrandEvent(ctx, "access_request.created", { access_request: adminAccessRequestJson(row) });
    })().catch((e) => ctx.log("error", "access request notification failed", { error: String(e) })),
  );
  return json(c, { id, status: "pending", created_at: now, decided_at: null, reason: null, request_token: token, status_url: `${base}/obx/v1/access-requests/${id}`, portal: null, credentials: null }, 202);
});

protocol.get("/obx/v1/access-requests/:id", async (c) => {
  const ctx = ctxOf(c);
  await requireSetup(c);
  const id = idParam(c);
  const tok = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!tok) throw new ObxError("unauthorized", "Send the request_token as Bearer token.");
  const rl = await dbLimit(ctx, `arp:${id}`, 10, 60);
  c.set("rl", limitHeaders(rl));
  enforce(rl, "status checks");
  const row = await ctx.db.first<AccessRequestRow>("SELECT * FROM access_requests WHERE id = ?", [id]);
  if (!row || !timingSafeEqualStr(row.request_token_hash, await tokenHash(tok))) throw new ObxError("not_found", "Unknown access request.");
  const base = await ctx.baseUrl();
  const access = safeJsonParse<string[]>(row.access, []);
  let credentials: Record<string, unknown> | null = null;
  if (row.status === "approved" && row.api_client_id) {
    const client = await ctx.db.first<ClientRow>("SELECT * FROM api_clients WHERE id = ?", [row.api_client_id]);
    let secret: string | null = null;
    if (row.pending_secret) {
      const claimed = await ctx.db.run("UPDATE access_requests SET pending_secret = NULL, claimed = 1 WHERE id = ? AND pending_secret IS NOT NULL", [id]);
      if (claimed.changes) secret = await ctx.keys.decrypt(row.pending_secret);
    }
    if (client)
      credentials = {
        client_id: client.client_id,
        client_secret: secret,
        token_endpoint: `${base}/obx/v1/oauth/token`,
        scopes: safeJsonParse<string[]>(client.scopes, []),
        claimed: secret === null,
      };
  }
  return json(c, {
    id: row.id,
    status: row.status,
    created_at: row.created_at,
    decided_at: row.decided_at,
    reason: row.status === "rejected" ? row.reason : null,
    status_url: `${base}/obx/v1/access-requests/${row.id}`,
    portal: row.status === "approved" && access.includes("portal") ? { invited: !!row.portal_invited, login_url: `${base}/login` } : null,
    credentials,
  });
});

// ------------------------------------------------------------------ OAuth2 token endpoint

function oauthError(status: number, error: string, description: string, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", "obx-version": "0.1", ...extra },
  });
}

protocol.post("/obx/v1/oauth/token", async (c) => {
  const ctx = ctxOf(c);
  await requireSetup(c);
  const rl = await dbLimit(ctx, `tok:${clientIp(c)}`, 30, 60);
  if (!rl.ok)
    return new Response(JSON.stringify({ type: "https://openbrandexchange.com/errors/rate_limited", title: "Too many requests", status: 429, detail: "Too many token requests.", obx_error: "rate_limited", retry_after: rl.reset }), {
      status: 429,
      headers: { "content-type": "application/problem+json", "retry-after": String(rl.reset), ...limitHeaders(rl) },
    });
  const ct = c.req.header("content-type") ?? "";
  if (!ct.includes("application/x-www-form-urlencoded")) return oauthError(400, "invalid_request", "Send the request as application/x-www-form-urlencoded.");
  const form = new URLSearchParams(await c.req.text());
  const grant = form.get("grant_type");
  let id = form.get("client_id");
  let secret = form.get("client_secret");
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("basic ")) {
    try {
      const dec = atob(auth.slice(6).trim());
      const i = dec.indexOf(":");
      if (i < 0) throw new Error();
      id = decodeURIComponent(dec.slice(0, i).replace(/\+/g, "%20"));
      secret = decodeURIComponent(dec.slice(i + 1).replace(/\+/g, "%20"));
    } catch {
      return oauthError(401, "invalid_client", "Malformed Basic authorization.", { "www-authenticate": 'Basic realm="obx"' });
    }
  }
  if (!grant) return oauthError(400, "invalid_request", "grant_type is required.");
  if (grant !== "client_credentials") return oauthError(400, "unsupported_grant_type", "Only client_credentials is supported.");
  if (!id || !secret) return oauthError(401, "invalid_client", "Client authentication failed.", { "www-authenticate": 'Basic realm="obx"' });
  const client = await verifyClientSecret(ctx, id, secret);
  if (!client || client.status !== "active") return oauthError(401, "invalid_client", "Client authentication failed.", { "www-authenticate": 'Basic realm="obx"' });
  const retailer = await ctx.db.first<RetailerRow>("SELECT * FROM retailers WHERE id = ?", [client.retailer_id]);
  if (!retailer || retailer.status !== "active") return oauthError(401, "invalid_client", "Access was revoked by the brand.", { "www-authenticate": 'Basic realm="obx"' });
  const g = await grantOf(ctx, retailer, client);
  const requested = form.get("scope");
  let scopes = g.scopes;
  if (requested && requested.trim()) {
    const want = [...new Set(requested.trim().split(/\s+/))];
    if (want.some((s) => !g.scopes.includes(s))) return oauthError(400, "invalid_scope", "The client does not have one of the requested scopes.");
    scopes = want;
  }
  const token = await issueAccessToken(ctx, client, scopes);
  if (!client.last_used_at || Date.parse(client.last_used_at) < ctx.now() - 5 * 60_000)
    ctx.p.defer(ctx.db.batch([
      { sql: "UPDATE api_clients SET last_used_at = ? WHERE id = ?", params: [ctx.iso(), client.id] },
      { sql: "UPDATE retailers SET last_activity_at = ? WHERE id = ?", params: [ctx.iso(), retailer.id] },
    ]).catch(() => {}));
  return new Response(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL, scope: scopes.join(" ") }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", "obx-version": "0.1", ...limitHeaders(rl) },
  });
});

// ------------------------------------------------------------------ authenticated protocol endpoints

async function client(c: C, scope: string, kind: "api" | "media" = "api"): Promise<ClientAuth> {
  const ctx = ctxOf(c);
  await requireSetup(c);
  const auth = await authenticateClient(ctx, c.req.header("authorization"));
  const rl = memLimit(ctx.now(), `${kind}:${auth.client.id}`, kind === "media" ? ctx.config.renditionRateLimit : ctx.config.apiRateLimit);
  c.set("rl", limitHeaders(rl));
  enforce(rl);
  requireScope(auth.scopes, scope);
  return auth;
}

protocol.get("/obx/v1/grant", async (c) => {
  const a = await client(c, "catalog:read");
  return json(c, await grantOf(ctxOf(c), a.retailer, a.client));
});

protocol.get("/obx/v1/changes", async (c) => {
  const a = await client(c, "catalog:read");
  const ctx = ctxOf(c);
  const limit = intQuery(c, "limit", 100, 1, 500);
  const page = await readChanges(ctx, { viewer: a.viewer, retailer: a.retailer, client: a.client }, c.req.query("cursor") || undefined, limit, await ctx.baseUrl());
  return json(c, page);
});

protocol.get("/obx/v1/brands", async (c) => {
  const a = await client(c, "catalog:read");
  return json(c, { items: await visibleBrands(ctxOf(c), a.viewer) });
});

protocol.get("/obx/v1/brands/:id", async (c) => {
  const a = await client(c, "catalog:read");
  const id = idParam(c);
  const b = (await visibleBrands(ctxOf(c), a.viewer)).find((x) => x.id === id);
  if (!b) throw new ObxError("not_found", "Unknown brand.");
  return json(c, b);
});

protocol.get("/obx/v1/products:by-gtin", async (c) => {
  const a = await client(c, "catalog:read");
  const ctx = ctxOf(c);
  const raw = c.req.query("gtin");
  if (!raw) throw new ObxError("invalid_request", "gtin is required (comma-separated).");
  const list = raw.split(",");
  if (list.length > 100) throw new ObxError("limit_exceeded", "At most 100 codes in the query string; use POST for up to 2000.");
  return json(c, await gtinLookup(ctx, a.viewer, list, await ctx.baseUrl()));
});

protocol.post("/obx/v1/products:by-gtin", async (c) => {
  const a = await client(c, "catalog:read");
  const ctx = ctxOf(c);
  const body = await readObject(c);
  if (!Array.isArray(body.gtins)) throw new ObxError("validation_failed", "gtins must be a list.", [fieldError("/gtins", "Must be a list of codes.")]);
  if (body.gtins.length > 2000) throw new ObxError("limit_exceeded", "At most 2000 codes per lookup.");
  const list = body.gtins.map((g) => (typeof g === "string" ? g : String(g)));
  return json(c, await gtinLookup(ctx, a.viewer, list, await ctx.baseUrl()));
});

protocol.get("/obx/v1/products", async (c) => {
  const a = await client(c, "catalog:read");
  const ctx = ctxOf(c);
  const limit = intQuery(c, "limit", 25, 1, 100);
  const settings = await ctx.settings();
  const base = await ctx.baseUrl();
  const idsQ = c.req.query("ids");
  if (idsQ) {
    const ids = idsQ.split(",").map((x) => x.trim()).filter(Boolean);
    if (ids.length > 100) throw new ObxError("limit_exceeded", "At most 100 ids.");
    return json(c, { items: await productDetails(ctx, a.viewer, ids, { base, settings }), next_cursor: null });
  }
  const brandId = c.req.query("brand_id");
  const updatedSinceRaw = c.req.query("updated_since");
  const updatedSince = updatedSinceRaw ? normDateTime(updatedSinceRaw) : null;
  if (updatedSinceRaw && !updatedSince) throw new ObxError("invalid_request", "updated_since must be an RFC 3339 timestamp.");
  const filterKey = canonicalJson({ brandId: brandId ?? null, updatedSince });
  const cur = await decodeListCursor<{ k: string; f: string }>(ctx, "products", c.req.query("cursor") || undefined);
  if (cur && cur.f !== filterKey) throw new ObxError("cursor_invalid", "This cursor belongs to a different filter.");
  const pv = productVisibleSql(a.viewer);
  const parts = [pv.sql, "p.id > ?"];
  const params: (string | number)[] = [...(pv.params as string[]), cur?.k ?? ""];
  if (brandId) {
    parts.push("p.brand_id = ?");
    params.push(brandId);
  }
  if (updatedSince) {
    parts.push("p.content_updated_at >= ?");
    params.push(updatedSince);
  }
  const rows = await ctx.db.all<{ id: string }>(`SELECT p.id FROM products p JOIN brands b ON b.id = p.brand_id WHERE ${parts.join(" AND ")} ORDER BY p.id LIMIT ?`, [...params, limit + 1]);
  const more = rows.length > limit;
  const page = rows.slice(0, limit).map((r) => r.id);
  const items = await productDetails(ctx, a.viewer, page, { base, settings });
  return json(c, { items, next_cursor: more ? await encodeListCursor(ctx, "products", { k: page[page.length - 1], f: filterKey }) : null });
});

function stripUrls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripUrls);
  if (isPlainObject(v)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== "url" && k !== "url_expires_at") o[k] = stripUrls(x);
    return o;
  }
  return v;
}

protocol.get("/obx/v1/products/:id", async (c) => {
  const a = await client(c, "catalog:read");
  const ctx = ctxOf(c);
  const id = idParam(c);
  const [p] = await productDetails(ctx, a.viewer, [id], { base: await ctx.baseUrl(), settings: await ctx.settings() });
  if (!p) throw new ObxError("not_found", "Unknown product.");
  const etag = `"${await sha256Hex(canonicalJson(stripUrls(p)))}"`;
  const inm = c.req.header("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim() === etag)) return new Response(null, { status: 304, headers: { etag, ...(c.get("rl") ?? {}) } });
  return json(c, p, 200, { etag });
});

protocol.get("/obx/v1/assets/:id", async (c) => {
  const a = await client(c, "media:read");
  const ctx = ctxOf(c);
  const row = await loadAssetForViewer(ctx, a.viewer, idParam(c));
  if (!row) throw new ObxError("not_found", "Unknown asset.");
  return json(c, await assetForViewer(ctx, row, await ctx.settings(), a.viewer, await assetVariantIds(ctx, row), await ctx.baseUrl()));
});

/** Resolves a signed-URL actor to a viewer, re-checking that it is still allowed (blocking works at once). */
export async function viewerForActor(c: C, actor: string): Promise<Viewer> {
  const ctx = ctxOf(c);
  const [kind, id] = [actor.slice(0, 1), actor.slice(2)];
  const settings = await ctx.settings();
  if (kind === "c") {
    const cl = await ctx.db.first<ClientRow>("SELECT * FROM api_clients WHERE id = ?", [id]);
    const r = cl ? await ctx.db.first<RetailerRow>("SELECT * FROM retailers WHERE id = ?", [cl.retailer_id]) : null;
    if (!cl || !r || cl.status !== "active" || r.status !== "active") throw new ObxError("access_revoked", "Access was revoked by the brand.");
    const g = await grantOf(ctx, r, cl);
    return { actor, kind: "client", retailerId: r.id, retailerName: r.name, actorName: cl.name, brandIds: g.brand_ids, original: g.original_allowed && g.scopes.includes("media:original"), scopes: g.scopes };
  }
  const u = await ctx.db.first<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
  if (!u || u.status !== "active") throw new ObxError("forbidden", "This link is no longer valid.");
  if (kind === "p" && u.role === "admin") return { actor, kind: "preview", retailerId: null, retailerName: null, actorName: u.name, brandIds: null, original: true, scopes: PROTOCOL_SCOPES };
  if (kind === "u" && u.role === "retailer") {
    const r = await ctx.db.first<RetailerRow>("SELECT * FROM retailers WHERE id = ?", [u.retailer_id]);
    if (!r || r.status !== "active") throw new ObxError("forbidden", "This link is no longer valid.");
    const original = settings.portal.allow_original_download && r.allow_original !== 0;
    return { actor, kind: "user", retailerId: r.id, retailerName: r.name, actorName: u.name, brandIds: safeJsonParse<string[] | null>(r.brand_ids, null), original, scopes: ["catalog:read", "media:read"] };
  }
  throw new ObxError("forbidden", "This link is not valid.");
}

protocol.on(["GET", "HEAD"], "/obx/v1/assets/:id/renditions/:name", async (c) => {
  const ctx = ctxOf(c);
  await requireSetup(c);
  const id = idParam(c);
  const name = c.req.param("name") as RenditionName;
  if (!(RENDITIONS as readonly string[]).includes(name)) throw new ObxError("not_found", "Unknown rendition.");
  const path = `/obx/v1/assets/${id}/renditions/${name}`;
  let viewer: Viewer;
  const q = { exp: c.req.query("exp"), a: c.req.query("a"), sig: c.req.query("sig") };
  if (q.sig) {
    const v = await verifySignedPath(ctx, path, q);
    if (v === "expired") throw new ObxError("forbidden", "This link has expired. Read the asset again for a fresh link.");
    if (!v) throw new ObxError("forbidden", "This link is not valid.");
    viewer = await viewerForActor(c, v.actor);
    if (viewer.kind === "client") {
      const rl = memLimit(ctx.now(), `media:${viewer.actor}`, ctx.config.renditionRateLimit);
      c.set("rl", limitHeaders(rl));
      enforce(rl);
      if (!viewer.scopes.includes("media:read")) throw new ObxError("insufficient_scope", "This call needs the media:read scope.");
    }
  } else {
    const a = await client(c, "media:read", "media");
    viewer = a.viewer;
    if (name === "original" && !a.scopes.includes("media:original")) {
      if (!a.viewer.original && !(await grantOf(ctx, a.retailer, a.client)).original_allowed) throw new ObxError("original_not_allowed", "Original files are not available to you.");
      throw new ObxError("insufficient_scope", "This call needs the media:original scope.");
    }
  }
  const row = await loadAssetForViewer(ctx, viewer, id);
  if (!row) throw new ObxError("not_found", "Unknown asset.");
  if (name === "original" && !viewer.original) throw new ObxError("original_not_allowed", "Original files are not available to you.");
  const files = safeJsonParse<Files>(row.files, {});
  const pick = pickFile(files, name);
  if (!pick) throw new ObxError("not_found", "This file is not available yet.");
  const filename = renditionFilename(assetFilename(row.external_id, safeJsonParse(row.stored, {}), files), name, pick.fallback);
  const res = await serveStored(ctx, c.req.raw, {
    key: blobKey(pick.ref.sha256),
    size: pick.ref.bytes,
    contentType: pick.ref.content_type,
    filename,
    disposition: "inline",
    sha256: pick.ref.sha256,
    cacheControl: "private, max-age=3600",
    extraHeaders: { ...(c.get("rl") ?? {}), "obx-version": "0.1" },
  });
  const range = c.req.header("range");
  if (viewer.kind === "client" && res.status === 200 && c.req.method === "GET" && (!range || /^bytes=0-/.test(range)))
    logDownload(ctx, { kind: "api_rendition", viewer, variant: name, productId: row.product_id, assetId: row.id, files: 1, bytes: pick.ref.bytes });
  return res;
});

// ------------------------------------------------------------------ exports

protocol.post("/obx/v1/exports", async (c) => {
  const a = await client(c, "catalog:read");
  const ctx = ctxOf(c);
  const idem = c.req.header("idempotency-key");
  if (idem) {
    if (idem.length > 200) throw new ObxError("invalid_request", "Idempotency-Key is too long.");
    const prev = await ctx.db.first<{ body: string }>("SELECT body FROM idempotency WHERE key = ?", [`exp:${a.client.id}:${idem}`]);
    if (prev) {
      const job = await getJob(ctx, prev.body);
      if (job) return json(c, await exportJson(ctx, job, a.viewer.actor), 202, { location: `/obx/v1/exports/${job.id}` });
    }
  }
  const body = await readObject(c);
  const v = new V();
  const f = isPlainObject(body.filter) ? body.filter : {};
  if (body.filter !== undefined && !isPlainObject(body.filter)) v.err("/filter", "Must be an object.");
  const arr = (x: unknown, p: string, max: number): string[] | null => {
    if (x === undefined || x === null) return null;
    if (!Array.isArray(x) || x.some((y) => typeof y !== "string")) {
      v.err(p, "Must be a list of strings.");
      return null;
    }
    if (x.length > max) v.err(p, `At most ${max} items.`);
    return x as string[];
  };
  const filter = {
    brand_ids: arr(f.brand_ids, "/filter/brand_ids", 1000),
    product_ids: arr(f.product_ids, "/filter/product_ids", 10000),
    gtins: arr(f.gtins, "/filter/gtins", 10000),
    updated_since: v.dateTime(f.updated_since, "/filter/updated_since"),
  };
  if (!Array.isArray(body.renditions) || body.renditions.some((r) => !(RENDITIONS as readonly string[]).includes(r as string))) v.err("/renditions", "List the renditions: original, web, square, thumb.");
  if (!v.ok) throw new ObxError("validation_failed", "The export request is invalid.", v.errors);
  const renditions = [...new Set(body.renditions as RenditionName[])];
  if (renditions.includes("original") && !a.viewer.original) throw new ObxError("original_not_allowed", "Original files are not available to you.");
  const running = await ctx.db.first<{ id: string }>("SELECT id FROM jobs WHERE kind = 'export' AND owner = ? AND status IN ('queued', 'running')", [`client:${a.client.id}`]);
  if (running) throw new ObxError("conflict", `Export ${running.id} is still running. Wait for it to finish.`);
  const input: ExportInput = {
    client_row_id: a.client.id,
    retailer_id: a.retailer.id,
    viewer: a.viewer,
    filter,
    renditions,
    include_data: body.include_data !== false,
    base: await ctx.baseUrl(),
  };
  const job = await enqueueJob(ctx, { kind: "export", owner: `client:${a.client.id}`, input, idempotencyKey: idem ?? null });
  if (idem) await ctx.db.run("INSERT OR IGNORE INTO idempotency (key, status, body, created_at) VALUES (?, 202, ?, ?)", [`exp:${a.client.id}:${idem}`, job.id, ctx.iso()]);
  return json(c, await exportJson(ctx, job, a.viewer.actor), 202, { location: `/obx/v1/exports/${job.id}` });
});

async function ownExport(c: C, a: ClientAuth | null, actorClientId: string | null) {
  const ctx = ctxOf(c);
  const job = await getJob(ctx, idParam(c));
  const owner = a ? a.client.id : actorClientId;
  if (!job || job.kind !== "export" || job.owner !== `client:${owner}`) throw new ObxError("not_found", "Unknown export.");
  return job;
}

protocol.get("/obx/v1/exports/:id", async (c) => {
  const a = await client(c, "catalog:read");
  const job = await ownExport(c, a, null);
  return json(c, await exportJson(ctxOf(c), job, a.viewer.actor));
});

async function signedOrBearer(c: C, path: string, scope: string): Promise<{ viewer: Viewer; clientId: string }> {
  const ctx = ctxOf(c);
  const q = { exp: c.req.query("exp"), a: c.req.query("a"), sig: c.req.query("sig") };
  if (q.sig) {
    await requireSetup(c);
    const v = await verifySignedPath(ctx, path, q);
    if (v === "expired") throw new ObxError("forbidden", "This link has expired. Read the export again for fresh links.");
    if (!v || !v.actor.startsWith("c.")) throw new ObxError("forbidden", "This link is not valid.");
    const viewer = await viewerForActor(c, v.actor);
    return { viewer, clientId: v.actor.slice(2) };
  }
  const a = await client(c, scope);
  return { viewer: a.viewer, clientId: a.client.id };
}

protocol.get("/obx/v1/exports/:id/manifest", async (c) => {
  const id = idParam(c);
  const who = await signedOrBearer(c, `/obx/v1/exports/${id}/manifest`, "catalog:read");
  const job = await ownExport(c, null, who.clientId);
  const ctx = ctxOf(c);
  if (job.status === "expired" || (job.expires_at && Date.parse(job.expires_at) < ctx.now())) throw new ObxError("export_expired", "This export has expired. Start a new one.");
  if (job.status !== "succeeded") throw new ObxError("not_found", "The export is not finished yet.");
  return new Response(manifestStream(ctx, job), { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "private, no-store", "obx-version": "0.1" } });
});

protocol.get("/obx/v1/exports/:id/parts/:number", async (c) => {
  const id = idParam(c);
  const n = Number(c.req.param("number"));
  const who = await signedOrBearer(c, `/obx/v1/exports/${id}/parts/${c.req.param("number")}`, "media:read");
  const job = await ownExport(c, null, who.clientId);
  const ctx = ctxOf(c);
  if (job.status === "expired" || (job.expires_at && Date.parse(job.expires_at) < ctx.now())) throw new ObxError("export_expired", "This export has expired. Start a new one.");
  const parts = safeJsonParse<{ parts?: { number: number; bytes: number; sha256: string; files: number }[] }>(job.result, {}).parts ?? [];
  const part = parts.find((p) => p.number === n);
  if (job.status !== "succeeded" || !part) throw new ObxError("not_found", "Unknown part.");
  const res = await serveStored(ctx, c.req.raw, {
    key: `jobs/${job.id}/part-${n}.zip`,
    size: part.bytes,
    contentType: "application/zip",
    filename: `obx-export-${job.id}-part-${n}.zip`,
    disposition: "attachment",
    sha256: part.sha256,
    extraHeaders: { "obx-version": "0.1" },
  });
  const range = c.req.header("range");
  if (res.status === 200 && (!range || /^bytes=0-/.test(range))) logDownload(ctx, { kind: "api_export", viewer: who.viewer, files: part.files, bytes: part.bytes });
  return res;
});

// ------------------------------------------------------------------ usage

protocol.post("/obx/v1/usage", async (c) => {
  const a = await client(c, "usage:write");
  const ctx = ctxOf(c);
  const body = await readObject(c, 2 * 1048576);
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 1000) throw new ObxError("validation_failed", "Send 1 to 1000 events.", [fieldError("/events", "1 to 1000 events.")]);
  const v = new V();
  const events = body.events.map((e, i) => {
    const p = `/events/${i}`;
    if (!isPlainObject(e)) {
      v.err(p, "Must be an object.");
      return null;
    }
    const asset = v.str(e.asset_id, `${p}/asset_id`, { required: true, pattern: /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/ });
    const ev = v.enumv(e.event, `${p}/event`, ["synced", "published", "downloaded", "removed"] as const, true);
    const at = v.dateTime(e.at, `${p}/at`);
    if (e.at === undefined) v.err(`${p}/at`, "This field is required.");
    const rendition = v.enumv(e.rendition, `${p}/rendition`, RENDITIONS);
    const channel = v.enumv(e.channel, `${p}/channel`, CHANNELS);
    const count = e.count === undefined ? 1 : v.int(e.count, `${p}/count`, 1, 1_000_000);
    return { asset, ev, at, rendition, channel, count: count ?? 1 };
  });
  if (!v.ok) throw new ObxError("validation_failed", "Some events are invalid.", v.errors.slice(0, 50));
  const ids = [...new Set(events.map((e) => e!.asset!))];
  const known = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const pv = productVisibleSql(a.viewer);
    for (const r of await ctx.db.all<{ id: string; product_id: string }>(`SELECT a.id, a.product_id FROM assets a JOIN products p ON p.id = a.product_id JOIN brands b ON b.id = p.brand_id WHERE a.id IN (${placeholders(chunk.length)}) AND ${pv.sql}`, [...chunk, ...pv.params]))
      known.set(r.id, r.product_id);
  }
  const stmts = events
    .filter((e) => known.has(e!.asset!))
    .map((e) => downloadStmt(ctx, { kind: "usage", viewer: a.viewer, variant: e!.rendition, productId: known.get(e!.asset!), assetId: e!.asset, usageEvent: e!.ev, files: e!.count, at: e!.at ?? undefined }));
  for (let i = 0; i < stmts.length; i += 200) await ctx.db.batch(stmts.slice(i, i + 200));
  return json(c, { accepted: stmts.length }, 202);
});

// ------------------------------------------------------------------ webhooks (consumer subscriptions)

protocol.get("/obx/v1/webhooks", async (c) => {
  const a = await client(c, "catalog:read");
  const rows = await ctxOf(c).db.all<WebhookRow>("SELECT * FROM webhooks WHERE owner = 'client' AND api_client_id = ? ORDER BY created_at", [a.client.id]);
  return json(c, { items: rows.map((w) => webhookJson(w)) });
});

protocol.post("/obx/v1/webhooks", async (c) => {
  const a = await client(c, "catalog:read");
  const ctx = ctxOf(c);
  const body = await readObject(c);
  const v = new V();
  const url = v.url(body.url, "/url");
  if (!Array.isArray(body.events) || !body.events.length || body.events.some((e) => !CLIENT_EVENTS.includes(e as string))) v.err("/events", `Events: ${CLIENT_EVENTS.join(", ")}.`);
  if (!v.ok) throw new ObxError("validation_failed", "The subscription is invalid.", v.errors);
  await assertSafeUrl(url!, ctx.urlPolicy());
  const count = await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM webhooks WHERE owner = 'client' AND api_client_id = ?", [a.client.id]);
  if ((count?.n ?? 0) >= 5) throw new ObxError("conflict", "At most 5 subscriptions per API key. Delete one first.");
  const { row, secret } = await createWebhook(ctx, "client", a.client.id, url!, body.events as string[]);
  return json(c, webhookJson(row, secret), 201);
});

protocol.delete("/obx/v1/webhooks/:id", async (c) => {
  const a = await client(c, "catalog:read");
  const r = await ctxOf(c).db.run("DELETE FROM webhooks WHERE id = ? AND owner = 'client' AND api_client_id = ?", [idParam(c), a.client.id]);
  if (!r.changes) throw new ObxError("not_found", "Unknown subscription.");
  return noContent(c);
});

protocol.post("/obx/v1/webhooks/:id/test", async (c) => {
  const a = await client(c, "catalog:read");
  const ctx = ctxOf(c);
  const w = await ctx.db.first<WebhookRow>("SELECT * FROM webhooks WHERE id = ? AND owner = 'client' AND api_client_id = ?", [idParam(c), a.client.id]);
  if (!w) throw new ObxError("not_found", "Unknown subscription.");
  const d = await testWebhook(ctx, w);
  return json(c, { delivered: d.state === "done", status: d.status_code });
});

export { brandRep };
