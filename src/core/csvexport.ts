// Article data as CSV: the canonical import columns plus image_files, so an export can be re-imported.
import type { Ctx } from "./ctx";
import type { Viewer } from "./auth";
import { writeCsv } from "../lib/csv";
import { formatMaterials } from "./importformat";
import { assetVisibleSql, placeholders, productVisibleSql, type AssetRow, type ProductRow, type VariantRow } from "./read";
import { safeJsonParse } from "../lib/util";
import { assetFilename, type Files } from "./reps";

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
