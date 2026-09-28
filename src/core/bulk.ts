// Background zips: portal download jobs (one zip) and protocol exports (manifest + zip parts).
import type { Ctx } from "./ctx";
import type { Viewer } from "./auth";
import { registerJob, jobItemStmt, jobItems, type JobRow, type StepOutcome } from "./jobs";
import { ZipWriter, newZipState, type ZipWriterState } from "./zipwriter";
import { assetVisibleSql, placeholders, productVisibleSql, productDetails, visibleBrands, type AssetRow, type ProductRow } from "./read";
import { renditionFilename, renditionMeta, assetFilename, type Files } from "./reps";
import { safeJsonParse, sanitizeFilename, isoNow } from "../lib/util";
import { crc32 } from "../lib/crypto";
import { articleCsv } from "./csvexport";
import { liveCursorAt, maxSeq } from "./changes";
import { sendEmail } from "./mail";
import { emitClientEvent } from "./notify";
import type { Stmt } from "../platform";
import type { RenditionName } from "./validate";

export interface PortalFilter {
  q?: string;
  brand_id?: string[];
  item_type?: string[];
  color?: string[];
  season?: string[];
  collection?: string[];
  target_group?: string[];
  updated_since?: string;
}

/** SQL WHERE for the portal filters (products p joined with brands b), excluding one facet if asked. */
export function filterSql(f: PortalFilter, viewer: Viewer, nowIso: string, exclude?: keyof PortalFilter): { sql: string; params: (string | number)[] } {
  const pv = productVisibleSql(viewer);
  const parts = [pv.sql];
  const params: (string | number)[] = [...(pv.params as string[])];
  const inList = (col: string, vals: string[] | undefined, key: keyof PortalFilter) => {
    if (!vals?.length || exclude === key) return;
    parts.push(`${col} IN (${placeholders(vals.length)})`);
    params.push(...vals);
  };
  inList("p.brand_id", f.brand_id, "brand_id");
  inList("p.item_type", f.item_type, "item_type");
  inList("p.season", f.season, "season");
  inList("p.collection", f.collection, "collection");
  inList("p.target_group", f.target_group, "target_group");
  if (f.color?.length && exclude !== "color") {
    parts.push(`EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.status = 'published' AND v.color_code IN (${placeholders(f.color.length)}))`);
    params.push(...f.color);
  }
  if (f.q && f.q.trim()) {
    const q = f.q.trim().toLowerCase().replace(/[%_\\]/g, (m) => "\\" + m);
    const digits = f.q.replace(/\s+/g, "");
    if (/^\d{8,14}$/.test(digits)) {
      parts.push("(p.search_text LIKE ? ESCAPE '\\' OR p.search_text LIKE ? ESCAPE '\\')");
      params.push(`%${q}%`, `%${digits.padStart(14, "0")}%`);
    } else {
      parts.push("p.search_text LIKE ? ESCAPE '\\'");
      params.push(`%${q}%`);
    }
  }
  if (f.updated_since) {
    parts.push("p.content_updated_at >= ?");
    params.push(f.updated_since);
  }
  void nowIso;
  return { sql: parts.join(" AND "), params };
}

export function pickFile(files: Files, variant: "original" | "web" | "square" | "thumb"): { name: RenditionName; ref: NonNullable<Files["original"]>; fallback: boolean } | null {
  const meta = renditionMeta(files);
  const m = meta[variant];
  if (!m) return null;
  return { name: variant, ref: m, fallback: m.fallback };
}

export function zipEntryName(filename: string, variant: RenditionName, fallback: boolean) {
  return sanitizeFilename(renditionFilename(filename, variant, fallback));
}

// ------------------------------------------------------------------ portal download jobs

export interface DownloadInput {
  user_id: string;
  retailer_id: string | null;
  viewer: Viewer;
  source: "selection" | "products" | "filter";
  product_ids: string[] | null;
  filter: PortalFilter | null;
  variant: "original" | "web" | "square";
  include_data_csv: boolean;
  email: string | null;
  name: string | null;
  lang: string;
}

interface DownloadState {
  phase: "plan" | "zip" | "finish";
  planOffset: number;
  fileCount: number;
  fi: number;
  zip: ZipWriterState | null;
  csv: { key: string; size: number; crc: number } | null;
}

async function planProducts(ctx: Ctx, input: DownloadInput, afterIdx: number, limit: number): Promise<string[]> {
  if (input.source !== "filter") return (input.product_ids ?? []).slice(afterIdx, afterIdx + limit);
  const f = filterSql(input.filter ?? {}, input.viewer, ctx.iso());
  const rows = await ctx.db.all<{ id: string }>(`SELECT p.id FROM products p JOIN brands b ON b.id = p.brand_id WHERE ${f.sql} ORDER BY p.style_number, p.id LIMIT ? OFFSET ?`, [...f.params, limit, afterIdx]);
  return rows.map((r) => r.id);
}

async function downloadStep(ctx: Ctx, job: JobRow, deadline: number): Promise<StepOutcome> {
  const input = safeJsonParse<DownloadInput>(job.input, {} as DownloadInput);
  const st = safeJsonParse<DownloadState>(job.state, { phase: "plan", planOffset: 0, fileCount: 0, fi: 0, zip: null, csv: null });
  if (!st.phase) Object.assign(st, { phase: "plan", planOffset: 0, fileCount: 0, fi: 0, zip: null, csv: null });
  while (ctx.now() < deadline) {
    if (st.phase === "plan") {
      const ids = await planProducts(ctx, input, st.planOffset, 100);
      if (!ids.length) {
        if (input.include_data_csv) {
          const all: string[] = [];
          for (let off = 0; ; off += 500) {
            const more = await jobItems<string>(ctx, job.id, "p", off, 500);
            if (!more.length) break;
            all.push(...more.map((m) => m.item));
            if (more.length < 500) break;
          }
          const { csv } = await articleCsv(ctx, input.viewer, all, input.lang === "nl" ? ";" : ",");
          const bytes = new TextEncoder().encode(csv);
          const key = `jobs/${job.id}/products.csv`;
          await ctx.blobs.put(key, bytes, "text/csv");
          st.csv = { key, size: bytes.length, crc: crc32(bytes) };
        }
        st.phase = "zip";
        st.zip = newZipState(`jobs/${job.id}/download.zip`);
        continue;
      }
      const stmts: Stmt[] = ids.map((id, i) => jobItemStmt(job.id, "p", st.planOffset + i + 1, id));
      const pv = productVisibleSql(input.viewer);
      const prods = await ctx.db.all<ProductRow>(`SELECT p.* FROM products p JOIN brands b ON b.id = p.brand_id WHERE p.id IN (${placeholders(ids.length)}) AND ${pv.sql}`, [...ids, ...pv.params]);
      const assets = await ctx.db.all<AssetRow>(
        `SELECT * FROM assets a WHERE a.product_id IN (${placeholders(ids.length)}) AND ${assetVisibleSql()} ORDER BY a.product_id, CASE WHEN a.color_code IS NULL THEN 0 ELSE 1 END, a.color_code, a.position`,
        [...ids, ctx.iso()],
      );
      const byId = new Map(prods.map((p) => [p.id, p]));
      for (const a of assets) {
        const p = byId.get(a.product_id);
        if (!p) continue;
        const files = safeJsonParse<Files>(a.files, {});
        const pick = pickFile(files, input.variant);
        if (!pick) continue;
        const fname = assetFilename(a.external_id, safeJsonParse(a.stored, {}), files);
        const path = `${sanitizeFilename(p.style_number)}/${zipEntryName(fname, input.variant, pick.fallback)}`;
        stmts.push(jobItemStmt(job.id, "f", ++st.fileCount, { path, sha256: pick.ref.sha256, size: pick.ref.bytes, crc: pick.ref.crc32, product_id: p.id, asset_id: a.id }));
      }
      for (let i = 0; i < stmts.length; i += 200) await ctx.db.batch(stmts.slice(i, i + 200));
      st.planOffset += ids.length;
      continue;
    }
    if (st.phase === "zip") {
      const w = new ZipWriter(ctx, job.id, st.zip!, "zcd");
      await w.resume();
      const used = new Set<string>();
      let stop = false;
      while (!stop) {
        const items = await jobItems<{ path: string; sha256: string; size: number; crc: number }>(ctx, job.id, "f", st.fi, 50);
        if (!items.length) break;
        for (const it of items) {
          if (ctx.now() >= deadline) {
            stop = true;
            break;
          }
          let path = it.item.path;
          if (used.has(path.toLowerCase())) path = path.replace(/(\.[^./]+)$/, ` (${it.idx})$1`);
          used.add(path.toLowerCase());
          await w.add(path, it.item.size, it.item.crc, { sha256: it.item.sha256 });
          st.fi = it.idx;
        }
      }
      if (stop) {
        await w.checkpoint();
        return { done: false, state: st, progressDone: st.fi, progressTotal: st.fileCount };
      }
      if (st.csv) {
        const bytes = (await ctx.blobs.getRange(st.csv.key, 0, st.csv.size))!;
        await w.add("products.csv", st.csv.size, st.csv.crc, { bytes });
      }
      const r = await w.finish();
      return {
        done: true,
        state: st,
        progressDone: st.fileCount,
        progressTotal: st.fileCount,
        result: { bytes: r.bytes, files: st.fileCount, sha256: r.sha256 },
        expiresAt: ctx.iso(7 * 24 * 3600 * 1000),
      };
    }
  }
  return { done: false, state: st, progressDone: st.phase === "zip" ? st.fi : 0, progressTotal: st.phase === "zip" ? st.fileCount : null };
}

export function downloadJobJson(job: JobRow) {
  const input = safeJsonParse<DownloadInput>(job.input, {} as DownloadInput);
  const result = safeJsonParse<{ bytes?: number; files?: number }>(job.result, {});
  const expired = job.status === "expired" || (job.expires_at !== null && Date.parse(job.expires_at) < Date.now());
  return {
    id: job.id,
    status: expired && job.status === "succeeded" ? "expired" : job.status,
    source: input.source,
    variant: input.variant,
    include_data_csv: !!input.include_data_csv,
    created_at: job.created_at,
    finished_at: job.finished_at,
    expires_at: job.expires_at,
    progress: { done: job.progress_done, total: job.progress_total },
    file_url: job.status === "succeeded" && !expired ? `/admin/api/portal/download-jobs/${job.id}/file` : null,
    bytes: result.bytes ?? null,
    files: result.files ?? null,
    error: job.error ? (safeJsonParse<{ detail?: string }>(job.error, {}).detail ?? "failed") : null,
  };
}

registerJob("download", downloadStep, async (ctx, job) => {
  if (job.status !== "succeeded") return;
  const input = safeJsonParse<DownloadInput>(job.input, {} as DownloadInput);
  const result = safeJsonParse<{ files?: number }>(job.result, {});
  if (!input.email) return;
  await sendEmail(ctx, {
    to: input.email,
    lang: input.lang,
    template: "zip_ready",
    name: input.name,
    vars: { files: result.files ?? 0 },
    link: `${await ctx.baseUrl()}/downloads/${job.id}`,
  });
});

// ------------------------------------------------------------------ protocol exports

export interface ExportInput {
  client_row_id: string;
  retailer_id: string;
  viewer: Viewer;
  filter: { brand_ids?: string[] | null; product_ids?: string[] | null; gtins?: string[] | null; updated_since?: string | null };
  renditions: RenditionName[];
  include_data: boolean;
  base: string;
}

interface ExportState {
  phase: "plan" | "zip" | "done";
  hw: number;
  cursor: string;
  planOffset: number;
  productIds: number;
  counts: { products: number; variants: number; assets: number; files: number };
  mi: Record<string, number>;
  fileCount: number;
  fi: number;
  part: number;
  zip: ZipWriterState | null;
  parts: { number: number; bytes: number; sha256: string; files: number }[];
  partFiles: number;
}

export const EXPORT_PART_LIMIT = 2 * 1024 * 1024 * 1024 - 64 * 1024 * 1024;

async function exportProductIds(ctx: Ctx, input: ExportInput, offset: number, limit: number): Promise<string[]> {
  const pv = productVisibleSql(input.viewer);
  const parts = [pv.sql];
  const params: (string | number)[] = [...(pv.params as string[])];
  const f = input.filter ?? {};
  if (f.brand_ids?.length) {
    parts.push(`p.brand_id IN (${placeholders(f.brand_ids.length)})`);
    params.push(...f.brand_ids);
  }
  if (f.product_ids?.length) {
    parts.push(`p.id IN (${placeholders(f.product_ids.length)})`);
    params.push(...f.product_ids);
  }
  if (f.gtins?.length) {
    const g14 = f.gtins.map((g) => g.replace(/\s+/g, "").padStart(14, "0"));
    parts.push(`p.id IN (SELECT product_id FROM variants WHERE status = 'published' AND gtin14 IN (${placeholders(g14.length)}))`);
    params.push(...g14);
  }
  if (f.updated_since) {
    parts.push("p.content_updated_at >= ?");
    params.push(f.updated_since);
  }
  const rows = await ctx.db.all<{ id: string }>(`SELECT p.id FROM products p JOIN brands b ON b.id = p.brand_id WHERE ${parts.join(" AND ")} ORDER BY p.id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return rows.map((r) => r.id);
}

async function exportStep(ctx: Ctx, job: JobRow, deadline: number): Promise<StepOutcome> {
  const input = safeJsonParse<ExportInput>(job.input, {} as ExportInput);
  let st = safeJsonParse<ExportState | null>(job.state, null);
  if (!st || !st.phase) {
    const hw = await maxSeq(ctx);
    st = { phase: "plan", hw, cursor: await liveCursorAt(ctx, hw), planOffset: 0, productIds: 0, counts: { products: 0, variants: 0, assets: 0, files: 0 }, mi: {}, fileCount: 0, fi: 0, part: 1, zip: null, parts: [], partFiles: 0 };
    if (input.include_data) {
      const brands = await visibleBrands(ctx, input.viewer);
      const wanted = input.filter?.brand_ids?.length ? brands.filter((b) => input.filter.brand_ids!.includes(b.id as string)) : brands;
      const stmts = wanted.map((b, i) => jobItemStmt(job.id, "m:brand", i + 1, { type: "brand", data: b }));
      st.mi["m:brand"] = wanted.length;
      if (stmts.length) await ctx.db.batch(stmts);
    }
  }
  const settings = await ctx.settings();
  while (ctx.now() < deadline) {
    if (st.phase === "plan") {
      const ids = await exportProductIds(ctx, input, st.planOffset, 50);
      if (!ids.length) {
        st.phase = "zip";
        st.zip = newZipState(`jobs/${job.id}/part-1.zip`);
        continue;
      }
      const details = await productDetails(ctx, input.viewer, ids, { base: input.base, settings });
      const stmts: Stmt[] = [];
      const add = (kind: string, item: unknown) => {
        st!.mi[kind] = (st!.mi[kind] ?? 0) + 1;
        stmts.push(jobItemStmt(job.id, kind, st!.mi[kind], item));
      };
      for (const d of details) {
        const { variants, assets, ...product } = d as { variants: Record<string, unknown>[]; assets: Record<string, unknown>[] } & Record<string, unknown>;
        st.counts.products++;
        st.counts.variants += variants.length;
        st.counts.assets += assets.length;
        if (input.include_data) {
          add("m:product", { type: "product", data: product });
          for (const v of variants) add("m:variant", { type: "variant", data: v });
          for (const a of assets) add("m:asset", { type: "asset", data: a });
        }
        for (const a of assets) {
          const files = (await ctx.db.first<{ files: string; stored: string; external_id: string }>("SELECT files, stored, external_id FROM assets WHERE id = ?", [a.id as string]))!;
          const f = safeJsonParse<Files>(files.files, {});
          const fname = assetFilename(files.external_id, safeJsonParse(files.stored, {}), f);
          for (const r of input.renditions) {
            const pick = pickFile(f, r);
            if (!pick) continue;
            const path = `${sanitizeFilename(String(product.style_number))}/${r}/${zipEntryName(fname, r, pick.fallback)}`;
            stmts.push(jobItemStmt(job.id, "f", ++st.fileCount, { path, sha256: pick.ref.sha256, size: pick.ref.bytes, crc: pick.ref.crc32, asset_id: a.id, rendition: r }));
          }
        }
      }
      for (let i = 0; i < stmts.length; i += 200) await ctx.db.batch(stmts.slice(i, i + 200));
      st.planOffset += ids.length;
      continue;
    }
    if (st.phase === "zip") {
      let w = new ZipWriter(ctx, job.id, st.zip!, `zcd:${st.part}`);
      await w.resume();
      let stop = false;
      while (!stop) {
        const items = await jobItems<{ path: string; sha256: string; size: number; crc: number; asset_id: string; rendition: string }>(ctx, job.id, "f", st.fi, 50);
        if (!items.length) break;
        for (const it of items) {
          if (ctx.now() >= deadline) {
            stop = true;
            break;
          }
          if (st.partFiles > 0 && w.projected(it.item.path, it.item.size) > EXPORT_PART_LIMIT) {
            const r = await w.finish();
            st.parts.push({ number: st.part, bytes: r.bytes, sha256: r.sha256, files: st.partFiles });
            st.part++;
            st.partFiles = 0;
            st.zip = newZipState(`jobs/${job.id}/part-${st.part}.zip`);
            w = new ZipWriter(ctx, job.id, st.zip, `zcd:${st.part}`);
          }
          await w.add(it.item.path, it.item.size, it.item.crc, { sha256: it.item.sha256 });
          st.zip = w.st;
          st.partFiles++;
          st.counts.files++;
          st.mi["m:file"] = (st.mi["m:file"] ?? 0) + 1;
          await ctx.db.batch([
            jobItemStmt(job.id, "m:file", st.mi["m:file"], { type: "file", asset_id: it.item.asset_id, rendition: it.item.rendition, part: st.part, path: it.item.path, bytes: it.item.size, sha256: it.item.sha256 }),
          ]);
          st.fi = it.idx;
        }
      }
      if (stop) {
        await w.checkpoint();
        return { done: false, state: st, progressDone: st.fi, progressTotal: st.fileCount };
      }
      if (st.partFiles > 0 || st.parts.length === 0) {
        const r = await w.finish();
        st.parts.push({ number: st.part, bytes: r.bytes, sha256: r.sha256, files: st.partFiles });
      }
      st.phase = "done";
      return { done: true, state: st, progressDone: st.fileCount, progressTotal: st.fileCount, result: { parts: st.parts, counts: st.counts, cursor: st.cursor }, expiresAt: ctx.iso(48 * 3600 * 1000) };
    }
    break;
  }
  return { done: false, state: st, progressDone: st.phase === "zip" ? st.fi : st.counts.products, progressTotal: st.phase === "zip" ? st.fileCount : null };
}

export async function exportJson(ctx: Ctx, job: JobRow, actor: string) {
  const { signPath } = await import("./read");
  const base = await ctx.baseUrl();
  const result = safeJsonParse<{ parts?: { number: number; bytes: number; sha256: string; files: number }[] }>(job.result, {});
  const expired = job.status === "expired" || (job.status === "succeeded" && job.expires_at !== null && Date.parse(job.expires_at) < ctx.now());
  const ok = job.status === "succeeded" && !expired;
  const exp = Math.min(Math.floor(ctx.now() / 1000) + 3600, job.expires_at ? Math.floor(Date.parse(job.expires_at) / 1000) : Infinity);
  const parts = ok
    ? await Promise.all(
        (result.parts ?? []).map(async (p) => ({ number: p.number, url: base + (await signPath(ctx, `/obx/v1/exports/${job.id}/parts/${p.number}`, actor, exp)), bytes: p.bytes, sha256: p.sha256, files: p.files })),
      )
    : [];
  return {
    id: job.id,
    status: expired ? "expired" : job.status,
    created_at: job.created_at,
    finished_at: job.finished_at,
    expires_at: job.expires_at,
    progress: { done: job.progress_done, total: job.progress_total },
    manifest_url: ok ? base + (await signPath(ctx, `/obx/v1/exports/${job.id}/manifest`, actor, exp)) : null,
    parts,
    error: job.error ? JSON.parse(job.error) : null,
  };
}

/** Streams the NDJSON manifest: header, brand, product, variant, asset, then file lines. */
export function manifestStream(ctx: Ctx, job: JobRow): ReadableStream<Uint8Array> {
  const st = safeJsonParse<ExportState>(job.state, {} as ExportState);
  const kinds = ["m:brand", "m:product", "m:variant", "m:asset", "m:file"];
  let ki = -1;
  let after = 0;
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (ki === -1) {
        const header = { type: "header", export_id: job.id, created_at: job.created_at, obx_version: "0.1", changes_cursor: st.cursor, counts: st.counts };
        c.enqueue(enc.encode(JSON.stringify(header) + "\n"));
        ki = 0;
        return;
      }
      while (ki < kinds.length) {
        const rows = await jobItems(ctx, job.id, kinds[ki], after, 500);
        if (rows.length) {
          after = rows[rows.length - 1].idx;
          c.enqueue(enc.encode(rows.map((r) => JSON.stringify(r.item)).join("\n") + "\n"));
          return;
        }
        ki++;
        after = 0;
      }
      c.close();
    },
  });
}

registerJob("export", exportStep, async (ctx, job) => {
  const input = safeJsonParse<ExportInput>(job.input, {} as ExportInput);
  await emitClientEvent(ctx, { clientId: input.client_row_id }, "export.completed", { export_id: job.id, status: job.status });
});

export { isoNow };
