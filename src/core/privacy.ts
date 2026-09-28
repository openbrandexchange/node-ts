// Personal data (GDPR): what the portal keeps about a retailer and its people, an export of it
// (right of access, Art. 15/20) and its erasure (Art. 17). Brand-side business data (the catalog)
// is not personal data; download statistics keep the retailer's company name but not the person.
import type { Ctx } from "./ctx";
import type { ClientRow, RetailerRow, UserRow } from "./auth";
import { adminAccessRequestJson, clientJson, retailerJson, userJson, type AccessRequestRow } from "./accounts";
import { auditJson, type AuditRow } from "./audit";
import { placeholders } from "./read";
import { safeJsonParse } from "../lib/util";
import type { Stmt } from "../platform";

export const EXPORT_FORMAT = "obx-personal-data-export/1";

async function accessRequestsFor(ctx: Ctx, retailerId: string | null, emails: string[]): Promise<AccessRequestRow[]> {
  const rows = await ctx.db.all<AccessRequestRow>("SELECT * FROM access_requests WHERE retailer_id IS ? OR retailer_id IS NULL ORDER BY created_at", [retailerId]);
  const set = new Set(emails.map((e) => e.toLowerCase()));
  return rows.filter((r) => (retailerId !== null && r.retailer_id === retailerId) || set.has(String(safeJsonParse<{ email?: string }>(r.contact, {}).email ?? "").toLowerCase()));
}

function eventJson(e: Record<string, unknown>) {
  const { id, at, kind, retailer_name, actor_type, actor_name, variant, product_id, asset_id, usage_event, files, bytes } = e;
  return { id, at, kind, retailer_name, actor_type, actor_name, variant, product_id, asset_id, usage_event, files, bytes };
}

async function auditFor(ctx: Ctx, userIds: string[]) {
  if (!userIds.length) return [];
  const rows = await ctx.db.all<AuditRow>(`SELECT * FROM audit_log WHERE actor_id IN (${placeholders(userIds.length)}) ORDER BY at`, userIds);
  return rows.map(auditJson);
}

/** Everything stored about one retailer company and its accounts, as one JSON document. */
export async function exportRetailer(ctx: Ctx, r: RetailerRow) {
  const users = await ctx.db.all<UserRow>("SELECT * FROM users WHERE retailer_id = ? ORDER BY created_at", [r.id]);
  const clients = await ctx.db.all<ClientRow>("SELECT * FROM api_clients WHERE retailer_id = ? ORDER BY created_at", [r.id]);
  const selections = users.length ? await ctx.db.all<{ user_id: string; product_ids: string; updated_at: string }>(`SELECT * FROM selections WHERE user_id IN (${placeholders(users.length)})`, users.map((u) => u.id)) : [];
  const events = await ctx.db.all<Record<string, unknown>>("SELECT * FROM download_events WHERE retailer_id = ? ORDER BY at", [r.id]);
  const hooks = clients.length ? await ctx.db.all<Record<string, unknown>>(`SELECT id, api_client_id, url, events, status, created_at, last_delivery_at FROM webhooks WHERE api_client_id IN (${placeholders(clients.length)})`, clients.map((c) => c.id)) : [];
  const brand = await ctx.settings();
  return {
    format: EXPORT_FORMAT,
    exported_at: ctx.iso(),
    controller: { name: brand.company.name, contact_email: brand.company.contact_email, website: brand.company.website },
    retailer: await retailerJson(ctx, r),
    users: users.map((u) => ({ ...userJson(u), selection: safeJsonParse<string[]>(selections.find((s) => s.user_id === u.id)?.product_ids ?? null, []) })),
    api_clients: clients.map(clientJson),
    webhooks: hooks.map((h) => ({ ...h, events: safeJsonParse<string[]>(h.events as string, []) })),
    access_requests: (await accessRequestsFor(ctx, r.id, users.map((u) => u.email))).map(adminAccessRequestJson),
    download_events: events.map(eventJson),
    audit_log: await auditFor(ctx, users.map((u) => u.id)),
    retention: brand.retention,
  };
}

/** Everything stored about one person (the signed-in user's own "download my data"). */
export async function exportUser(ctx: Ctx, u: UserRow) {
  const sel = await ctx.db.first<{ product_ids: string }>("SELECT product_ids FROM selections WHERE user_id = ?", [u.id]);
  const retailer = u.retailer_id ? await ctx.db.first<RetailerRow>("SELECT * FROM retailers WHERE id = ?", [u.retailer_id]) : null;
  const events = u.retailer_id ? await ctx.db.all<Record<string, unknown>>("SELECT * FROM download_events WHERE retailer_id = ? AND actor_type = 'user' AND actor_name = ? ORDER BY at", [u.retailer_id, u.name]) : [];
  const brand = await ctx.settings();
  return {
    format: EXPORT_FORMAT,
    exported_at: ctx.iso(),
    controller: { name: brand.company.name, contact_email: brand.company.contact_email, website: brand.company.website },
    user: userJson(u),
    retailer: retailer ? { id: retailer.id, name: retailer.name } : null,
    selection: safeJsonParse<string[]>(sel?.product_ids ?? null, []),
    access_requests: (await accessRequestsFor(ctx, u.retailer_id, [u.email])).map(adminAccessRequestJson),
    download_events: events.map(eventJson),
    audit_log: await auditFor(ctx, [u.id]),
    retention: brand.retention,
  };
}

/** Statements that erase one person: account, sessions, selection, resets; their name leaves statistics and the audit log. */
export function eraseUserStmts(u: UserRow): Stmt[] {
  return [
    { sql: "DELETE FROM sessions WHERE user_id = ?", params: [u.id] },
    { sql: "DELETE FROM selections WHERE user_id = ?", params: [u.id] },
    { sql: "DELETE FROM password_resets WHERE user_id = ?", params: [u.id] },
    { sql: "UPDATE download_events SET actor_name = NULL WHERE actor_type = 'user' AND actor_name = ? AND retailer_id IS ?", params: [u.name, u.retailer_id] },
    { sql: "UPDATE audit_log SET actor_name = NULL, ip = NULL WHERE actor_id = ?", params: [u.id] },
    { sql: "DELETE FROM users WHERE id = ?", params: [u.id] },
  ];
}

/** Statements that erase a retailer company: its people, keys, webhooks and access requests. Statistics keep only the company name. */
export async function eraseRetailerStmts(ctx: Ctx, r: RetailerRow): Promise<Stmt[]> {
  const users = await ctx.db.all<UserRow>("SELECT * FROM users WHERE retailer_id = ?", [r.id]);
  const requests = await accessRequestsFor(ctx, r.id, users.map((u) => u.email));
  return [
    ...users.flatMap(eraseUserStmts),
    { sql: "DELETE FROM webhook_deliveries WHERE webhook_id IN (SELECT id FROM webhooks WHERE api_client_id IN (SELECT id FROM api_clients WHERE retailer_id = ?))", params: [r.id] },
    { sql: "DELETE FROM webhooks WHERE api_client_id IN (SELECT id FROM api_clients WHERE retailer_id = ?)", params: [r.id] },
    { sql: "DELETE FROM api_clients WHERE retailer_id = ?", params: [r.id] },
    { sql: "UPDATE download_events SET retailer_id = NULL, actor_name = NULL WHERE retailer_id = ?", params: [r.id] },
    ...requests.map((q) => ({ sql: "DELETE FROM access_requests WHERE id = ?", params: [q.id] })),
    { sql: "DELETE FROM retailers WHERE id = ?", params: [r.id] },
  ];
}
