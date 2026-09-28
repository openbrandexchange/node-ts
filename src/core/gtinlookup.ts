// GTIN lookup (protocol.md §7): lenient normalisation, one result per distinct input, products once.
import type { Ctx } from "./ctx";
import type { Viewer } from "./auth";
import { normaliseLookupGtin } from "../lib/gtin";
import { placeholders, productDetails, productVisibleSql } from "./read";

export async function gtinLookup(ctx: Ctx, viewer: Viewer, inputs: string[], base: string) {
  const results: { input: string; gtin: string | null; status: "matched" | "unmatched" | "invalid"; product_id: string | null; variant_id: string | null }[] = [];
  const seen = new Set<string>();
  const want: string[] = [];
  for (const raw of inputs) {
    const input = String(raw).trim().slice(0, 64);
    const g = normaliseLookupGtin(input);
    const key = g ?? `invalid:${input}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ input, gtin: g, status: g ? "unmatched" : "invalid", product_id: null, variant_id: null });
    if (g) want.push(g);
  }
  const pv = productVisibleSql(viewer);
  const found = new Map<string, { id: string; product_id: string }>();
  for (let i = 0; i < want.length; i += 200) {
    const chunk = want.slice(i, i + 200);
    const rows = await ctx.db.all<{ id: string; product_id: string; gtin14: string }>(
      `SELECT v.id, v.product_id, v.gtin14 FROM variants v JOIN products p ON p.id = v.product_id JOIN brands b ON b.id = p.brand_id
       WHERE v.gtin14 IN (${placeholders(chunk.length)}) AND v.status = 'published' AND ${pv.sql}`,
      [...chunk, ...pv.params],
    );
    for (const r of rows) found.set(r.gtin14, r);
  }
  const productOrder: string[] = [];
  for (const r of results) {
    if (!r.gtin) continue;
    const f = found.get(r.gtin);
    if (!f) continue;
    r.status = "matched";
    r.product_id = f.product_id;
    r.variant_id = f.id;
    if (!productOrder.includes(f.product_id)) productOrder.push(f.product_id);
  }
  const settings = await ctx.settings();
  const products: Record<string, unknown>[] = [];
  for (let i = 0; i < productOrder.length; i += 50) products.push(...(await productDetails(ctx, viewer, productOrder.slice(i, i + 50), { base, settings })));
  return { results, products };
}
