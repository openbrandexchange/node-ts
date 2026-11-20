// Retailer portal API ("<Brand> · Beeldbank"): browse, filter, EAN paste, selection, downloads, CSV.
// Admins get the same endpoints as a preview of everything published (their downloads are not logged).
import { Hono } from "hono";
import type { AppEnv, C } from "./common";
import { ctxOf, json, noContent, readObject, limitQuery, idParam, listQuery, encodeListCursor, decodeListCursor } from "./common";
import { requireUser } from "./admin-auth";
import { ObxError } from "../lib/problem";
import { grantOf, retailerOriginalAllowed, type RetailerRow, type ClientRow, type Viewer, type SessionInfo } from "../core/auth";
import { PROTOCOL_SCOPES } from "../core/validate";
import { assetVisibleSql, loadAssetForViewer, placeholders, productDetails, productVisibleSql, renditionUrl, signedExpiry, visibleBrandsStmt, type AssetRow, type BrandRow, type ProductRow } from "../core/read";
import { QUALIFIER_ROWS, filterSql, pickFile, zipEntryName, downloadJobJson, type PortalFilter, type DownloadInput } from "../core/bulk";
import { gtinLookup } from "../core/gtinlookup";
import { safeJsonParse, contentDisposition, sanitizeFilename, normDateTime } from "../lib/util";
import { assetFilename, brandRep, type Files } from "../core/reps";
import { blobKey } from "../core/blobs";
import { serveStored } from "./files";
import { logDownload } from "../core/stats";
import { zipSize, zipStream, uniqueNamer, type StreamEntry } from "../lib/zip";
import { articleCsv, downloadAssetsCsv } from "../core/csvexport";
import { crc32 } from "../lib/crypto";
import { enqueueJob, getJob, type JobRow } from "../core/jobs";
import { clientJson, clientWithSecret, createClient, rotateClient } from "../core/accounts";
import { V } from "../core/validate";
import { faviconUrl, logoUrl } from "./protocol";
import { appearanceJson, withImageUrls } from "../core/branding";
import { memLimit, enforce } from "../core/ratelimit";
import { QUALIFIER_NAMES } from "../core/article";

export const portal = new Hono<AppEnv>();

export const SELECTION_MAX = 1000;
export const SYNC_ZIP_MAX = 400;

async function viewerOf(c: C): Promise<{ viewer: Viewer; session: SessionInfo }> {
  const session = requireUser(c);
  const ctx = ctxOf(c);
  const rl = memLimit(ctx.now(), `portal:${session.user.id}`, 1200);
  enforce(rl);
  if (session.user.role === "admin")
    return { session, viewer: { actor: `p.${session.user.id}`, kind: "preview", retailerId: null, retailerName: null, actorName: session.user.name, brandIds: null, original: true, scopes: PROTOCOL_SCOPES } };
  const r = session.retailer!;
  const s = await ctx.settings();
  return {
    session,
    viewer: {
      actor: `u.${session.user.id}`,
      kind: "user",
      retailerId: r.id,
      retailerName: r.name,
      actorName: session.user.name,
      brandIds: safeJsonParse<string[] | null>(r.brand_ids, null),
      original: retailerOriginalAllowed(r, s.portal.allow_original_download),
      scopes: ["catalog:read", "media:read"],
    },
  };
}

function filterFrom(c: C): PortalFilter {
  const since = c.req.query("updated_since");
  const norm = since ? normDateTime(since) : null;
  if (since && !norm) throw new ObxError("invalid_request", "updated_since must be a date or timestamp.");
  return {
    q: c.req.query("q") ?? undefined,
    brand_id: listQuery(c, "brand_id"),
    item_type: listQuery(c, "item_type"),
    color: listQuery(c, "color"),
    season: listQuery(c, "season"),
    collection: listQuery(c, "collection"),
    target_group: listQuery(c, "target_group"),
    qualifier: listQuery(c, "qualifier"),
    updated_since: norm ?? undefined,
  };
}

function variantParam(c: C, viewer: Viewer): "original" | "web" | "square" {
  const v = c.req.query("variant");
  if (v && !["original", "web", "square"].includes(v)) throw new ObxError("invalid_request", "variant must be original, web or square.");
  const chosen = (v as "original" | "web" | "square" | undefined) ?? (viewer.original ? "original" : "web");
  if (chosen === "original" && !viewer.original) throw new ObxError("original_not_allowed", "Original files are not available to you. Choose web or square.");
  return chosen;
}

async function selectionIds(c: C, userId: string): Promise<string[]> {
  const row = await ctxOf(c).db.first<{ product_ids: string }>("SELECT product_ids FROM selections WHERE user_id = ?", [userId]);
  return safeJsonParse<string[]>(row?.product_ids, []);
}

async function visibleIds(c: C, viewer: Viewer, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const ctx = ctxOf(c);
  const pv = productVisibleSql(viewer);
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    for (const r of await ctx.db.all<{ id: string }>(`SELECT p.id FROM products p JOIN brands b ON b.id = p.brand_id WHERE p.id IN (${placeholders(chunk.length)}) AND ${pv.sql}`, [...chunk, ...pv.params]))
      out.add(r.id);
  }
  return ids.filter((id) => out.has(id));
}

async function imageCount(c: C, ids: string[]): Promise<number> {
  let n = 0;
  const ctx = ctxOf(c);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    n += (await ctx.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM assets a WHERE a.product_id IN (${placeholders(chunk.length)}) AND ${assetVisibleSql()}`, [...chunk, ctx.iso()]))?.n ?? 0;
  }
  return n;
}

// ------------------------------------------------------------------ viewer & browsing

portal.get("/admin/api/portal/viewer", async (c) => {
  const { viewer, session } = await viewerOf(c);
  const ctx = ctxOf(c);
  const s = await ctx.settings();
  const pv = productVisibleSql(viewer);
  // One round trip: the brands and how many products of the selection are still visible.
  const [brandRows, selRows] = await ctx.db.reads([
    visibleBrandsStmt(viewer),
    {
      sql: `SELECT COUNT(DISTINCT p.id) AS n FROM selections s, json_each(s.product_ids) j JOIN products p ON p.id = j.value JOIN brands b ON b.id = p.brand_id WHERE s.user_id = ? AND ${pv.sql}`,
      params: [session.user.id, ...pv.params],
    },
  ]);
  const look = appearanceJson(s.branding);
  return json(c, {
    preview: viewer.kind === "preview",
    retailer: session.retailer ? { id: session.retailer.id, name: session.retailer.name } : null,
    brands: (brandRows as BrandRow[]).map(brandRep),
    permissions: {
      original_download: viewer.original,
      article_data_export: s.portal.allow_article_data_export,
      api_self_service: s.portal.retailer_api_self_service && viewer.kind === "user",
    },
    branding: {
      name: s.branding.display_name || s.company.name,
      logo_url: await logoUrl(c),
      favicon_url: await faviconUrl(c),
      accent_color: s.branding.accent_color,
      welcome_text: s.branding.welcome_text,
      portal_name: s.branding.portal_name,
      languages: s.portal.languages,
      default_language: s.portal.default_language,
      access_requests_enabled: s.portal.access_requests_enabled,
      setup_required: false,
      // Portal appearance with every image id resolved to its URL (blocks keep `image` and get `image_url`).
      theme: look.theme,
      login: withImageUrls(look.login),
      home: withImageUrls(look.home),
    },
    languages: s.portal.languages,
    selection_count: (selRows[0] as { n: number } | undefined)?.n ?? 0,
    limits: { selection_max_products: SELECTION_MAX, sync_zip_max_images: SYNC_ZIP_MAX, gtin_lookup_max: 2000 },
  });
});

portal.get("/admin/api/portal/products", async (c) => {
  const { viewer } = await viewerOf(c);
  const ctx = ctxOf(c);
  const limit = limitQuery(c, 48, 200);
  const f = filterFrom(c);
  const w = filterSql(f, viewer, ctx.iso());
  const off = (await decodeListCursor<number>(ctx, "portal-products", c.req.query("cursor") || undefined)) ?? 0;
  // Page first on the narrow columns, then read the stored documents of that page only; the count
  // goes in the same round trip.
  const [countRows, pageRows] = await ctx.db.reads([
    { sql: `SELECT COUNT(*) AS n FROM products p JOIN brands b ON b.id = p.brand_id WHERE ${w.sql}`, params: w.params },
    {
      sql: `SELECT p.*, b.stored AS brand_stored FROM (
       SELECT p.id AS pid, p.style_number AS sn FROM products p JOIN brands b ON b.id = p.brand_id WHERE ${w.sql} ORDER BY p.style_number COLLATE NOCASE, p.id LIMIT ? OFFSET ?
     ) pg JOIN products p ON p.id = pg.pid JOIN brands b ON b.id = p.brand_id ORDER BY pg.sn COLLATE NOCASE, pg.pid`,
      params: [...w.params, limit + 1, off],
    },
  ]);
  const total = (countRows[0] as { n: number } | undefined)?.n ?? 0;
  const rows = pageRows as (ProductRow & { brand_stored: string })[];
  const page = rows.slice(0, limit);
  const ids = page.map((p) => p.id);
  const [variantRows, assetRows] = ids.length
    ? await ctx.db.reads([
        { sql: `SELECT product_id, color_code, stored FROM variants WHERE product_id IN (${placeholders(ids.length)}) AND status = 'published' ORDER BY external_id`, params: ids },
        {
          sql: `SELECT * FROM assets a WHERE a.product_id IN (${placeholders(ids.length)}) AND ${assetVisibleSql()} ORDER BY CASE WHEN a.color_code IS NULL THEN 0 ELSE 1 END, a.color_code, a.position`,
          params: [...ids, ctx.iso()],
        },
      ])
    : [[], []];
  const variants = variantRows as { product_id: string; color_code: string; stored: string }[];
  const assets = assetRows as AssetRow[];
  const base = await ctx.baseUrl();
  const exp = signedExpiry(ctx.now());
  const items = [];
  for (const p of page) {
    const s = safeJsonParse<Record<string, unknown>>(p.stored, {});
    const pa = assets.filter((a) => a.product_id === p.id);
    const colors = new Map<string, Record<string, unknown> | null>();
    for (const v of variants.filter((x) => x.product_id === p.id)) if (!colors.has(v.color_code)) colors.set(v.color_code, safeJsonParse<{ color?: { name?: Record<string, unknown> } }>(v.stored, {}).color?.name ?? null);
    const colorList = [];
    for (const [code, name] of colors) {
      const first = pa.find((a) => a.color_code === code);
      colorList.push({ code, name, thumb_url: first ? await renditionUrl(ctx, base, first.id, "thumb", viewer.actor, exp) : null });
    }
    items.push({
      id: p.id,
      style_number: p.style_number,
      name: s.name,
      brand: { id: p.brand_id, name: String(safeJsonParse<Record<string, unknown>>(p.brand_stored, {}).name ?? "") },
      item_type: p.item_type,
      target_group: p.target_group,
      season: p.season,
      collection: p.collection,
      thumb_url: pa[0] ? await renditionUrl(ctx, base, pa[0].id, "thumb", viewer.actor, exp) : null,
      colors: colorList,
      image_count: pa.length,
      variant_count: variants.filter((x) => x.product_id === p.id).length,
      updated_at: p.content_updated_at,
    });
  }
  return json(c, { items, next_cursor: rows.length > limit ? await encodeListCursor(ctx, "portal-products", off + limit) : null, total });
});

/**
 * Facet `qualifiers` (spec node-admin.yaml Facets): every qualifier code on any fibre of the matching
 * products, with the vocabulary's name as label (else the name written with it, else the code) and the
 * number of products.
 */
type Facet = { value: string; count: number };
type QualifierRow = { code: string; n: number; name: string | null };

function qualifierFacetStmt(w: { sql: string; params: (string | number)[] }) {
  return {
    sql: `SELECT json_extract(q.value, '$.code') AS code, COUNT(DISTINCT p.id) AS n, MAX(json_extract(q.value, '$.name')) AS name FROM products p JOIN brands b ON b.id = p.brand_id, ${QUALIFIER_ROWS} WHERE ${w.sql} AND json_type(q.value, '$.code') = 'text' GROUP BY code ORDER BY n DESC, code LIMIT 200`,
    params: w.params,
  };
}

function qualifierFacet(rows: QualifierRow[]) {
  return rows.map((r) => {
    const known = QUALIFIER_NAMES.get(r.code);
    const written = r.name ? safeJsonParse<unknown>(r.name, null) : null;
    const label = known ?? (written && typeof written === "object" && !Array.isArray(written) ? written : r.code);
    return { value: r.code, label, count: r.n };
  });
}

portal.get("/admin/api/portal/facets", async (c) => {
  const { viewer } = await viewerOf(c);
  const ctx = ctxOf(c);
  const f = filterFrom(c);
  const now = ctx.iso();
  // Every facet in one round trip.
  const simple = (col: string, key: keyof PortalFilter) => {
    const w = filterSql(f, viewer, now, key);
    return {
      sql: `SELECT ${col} AS value, COUNT(*) AS count FROM products p JOIN brands b ON b.id = p.brand_id WHERE ${w.sql} AND ${col} IS NOT NULL GROUP BY ${col} ORDER BY count DESC, value LIMIT 200`,
      params: w.params,
    };
  };
  const cw = filterSql(f, viewer, now, "color");
  const [brandRows, brandList, colorRows, itemTypes, seasons, collections, targetGroups, qualifierRows] = (await ctx.db.reads([
    simple("p.brand_id", "brand_id"),
    visibleBrandsStmt(viewer),
    // Colour names from one variant per colour (not a JSON parse of every variant).
    {
      sql: `SELECT c.value, c.count, (SELECT json_extract(x.stored, '$.color.name') FROM variants x WHERE x.rowid = c.r) AS name FROM (
              SELECT v.color_code AS value, COUNT(DISTINCT p.id) AS count, MIN(v.rowid) AS r FROM products p JOIN brands b ON b.id = p.brand_id JOIN variants v ON v.product_id = p.id AND v.status = 'published' WHERE ${cw.sql} AND v.color_code IS NOT NULL GROUP BY v.color_code ORDER BY count DESC, value LIMIT 300
            ) c ORDER BY c.count DESC, c.value`,
      params: cw.params,
    },
    simple("p.item_type", "item_type"),
    simple("p.season", "season"),
    simple("p.collection", "collection"),
    simple("p.target_group", "target_group"),
    qualifierFacetStmt(filterSql(f, viewer, now, "qualifier")),
  ])) as [Facet[], BrandRow[], (Facet & { name: string | null })[], Facet[], Facet[], Facet[], Facet[], QualifierRow[]];
  const brands = brandList.map(brandRep);
  return json(c, {
    brands: brandRows.map((r) => ({ value: r.value, label: String(brands.find((b) => b.id === r.value)?.name ?? r.value), count: r.count })),
    item_types: itemTypes,
    colors: colorRows.map((r) => ({ value: r.value, label: r.name ? safeJsonParse(r.name, r.value) : r.value, count: r.count })),
    seasons,
    collections,
    target_groups: targetGroups,
    qualifiers: qualifierFacet(qualifierRows),
  });
});

portal.get("/admin/api/portal/products/data.csv", async (c) => {
  const { viewer } = await viewerOf(c);
  const ctx = ctxOf(c);
  const s = await ctx.settings();
  if (!s.portal.allow_article_data_export) throw new ObxError("forbidden", "The brand does not offer article data downloads.");
  const w = filterSql(filterFrom(c), viewer, ctx.iso());
  const ids = (await ctx.db.all<{ id: string }>(`SELECT p.id FROM products p JOIN brands b ON b.id = p.brand_id WHERE ${w.sql} ORDER BY p.style_number COLLATE NOCASE, p.id LIMIT 20000`, w.params)).map((r) => r.id);
  return csvResponse(c, viewer, ids, "articles.csv");
});

async function csvResponse(c: C, viewer: Viewer, ids: string[], filename: string) {
  const ctx = ctxOf(c);
  const d = c.req.query("delimiter");
  if (d && d !== "comma" && d !== "semicolon") throw new ObxError("invalid_request", "delimiter must be comma or semicolon.");
  const { csv, rows } = await articleCsv(ctx, viewer, ids, d === "semicolon" ? ";" : ",");
  logDownload(ctx, { kind: "csv", viewer, files: 0, bytes: csv.length });
  void rows;
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": contentDisposition("attachment", filename), "cache-control": "private, no-store" } });
}

portal.get("/admin/api/portal/products/:id", async (c) => {
  const { viewer } = await viewerOf(c);
  const ctx = ctxOf(c);
  const [p] = await productDetails(ctx, viewer, [idParam(c)], { base: await ctx.baseUrl(), settings: await ctx.settings() });
  if (!p) throw new ObxError("not_found", "Unknown product.");
  return json(c, p);
});

portal.post("/admin/api/portal/gtin-lookup", async (c) => {
  const { viewer } = await viewerOf(c);
  const ctx = ctxOf(c);
  const body = await readObject(c, 512 * 1024);
  let list: string[];
  if (typeof body.text === "string") {
    if (body.text.length > 100000) throw new ObxError("limit_exceeded", "The pasted text is too long.");
    list = body.text.split(/[^0-9]+/).filter(Boolean);
  } else if (Array.isArray(body.gtins)) list = body.gtins.map((g) => String(g));
  else throw new ObxError("invalid_request", "Send text (pasted EAN list) or gtins.");
  if (list.length > 2000) throw new ObxError("limit_exceeded", "At most 2000 EANs at once.");
  return json(c, await gtinLookup(ctx, viewer, list, await ctx.baseUrl()));
});

// ------------------------------------------------------------------ selection

async function selectionJson(c: C, viewer: Viewer, userId: string) {
  const ctx = ctxOf(c);
  const row = await ctx.db.first<{ product_ids: string; updated_at: string }>("SELECT * FROM selections WHERE user_id = ?", [userId]);
  const ids = await visibleIds(c, viewer, safeJsonParse<string[]>(row?.product_ids, []));
  return { product_ids: ids, image_count: await imageCount(c, ids), updated_at: row?.updated_at ?? null };
}

portal.get("/admin/api/portal/selection", async (c) => {
  const { viewer, session } = await viewerOf(c);
  return json(c, await selectionJson(c, viewer, session.user.id));
});

portal.put("/admin/api/portal/selection", async (c) => {
  const { viewer, session } = await viewerOf(c);
  const ctx = ctxOf(c);
  const body = await readObject(c);
  if (!Array.isArray(body.product_ids) || body.product_ids.some((x) => typeof x !== "string")) throw new ObxError("invalid_request", "product_ids must be a list of product ids.");
  const ids = [...new Set(body.product_ids as string[])];
  if (ids.length > SELECTION_MAX) throw new ObxError("limit_exceeded", `A selection holds at most ${SELECTION_MAX} products. Use a download of the whole filter instead.`);
  const vis = await visibleIds(c, viewer, ids);
  await ctx.db.run("INSERT INTO selections (user_id, product_ids, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET product_ids = excluded.product_ids, updated_at = excluded.updated_at", [
    session.user.id,
    JSON.stringify(vis),
    ctx.iso(),
  ]);
  return json(c, await selectionJson(c, viewer, session.user.id));
});

portal.delete("/admin/api/portal/selection", async (c) => {
  const { session } = await viewerOf(c);
  await ctxOf(c).db.run("DELETE FROM selections WHERE user_id = ?", [session.user.id]);
  return noContent(c);
});

// ------------------------------------------------------------------ downloads

portal.get("/admin/api/portal/assets/:id/download", async (c) => {
  const { viewer } = await viewerOf(c);
  const ctx = ctxOf(c);
  const variant = variantParam(c, viewer);
  const a = await loadAssetForViewer(ctx, viewer.kind === "preview" ? { ...viewer, kind: "user" } : viewer, idParam(c));
  if (!a) throw new ObxError("not_found", "Unknown image.");
  const files = safeJsonParse<Files>(a.files, {});
  const pick = pickFile(files, variant);
  if (!pick) throw new ObxError("not_found", "This image is not available.");
  const name = zipEntryName(assetFilename(a.external_id, safeJsonParse(a.stored, {}), files), variant, pick.fallback);
  const res = await serveStored(ctx, c.req.raw, { key: blobKey(pick.ref.sha256), size: pick.ref.bytes, contentType: pick.ref.content_type, filename: name, disposition: "attachment", sha256: pick.ref.sha256 });
  if (res.status === 200) logDownload(ctx, { kind: "image", viewer, variant, productId: a.product_id, assetId: a.id, files: 1, bytes: pick.ref.bytes });
  return res;
});

async function zipOf(c: C, viewer: Viewer, productIds: string[], variant: "original" | "web" | "square", folders: boolean, max: number | null) {
  const ctx = ctxOf(c);
  const entries: StreamEntry[] = [];
  const images: { file: string; styleNumber: string; row: AssetRow }[] = [];
  const unique = uniqueNamer();
  for (let i = 0; i < productIds.length; i += 200) {
    const chunk = productIds.slice(i, i + 200);
    const pv = productVisibleSql(viewer);
    const prods = await ctx.db.all<ProductRow>(`SELECT p.* FROM products p JOIN brands b ON b.id = p.brand_id WHERE p.id IN (${placeholders(chunk.length)}) AND ${pv.sql}`, [...chunk, ...pv.params]);
    const byId = new Map(prods.map((p) => [p.id, p]));
    const assets = await ctx.db.all<AssetRow>(
      `SELECT * FROM assets a WHERE a.product_id IN (${placeholders(chunk.length)}) AND ${assetVisibleSql()} ORDER BY a.product_id, CASE WHEN a.color_code IS NULL THEN 0 ELSE 1 END, a.color_code, a.position`,
      [...chunk, ctx.iso()],
    );
    for (const pid of chunk) {
      const p = byId.get(pid);
      if (!p) continue;
      for (const a of assets.filter((x) => x.product_id === pid)) {
        const files = safeJsonParse<Files>(a.files, {});
        const pick = pickFile(files, variant);
        if (!pick) continue;
        const base = zipEntryName(assetFilename(a.external_id, safeJsonParse(a.stored, {}), files), variant, pick.fallback);
        const name = unique(folders ? `${sanitizeFilename(p.style_number)}/${base}` : base);
        const sha = pick.ref.sha256;
        entries.push({ name, size: pick.ref.bytes, crc: pick.ref.crc32, open: async () => (await ctx.blobs.get(blobKey(sha))) ?? new Uint8Array(0) });
        images.push({ file: name.split("/").pop()!, styleNumber: p.style_number, row: a });
        if (max !== null && entries.length > max) throw new ObxError("limit_exceeded", `This download has more than ${max} images. Start a background download instead; you get a link when it is ready.`);
      }
    }
  }
  const imageCount = entries.length;
  if (images.length) {
    // The rights, embargo and AI provenance travel with the files (spec import-format.md §2.3).
    const bytes = await downloadAssetsCsv(ctx, images);
    entries.push({ name: unique("assets.csv"), size: bytes.length, crc: crc32(bytes), open: async () => bytes });
  }
  return { entries, imageCount };
}

function zipResponse(entries: StreamEntry[], filename: string) {
  return new Response(zipStream(entries), {
    headers: {
      "content-type": "application/zip",
      "content-length": String(zipSize(entries)),
      "content-disposition": contentDisposition("attachment", filename),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

portal.get("/admin/api/portal/products/:id/download.zip", async (c) => {
  const { viewer } = await viewerOf(c);
  const ctx = ctxOf(c);
  const variant = variantParam(c, viewer);
  const id = idParam(c);
  const p = await ctx.db.first<ProductRow>(
    `SELECT p.* FROM products p JOIN brands b ON b.id = p.brand_id WHERE p.id = ? AND ${productVisibleSql(viewer).sql}`,
    [id, ...productVisibleSql(viewer).params],
  );
  if (!p) throw new ObxError("not_found", "Unknown product.");
  const { entries, imageCount } = await zipOf(c, viewer, [id], variant, false, null);
  logDownload(ctx, { kind: "product_zip", viewer, variant, productId: id, files: imageCount, bytes: zipSize(entries) });
  return zipResponse(entries, `${sanitizeFilename(p.style_number)}_${variant}.zip`);
});

portal.get("/admin/api/portal/selection/download.zip", async (c) => {
  const { viewer, session } = await viewerOf(c);
  const ctx = ctxOf(c);
  const variant = variantParam(c, viewer);
  const ids = await visibleIds(c, viewer, await selectionIds(c, session.user.id));
  if (!ids.length) throw new ObxError("invalid_request", "Your selection is empty.");
  const { entries, imageCount } = await zipOf(c, viewer, ids, variant, true, SYNC_ZIP_MAX);
  logDownload(ctx, { kind: "selection_zip", viewer, variant, files: imageCount, bytes: zipSize(entries) });
  return zipResponse(entries, `selection_${variant}.zip`);
});

portal.get("/admin/api/portal/selection/data.csv", async (c) => {
  const { viewer, session } = await viewerOf(c);
  const s = await ctxOf(c).settings();
  if (!s.portal.allow_article_data_export) throw new ObxError("forbidden", "The brand does not offer article data downloads.");
  return csvResponse(c, viewer, await visibleIds(c, viewer, await selectionIds(c, session.user.id)), "selection.csv");
});

// ------------------------------------------------------------------ background downloads

async function ownJob(c: C, userId: string): Promise<JobRow> {
  const job = await getJob(ctxOf(c), idParam(c));
  if (!job || job.kind !== "download" || job.owner !== `user:${userId}`) throw new ObxError("not_found", "Unknown download.");
  return job;
}

portal.get("/admin/api/portal/download-jobs", async (c) => {
  const { session } = await viewerOf(c);
  const ctx = ctxOf(c);
  const rows = await ctx.db.all<JobRow>("SELECT * FROM jobs WHERE kind = 'download' AND owner = ? AND created_at > ? ORDER BY created_at DESC LIMIT 50", [`user:${session.user.id}`, ctx.iso(-7 * 24 * 3600 * 1000)]);
  return json(c, { items: rows.map(downloadJobJson) });
});

portal.post("/admin/api/portal/download-jobs", async (c) => {
  const { viewer, session } = await viewerOf(c);
  const ctx = ctxOf(c);
  const body = await readObject(c);
  const v = new V();
  const source = v.enumv(body.source, "/source", ["selection", "products", "filter"] as const, true);
  const variant = v.enumv(body.variant, "/variant", ["original", "web", "square"] as const, true);
  if (!v.ok) throw new ObxError("validation_failed", "Invalid download.", v.errors);
  if (variant === "original" && !viewer.original) throw new ObxError("original_not_allowed", "Original files are not available to you.");
  const running = await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'download' AND owner = ? AND status IN ('queued', 'running')", [`user:${session.user.id}`]);
  if ((running?.n ?? 0) >= 2) throw new ObxError("conflict", "You already have two downloads in progress. Wait until one is ready.");
  let productIds: string[] | null = null;
  let filter: PortalFilter | null = null;
  if (source === "selection") productIds = await visibleIds(c, viewer, await selectionIds(c, session.user.id));
  else if (source === "products") {
    if (!Array.isArray(body.product_ids) || body.product_ids.some((x) => typeof x !== "string")) throw new ObxError("validation_failed", "product_ids must be a list.");
    if (body.product_ids.length > 10000) throw new ObxError("limit_exceeded", "At most 10000 products per download.");
    productIds = [...new Set(body.product_ids as string[])];
  } else {
    const f = (body.filter ?? {}) as Record<string, unknown>;
    const arr = (x: unknown) => (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string") : undefined);
    filter = {
      q: typeof f.q === "string" ? f.q : undefined,
      brand_id: arr(f.brand_id),
      item_type: arr(f.item_type),
      color: arr(f.color),
      season: arr(f.season),
      collection: arr(f.collection),
      target_group: arr(f.target_group),
      qualifier: arr(f.qualifier),
      updated_since: typeof f.updated_since === "string" ? (normDateTime(f.updated_since) ?? undefined) : undefined,
    };
  }
  const input: DownloadInput = {
    user_id: session.user.id,
    retailer_id: viewer.retailerId,
    viewer,
    source: source!,
    product_ids: productIds,
    filter,
    variant: variant!,
    include_data_csv: body.include_data_csv !== false && (await ctx.settings()).portal.allow_article_data_export,
    email: session.user.email,
    name: session.user.name,
    lang: session.user.language,
  };
  const job = await enqueueJob(ctx, { kind: "download", owner: `user:${session.user.id}`, input });
  return json(c, downloadJobJson(job), 202);
});

portal.get("/admin/api/portal/download-jobs/:id", async (c) => {
  const { session } = await viewerOf(c);
  return json(c, downloadJobJson(await ownJob(c, session.user.id)));
});

portal.get("/admin/api/portal/download-jobs/:id/file", async (c) => {
  const { viewer, session } = await viewerOf(c);
  const ctx = ctxOf(c);
  const job = await ownJob(c, session.user.id);
  if (job.status === "expired" || (job.expires_at && Date.parse(job.expires_at) < ctx.now())) throw new ObxError("export_expired", "This download has expired (files are kept 7 days). Start it again.");
  if (job.status !== "succeeded") throw new ObxError("not_found", "The download is not ready yet.");
  const r = safeJsonParse<{ bytes: number; files: number; sha256: string }>(job.result, { bytes: 0, files: 0, sha256: "" });
  const input = safeJsonParse<DownloadInput>(job.input, {} as DownloadInput);
  const res = await serveStored(ctx, c.req.raw, {
    key: `jobs/${job.id}/download.zip`,
    size: r.bytes,
    contentType: "application/zip",
    filename: `download_${input.variant}_${job.created_at.slice(0, 10)}.zip`,
    disposition: "attachment",
    sha256: r.sha256 || null,
  });
  const range = c.req.header("range");
  if (res.status === 200 && (!range || /^bytes=0-/.test(range))) logDownload(ctx, { kind: "bulk_zip", viewer, variant: input.variant, files: r.files, bytes: r.bytes });
  return res;
});

// ------------------------------------------------------------------ retailer's own API keys

async function selfService(c: C): Promise<{ retailer: RetailerRow }> {
  const { viewer, session } = await viewerOf(c);
  const s = await ctxOf(c).settings();
  if (viewer.kind !== "user" || !session.retailer) throw new ObxError("forbidden", "Only retailer accounts have their own API keys.");
  if (!s.portal.retailer_api_self_service) throw new ObxError("forbidden", "The brand does not offer self-service API keys. Ask the brand for one.");
  return { retailer: session.retailer };
}

portal.get("/admin/api/portal/api-clients", async (c) => {
  const { viewer, session } = await viewerOf(c);
  if (viewer.kind !== "user" || !session.retailer) throw new ObxError("forbidden", "Only retailer accounts have their own API keys.");
  const rows = await ctxOf(c).db.all<ClientRow>("SELECT * FROM api_clients WHERE retailer_id = ? AND status = 'active' ORDER BY created_at", [session.retailer.id]);
  return json(c, { items: rows.map(clientJson) });
});

portal.post("/admin/api/portal/api-clients", async (c) => {
  const { retailer } = await selfService(c);
  const ctx = ctxOf(c);
  const body = await readObject(c);
  const v = new V();
  const name = v.str(body.name, "/name", { required: true, min: 1, max: 200 });
  if (!v.ok) throw new ObxError("validation_failed", "Give the API key a name.", v.errors);
  const g = await grantOf(ctx, retailer, null);
  let scopes = g.scopes;
  if (Array.isArray(body.scopes)) scopes = (body.scopes as string[]).filter((s) => g.scopes.includes(s));
  if (!scopes.length) throw new ObxError("validation_failed", "Choose at least one allowed scope.");
  const n = await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM api_clients WHERE retailer_id = ? AND status = 'active'", [retailer.id]);
  if ((n?.n ?? 0) >= 5) throw new ObxError("conflict", "You already have 5 API keys. Revoke one first.");
  const { row, secret } = await createClient(ctx, retailer, name!, scopes, "retailer");
  return json(c, await clientWithSecret(ctx, row, secret), 201);
});

portal.post("/admin/api/portal/api-clients/:id/rotate", async (c) => {
  const { retailer } = await selfService(c);
  const ctx = ctxOf(c);
  const cl = await ctx.db.first<ClientRow>("SELECT * FROM api_clients WHERE id = ? AND retailer_id = ? AND status = 'active'", [idParam(c), retailer.id]);
  if (!cl) throw new ObxError("not_found", "Unknown API key.");
  const { row, secret } = await rotateClient(ctx, cl);
  return json(c, await clientWithSecret(ctx, row, secret));
});

portal.delete("/admin/api/portal/api-clients/:id", async (c) => {
  const { viewer, session } = await viewerOf(c);
  if (viewer.kind !== "user" || !session.retailer) throw new ObxError("forbidden", "Only retailer accounts have their own API keys.");
  const ctx = ctxOf(c);
  const r = await ctx.db.run("UPDATE api_clients SET status = 'revoked' WHERE id = ? AND retailer_id = ? AND status = 'active'", [idParam(c), session.retailer.id]);
  if (!r.changes) throw new ObxError("not_found", "Unknown API key.");
  return noContent(c);
});
