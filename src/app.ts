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
// Job handlers register themselves on import.
import "./core/importjob";
import "./core/batch";
import "./core/bulk";
import "./core/cron";

export const API_PREFIXES = ["/admin/api", "/obx/", "/.well-known/"];

export function isApiPath(path: string): boolean {
  return path === "/obx" || API_PREFIXES.some((p) => path.startsWith(p));
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
};

export function createApp(platform: Platform) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const ctx = new Ctx(platform);
    ctx.requestOrigin = new URL(c.req.url).origin;
    c.set("ctx", ctx);
    c.set("session", null);
    c.set("rl", null);
    await ctx.ready();
    await ensureSetupCode(ctx);
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
    if (c.req.path.startsWith("/obx/") || c.req.path.startsWith("/.well-known/")) c.res.headers.set("obx-version", "0.1");
  });

  app.onError((err, c) => {
    const e =
      err instanceof ObxError
        ? err
        : (() => {
            platform.log("error", "unhandled error", { path: c.req.path, method: c.req.method, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), stack: err instanceof Error ? err.stack?.split("\n").slice(0, 6).join(" | ") : undefined });
            return new ObxError("internal_error", "Something went wrong on the server. Try again later.");
          })();
    const res = problemResponse(e);
    const rl = c.get("rl");
    if (rl) for (const [k, v] of Object.entries(rl)) if (!res.headers.has(k)) res.headers.set(k, v);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    if (c.req.path.startsWith("/obx/") || c.req.path.startsWith("/.well-known/")) res.headers.set("obx-version", "0.1");
    return res;
  });

  app.route("/", protocol);
  app.route("/obx/v1/ingest", ingest);
  app.use("/admin/api/*", adminMiddleware);
  app.route("/", adminAuth);
  app.route("/", adminManage);
  app.route("/", portal);

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.notFound((c) => {
    if (isApiPath(c.req.path)) return problemResponse(new ObxError("not_found", "There is nothing at this address."));
    return c.text("Not found", 404);
  });

  return app;
}

/** Background work for adapters: the minute tick and "run queued jobs now". */
export function createWorker(platform: Platform) {
  return {
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
