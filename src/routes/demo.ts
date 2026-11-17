// Demo mode routes and guard (only mounted with OBX_DEMO=true; docs/demo.md).
import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "./common";
import { clientIp, ctxOf, json, readOptionalObject } from "./common";
import { loginAs, requireUser } from "./admin-auth";
import { ObxError } from "../lib/problem";
import { dbLimit, enforce, limitHeaders, memLimit } from "../core/ratelimit";
import { DEMO, demoError, demoInfo, demoNeedsBody, demoRefusal, ensureDemo, resetDemo, verifyTurnstile } from "../core/demo";
import type { UserRow } from "../core/auth";
import { isPlainObject } from "../lib/util";

/**
 * Runs before every route in demo mode: abuse limits per address, the demo's refusals, the upload
 * cap, and no indexing or shared caching of anything the demo serves.
 */
export const demoGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ctx = ctxOf(c);
  const method = c.req.method;
  const path = c.req.path;
  const write = !["GET", "HEAD", "OPTIONS"].includes(method);
  const ip = clientIp(c);
  if (path !== "/healthz" && path !== "/readyz") {
    const bucket = path === "/admin/api/demo/login" ? "login" : write ? "write" : "read";
    const limit = ctx.p.demoLimit ?? memoryDemoLimit(ctx.now.bind(ctx));
    if (!(await limit(bucket, ip))) throw new ObxError("rate_limited", "Too many requests to the demo from your address. Wait a minute and try again.", [], { retryAfter: 60, headers: { "retry-after": "60" } });
  }
  if (write) {
    const len = c.req.header("content-length");
    const chunked = /chunked/i.test(c.req.header("transfer-encoding") ?? "");
    if ((len && Number(len) > ctx.config.demoMaxUploadBytes) || (!len && chunked))
      throw demoError({ code: "payload_too_large", detail: `Uploads in the demo are limited to ${Math.round(ctx.config.demoMaxUploadBytes / 1048576)} MB (send a Content-Length).` });
  }
  let body: Record<string, unknown> | null = null;
  if (demoNeedsBody(method, path)) {
    try {
      const v = JSON.parse(await c.req.raw.clone().text());
      body = isPlainObject(v) ? v : null;
    } catch {
      body = null;
    }
  }
  const refusal = demoRefusal(method, path, body);
  if (refusal) throw demoError(refusal);
  await next();
  c.res.headers.set("x-robots-tag", "noindex, nofollow");
  // Files (also images visitors uploaded) never go into shared caches: they are gone after the next reset.
  const cc = c.res.headers.get("cache-control");
  if (cc && /public/i.test(cc)) c.res.headers.set("cache-control", "private, max-age=300");
};

const limits = { read: 300, write: 40, login: 10 };

function memoryDemoLimit(now: () => number) {
  return async (bucket: keyof typeof limits, key: string) => memLimit(now(), `demo:${bucket}:${key}`, limits[bucket], 60).ok;
}

export const demo = new Hono<AppEnv>();

demo.get("/admin/api/demo", async (c) => json(c, await demoInfo(ctxOf(c))));

/** One-click sign-in as the demo retailer or the demo brand admin. */
demo.post("/admin/api/demo/login", async (c) => {
  const ctx = ctxOf(c);
  const body = await readOptionalObject(c);
  const as = body.as;
  if (as !== "retailer" && as !== "brand") throw new ObxError("validation_failed", 'Send {"as": "retailer"} or {"as": "brand"}.');
  const rl = await dbLimit(ctx, `demo-login:${clientIp(c)}`, 30, 600);
  c.set("rl", limitHeaders(rl));
  enforce(rl, "demo sign-ins");
  await verifyTurnstile(ctx, body.turnstile_token, clientIp(c));
  await ensureDemo(ctx);
  ctx.invalidateSettings();
  const user = await ctx.db.first<UserRow>("SELECT * FROM users WHERE id = ?", [as === "brand" ? DEMO.brandUser : DEMO.retailerUser]);
  if (!user) throw new ObxError("service_unavailable", "The demo is being reset. Try again in a minute.", [], { retryAfter: 60 });
  const old = c.get("session");
  if (old) await ctx.db.run("DELETE FROM sessions WHERE id_hash = ?", [old.sessionHash]);
  return json(c, await loginAs(c, user));
});

/** Reset on demand (signed-in demo visitors; at most once per 10 minutes for everyone). */
demo.post("/admin/api/demo/reset", async (c) => {
  const ctx = ctxOf(c);
  requireUser(c);
  const rl = await dbLimit(ctx, "demo-reset", 1, 600);
  c.set("rl", limitHeaders(rl));
  enforce(rl, "resets of the demo");
  await resetDemo(ctx);
  return json(c, await demoInfo(ctx), 202);
});
