// Webhooks (protocol.md §9, plus the brand's own admin webhooks) and job completion notifications.
import type { Ctx } from "./ctx";
import type { JobRow } from "./jobs";
import { webhookSignature } from "../lib/crypto";
import { newId, newSecret, safeJsonParse } from "../lib/util";
import { safeFetch } from "../lib/ssrf";
import { ObxError } from "../lib/problem";
import { maxSeq } from "./changes";

export interface WebhookRow {
  id: string;
  owner: "brand" | "client";
  api_client_id: string | null;
  url: string;
  events: string;
  secret_enc: string;
  status: "active" | "disabled";
  notified_seq: number;
  notified_at: string | null;
  failing_since: string | null;
  last_delivery_at: string | null;
  last_status: number | null;
  created_at: string;
}

export interface DeliveryRow {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  body: string;
  attempt: number;
  state: "pending" | "done" | "failed";
  next_attempt_at: string | null;
  status_code: number | null;
  duration_ms: number | null;
  error: string | null;
  at: string;
  created_at: string;
}

export const CLIENT_EVENTS = ["changes.available", "grant.updated", "export.completed"];
export const BRAND_EVENTS = ["access_request.created", "import_run.completed", "ingest_job.completed"];
const RETRY_DELAYS = [60, 300, 1800, 7200, 21600, 43200];

export function webhookJson(w: WebhookRow, secret: string | null = null) {
  return {
    id: w.id,
    url: w.url,
    events: safeJsonParse<string[]>(w.events, []),
    secret,
    status: w.status,
    created_at: w.created_at,
    last_delivery_at: w.last_delivery_at,
    last_status: w.last_status,
  };
}

export function deliveryJson(d: DeliveryRow) {
  return {
    id: d.id,
    event_id: d.event_id,
    event_type: d.event_type,
    at: d.at,
    status_code: d.status_code,
    duration_ms: d.duration_ms,
    attempt: d.attempt,
    success: d.state === "done",
    error: d.error,
  };
}

export async function createWebhook(ctx: Ctx, owner: "brand" | "client", clientId: string | null, url: string, events: string[]) {
  const secret = newSecret("whsec_", 24);
  const w: WebhookRow = {
    id: newId("whk"),
    owner,
    api_client_id: clientId,
    url,
    events: JSON.stringify([...new Set(events)]),
    secret_enc: await ctx.keys.encrypt(secret),
    status: "active",
    notified_seq: await maxSeq(ctx),
    notified_at: null,
    failing_since: null,
    last_delivery_at: null,
    last_status: null,
    created_at: ctx.iso(),
  };
  await ctx.db.run(
    "INSERT INTO webhooks (id, owner, api_client_id, url, events, secret_enc, status, notified_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [w.id, w.owner, w.api_client_id, w.url, w.events, w.secret_enc, w.status, w.notified_seq, w.created_at],
  );
  return { row: w, secret };
}

async function queue(ctx: Ctx, hooks: WebhookRow[], type: string, data: unknown) {
  if (!hooks.length) return;
  const now = ctx.iso();
  const eventId = newId("evt");
  const body = JSON.stringify({ id: eventId, type, created_at: now, data });
  await ctx.db.batch(
    hooks.map((h) => ({
      sql: "INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, body, attempt, state, next_attempt_at, at, created_at) VALUES (?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?)",
      params: [newId("dlv"), h.id, eventId, type, body, now, now, now],
    })),
  );
  ctx.p.defer(deliverDue(ctx, 20_000).catch(() => {}));
}

export async function emitBrandEvent(ctx: Ctx, type: string, data: unknown) {
  const hooks = await ctx.db.all<WebhookRow>("SELECT * FROM webhooks WHERE owner = 'brand' AND status = 'active'");
  await queue(ctx, hooks.filter((h) => safeJsonParse<string[]>(h.events, []).includes(type)), type, data);
}

export async function emitClientEvent(ctx: Ctx, where: { clientId?: string; retailerId?: string }, type: string, data: unknown) {
  const hooks = where.clientId
    ? await ctx.db.all<WebhookRow>("SELECT * FROM webhooks WHERE owner = 'client' AND status = 'active' AND api_client_id = ?", [where.clientId])
    : await ctx.db.all<WebhookRow>(
        "SELECT w.* FROM webhooks w JOIN api_clients c ON c.id = w.api_client_id WHERE w.owner = 'client' AND w.status = 'active' AND c.status = 'active' AND c.retailer_id = ?",
        [where.retailerId ?? null],
      );
  await queue(ctx, hooks.filter((h) => safeJsonParse<string[]>(h.events, []).includes(type)), type, data);
}

/** changes.available wake-ups, at most every 30 s per subscription. */
export async function notifyChanges(ctx: Ctx) {
  const latest = await maxSeq(ctx);
  const cutoff = ctx.iso(-30_000);
  const hooks = await ctx.db.all<WebhookRow>(
    "SELECT w.* FROM webhooks w JOIN api_clients c ON c.id = w.api_client_id JOIN retailers r ON r.id = c.retailer_id WHERE w.owner = 'client' AND w.status = 'active' AND c.status = 'active' AND r.status = 'active' AND w.notified_seq < ? AND (w.notified_at IS NULL OR w.notified_at < ?)",
    [latest, cutoff],
  );
  const due = hooks.filter((h) => safeJsonParse<string[]>(h.events, []).includes("changes.available"));
  if (!due.length) return;
  await ctx.db.batch(due.map((h) => ({ sql: "UPDATE webhooks SET notified_seq = ?, notified_at = ? WHERE id = ?", params: [latest, ctx.iso(), h.id] })));
  await queue(ctx, due, "changes.available", { latest_seq: latest });
}

/** One HTTP attempt. Returns the delivery outcome (no redirects are followed). */
export async function attempt(ctx: Ctx, hook: WebhookRow, body: string, eventId: string) {
  const ts = String(Math.floor(ctx.now() / 1000));
  const secret = await ctx.keys.decrypt(hook.secret_enc);
  const started = Date.now();
  try {
    const res = await safeFetch(
      hook.url,
      {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "user-agent": `obx-node-ts/${ctx.config.version}`,
          "obx-webhook-id": eventId,
          "obx-webhook-timestamp": ts,
          "obx-webhook-signature": await webhookSignature(secret, ts, body),
        },
        timeoutMs: 10_000,
        followRedirects: false,
      },
      ctx.urlPolicy(),
    );
    await res.body?.cancel().catch(() => {});
    return { ok: res.status >= 200 && res.status < 300, status: res.status, ms: Date.now() - started, error: res.status >= 300 && res.status < 400 ? "Redirects are not followed." : null };
  } catch (e) {
    return { ok: false, status: null, ms: Date.now() - started, error: e instanceof ObxError ? (e.detail ?? e.code) : e instanceof Error ? e.name : "network error" };
  }
}

async function recordAttempt(ctx: Ctx, hook: WebhookRow, d: DeliveryRow, r: Awaited<ReturnType<typeof attempt>>, final = false) {
  const now = ctx.iso();
  const n = d.attempt + 1;
  const age = ctx.now() - Date.parse(d.created_at);
  const giveUp = !r.ok && (final || n > RETRY_DELAYS.length || age > 24 * 3600 * 1000);
  const state = r.ok ? "done" : giveUp ? "failed" : "pending";
  const next = r.ok || giveUp ? null : ctx.iso(RETRY_DELAYS[n - 1] * 1000);
  const failingSince = r.ok ? null : (hook.failing_since ?? now);
  const disable = !r.ok && Date.parse(failingSince!) < ctx.now() - 3 * 24 * 3600 * 1000;
  await ctx.db.batch([
    {
      sql: "UPDATE webhook_deliveries SET attempt = ?, state = ?, next_attempt_at = ?, status_code = ?, duration_ms = ?, error = ?, at = ? WHERE id = ?",
      params: [n, state, next, r.status, r.ms, r.error, now, d.id],
    },
    {
      sql: "UPDATE webhooks SET last_delivery_at = ?, last_status = ?, failing_since = ?, status = ? WHERE id = ?",
      params: [now, r.status, failingSince, disable ? "disabled" : hook.status, hook.id],
    },
  ]);
  return { ...d, attempt: n, state, next_attempt_at: next, status_code: r.status, duration_ms: r.ms, error: r.error, at: now } as DeliveryRow;
}

export async function deliverDue(ctx: Ctx, budgetMs: number) {
  const start = ctx.now();
  for (let round = 0; round < 20 && ctx.now() - start < budgetMs; round++) {
    const due = await ctx.db.all<DeliveryRow>("SELECT * FROM webhook_deliveries WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 20", [ctx.iso()]);
    if (!due.length) return;
    for (const d of due) {
      // claim: push next_attempt_at forward so parallel runners skip it
      const claimed = await ctx.db.run("UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ? AND next_attempt_at = ?", [ctx.iso(60_000), d.id, d.next_attempt_at]);
      if (!claimed.changes) continue;
      const hook = await ctx.db.first<WebhookRow>("SELECT * FROM webhooks WHERE id = ?", [d.webhook_id]);
      if (!hook || hook.status !== "active") {
        await ctx.db.run("UPDATE webhook_deliveries SET state = 'failed', error = 'subscription disabled' WHERE id = ?", [d.id]);
        continue;
      }
      await recordAttempt(ctx, hook, d, await attempt(ctx, hook, d.body, d.event_id));
    }
  }
}

/** POST …/test: deliver webhook.test right now and report the result. */
export async function testWebhook(ctx: Ctx, hook: WebhookRow): Promise<DeliveryRow> {
  const now = ctx.iso();
  const eventId = newId("evt");
  const body = JSON.stringify({ id: eventId, type: "webhook.test", created_at: now, data: {} });
  const d: DeliveryRow = { id: newId("dlv"), webhook_id: hook.id, event_id: eventId, event_type: "webhook.test", body, attempt: 0, state: "pending", next_attempt_at: null, status_code: null, duration_ms: null, error: null, at: now, created_at: now };
  await ctx.db.run("INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, body, attempt, state, next_attempt_at, at, created_at) VALUES (?, ?, ?, ?, ?, 0, 'pending', NULL, ?, ?)", [
    d.id,
    d.webhook_id,
    d.event_id,
    d.event_type,
    d.body,
    now,
    now,
  ]);
  const r = await attempt(ctx, hook, body, eventId);
  return recordAttempt(ctx, hook, d, r, true);
}

// ------------------------------------------------------------------ job completion hooks

export async function onImportFinished(ctx: Ctx, job: JobRow) {
  const { importRunOf } = await import("./importjob");
  const run = importRunOf(job);
  if (job.source_id) await ctx.db.run("UPDATE import_sources SET last_run_id = ? WHERE id = ?", [job.id, job.source_id]);
  await emitBrandEvent(ctx, "import_run.completed", { import_run: run });
  if (job.owner.startsWith("ingest:")) await emitBrandEvent(ctx, "ingest_job.completed", { job_id: job.id, kind: "import", status: job.status });
}

export async function onBatchFinished(ctx: Ctx, job: JobRow) {
  await emitBrandEvent(ctx, "ingest_job.completed", { job_id: job.id, kind: "batch", status: job.status });
}
