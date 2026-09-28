// Rate limits: in-memory fixed windows for API traffic (per isolate/process, best effort) and
// database-backed windows for security-sensitive endpoints (login, setup, access requests, tokens).
import type { Ctx } from "./ctx";
import { ObxError } from "../lib/problem";

export interface Limit {
  limit: number;
  remaining: number;
  reset: number;
  ok: boolean;
}

const mem = new Map<string, { start: number; count: number }>();

export function memLimit(nowMs: number, key: string, limit: number, windowS = 60): Limit {
  const start = Math.floor(nowMs / 1000 / windowS) * windowS;
  let e = mem.get(key);
  if (!e || e.start !== start) {
    e = { start, count: 0 };
    mem.set(key, e);
    if (mem.size > 20000) for (const [k, v] of mem) if (v.start < start) mem.delete(k);
  }
  e.count++;
  const reset = start + windowS - Math.floor(nowMs / 1000);
  return { limit, remaining: Math.max(0, limit - e.count), reset, ok: e.count <= limit };
}

export async function dbLimit(ctx: Ctx, key: string, limit: number, windowS: number): Promise<Limit> {
  const now = Math.floor(ctx.now() / 1000);
  const start = Math.floor(now / windowS) * windowS;
  const row = await ctx.db.first<{ count: number }>(
    "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END, window_start = excluded.window_start RETURNING count",
    [key, start],
  );
  const count = row?.count ?? 1;
  return { limit, remaining: Math.max(0, limit - count), reset: start + windowS - now, ok: count <= limit };
}

/** The current window's count without counting this request (for limits that only count failures). */
export async function dbPeek(ctx: Ctx, key: string, limit: number, windowS: number): Promise<Limit> {
  const now = Math.floor(ctx.now() / 1000);
  const start = Math.floor(now / windowS) * windowS;
  const row = await ctx.db.first<{ count: number; window_start: number }>("SELECT count, window_start FROM rate_limits WHERE key = ?", [key]);
  const count = row && row.window_start === start ? row.count : 0;
  return { limit, remaining: Math.max(0, limit - count), reset: start + windowS - now, ok: count < limit };
}

export function limitHeaders(l: Limit): Record<string, string> {
  return { "ratelimit-limit": String(l.limit), "ratelimit-remaining": String(l.remaining), "ratelimit-reset": String(l.reset) };
}

export function enforce(l: Limit, what = "requests") {
  if (!l.ok)
    throw new ObxError("rate_limited", `Too many ${what}. Try again in ${l.reset} seconds.`, [], { retryAfter: l.reset, headers: limitHeaders(l) });
}
