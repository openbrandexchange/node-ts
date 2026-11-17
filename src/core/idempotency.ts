// Idempotency-Key (spec ingest.md §3.5, protocol.md §7 exports): the same key, by the same token, on the
// same endpoint and with the same request within 24 hours replays the first response; the same key with
// another request is 409 idempotency_key_reused and runs nothing. Rows expire in the cron (cron.ts).
import type { Ctx } from "./ctx";
import { ObxError } from "../lib/problem";

export function checkIdempotencyKey(key: string | undefined | null): string | null {
  if (key === undefined || key === null || key === "") return null;
  if (key.length > 200) throw new ObxError("invalid_request", "Idempotency-Key may be at most 200 characters.");
  return key;
}

/** The stored response for this key, or null. A different request hash is idempotency_key_reused. */
export async function idempotencyLookup(ctx: Ctx, key: string, requestHash: string): Promise<{ status: number; body: string } | null> {
  const prev = await ctx.db.first<{ status: number; body: string; request_hash: string; created_at: string }>(
    "SELECT status, body, request_hash, created_at FROM idempotency_keys WHERE key = ?",
    [key],
  );
  if (!prev || prev.created_at < ctx.iso(-24 * 3600 * 1000)) return null;
  if (prev.request_hash !== requestHash)
    throw new ObxError("idempotency_key_reused", "This Idempotency-Key was used within the last 24 hours with a different request. Use a new key for a new request.");
  return { status: prev.status, body: prev.body };
}

export async function idempotencyStore(ctx: Ctx, key: string, status: number, body: string, requestHash: string): Promise<void> {
  await ctx.db.run("INSERT OR REPLACE INTO idempotency_keys (key, status, body, request_hash, created_at) VALUES (?, ?, ?, ?, ?)", [key, status, body, requestHash, ctx.iso()]);
}
