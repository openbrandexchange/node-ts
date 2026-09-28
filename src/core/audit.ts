// Audit log of admin actions: every change made through the admin API (and sign-ins, password
// resets, self-service API keys and personal-data exports) is written here with who, what, when
// and the outcome. Request bodies are never stored (they can hold secrets and passwords).
import type { Ctx } from "./ctx";
import { newId } from "../lib/util";

export interface AuditActor {
  type: "user" | "anonymous";
  id: string | null;
  name: string | null;
  role: string | null;
}

export interface AuditEntry {
  actor: AuditActor;
  method: string;
  route: string;
  targetId: string | null;
  status: number;
  requestId: string | null;
  ip: string | null;
  details?: Record<string, unknown> | null;
}

/** Retailer browsing and downloads are recorded as download statistics, not as admin actions. */
const NOT_AUDITED = [
  /^\/admin\/api\/portal\/(selection|download-jobs|gtin-lookup|products|assets|facets|viewer)/,
  /^\/admin\/api\/password\/forgot$/,
  /^\/admin\/api\/session$/,
];

export function isAudited(method: string, path: string): boolean {
  if (NOT_AUDITED.some((re) => re.test(path))) return false;
  if (method === "GET" || method === "HEAD") return /\/export$/.test(path);
  return method !== "OPTIONS";
}

/**
 * A stable, readable action name from the route: `PATCH /admin/api/retailers/:id` → `retailers.update`,
 * `POST /admin/api/access-requests/:id/approve` → `access-requests.approve`.
 */
export function actionName(method: string, route: string): string {
  const segs = route.replace(/^\/admin\/api\/?/, "").split("/").filter(Boolean);
  const plain = segs.filter((s) => !s.startsWith(":"));
  const last = segs[segs.length - 1] ?? "";
  const beforeLast = segs[segs.length - 2] ?? "";
  if (segs.length >= 2 && !last.startsWith(":") && beforeLast.startsWith(":")) return [...plain.slice(0, -1), last].join(".");
  const verb = { POST: "create", PUT: "update", PATCH: "update", DELETE: "delete", GET: "read", HEAD: "read" }[method] ?? method.toLowerCase();
  const special: Record<string, string> = { "session/login": "session.login", "session/logout": "session.logout", setup: "setup.complete", "password/reset": "password.reset" };
  return special[plain.join("/")] ?? [...plain, verb].join(".");
}

/** What kind of object the route acts on: `retailer`, `user`, `product`, `settings`, `node` … */
export function targetType(route: string): string | null {
  const plain = route.replace(/^\/admin\/api\/?/, "").split("/").filter((x) => x && !x.startsWith(":"));
  const first = plain[0];
  if (!first) return null;
  if (["session", "password", "me", "invites"].includes(first)) return "user";
  if (first === "setup") return "node";
  if (first === "settings") return "settings";
  const noun = (first === "catalog" || first === "portal") && plain[1] ? plain[1] : first;
  return noun.replace(/-/g, "_").replace(/ies$/, "y").replace(/s$/, "");
}

export async function writeAudit(ctx: Ctx, e: AuditEntry) {
  await ctx.db.run(
    "INSERT INTO audit_log (id, at, actor_type, actor_id, actor_name, actor_role, action, method, route, target_id, status, request_id, ip, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      newId("aud"),
      ctx.iso(),
      e.actor.type,
      e.actor.id,
      e.actor.name,
      e.actor.role,
      actionName(e.method, e.route),
      e.method,
      e.route,
      e.targetId,
      e.status,
      e.requestId,
      e.ip && e.ip !== "unknown" ? e.ip : null,
      e.details && Object.keys(e.details).length ? JSON.stringify(e.details) : null,
    ],
  );
}

export interface AuditRow {
  id: string;
  at: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  method: string;
  route: string;
  target_id: string | null;
  status: number;
  request_id: string | null;
  ip: string | null;
  details: string | null;
}

export function auditJson(r: AuditRow) {
  return {
    id: r.id,
    at: r.at,
    actor: { type: r.actor_type, id: r.actor_id, name: r.actor_name, role: r.actor_role },
    action: r.action,
    method: r.method,
    route: r.route,
    target: r.target_id || targetType(r.route) ? { type: targetType(r.route), id: r.target_id } : null,
    target_id: r.target_id,
    status: r.status,
    succeeded: r.status < 400,
    request_id: r.request_id,
    ip: r.ip,
    detail: r.details ? JSON.parse(r.details) : null,
  };
}
