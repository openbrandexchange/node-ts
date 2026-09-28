// Admin API: audit log of admin actions, personal-data exports (retailer, person, own account)
// and erasure of one's own retailer account. Retention periods are part of the settings.
import { Hono } from "hono";
import type { AppEnv, C } from "./common";
import { ctxOf, decodeListCursor, encodeListCursor, idParam, intQuery, json, noContent } from "./common";
import { requireAdmin, requireUser, setSessionCookies } from "./admin-auth";
import { ObxError } from "../lib/problem";
import { getRetailer } from "../core/accounts";
import { auditJson, type AuditRow } from "../core/audit";
import { eraseUserStmts, exportRetailer, exportUser } from "../core/privacy";
import { newCsrf, type UserRow } from "../core/auth";
import { slugify } from "../lib/util";

export const adminPrivacy = new Hono<AppEnv>();

function download(c: C, name: string, body: unknown) {
  return c.body(JSON.stringify(body, null, 2), 200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${name}"`,
    "cache-control": "no-store",
  });
}

adminPrivacy.get("/admin/api/audit-log", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const limit = intQuery(c, "limit", 50, 1, 200);
  const where: string[] = ["1 = 1"];
  const params: string[] = [];
  for (const [q, col] of [
    ["action", "action"],
    ["actor_id", "actor_id"],
    ["target_id", "target_id"],
  ] as const) {
    const v = c.req.query(q);
    if (v) {
      where.push(`${col} = ?`);
      params.push(v);
    }
  }
  const outcome = c.req.query("outcome");
  if (outcome === "failed") where.push("status >= 400");
  else if (outcome === "succeeded") where.push("status < 400");
  const cur = await decodeListCursor<{ t: string; id: string }>(ctx, "audit", c.req.query("cursor") || undefined);
  if (cur) {
    where.push("(at < ? OR (at = ? AND id < ?))");
    params.push(cur.t, cur.t, cur.id);
  }
  const rows = await ctx.db.all<AuditRow>(`SELECT * FROM audit_log WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`, [...params, limit + 1] as never);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return json(c, { items: page.map(auditJson), next_cursor: rows.length > limit ? await encodeListCursor(ctx, "audit", { t: last.at, id: last.id }) : null });
});

adminPrivacy.get("/admin/api/retailers/:id/export", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const r = await getRetailer(ctx, idParam(c));
  return download(c, `personal-data-${slugify(r.name) || r.id}-${ctx.iso().slice(0, 10)}.json`, await exportRetailer(ctx, r));
});

adminPrivacy.get("/admin/api/users/:id/export", async (c) => {
  requireAdmin(c);
  const ctx = ctxOf(c);
  const u = await ctx.db.first<UserRow>("SELECT * FROM users WHERE id = ?", [idParam(c)]);
  if (!u) throw new ObxError("not_found", "Unknown account.");
  return download(c, `personal-data-${u.id}-${ctx.iso().slice(0, 10)}.json`, await exportUser(ctx, u));
});

/** "Download my data" for anyone signed in. */
adminPrivacy.get("/admin/api/me/export", async (c) => {
  const s = requireUser(c);
  const ctx = ctxOf(c);
  return download(c, `my-data-${ctx.iso().slice(0, 10)}.json`, await exportUser(ctx, s.user));
});

/** A retailer's person deletes their own account (brand administrators are removed by another administrator). */
adminPrivacy.delete("/admin/api/me", async (c) => {
  const s = requireUser(c);
  if (s.user.role === "admin") throw new ObxError("forbidden", "Administrators are removed by another administrator under Settings → Team.");
  const ctx = ctxOf(c);
  c.set("auditActor", { type: "user", id: s.user.id, name: null, role: s.user.role });
  await ctx.db.batch(eraseUserStmts(s.user));
  setSessionCookies(c, "", newCsrf());
  c.set("session", null);
  return noContent(c);
});
