// Article data as CSV: the canonical import columns plus image_files, so an export can be re-imported.
import type { Ctx } from "./ctx";
import type { Viewer } from "./auth";
import { writeCsv } from "../lib/csv";
import { formatMaterials } from "./importformat";
import { assetVisibleSql, placeholders, productVisibleSql, type AssetRow, type ProductRow, type VariantRow } from "./read";
import { safeJsonParse } from "../lib/util";
import { assetCore, assetFilename, type Files } from "./reps";

export async function articleCsv(ctx: Ctx, viewer: Viewer, productIds: string[], delimiter: string): Promise<{ csv: string; rows: number }> {
  const settings = await ctx.settings();
  const langs = settings.portal.languages.length ? settings.portal.languages : ["en"];
  const rows: unknown[][] = [];
  const products: ProductRow[] = [];
  const pv = productVisibleSql(viewer);
  for (let i = 0; i < productIds.length; i += 200) {
    const chunk = productIds.slice(i, i + 200);
    products.push(...(await ctx.db.all<ProductRow>(`SELECT p.* FROM products p JOIN brands b ON b.id = p.brand_id WHERE p.id IN (${placeholders(chunk.length)}) AND ${pv.sql}`, [...chunk, ...pv.params])));
  }
  const order = new Map(productIds.map((id, i) => [id, i]));
  products.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const brands = new Map<string, string>();
  for (const b of await ctx.db.all<{ id: string; stored: string }>("SELECT id, stored FROM brands")) brands.set(b.id, String(safeJsonParse<Record<string, unknown>>(b.stored, {}).name ?? ""));
  const attrKeys = new Set<string>();
  const parsed = products.map((p) => {
    const s = safeJsonParse<Record<string, unknown>>(p.stored, {});
    for (const k of Object.keys((s.attributes as Record<string, unknown>) ?? {})) attrKeys.add(k);
    return { p, s };
  });
  const attrs = [...attrKeys].sort();
  rows.push([
    "brand",
    "product_id",
    "style_number",
    ...langs.map((l) => `name:${l}`),
    ...langs.map((l) => `description:${l}`),
    "item_type",
    "target_group",
    "season",
    "collection",
    "gpc_brick",
    "materials",
    "care",
    "country_of_origin",
    "dpp_url",
    "status",
    ...attrs.map((a) => `attr:${a}`),
    "variant_id",
    "gtin",
    "sku",
    "color_code",
    ...langs.map((l) => `color_name:${l}`),
    "supplier_color",
    "size",
    "size_system",
    "variant_status",
    "image_files",
  ]);
  for (let i = 0; i < parsed.length; i += 200) {
    const chunk = parsed.slice(i, i + 200);
    const ids = chunk.map((x) => x.p.id);
    const variants = await ctx.db.all<VariantRow>(`SELECT * FROM variants WHERE product_id IN (${placeholders(ids.length)}) AND status = 'published' ORDER BY product_id, external_id`, ids);
    const assets = await ctx.db.all<AssetRow>(
      `SELECT * FROM assets a WHERE a.product_id IN (${placeholders(ids.length)}) AND ${assetVisibleSql()} ORDER BY a.product_id, CASE WHEN a.color_code IS NULL THEN 0 ELSE 1 END, a.color_code, a.position`,
      [...ids, ctx.iso()],
    );
    for (const { p, s } of chunk) {
      const name = (s.name as Record<string, string>) ?? {};
      const desc = (s.description as Record<string, string>) ?? {};
      const at = (s.attributes as Record<string, unknown>) ?? {};
      const base = [
        brands.get(p.brand_id) ?? "",
        p.external_id,
        s.style_number,
        ...langs.map((l) => name[l] ?? ""),
        ...langs.map((l) => desc[l] ?? ""),
        s.item_type ?? "",
        s.target_group ?? "",
        s.season ?? "",
        s.collection ?? "",
        s.gpc_brick ?? "",
        formatMaterials(s.materials as never),
        ((s.care as { code: string }[]) ?? []).map((c) => c.code).join("|"),
        s.country_of_origin ?? "",
        s.dpp_url ?? "",
        p.status,
        ...attrs.map((a) => (at[a] === undefined ? "" : typeof at[a] === "object" ? JSON.stringify(at[a]) : String(at[a]))),
      ];
      const pAssets = assets.filter((a) => a.product_id === p.id);
      const filesFor = (color: string | null) =>
        pAssets
          .filter((a) => color === null || a.color_code === null || a.color_code === color)
          .map((a) => assetFilename(a.external_id, safeJsonParse(a.stored, {}), safeJsonParse<Files>(a.files, {})))
          .join("|");
      const pv2 = variants.filter((v) => v.product_id === p.id);
      if (!pv2.length) {
        rows.push([...base, "", "", "", "", ...langs.map(() => ""), "", "", "", "", filesFor(null)]);
        continue;
      }
      for (const v of pv2) {
        const vs = safeJsonParse<Record<string, unknown>>(v.stored, {});
        const color = (vs.color as { code: string; name?: Record<string, string>; supplier_color?: string }) ?? { code: "" };
        rows.push([
          ...base,
          v.external_id,
          vs.gtin_original ?? "",
          vs.sku ?? "",
          color.code,
          ...langs.map((l) => color.name?.[l] ?? ""),
          color.supplier_color ?? "",
          vs.size ?? "",
          vs.size_system ?? "",
          v.status,
          filesFor(color.code),
        ]);
      }
    }
  }
  return { csv: writeCsv(rows, delimiter), rows: rows.length - 1 };
}

// ------------------------------------------------------------------ assets.csv in portal downloads

/** Columns of the assets.csv in a portal download (spec import-format.md §2.3). */
export function downloadAssetsHeader(langs: string[]): string[] {
  return [
    "file", "style_number", "color_code", "position", "role", "view",
    ...langs.map((l) => `alt_text:${l}`),
    "license", "license_text", "channels", "territories", "embargo_until", "expires_at", "credit",
    "model_release", "ai_generated", "ai_edited", "source", "c2pa", "generator",
  ];
}

/** One row: the image's file name in the zip and its effective rights, embargo and AI provenance. */
export function downloadAssetsRow(file: string, styleNumber: string, rep: Record<string, unknown>, langs: string[]): unknown[] {
  const r = (rep.rights ?? {}) as Record<string, unknown>;
  const p = { ai_generated: false, ai_edited: false, source: "photo", c2pa: "none", generator: null, ...((rep.provenance ?? {}) as Record<string, unknown>) };
  const alt = (rep.alt_text ?? {}) as Record<string, string>;
  const list = (v: unknown) => (Array.isArray(v) ? v.join("|") : "");
  const bool = (v: unknown) => (v === null || v === undefined ? "" : v ? "true" : "false");
  return [
    file, styleNumber, rep.color_code ?? "", rep.position ?? "", rep.role ?? "", rep.view ?? "",
    ...langs.map((l) => alt[l] ?? ""),
    r.license ?? "", r.license_text ?? "", list(r.channels), list(r.territories), r.embargo_until ?? "", r.expires_at ?? "", r.credit ?? "",
    bool(r.model_release), bool(p.ai_generated), bool(p.ai_edited), p.source ?? "", p.c2pa ?? "", p.generator ?? "",
  ];
}

/** The whole assets.csv for the images of a streamed zip (formula-escaped, no BOM). */
export async function downloadAssetsCsv(ctx: Ctx, images: { file: string; styleNumber: string; row: AssetRow }[]): Promise<Uint8Array> {
  const settings = await ctx.settings();
  const reps = images.map((im) => ({ ...im, rep: assetCore(im.row, settings, null) }));
  const langSet = new Set<string>();
  for (const im of reps) for (const l of Object.keys((im.rep.alt_text as Record<string, string> | null) ?? {})) langSet.add(l);
  const langs = [...langSet].sort();
  const rows: unknown[][] = [downloadAssetsHeader(langs), ...reps.map((im) => downloadAssetsRow(im.file, im.styleNumber, im.rep, langs))];
  return new TextEncoder().encode(writeCsv(rows, ",", false));
}
