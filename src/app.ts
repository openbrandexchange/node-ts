// The node as one Hono app. Adapters (Workers, Bun) provide the Platform and serve the static UI.
import { Hono } from "hono";
import type { AppEnv } from "./routes/common";
import type { Platform } from "./platform";
import { Ctx } from "./core/ctx";
import { ObxError, problemResponse } from "./lib/problem";
import { protocol } from "./routes/protocol";
import { ingest } from "./routes/ingest";
import { adminAuth, adminMiddleware, ensureSetupCode } from "./routes/admin-auth";
import { adminManage } from "./routes/admin-manage";
import { portal } from "./routes/portal";
import { tick } from "./core/cron";
import { runJobs } from "./core/jobs";
import { isShuttingDown, metricsAuthorized, metricsText, readiness, recordRequest, requestIdFrom } from "./core/ops";
import { SchemaTooNewError } from "./db/migrate";
// Job handlers register themselves on import.
import "./core/importjob";
import "./core/batch";
import "./core/bulk";
import "./core/cron";

export const API_PREFIXES = ["/admin/api", "/obx/", "/.well-known/"];
export const OPS_PATHS = ["/healthz", "/readyz", "/metrics"];

/** Paths the Worker / Bun app answers (everything else is the static admin UI). */
export function isApiPath(path: string): boolean {
  return path === "/obx" || OPS_PATHS.includes(path) || API_PREFIXES.some((p) => path.startsWith(p));
}

/** Headers on every API response. The UI's own headers (CSP for scripts) come from public/_headers and static.ts. */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

export const HSTS = "max-age=31536000";

function isHttps(req: Request): boolean {
  // On Bun, X-Forwarded-Proto only survives when OBX_TRUST_PROXY=true (see adapters/bun/serve.ts).
  return new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
}

function applyHeaders(res: Response, req: Request, path: string, requestId: string) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!res.headers.has(k)) res.headers.set(k, v);
  if (isHttps(req)) res.headers.set("strict-transport-security", HSTS);
  res.headers.set("x-request-id", requestId);
  if (path.startsWith("/obx/") || path.startsWith("/.well-known/")) res.headers.set("obx-version", "0.1");
}

export function createApp(platform: Platform) {
  const app = new Hono<AppEnv>();

  // Liveness: the process answers. No database access, so a slow database never restarts healthy instances.
  app.get("/healthz", (c) => c.json({ ok: true }, 200, { "cache-control": "no-store", "x-request-id": requestIdFrom(c.req.header("x-request-id")) }));

  app.use("*", async (c, next) => {
    const started = Date.now();
    const ctx = new Ctx(platform);
    ctx.requestOrigin = new URL(c.req.url).origin;
    ctx.requestId = requestIdFrom(c.req.header("x-request-id") ?? c.req.header("cf-ray"));
    c.set("ctx", ctx);
    c.set("session", null);
    c.set("rl", null);
    let failed = false;
    try {
      await ctx.ready();
      await ensureSetupCode(ctx);
      await next();
    } catch (e) {
      failed = true;
      throw e;
    } finally {
      const status = failed ? 500 : c.res.status;
      recordRequest(c.req.method, c.req.path, status, (Date.now() - started) / 1000);
      if (platform.config.accessLog && c.req.path !== "/readyz" && c.req.path !== "/metrics")
        platform.log("info", "request", { request_id: ctx.requestId, method: c.req.method, path: c.req.path, status, ms: Date.now() - started });
    }
    applyHeaders(c.res, c.req.raw, c.req.path, ctx.requestId);
  });

  app.onError((err, c) => {
    const requestId = c.get("ctx")?.requestId ?? requestIdFrom(null);
    const e =
      err instanceof ObxError
        ? err
        : err instanceof SchemaTooNewError
          ? (platform.log("error", err.message, { request_id: requestId }), new ObxError("service_unavailable", err.message))
          : (() => {
              platform.log("error", "unhandled error", { request_id: requestId, path: c.req.path, method: c.req.method, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), stack: err instanceof Error ? err.stack?.split("\n").slice(0, 6).join(" | ") : undefined });
              return new ObxError("internal_error", "Something went wrong on the server. Try again later.");
            })();
    const res = problemResponse(e);
    const rl = c.get("rl");
    if (rl) for (const [k, v] of Object.entries(rl)) if (!res.headers.has(k)) res.headers.set(k, v);
    applyHeaders(res, c.req.raw, c.req.path, requestId);
    return res;
  });

  // Readiness: database reachable and migrated, storage reachable, not shutting down.
  app.get("/readyz", async (c) => {
    const r = await readiness(c.get("ctx"));
    return c.json(r, r.ok ? 200 : 503, { "cache-control": "no-store" });
  });

  // Prometheus metrics, only with OBX_METRICS_TOKEN set and sent as a Bearer token.
  app.get("/metrics", async (c) => {
    const ctx = c.get("ctx");
    if (!metricsAuthorized(ctx, c.req.header("authorization"))) throw new ObxError("not_found", "There is nothing at this address.");
    return c.body(await metricsText(ctx), 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
  });

  app.route("/", protocol);
  app.route("/obx/v1/ingest", ingest);
  app.use("/admin/api/*", adminMiddleware);
  app.route("/", adminAuth);
  app.route("/", adminManage);
  app.route("/", portal);

  // An existing path with a method it does not support answers 405 with an Allow header.
  const allowed = allowedMethods(app.routes);
  app.notFound((c) => {
    if (isApiPath(c.req.path)) {
      const methods = allowed(c.req.path);
      if (methods.length) return problemResponse(new ObxError("method_not_allowed", `This address supports ${methods.join(", ")}.`, [], { headers: { allow: methods.join(", ") } }));
      return problemResponse(new ObxError("not_found", "There is nothing at this address."));
    }
    return c.text("Not found", 404);
  });

  return app;
}

/** Methods registered for a path (route handlers only, not middleware), for 405 answers. */
function allowedMethods(routes: { path: string; method: string }[]) {
  let table: { re: RegExp; methods: Set<string> }[] | null = null;
  return (path: string): string[] => {
    table ??= (() => {
      const byPath = new Map<string, Set<string>>();
      for (const r of routes) {
        if (r.method === "ALL" || r.path.includes("*")) continue;
        byPath.set(r.path, (byPath.get(r.path) ?? new Set()).add(r.method));
      }
      return [...byPath].map(([p, methods]) => {
        const re = p
          .split("/")
          .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
          .join("/");
        return { re: new RegExp(`^${re}$`), methods };
      });
    })();
    const out = new Set<string>();
    for (const t of table) if (t.re.test(path)) for (const m of t.methods) out.add(m);
    if (out.has("GET")) out.add("HEAD");
    return [...out].sort();
  };
}

/** Background work for adapters: the minute tick and "run queued jobs now". */
export function createWorker(platform: Platform) {
  return {
    /** Applies migrations and fails fast (e.g. a database newer than this software) before serving. */
    async prepare() {
      await new Ctx(platform).ready();
    },
    shuttingDown: isShuttingDown,
    async tick(budgetMs: number) {
      const ctx = new Ctx(platform);
      await ctx.ready();
      await tick(ctx, budgetMs);
    },
    async runJobs(budgetMs: number) {
      const ctx = new Ctx(platform);
      await ctx.ready();
      return runJobs(ctx, budgetMs);
    },
    async rotateSetupCode() {
      const ctx = new Ctx(platform);
      await ctx.ready();
      await ensureSetupCode(ctx, true);
    },
  };
}
