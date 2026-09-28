// Retailers, accounts (invites), API clients and access requests: the brand's relationship management.
import type { Ctx } from "./ctx";
import type { ClientRow, RetailerRow, UserRow } from "./auth";
import { newClientCredentials, retailerOriginalAllowed } from "./auth";
import { ObxError } from "../lib/problem";
import { b64url, newId, randomBytes, safeJsonParse } from "../lib/util";
import { tokenHash } from "../lib/crypto";
import { grantChangeStmt } from "./changes";
import { emitClientEvent } from "./notify";
import { sendEmail } from "./mail";
import type { Stmt } from "../platform";

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export function userJson(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    retailer_id: u.retailer_id,
    status: u.status,
    language: u.language,
    last_login_at: u.last_login_at,
    invite_expires_at: u.status === "invited" ? u.invite_expires_at : null,
    created_at: u.created_at,
  };
}

export async function retailerJson(ctx: Ctx, r: RetailerRow) {
  const counts = await ctx.db.first<{ users: number; clients: number }>(
    "SELECT (SELECT COUNT(*) FROM users WHERE retailer_id = ?) AS users, (SELECT COUNT(*) FROM api_clients WHERE retailer_id = ? AND status = 'active') AS clients",
    [r.id, r.id],
  );
  return {
    id: r.id,
    name: r.name,
    reference: r.reference,
    website: r.website,
    vat_number: r.vat_number,
    country: r.country,
    notes: r.notes,
    status: r.status,
    brand_ids: safeJsonParse<string[] | null>(r.brand_ids, null),
    allow_original: r.allow_original === null ? null : !!r.allow_original,
    user_count: counts?.users ?? 0,
    api_client_count: counts?.clients ?? 0,
    last_activity_at: r.last_activity_at,
    created_at: r.created_at,
  };
}

export function clientJson(cl: ClientRow) {
  return {
    id: cl.id,
    client_id: cl.client_id,
    name: cl.name,
    retailer_id: cl.retailer_id,
    scopes: safeJsonParse<string[]>(cl.scopes, []),
    status: cl.status,
    created_at: cl.created_at,
    last_used_at: cl.last_used_at,
  };
}

export async function clientWithSecret(ctx: Ctx, cl: ClientRow, secret: string) {
  const base = await ctx.baseUrl();
  return { client: clientJson(cl), client_secret: secret, token_endpoint: `${base}/obx/v1/oauth/token`, discovery_url: `${base}/.well-known/obx` };
}

export async function getRetailer(ctx: Ctx, id: string): Promise<RetailerRow> {
  const r = await ctx.db.first<RetailerRow>("SELECT * FROM retailers WHERE id = ?", [id]);
  if (!r) throw new ObxError("not_found", "Unknown retailer.");
  return r;
}

export async function createRetailer(ctx: Ctx, f: { name: string; reference?: string | null; website?: string | null; vat_number?: string | null; country?: string | null; notes?: string | null; brand_ids?: string[] | null; allow_original?: boolean | null }) {
  const id = newId("rtl");
  const now = ctx.iso();
  await ctx.db.run(
    "INSERT INTO retailers (id, name, reference, website, vat_number, country, notes, status, brand_ids, allow_original, grant_updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)",
    [id, f.name, f.reference ?? null, f.website ?? null, f.vat_number ?? null, f.country ?? null, f.notes ?? null, f.brand_ids ? JSON.stringify(f.brand_ids) : null, f.allow_original === undefined || f.allow_original === null ? null : f.allow_original ? 1 : 0, now, now],
  );
  return getRetailer(ctx, id);
}

/** Applies a retailer patch; grant changes write a grant entry (resync) and a grant.updated webhook. */
export async function patchRetailer(ctx: Ctx, r: RetailerRow, p: Record<string, unknown>): Promise<RetailerRow> {
  const next = { ...r };
  for (const k of ["name", "reference", "website", "vat_number", "country", "notes", "status"] as const) if (k in p) (next as Record<string, unknown>)[k] = p[k];
  if ("brand_ids" in p) next.brand_ids = p.brand_ids === null ? null : JSON.stringify(p.brand_ids);
  if ("allow_original" in p) next.allow_original = p.allow_original === null ? null : p.allow_original ? 1 : 0;
  const s = await ctx.settings();
  const visibleChanged = next.brand_ids !== r.brand_ids || retailerOriginalAllowed(next, s.portal.allow_original_download) !== retailerOriginalAllowed(r, s.portal.allow_original_download);
  const statusChanged = next.status !== r.status;
  const now = ctx.iso();
  const stmts: Stmt[] = [
    {
      sql: "UPDATE retailers SET name = ?, reference = ?, website = ?, vat_number = ?, country = ?, notes = ?, status = ?, brand_ids = ?, allow_original = ?, grant_updated_at = ? WHERE id = ?",
      params: [next.name, next.reference, next.website, next.vat_number, next.country, next.notes, next.status, next.brand_ids, next.allow_original, visibleChanged || statusChanged ? now : r.grant_updated_at, r.id],
    },
  ];
  if (visibleChanged) stmts.push(grantChangeStmt(ctx, r.id, true));
  else if (statusChanged && next.status === "active") stmts.push(grantChangeStmt(ctx, r.id, false));
  if (statusChanged && next.status === "blocked") stmts.push({ sql: "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE retailer_id = ?)", params: [r.id] });
  await ctx.db.batch(stmts);
  const updated = await getRetailer(ctx, r.id);
  if (visibleChanged) {
    const { grantOf } = await import("./auth");
    await emitClientEvent(ctx, { retailerId: r.id }, "grant.updated", { grant: await grantOf(ctx, updated, null) });
  }
  return updated;
}

/** Deletes a retailer and erases the personal data of its people (see core/privacy.ts). */
export async function deleteRetailer(ctx: Ctx, r: RetailerRow) {
  const { eraseRetailerStmts } = await import("./privacy");
  await ctx.db.batch(await eraseRetailerStmts(ctx, r));
}

export function defaultScopes(originalAllowed: boolean): string[] {
  // usage:write only when asked for explicitly (spec NOTES: API keys).
  return originalAllowed ? ["catalog:read", "media:read", "media:original"] : ["catalog:read", "media:read"];
}

export async function createClient(ctx: Ctx, retailer: RetailerRow, name: string, scopes: string[] | null, createdBy: string) {
  const s = await ctx.settings();
  const allowed = retailerOriginalAllowed(retailer, s.portal.allow_original_download);
  const sc = scopes ?? defaultScopes(allowed);
  const { clientId, secret, hash } = await newClientCredentials();
  const id = newId("cli");
  await ctx.db.run(
    "INSERT INTO api_clients (id, client_id, secret_hash, secret_version, name, retailer_id, scopes, status, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, 'active', ?, ?)",
    [id, clientId, hash, name, retailer.id, JSON.stringify([...new Set(sc)]), createdBy, ctx.iso()],
  );
  return { row: (await ctx.db.first<ClientRow>("SELECT * FROM api_clients WHERE id = ?", [id]))!, secret };
}

export async function rotateClient(ctx: Ctx, cl: ClientRow) {
  const { secret, hash } = await newClientCredentials();
  await ctx.db.run("UPDATE api_clients SET secret_hash = ?, secret_version = secret_version + 1 WHERE id = ?", [hash, cl.id]);
  return { row: (await ctx.db.first<ClientRow>("SELECT * FROM api_clients WHERE id = ?", [cl.id]))!, secret };
}

// ------------------------------------------------------------------ invitations

export async function inviteUser(
  ctx: Ctx,
  o: { email: string; name: string | null; role: "admin" | "retailer"; retailerId: string | null; language: string | null; inviterName?: string | null },
) {
  const existing = await ctx.db.first<UserRow>("SELECT * FROM users WHERE email = ?", [o.email.toLowerCase()]);
  if (existing) throw new ObxError("conflict", "This e-mail address already has an account on this portal.");
  const token = b64url(randomBytes(32));
  const id = newId("usr");
  const s = await ctx.settings();
  const lang = o.language ?? s.portal.default_language;
  const exp = ctx.iso(INVITE_TTL_MS);
  await ctx.db.run(
    "INSERT INTO users (id, email, name, role, retailer_id, status, language, invite_token_hash, invite_expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'invited', ?, ?, ?, ?)",
    [id, o.email.toLowerCase(), o.name ?? "", o.role, o.retailerId, lang, await tokenHash(token), exp, ctx.iso()],
  );
  const user = (await ctx.db.first<UserRow>("SELECT * FROM users WHERE id = ?", [id]))!;
  return sendInvite(ctx, user, token);
}

export async function sendInvite(ctx: Ctx, user: UserRow, token: string) {
  const base = await ctx.mailBaseUrl();
  const url = `${base}/invite/${token}`;
  const expires = user.invite_expires_at!;
  const sent = await sendEmail(ctx, {
    to: user.email,
    lang: user.language,
    template: "invite",
    name: user.name || null,
    vars: { expires: expires.slice(0, 10) },
    link: url,
  });
  return { user: userJson(user), invite_url: url, expires_at: expires, email_sent: sent };
}

export async function resendInvite(ctx: Ctx, user: UserRow) {
  if (user.status !== "invited") throw new ObxError("conflict", "This account is already active.");
  const token = b64url(randomBytes(32));
  const exp = ctx.iso(INVITE_TTL_MS);
  await ctx.db.run("UPDATE users SET invite_token_hash = ?, invite_expires_at = ? WHERE id = ?", [await tokenHash(token), exp, user.id]);
  return sendInvite(ctx, { ...user, invite_expires_at: exp }, token);
}

export async function findInvite(ctx: Ctx, token: string): Promise<UserRow> {
  if (!token || token.length < 20 || token.length > 200) throw new ObxError("invite_invalid", "This link is not valid.");
  const u = await ctx.db.first<UserRow>("SELECT * FROM users WHERE invite_token_hash = ?", [await tokenHash(token)]);
  if (!u || u.status !== "invited" || !u.invite_expires_at || Date.parse(u.invite_expires_at) < ctx.now()) throw new ObxError("invite_invalid", "This link has expired or was already used. Ask for a new invitation.");
  return u;
}

// ------------------------------------------------------------------ access requests (admin side)

export interface AccessRequestRow {
  id: string;
  status: "pending" | "approved" | "rejected";
  retailer: string;
  contact: string;
  access: string;
  requested_brand_ids: string | null;
  message: string | null;
  request_token_hash: string;
  reason: string | null;
  retailer_id: string | null;
  api_client_id: string | null;
  pending_secret: string | null;
  claimed: number;
  portal_invited: number;
  created_at: string;
  decided_at: string | null;
}

export function adminAccessRequestJson(r: AccessRequestRow) {
  return {
    id: r.id,
    status: r.status,
    created_at: r.created_at,
    decided_at: r.decided_at,
    reason: r.reason,
    retailer: safeJsonParse(r.retailer, { name: "" }),
    contact: safeJsonParse(r.contact, { name: "", email: "" }),
    access: safeJsonParse<string[]>(r.access, []),
    requested_brand_ids: safeJsonParse<string[] | null>(r.requested_brand_ids, null),
    message: r.message,
    retailer_id: r.retailer_id,
    source_ip_country: null,
  };
}

export async function approveAccessRequest(
  ctx: Ctx,
  r: AccessRequestRow,
  body: { retailer_id?: string | null; brand_ids?: string[] | null; invite_portal_user?: boolean; create_api_client?: boolean },
) {
  if (r.status !== "pending") throw new ObxError("conflict", "This request was already decided.");
  const access = safeJsonParse<string[]>(r.access, []);
  const info = safeJsonParse<Record<string, string | null>>(r.retailer, {});
  const contact = safeJsonParse<Record<string, string | null>>(r.contact, {});
  const requested = safeJsonParse<string[] | null>(r.requested_brand_ids, null);
  const brandIds = body.brand_ids !== undefined ? body.brand_ids : requested && requested.length ? requested : null;
  let retailer: RetailerRow;
  if (body.retailer_id) retailer = await getRetailer(ctx, body.retailer_id);
  else
    retailer = await createRetailer(ctx, {
      name: info.name ?? "Retailer",
      reference: info.reference,
      website: info.website,
      vat_number: info.vat_number,
      country: info.country,
      brand_ids: brandIds,
    });
  // Claim the request first so a double click cannot approve twice.
  const claimed = await ctx.db.run("UPDATE access_requests SET status = 'approved', decided_at = ?, retailer_id = ? WHERE id = ? AND status = 'pending'", [ctx.iso(), retailer.id, r.id]);
  if (!claimed.changes) throw new ObxError("conflict", "This request was already decided.");
  let invite = null;
  const wantPortal = body.invite_portal_user ?? access.includes("portal");
  if (wantPortal && contact.email) {
    const existing = await ctx.db.first<UserRow>("SELECT * FROM users WHERE email = ?", [contact.email.toLowerCase()]);
    if (!existing) {
      invite = await inviteUser(ctx, { email: contact.email, name: contact.name ?? null, role: "retailer", retailerId: retailer.id, language: contact.language ?? null });
      await ctx.db.run("UPDATE access_requests SET portal_invited = 1 WHERE id = ?", [r.id]);
    }
  }
  let apiClient = null;
  const wantApi = body.create_api_client ?? access.includes("api");
  if (wantApi) {
    const { row, secret } = await createClient(ctx, retailer, `${info.name ?? "Retailer"} (requested)`, null, "access_request");
    await ctx.db.run("UPDATE access_requests SET api_client_id = ?, pending_secret = ? WHERE id = ?", [row.id, await ctx.keys.encrypt(secret), r.id]);
    apiClient = clientJson(row);
  }
  if (contact.email)
    await sendEmail(ctx, {
      to: contact.email,
      lang: contact.language ?? (await ctx.settings()).portal.default_language,
      template: "accessApproved",
      name: contact.name ?? null,
      vars: {},
      extra: apiClient ? ["apiNote"] : [],
      // With a portal invite the retailer first chooses a password via the invite e-mail.
      link: invite ? null : `${await ctx.mailBaseUrl()}/login`,
    });
  const updated = (await ctx.db.first<AccessRequestRow>("SELECT * FROM access_requests WHERE id = ?", [r.id]))!;
  return {
    access_request: adminAccessRequestJson(updated),
    retailer: await retailerJson(ctx, await getRetailer(ctx, retailer.id)),
    ...(invite ? { invite } : {}),
    ...(apiClient ? { api_client: apiClient } : {}),
  };
}

export async function rejectAccessRequest(ctx: Ctx, r: AccessRequestRow, reason: string | null) {
  const res = await ctx.db.run("UPDATE access_requests SET status = 'rejected', decided_at = ?, reason = ? WHERE id = ? AND status = 'pending'", [ctx.iso(), reason, r.id]);
  if (!res.changes) throw new ObxError("conflict", "This request was already decided.");
  const contact = safeJsonParse<Record<string, string | null>>(r.contact, {});
  if (contact.email)
    await sendEmail(ctx, {
      to: contact.email,
      lang: contact.language ?? (await ctx.settings()).portal.default_language,
      template: "accessRejected",
      name: contact.name ?? null,
      vars: { reason: reason ?? "" },
      extra: reason ? ["reason"] : [],
    });
  return adminAccessRequestJson((await ctx.db.first<AccessRequestRow>("SELECT * FROM access_requests WHERE id = ?", [r.id]))!);
}
