// Read side: visibility (protocol.md §5.8) for a viewer, ProductDetail assembly and signed rendition URLs.
import type { Ctx, SettingsData } from "./ctx";
import type { SqlValue } from "../platform";
import type { Viewer } from "./auth";
import { assetCore, brandRep, productRep, renditionMeta, variantRep, type AssetRowLike, type Files } from "./reps";
import { isoNow, safeJsonParse } from "../lib/util";
import type { RenditionName } from "./validate";

export interface BrandRow {
  id: string;
  external_id: string;
  status: string;
  stored: string;
  updated_at: string;
  created_at: string;
  modified_at: string;
}
export interface ProductRow {
  id: string;
  external_id: string;
  brand_id: string;
  style_number: string;
  status: string;
  stored: string;
  item_type: string | null;
  target_group: string | null;
  season: string | null;
  collection: string | null;
  created_at: string;
  updated_at: string;
  content_updated_at: string;
  modified_at: string;
}
export interface VariantRow {
  id: string;
  external_id: string;
  product_id: string;
  brand_id: string;
  status: string;
  gtin14: string | null;
  color_code: string | null;
  stored: string;
  updated_at: string;
}
export interface AssetRow extends AssetRowLike {
  status: string;
  color_code: string | null;
  position: number;
  has_original: number;
  missing_renditions: number;
  expires_at: string | null;
  staged: string | null;
  created_at: string;
  modified_at: string;
}

/** SQL for "brand b is visible to viewer v". */
export function brandVisibleSql(v: Viewer | null, alias = "b"): { sql: string; params: SqlValue[] } {
  if (!v || v.brandIds === null) return { sql: `${alias}.status = 'published'`, params: [] };
  if (!v.brandIds.length) return { sql: "0", params: [] };
  return { sql: `${alias}.status = 'published' AND ${alias}.id IN (${v.brandIds.map(() => "?").join(",")})`, params: v.brandIds };
}

export function productVisibleSql(v: Viewer | null, p = "p", b = "b"): { sql: string; params: SqlValue[] } {
  const bs = brandVisibleSql(v, b);
  return { sql: `${p}.status = 'published' AND ${bs.sql}`, params: bs.params };
}

export const assetVisibleSql = (a = "a") => `${a}.status = 'published' AND ${a}.has_original = 1 AND (${a}.expires_at IS NULL OR ${a}.expires_at > ?)`;

export function placeholders(n: number) {
  return Array(n).fill("?").join(",");
}

// ------------------------------------------------------------------ signed URLs

/** Expiry rounded to 30-minute buckets so URLs stay stable (cacheable) for a while; lifetime 60-90 min. */
export function signedExpiry(nowMs: number): number {
  const b = 1800;
  return Math.ceil((Math.floor(nowMs / 1000) + 3600) / b) * b;
}

export async function signPath(ctx: Ctx, path: string, actor: string, exp: number): Promise<string> {
  const sig = await ctx.keys.sign("url", `GET\n${path}\n${exp}\n${actor}`);
  return `${path}?exp=${exp}&a=${encodeURIComponent(actor)}&sig=${sig}`;
}

export async function verifySignedPath(ctx: Ctx, path: string, q: { exp?: string; a?: string; sig?: string }): Promise<{ actor: string } | "expired" | null> {
  if (!q.exp || !q.a || !q.sig || !/^\d+$/.test(q.exp)) return null;
  const ok = await ctx.keys.verify("url", `GET\n${path}\n${q.exp}\n${q.a}`, q.sig);
  if (!ok) return null;
  if (Number(q.exp) * 1000 < ctx.now()) return "expired";
  return { actor: q.a };
}

export async function renditionUrl(ctx: Ctx, base: string, assetId: string, name: RenditionName, actor: string, exp: number) {
  return base + (await signPath(ctx, `/obx/v1/assets/${assetId}/renditions/${name}`, actor, exp));
}

// ------------------------------------------------------------------ representations for a viewer

export async function assetForViewer(
  ctx: Ctx,
  row: AssetRow | AssetRowLike,
  settings: SettingsData,
  viewer: Viewer,
  variantIds: string[] | null,
  base: string,
  opts: { allRenditions?: boolean } = {},
): Promise<Record<string, unknown>> {
  const core = assetCore(row, settings, variantIds);
  const files = safeJsonParse<Files>(row.files, {});
  const meta = renditionMeta(files);
  const exp = signedExpiry(ctx.now());
  const renditions: Record<string, unknown> = {};
  const names: RenditionName[] = viewer.original || opts.allRenditions ? ["original", "web", "square", "thumb"] : ["web", "square", "thumb"];
  for (const n of names) {
    const m = meta[n];
    if (!m) continue;
    renditions[n] = {
      name: n,
      url: await renditionUrl(ctx, base, row.id, n, viewer.actor, exp),
      url_expires_at: isoNow(exp * 1000),
      content_type: m.content_type,
      width: m.width,
      height: m.height,
      bytes: m.bytes,
      sha256: m.sha256,
      ...(m.fallback ? { "x-obx-fallback": true } : {}),
    };
  }
  return { ...core, renditions };
}

export interface DetailOptions {
  base: string;
  settings: SettingsData;
}

/** ProductDetail for visible products among `ids` (input order kept). */
export async function productDetails(ctx: Ctx, viewer: Viewer, ids: string[], o: DetailOptions): Promise<Record<string, unknown>[]> {
  if (!ids.length) return [];
  const pv = productVisibleSql(viewer);
  const products = await ctx.db.all<ProductRow>(
    `SELECT p.* FROM products p JOIN brands b ON b.id = p.brand_id WHERE p.id IN (${placeholders(ids.length)}) AND ${pv.sql}`,
    [...ids, ...pv.params],
  );
  if (!products.length) return [];
  const pids = products.map((p) => p.id);
  const variants = await ctx.db.all<VariantRow>(`SELECT * FROM variants WHERE product_id IN (${placeholders(pids.length)}) AND status = 'published' ORDER BY product_id, external_id`, pids);
  const assets = await ctx.db.all<AssetRow>(
    `SELECT * FROM assets a WHERE a.product_id IN (${placeholders(pids.length)}) AND ${assetVisibleSql()} ORDER BY a.product_id, CASE WHEN a.color_code IS NULL THEN 0 ELSE 1 END, a.color_code, a.position`,
    [...pids, ctx.iso()],
  );
  const vByProduct = new Map<string, VariantRow[]>();
  for (const v of variants) {
    const l = vByProduct.get(v.product_id) ?? [];
    l.push(v);
    vByProduct.set(v.product_id, l);
  }
  const aByProduct = new Map<string, AssetRow[]>();
  for (const a of assets) {
    const l = aByProduct.get(a.product_id) ?? [];
    l.push(a);
    aByProduct.set(a.product_id, l);
  }
  const byId = new Map<string, Record<string, unknown>>();
  for (const p of products) {
    const vs = (vByProduct.get(p.id) ?? []).sort((a, b) => (a.external_id < b.external_id ? -1 : a.external_id > b.external_id ? 1 : 0));
    const extToId = new Map(vs.map((v) => [v.external_id, v.id]));
    const as: Record<string, unknown>[] = [];
    for (const a of aByProduct.get(p.id) ?? []) {
      const s = safeJsonParse<Record<string, unknown>>(a.stored, {});
      const vids = Array.isArray(s.variant_external_ids) ? (s.variant_external_ids as string[]).map((e) => extToId.get(e)).filter((x): x is string => !!x) : null;
      as.push(await assetForViewer(ctx, a, o.settings, viewer, vids, o.base));
    }
    byId.set(p.id, { ...productRep(p), variants: vs.map(variantRep), assets: as });
  }
  return ids.map((id) => byId.get(id)).filter((x): x is Record<string, unknown> => !!x);
}

export async function visibleBrands(ctx: Ctx, viewer: Viewer | null): Promise<Record<string, unknown>[]> {
  const bv = brandVisibleSql(viewer);
  const rows = await ctx.db.all<BrandRow>(`SELECT * FROM brands b WHERE ${bv.sql} ORDER BY b.id`, bv.params);
  return rows.map(brandRep);
}

/** One asset if visible to the viewer (admins in preview see every asset with files). */
export async function loadAssetForViewer(ctx: Ctx, viewer: Viewer, id: string): Promise<AssetRow | null> {
  if (viewer.kind === "preview") return ctx.db.first<AssetRow>("SELECT * FROM assets WHERE id = ?", [id]);
  const pv = productVisibleSql(viewer);
  return ctx.db.first<AssetRow>(
    `SELECT a.* FROM assets a JOIN products p ON p.id = a.product_id JOIN brands b ON b.id = p.brand_id WHERE a.id = ? AND ${assetVisibleSql()} AND ${pv.sql}`,
    [id, ctx.iso(), ...pv.params],
  );
}

export async function assetVariantIds(ctx: Ctx, a: AssetRow): Promise<string[] | null> {
  const s = safeJsonParse<Record<string, unknown>>(a.stored, {});
  if (!Array.isArray(s.variant_external_ids)) return null;
  const exts = s.variant_external_ids as string[];
  if (!exts.length) return [];
  const rows = await ctx.db.all<{ id: string; external_id: string }>(
    `SELECT id, external_id FROM variants WHERE product_id = ? AND status = 'published' AND external_id IN (${placeholders(exts.length)})`,
    [a.product_id, ...exts],
  );
  const m = new Map(rows.map((r) => [r.external_id, r.id]));
  return exts.map((e) => m.get(e)).filter((x): x is string => !!x);
}
