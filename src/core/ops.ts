// Operations endpoints and helpers: request ids, liveness (/healthz), readiness (/readyz),
// Prometheus metrics (/metrics, behind OBX_METRICS_TOKEN) and the in-process request counters.
import type { Ctx } from "./ctx";
import { schemaStatus } from "../db/migrate";
import { timingSafeEqualStr } from "../lib/crypto";
import { b64url, randomBytes } from "../lib/util";

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** Keeps a well-formed incoming X-Request-Id (so a proxy's id links the logs), else makes one. */
export function requestIdFrom(incoming: string | null | undefined): string {
  const v = incoming?.trim();
  if (v && REQUEST_ID_RE.test(v)) return v;
  return "req_" + b64url(randomBytes(12));
}

/** Coarse route group for metrics labels (bounded cardinality, no ids). */
export function routeGroup(path: string): string {
  if (path.startsWith("/obx/v1/ingest")) return "ingest";
  if (path.startsWith("/obx/v1/assets/") && path.includes("/renditions/")) return "media";
  if (path.startsWith("/obx/") || path.startsWith("/.well-known/")) return "protocol";
  if (path.startsWith("/admin/api/portal")) return "portal";
  if (path.startsWith("/admin/api")) return "admin";
  if (path === "/healthz" || path === "/readyz" || path === "/metrics") return "ops";
  return "other";
}

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

interface Series {
  count: number;
  sum: number;
  buckets: number[];
}

const requests = new Map<string, number>();
const durations = new Map<string, Series>();
const startedAt = Date.now();

export function recordRequest(method: string, path: string, status: number, seconds: number) {
  const group = routeGroup(path);
  const m = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method) ? method : "OTHER";
  const key = `group="${group}",method="${m}",status="${Math.floor(status / 100)}xx"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
  const dkey = `group="${group}"`;
  let s = durations.get(dkey);
  if (!s) durations.set(dkey, (s = { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) }));
  s.count++;
  s.sum += seconds;
  BUCKETS.forEach((b, i) => {
    if (seconds <= b) s!.buckets[i]++;
  });
}

export interface Readiness {
  ok: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

let shuttingDown = false;

/** Bun: marks the process as stopping, so /readyz answers 503 and load balancers drain it. */
export function markShuttingDown() {
  shuttingDown = true;
}

export function isShuttingDown() {
  return shuttingDown;
}

/** Can this instance serve traffic? Database reachable and on the current schema, storage reachable. */
export async function readiness(ctx: Ctx): Promise<Readiness> {
  const checks: Readiness["checks"] = {};
  if (shuttingDown) checks.process = { ok: false, detail: "shutting down" };
  try {
    await ctx.db.first("SELECT 1 AS ok");
    const s = await schemaStatus(ctx.db);
    checks.database = s.pending.length || s.unknown.length ? { ok: false, detail: s.unknown.length ? `database is newer than this software (${s.unknown.join(", ")})` : `pending migrations: ${s.pending.join(", ")}` } : { ok: true, detail: s.latest };
  } catch (e) {
    checks.database = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  try {
    await ctx.blobs.head("readyz/probe");
    checks.storage = { ok: true };
  } catch (e) {
    checks.storage = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  return { ok: Object.values(checks).every((c) => c.ok), checks };
}

export function metricsAuthorized(ctx: Ctx, authorization: string | undefined): boolean {
  const t = ctx.config.metricsToken;
  if (!t) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  return !!m && timingSafeEqualStr(m[1].trim(), t);
}

function line(name: string, labels: string, value: number) {
  return `${name}${labels ? `{${labels}}` : ""} ${Number.isFinite(value) ? value : 0}`;
}

/** Prometheus text exposition. Request counters are per process (per isolate on Workers). */
export async function metricsText(ctx: Ctx): Promise<string> {
  const out: string[] = [];
  const help = (name: string, type: string, text: string) => out.push(`# HELP ${name} ${text}`, `# TYPE ${name} ${type}`);
  help("obx_build_info", "gauge", "Software and version of this node.");
  out.push(line("obx_build_info", `software="${ctx.config.software}",version="${ctx.config.version}",runtime="${ctx.config.runtime}"`, 1));
  help("obx_process_start_time_seconds", "gauge", "When this process (or Workers isolate) started.");
  out.push(line("obx_process_start_time_seconds", "", Math.floor(startedAt / 1000)));
  help("obx_http_requests_total", "counter", "API requests handled by this process, by route group, method and status class.");
  for (const [k, v] of requests) out.push(line("obx_http_requests_total", k, v));
  help("obx_http_request_duration_seconds", "histogram", "API request duration by route group.");
  for (const [k, s] of durations) {
    BUCKETS.forEach((b, i) => out.push(line("obx_http_request_duration_seconds_bucket", `${k},le="${b}"`, s.buckets[i])));
    out.push(line("obx_http_request_duration_seconds_bucket", `${k},le="+Inf"`, s.count));
    out.push(line("obx_http_request_duration_seconds_sum", k, Number(s.sum.toFixed(6))));
    out.push(line("obx_http_request_duration_seconds_count", k, s.count));
  }
  const q = await ctx.db.first<Record<string, number | null>>(
    `SELECT
       (SELECT COUNT(*) FROM products) AS products,
       (SELECT COUNT(*) FROM variants) AS variants,
       (SELECT COUNT(*) FROM assets) AS assets,
       (SELECT COUNT(*) FROM blobs) AS blobs,
       (SELECT COALESCE(SUM(bytes), 0) FROM blobs) AS blob_bytes,
       (SELECT COALESCE(MAX(seq), 0) FROM changes) AS latest_seq,
       (SELECT COUNT(*) FROM retailers WHERE status = 'active') AS retailers,
       (SELECT COUNT(*) FROM api_clients WHERE status = 'active') AS api_clients,
       (SELECT COUNT(*) FROM access_requests WHERE status = 'pending') AS pending_requests,
       (SELECT COUNT(*) FROM webhooks WHERE status = 'active' AND failing_since IS NOT NULL) AS failing_webhooks,
       (SELECT COUNT(*) FROM webhook_deliveries WHERE state = 'pending') AS pending_deliveries`,
  );
  const gauges: [string, string, number | null | undefined][] = [
    ["obx_catalog_products", "Products stored (all states).", q?.products],
    ["obx_catalog_variants", "Variants stored (all states).", q?.variants],
    ["obx_catalog_assets", "Images stored (all states).", q?.assets],
    ["obx_blobs", "Stored files.", q?.blobs],
    ["obx_blob_bytes", "Bytes of stored files.", q?.blob_bytes],
    ["obx_changes_latest_seq", "Latest change feed sequence number.", q?.latest_seq],
    ["obx_retailers_active", "Active retailers.", q?.retailers],
    ["obx_api_clients_active", "Active API keys for retailers' software.", q?.api_clients],
    ["obx_access_requests_pending", "Access requests waiting for a decision.", q?.pending_requests],
    ["obx_webhooks_failing", "Active webhooks whose deliveries are failing.", q?.failing_webhooks],
    ["obx_webhook_deliveries_pending", "Webhook deliveries waiting to be sent or retried.", q?.pending_deliveries],
  ];
  for (const [name, text, v] of gauges) {
    help(name, "gauge", text);
    out.push(line(name, "", Number(v ?? 0)));
  }
  help("obx_jobs", "gauge", "Background jobs by kind and status.");
  for (const r of await ctx.db.all<{ kind: string; status: string; n: number }>("SELECT kind, status, COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running', 'failed') GROUP BY kind, status"))
    out.push(line("obx_jobs", `kind="${r.kind}",status="${r.status}"`, r.n));
  help("obx_downloads_24h", "gauge", "Downloads by retailers in the last 24 hours.");
  out.push(line("obx_downloads_24h", "", (await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM download_events WHERE at >= ? AND kind != 'usage'", [ctx.iso(-86_400_000)]))?.n ?? 0));
  return out.join("\n") + "\n";
}
