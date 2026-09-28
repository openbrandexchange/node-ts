// The change feed (protocol.md §6): snapshot first, then live entries, filtered per viewer.
import type { Ctx } from "./ctx";
import type { Viewer, RetailerRow } from "./auth";
import { grantOf } from "./auth";
import { ObxError } from "../lib/problem";
import { brandRep, productRep, variantRep } from "./reps";
import {
  assetForViewer,
  assetVisibleSql,
  brandVisibleSql,
  placeholders,
  productVisibleSql,
  type AssetRow,
  type BrandRow,
  type ProductRow,
  type VariantRow,
} from "./read";
import { safeJsonParse } from "../lib/util";

const TYPES = ["brand", "product", "variant", "asset"] as const;
type T = (typeof TYPES)[number];

interface CursorPayload {
  n: string; // node id
  p: "s" | "l";
  t?: number; // snapshot type index
  k?: string; // last id within type
  h: number; // high-water seq
  s?: number; // live: last seq
  ts: number; // created (ms), snapshot expiry
}

const SNAPSHOT_TTL_MS = 24 * 3600 * 1000;
export const RETENTION_DAYS = 90;

async function encodeCursor(ctx: Ctx, p: CursorPayload): Promise<string> {
  return await ctx.keys.seal("cursor", p);
}

async function decodeCursor(ctx: Ctx, raw: string): Promise<CursorPayload> {
  if (raw.length > 4096) throw new ObxError("cursor_invalid", "This cursor is not valid.");
  const p = await ctx.keys.unseal<CursorPayload>("cursor", raw);
  if (!p || typeof p !== "object" || (p.p !== "s" && p.p !== "l")) throw new ObxError("cursor_invalid", "This cursor is not valid (malformed or from another node). Restart without a cursor.");
  if (p.n !== (await ctx.nodeId())) throw new ObxError("cursor_invalid", "This cursor belongs to another node. Restart without a cursor.");
  return p;
}

export async function liveCursorAt(ctx: Ctx, seq: number): Promise<string> {
  return encodeCursor(ctx, { n: await ctx.nodeId(), p: "l", h: seq, s: seq, ts: ctx.now() });
}

export async function maxSeq(ctx: Ctx): Promise<number> {
  const r = await ctx.db.first<{ m: number | null }>("SELECT MAX(seq) AS m FROM changes");
  return r?.m ?? 0;
}

interface FeedAuth {
  viewer: Viewer;
  retailer: RetailerRow;
  client: Parameters<typeof grantOf>[2];
}

type Entry = Record<string, unknown>;

async function objectsOfType(ctx: Ctx, t: T, viewer: Viewer, afterId: string, limit: number, ids?: string[]): Promise<Record<string, unknown>[]> {
  const pv = productVisibleSql(viewer);
  const idFilter = ids ? ` AND x.id IN (${placeholders(ids.length)})` : " AND x.id > ?";
  const idParams = ids ?? [afterId];
  const lim = ids ? "" : ` ORDER BY x.id LIMIT ${limit}`;
  const seqCol = "(SELECT MAX(seq) FROM changes c WHERE c.obj_id = x.id) AS last_seq";
  switch (t) {
    case "brand": {
      const bv = brandVisibleSql(viewer, "x");
      return ctx.db.all(`SELECT x.*, ${seqCol} FROM brands x WHERE ${bv.sql}${idFilter}${lim}`, [...bv.params, ...idParams]);
    }
    case "product":
      return ctx.db.all(`SELECT x.*, ${seqCol} FROM products x JOIN brands b ON b.id = x.brand_id WHERE ${productVisibleSql(viewer, "x").sql}${idFilter}${lim}`, [
        ...productVisibleSql(viewer, "x").params,
        ...idParams,
      ]);
    case "variant":
      return ctx.db.all(
        `SELECT x.*, ${seqCol} FROM variants x JOIN products p ON p.id = x.product_id JOIN brands b ON b.id = p.brand_id WHERE x.status = 'published' AND ${pv.sql}${idFilter}${lim}`,
        [...pv.params, ...idParams],
      );
    case "asset":
      return ctx.db.all(
        `SELECT x.*, ${seqCol} FROM assets x JOIN products p ON p.id = x.product_id JOIN brands b ON b.id = p.brand_id WHERE ${assetVisibleSql("x")} AND ${pv.sql}${idFilter}${lim}`,
        [ctx.iso(), ...pv.params, ...idParams],
      );
  }
}

async function dataFor(ctx: Ctx, t: T, rows: Record<string, unknown>[], viewer: Viewer, base: string): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (t === "brand") for (const r of rows) out.set(r.id as string, brandRep(r as unknown as BrandRow));
  if (t === "product") for (const r of rows) out.set(r.id as string, productRep(r as unknown as ProductRow));
  if (t === "variant") for (const r of rows) out.set(r.id as string, variantRep(r as unknown as VariantRow));
  if (t === "asset") {
    const settings = await ctx.settings();
    const productIds = [...new Set(rows.map((r) => r.product_id as string))];
    const vmap = new Map<string, Map<string, string>>();
    if (productIds.length) {
      const vs = await ctx.db.all<{ id: string; external_id: string; product_id: string }>(
        `SELECT id, external_id, product_id FROM variants WHERE status = 'published' AND product_id IN (${placeholders(productIds.length)})`,
        productIds,
      );
      for (const v of vs) {
        const m = vmap.get(v.product_id) ?? new Map();
        m.set(v.external_id, v.id);
        vmap.set(v.product_id, m);
      }
    }
    for (const r of rows) {
      const a = r as unknown as AssetRow;
      const s = safeJsonParse<Record<string, unknown>>(a.stored, {});
      const m = vmap.get(a.product_id) ?? new Map<string, string>();
      const vids = Array.isArray(s.variant_external_ids) ? (s.variant_external_ids as string[]).map((e) => m.get(e)).filter((x): x is string => !!x) : null;
      out.set(a.id, await assetForViewer(ctx, a, settings, viewer, vids, base));
    }
  }
  return out;
}

function entryOf(t: T, r: Record<string, unknown>, data: Record<string, unknown>, seq: number): Entry {
  return {
    seq,
    type: t,
    op: "upsert",
    id: r.id,
    external_id: r.external_id,
    brand_id: t === "brand" ? r.id : (data.brand_id ?? null),
    product_id: t === "variant" || t === "asset" ? r.product_id : null,
    updated_at: r.updated_at,
    data,
  };
}

export async function readChanges(ctx: Ctx, auth: FeedAuth, cursorRaw: string | undefined, limit: number, base: string) {
  const viewer = auth.viewer;
  const nodeId = await ctx.nodeId();
  let cur: CursorPayload;
  if (!cursorRaw) {
    cur = { n: nodeId, p: "s", t: 0, k: "", h: await maxSeq(ctx), ts: ctx.now() };
  } else {
    cur = await decodeCursor(ctx, cursorRaw);
    if (cur.p === "s" && ctx.now() - cur.ts > SNAPSHOT_TTL_MS) throw new ObxError("cursor_expired", "This snapshot cursor expired. Restart without a cursor.");
    if (cur.p === "l") {
      const floor = Number((await ctx.meta("changes_floor_seq")) ?? "0");
      if ((cur.s ?? 0) < floor) throw new ObxError("cursor_expired", "This cursor is older than the retained history. Restart without a cursor.");
      if ((cur.s ?? 0) > (await maxSeq(ctx))) throw new ObxError("cursor_invalid", "This cursor is ahead of this node's history. Restart without a cursor.");
    }
  }

  if (cur.p === "s") {
    const changes: Entry[] = [];
    let t = cur.t ?? 0;
    let k = cur.k ?? "";
    while (t < TYPES.length && changes.length < limit) {
      const type = TYPES[t];
      const rows = await objectsOfType(ctx, type, viewer, k, limit - changes.length);
      const data = await dataFor(ctx, type, rows, viewer, base);
      for (const r of rows) changes.push(entryOf(type, r, data.get(r.id as string)!, (r.last_seq as number | null) ?? Math.max(cur.h, 1)));
      if (rows.length) k = rows[rows.length - 1].id as string;
      if (changes.length >= limit) break;
      t++;
      k = "";
    }
    const next: CursorPayload = t >= TYPES.length ? { n: nodeId, p: "l", h: cur.h, s: cur.h, ts: ctx.now() } : { ...cur, t, k };
    return { changes, next_cursor: await encodeCursor(ctx, next), has_more: true, phase: "snapshot" as const };
  }

  // live
  let seq = cur.s ?? 0;
  const out: Entry[] = [];
  const grantBrands = viewer.brandIds ? new Set(viewer.brandIds) : null;
  let scanned = 0;
  let reachedEnd = false;
  while (out.length < limit && scanned < 5000) {
    const batch = Math.min(1000, Math.max(limit * 2, 50));
    const rows = await ctx.db.all<{
      seq: number;
      type: T | "grant";
      op: "upsert" | "delete";
      obj_id: string;
      external_id: string | null;
      brand_id: string | null;
      product_id: string | null;
      retailer_id: string | null;
      resync: number | null;
      updated_at: string;
    }>("SELECT * FROM changes WHERE seq > ? ORDER BY seq LIMIT ?", [seq, batch]);
    if (!rows.length) {
      reachedEnd = true;
      break;
    }
    scanned += rows.length;
    // Collect upsert ids per type to fetch current, visible data in bulk.
    const want = new Map<T, Set<string>>();
    for (const r of rows) {
      if (r.type === "grant" || r.op !== "upsert") continue;
      if (grantBrands && r.brand_id && !grantBrands.has(r.brand_id)) continue;
      const s = want.get(r.type as T) ?? new Set<string>();
      s.add(r.obj_id);
      want.set(r.type as T, s);
    }
    const current = new Map<string, { row: Record<string, unknown>; data: Record<string, unknown> }>();
    for (const [t, ids] of want) {
      const list = [...ids];
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        const objs = await objectsOfType(ctx, t, viewer, "", 0, chunk);
        const data = await dataFor(ctx, t, objs, viewer, base);
        for (const o of objs) current.set(o.id as string, { row: o, data: data.get(o.id as string)! });
      }
    }
    let grant: Record<string, unknown> | null = null;
    let stop = false;
    for (const r of rows) {
      seq = r.seq;
      if (r.type === "grant") {
        if (r.retailer_id !== auth.retailer.id) continue;
        grant ??= await grantOf(ctx, auth.retailer, auth.client);
        out.push({ seq: r.seq, type: "grant", op: "upsert", id: r.obj_id, external_id: null, brand_id: null, product_id: null, updated_at: r.updated_at, data: grant, resync: !!r.resync });
      } else {
        if (grantBrands && (!r.brand_id || !grantBrands.has(r.brand_id))) continue;
        if (r.op === "delete") {
          out.push({ seq: r.seq, type: r.type, op: "delete", id: r.obj_id, external_id: r.external_id, brand_id: r.brand_id, product_id: r.product_id, updated_at: r.updated_at });
        } else {
          const c = current.get(r.obj_id);
          if (!c) continue;
          out.push({ ...entryOf(r.type as T, c.row, c.data, r.seq), updated_at: c.row.updated_at });
        }
      }
      if (out.length >= limit) {
        stop = true;
        break;
      }
    }
    if (stop) break;
    if (rows.length < batch) {
      reachedEnd = true;
      break;
    }
  }
  let hasMore = !reachedEnd;
  if (!reachedEnd) hasMore = !!(await ctx.db.first("SELECT 1 AS x FROM changes WHERE seq > ? LIMIT 1", [seq]));
  return {
    changes: out,
    next_cursor: await encodeCursor(ctx, { n: nodeId, p: "l", h: cur.h, s: seq, ts: ctx.now() }),
    has_more: hasMore,
    phase: "live" as const,
  };
}

/** A grant entry for one retailer (resync = the visible set changed). */
export function grantChangeStmt(ctx: Ctx, retailerId: string, resync: boolean) {
  const now = ctx.iso();
  return {
    sql: "INSERT INTO changes (type, op, obj_id, external_id, brand_id, product_id, retailer_id, resync, updated_at, created_at) VALUES ('grant', 'upsert', ?, NULL, NULL, NULL, ?, ?, ?, ?)",
    params: ["grt_" + retailerId.replace(/^rtl_/, ""), retailerId, resync ? 1 : 0, now, now],
  };
}

/** Grant entries for every active retailer (e.g. original downloads toggled). */
export function grantChangeAllStmt(ctx: Ctx, resync: boolean) {
  const now = ctx.iso();
  return {
    sql: "INSERT INTO changes (type, op, obj_id, external_id, brand_id, product_id, retailer_id, resync, updated_at, created_at) SELECT 'grant', 'upsert', 'grt_' || substr(id, 5), NULL, NULL, NULL, id, ?, ?, ? FROM retailers WHERE status = 'active' ORDER BY id",
    params: [resync ? 1 : 0, now, now],
  };
}

/** Drops history older than the retention window (tombstones kept >= 90 days). */
export async function pruneChanges(ctx: Ctx) {
  const cutoff = ctx.iso(-(RETENTION_DAYS + 10) * 24 * 3600 * 1000);
  const r = await ctx.db.first<{ m: number | null }>("SELECT MAX(seq) AS m FROM changes WHERE created_at < ?", [cutoff]);
  if (!r?.m) return;
  await ctx.db.batch([
    { sql: "DELETE FROM changes WHERE seq <= ?", params: [r.m] },
    ctx.metaStmt("changes_floor_seq", String(r.m)),
  ]);
}
