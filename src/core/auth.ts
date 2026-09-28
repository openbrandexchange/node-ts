// Authentication for the three faces: OAuth2 client credentials (protocol), ingest tokens, admin sessions.
import type { Ctx } from "./ctx";
import { ObxError } from "../lib/problem";
import { b64url, newSecret, randomBytes, safeJsonParse } from "../lib/util";
import { sha256Hex, timingSafeEqualStr, tokenHash } from "../lib/crypto";

export const ACCESS_TOKEN_TTL = 3600;
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

// ------------------------------------------------------------------ grants & viewers

export interface RetailerRow {
  id: string;
  name: string;
  reference: string | null;
  website: string | null;
  vat_number: string | null;
  country: string | null;
  notes: string | null;
  status: "active" | "blocked";
  brand_ids: string | null;
  allow_original: number | null;
  grant_updated_at: string;
  last_activity_at: string | null;
  created_at: string;
}

export interface ClientRow {
  id: string;
  client_id: string;
  secret_hash: string;
  secret_version: number;
  name: string;
  retailer_id: string;
  scopes: string;
  status: "active" | "revoked";
  created_by: string;
  created_at: string;
  last_used_at: string | null;
}

/** Who is reading. Everything the protocol and the portal return is filtered through this. */
export interface Viewer {
  /** Signed-URL actor: c.<client row id> | u.<user id> | p.<user id> (admin preview). */
  actor: string;
  kind: "client" | "user" | "preview";
  retailerId: string | null;
  retailerName: string | null;
  actorName: string | null;
  brandIds: string[] | null;
  original: boolean;
  scopes: string[];
}

export function retailerOriginalAllowed(r: Pick<RetailerRow, "allow_original">, siteAllows: boolean): boolean {
  return siteAllows && r.allow_original !== 0;
}

export async function grantOf(ctx: Ctx, r: RetailerRow, client: ClientRow | null) {
  const s = await ctx.settings();
  const original = retailerOriginalAllowed(r, s.portal.allow_original_download);
  let scopes = client ? safeJsonParse<string[]>(client.scopes, []) : ["catalog:read", "media:read", "media:original", "usage:write"];
  if (!original) scopes = scopes.filter((x) => x !== "media:original");
  return {
    id: grantIdOf(r.id),
    retailer: { id: r.id, name: r.name },
    brand_ids: safeJsonParse<string[] | null>(r.brand_ids, null),
    scopes,
    original_allowed: original,
    status: r.status === "active" && (!client || client.status === "active") ? "active" : "revoked",
    updated_at: r.grant_updated_at,
  };
}

export function grantIdOf(retailerId: string): string {
  return "grt_" + retailerId.replace(/^rtl_/, "");
}

// ------------------------------------------------------------------ OAuth2 access tokens (stateless, sealed)

interface AccessPayload {
  c: string; // client row id
  v: number; // secret version
  s: string[];
  e: number; // expiry (unix s)
}

export async function issueAccessToken(ctx: Ctx, client: ClientRow, scopes: string[]): Promise<string> {
  const p: AccessPayload = { c: client.id, v: client.secret_version, s: scopes, e: Math.floor(ctx.now() / 1000) + ACCESS_TOKEN_TTL };
  return "obxa_" + (await ctx.keys.seal("access-token", p));
}

export interface ClientAuth {
  client: ClientRow;
  retailer: RetailerRow;
  viewer: Viewer;
  scopes: string[];
}

function bearer(h: string | null | undefined): string | null {
  if (!h) return null;
  const m = h.match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}

export async function authenticateClient(ctx: Ctx, authorization: string | null | undefined): Promise<ClientAuth> {
  const tok = bearer(authorization);
  if (!tok) throw new ObxError("unauthorized", "Send an access token: Authorization: Bearer <token>.", [], { headers: { "www-authenticate": 'Bearer realm="obx"' } });
  if (!tok.startsWith("obxa_")) throw new ObxError("invalid_token", "Unknown or expired access token.", [], { headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
  const p = await ctx.keys.unseal<AccessPayload>("access-token", tok.slice(5));
  if (!p || typeof p.e !== "number" || p.e < Math.floor(ctx.now() / 1000))
    throw new ObxError("invalid_token", "Unknown or expired access token. Request a new one.", [], { headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
  const row = await ctx.db.first<ClientRow & { r_json: string }>("SELECT * FROM api_clients WHERE id = ?", [p.c]);
  if (!row) throw new ObxError("access_revoked", "This API key was removed. Stop syncing and contact the brand.");
  if (row.secret_version !== p.v) throw new ObxError("invalid_token", "The API key was rotated. Request a new token with the new secret.");
  const retailer = await ctx.db.first<RetailerRow>("SELECT * FROM retailers WHERE id = ?", [row.retailer_id]);
  if (!retailer || retailer.status !== "active" || row.status !== "active") throw new ObxError("access_revoked", "Access was revoked by the brand. Stop syncing and contact the brand.");
  const grant = await grantOf(ctx, retailer, row);
  const scopes = p.s.filter((x) => grant.scopes.includes(x));
  const viewer: Viewer = {
    actor: `c.${row.id}`,
    kind: "client",
    retailerId: retailer.id,
    retailerName: retailer.name,
    actorName: row.name,
    brandIds: grant.brand_ids,
    original: grant.original_allowed && scopes.includes("media:original"),
    scopes,
  };
  return { client: row, retailer, viewer, scopes };
}

export function requireScope(scopes: string[], scope: string) {
  if (!scopes.includes(scope)) throw new ObxError("insufficient_scope", `This call needs the ${scope} scope.`);
}

export async function verifyClientSecret(ctx: Ctx, clientId: string, secret: string): Promise<ClientRow | null> {
  const row = await ctx.db.first<ClientRow>("SELECT * FROM api_clients WHERE client_id = ?", [clientId]);
  const h = await tokenHash(secret);
  const ok = timingSafeEqualStr(row?.secret_hash ?? "0".repeat(64), h);
  return row && ok ? row : null;
}

export async function newClientCredentials(): Promise<{ clientId: string; secret: string; hash: string }> {
  const clientId = "obxc_" + b64url(randomBytes(12));
  const secret = newSecret("obxs_", 32);
  return { clientId, secret, hash: await tokenHash(secret) };
}

// ------------------------------------------------------------------ ingest tokens

export interface IngestTokenRow {
  id: string;
  name: string;
  prefix: string;
  token_hash: string;
  scopes: string;
  brand_external_ids: string | null;
  status: string;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface IngestAuth {
  token: IngestTokenRow;
  scopes: string[];
  brands: string[] | null;
}

export async function authenticateIngest(ctx: Ctx, authorization: string | null | undefined): Promise<IngestAuth> {
  const tok = bearer(authorization);
  if (!tok) throw new ObxError("unauthorized", "Send your ingest token: Authorization: Bearer obxi_…");
  if (!tok.startsWith("obxi_")) throw new ObxError("invalid_token", "This is not an ingest token (they start with obxi_).");
  const row = await ctx.db.first<IngestTokenRow>("SELECT * FROM ingest_tokens WHERE token_hash = ?", [await tokenHash(tok)]);
  if (!row) throw new ObxError("invalid_token", "Unknown ingest token.");
  if (row.status !== "active") throw new ObxError("access_revoked", "This ingest token was revoked. Create a new one in the admin.");
  if (row.expires_at && Date.parse(row.expires_at) <= ctx.now()) throw new ObxError("access_revoked", "This ingest token has expired. Create a new one in the admin.");
  if (!row.last_used_at || Date.parse(row.last_used_at) < ctx.now() - 5 * 60_000) {
    ctx.p.defer(ctx.db.run("UPDATE ingest_tokens SET last_used_at = ? WHERE id = ?", [ctx.iso(), row.id]).catch(() => {}));
  }
  return { token: row, scopes: safeJsonParse<string[]>(row.scopes, []), brands: safeJsonParse<string[] | null>(row.brand_external_ids, null) };
}

export async function newIngestToken(): Promise<{ secret: string; hash: string; prefix: string }> {
  const secret = newSecret("obxi_", 32);
  return { secret, hash: await tokenHash(secret), prefix: secret.slice(0, 12) };
}

// ------------------------------------------------------------------ sessions & CSRF (admin API)

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: "admin" | "retailer";
  retailer_id: string | null;
  status: "invited" | "active" | "blocked";
  language: string;
  password_hash: string | null;
  invite_token_hash: string | null;
  invite_expires_at: string | null;
  last_login_at: string | null;
  created_at: string;
}

export interface SessionInfo {
  user: UserRow;
  retailer: RetailerRow | null;
  sessionHash: string;
  csrf: string;
}

export function parseCookies(h: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function loadSession(ctx: Ctx, cookieHeader: string | null | undefined): Promise<SessionInfo | null> {
  const sid = parseCookies(cookieHeader).obx_session;
  if (!sid) return null;
  const h = await sha256Hex(sid);
  const s = await ctx.db.first<{ id_hash: string; user_id: string; csrf_token: string; expires_at: string; seen_at: string }>("SELECT * FROM sessions WHERE id_hash = ?", [h]);
  if (!s || Date.parse(s.expires_at) <= ctx.now()) return null;
  const user = await ctx.db.first<UserRow>("SELECT * FROM users WHERE id = ?", [s.user_id]);
  if (!user || user.status !== "active") return null;
  let retailer: RetailerRow | null = null;
  if (user.role === "retailer") {
    retailer = await ctx.db.first<RetailerRow>("SELECT * FROM retailers WHERE id = ?", [user.retailer_id]);
    if (!retailer || retailer.status !== "active") return null;
  }
  // Sliding expiry, written at most every 10 minutes.
  if (Date.parse(s.seen_at) < ctx.now() - 10 * 60_000) {
    ctx.p.defer(ctx.db.run("UPDATE sessions SET seen_at = ?, expires_at = ? WHERE id_hash = ?", [ctx.iso(), ctx.iso(SESSION_TTL_MS), h]).catch(() => {}));
    if (retailer) ctx.p.defer(ctx.db.run("UPDATE retailers SET last_activity_at = ? WHERE id = ?", [ctx.iso(), retailer.id]).catch(() => {}));
  }
  return { user, retailer, sessionHash: h, csrf: s.csrf_token };
}

export async function createSession(ctx: Ctx, userId: string): Promise<{ sid: string; csrf: string }> {
  const sid = b64url(randomBytes(32));
  const csrf = b64url(randomBytes(24));
  await ctx.db.batch([
    { sql: "INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, expires_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)", params: [await sha256Hex(sid), userId, csrf, ctx.iso(), ctx.iso(SESSION_TTL_MS), ctx.iso()] },
    { sql: "UPDATE users SET last_login_at = ? WHERE id = ?", params: [ctx.iso(), userId] },
  ]);
  return { sid, csrf };
}

export function newCsrf(): string {
  return b64url(randomBytes(24));
}

export function cookieFlags(secure: boolean, maxAgeS: number | null): string {
  return `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}${maxAgeS === null ? "" : `; Max-Age=${maxAgeS}`}`;
}
