// Download log and statistics for the brand (never IP addresses; organisation-level).
import type { Ctx } from "./ctx";
import type { Viewer } from "./auth";
import { newId } from "../lib/util";

export type DownloadKind = "image" | "product_zip" | "selection_zip" | "bulk_zip" | "csv" | "api_rendition" | "api_export" | "usage";

export interface DownloadEventInput {
  kind: DownloadKind;
  viewer: Viewer;
  variant?: string | null;
  productId?: string | null;
  assetId?: string | null;
  usageEvent?: string | null;
  files?: number;
  bytes?: number | null;
  at?: string;
}

export function downloadStmt(ctx: Ctx, e: DownloadEventInput) {
  return {
    sql: "INSERT INTO download_events (id, at, kind, retailer_id, retailer_name, actor_type, actor_name, variant, product_id, asset_id, usage_event, files, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    params: [
      newId("dle"),
      e.at ?? ctx.iso(),
      e.kind,
      e.viewer.retailerId,
      e.viewer.retailerName,
      e.viewer.kind === "client" ? "api_client" : "user",
      e.viewer.actorName,
      e.variant ?? null,
      e.productId ?? null,
      e.assetId ?? null,
      e.usageEvent ?? null,
      e.files ?? 0,
      e.bytes ?? null,
    ],
  };
}

/** Logs a download unless it is an admin preview. Runs after the response. */
export function logDownload(ctx: Ctx, e: DownloadEventInput) {
  if (e.viewer.kind === "preview") return;
  ctx.p.defer(ctx.db.batch([downloadStmt(ctx, e)]).catch((err) => ctx.log("warn", "download log failed", { error: String(err) })));
}

export async function stats(ctx: Ctx, days: number) {
  const since = ctx.iso(-days * 24 * 3600 * 1000);
  const t = await ctx.db.first<Record<string, number>>(
    `SELECT
       SUM(CASE WHEN kind != 'usage' THEN 1 ELSE 0 END) AS downloads,
       SUM(CASE WHEN kind NOT IN ('usage', 'csv') THEN files ELSE 0 END) AS images,
       SUM(CASE WHEN kind IN ('product_zip', 'selection_zip', 'bulk_zip') THEN 1 ELSE 0 END) AS zips,
       SUM(CASE WHEN kind = 'csv' THEN 1 ELSE 0 END) AS csv_exports,
       SUM(CASE WHEN kind IN ('api_rendition', 'api_export') THEN 1 ELSE 0 END) AS api_downloads,
       SUM(CASE WHEN kind = 'usage' THEN files ELSE 0 END) AS usage_events,
       COUNT(DISTINCT CASE WHEN kind != 'usage' THEN retailer_id END) AS active_retailers
     FROM download_events WHERE at >= ?`,
    [since],
  );
  const byDay = await ctx.db.all<{ date: string; downloads: number; images: number }>(
    `SELECT substr(at, 1, 10) AS date, SUM(CASE WHEN kind != 'usage' THEN 1 ELSE 0 END) AS downloads, SUM(CASE WHEN kind NOT IN ('usage', 'csv') THEN files ELSE 0 END) AS images
     FROM download_events WHERE at >= ? GROUP BY substr(at, 1, 10) ORDER BY date`,
    [since],
  );
  const topRetailers = await ctx.db.all<{ retailer_id: string; name: string; downloads: number; images: number; last_activity_at: string | null }>(
    `SELECT retailer_id, MAX(retailer_name) AS name, SUM(CASE WHEN kind != 'usage' THEN 1 ELSE 0 END) AS downloads, SUM(CASE WHEN kind NOT IN ('usage', 'csv') THEN files ELSE 0 END) AS images, MAX(at) AS last_activity_at
     FROM download_events WHERE at >= ? AND retailer_id IS NOT NULL GROUP BY retailer_id ORDER BY downloads DESC LIMIT 20`,
    [since],
  );
  const topProducts = await ctx.db.all<{ product_id: string; style_number: string; stored: string | null; downloads: number }>(
    `SELECT e.product_id, COALESCE(p.style_number, '') AS style_number, p.stored, COUNT(*) AS downloads
     FROM download_events e LEFT JOIN products p ON p.id = e.product_id WHERE e.at >= ? AND e.product_id IS NOT NULL AND e.kind != 'usage'
     GROUP BY e.product_id ORDER BY downloads DESC LIMIT 20`,
    [since],
  );
  // fill missing days so charts have a continuous axis
  const days_: { date: string; downloads: number; images: number }[] = [];
  const m = new Map(byDay.map((d) => [d.date, d]));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(ctx.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    days_.push(m.get(d) ?? { date: d, downloads: 0, images: 0 });
  }
  return {
    days,
    totals: {
      downloads: t?.downloads ?? 0,
      images: t?.images ?? 0,
      zips: t?.zips ?? 0,
      csv_exports: t?.csv_exports ?? 0,
      api_downloads: t?.api_downloads ?? 0,
      usage_events: t?.usage_events ?? 0,
      active_retailers: t?.active_retailers ?? 0,
    },
    by_day: days_,
    top_retailers: topRetailers.map((r) => ({ ...r, name: r.name ?? "" })),
    top_products: topProducts.map((p) => ({
      product_id: p.product_id,
      style_number: p.style_number,
      name: p.stored ? (JSON.parse(p.stored).name ?? { en: p.style_number }) : { en: p.style_number || "?" },
      downloads: p.downloads,
    })),
  };
}
