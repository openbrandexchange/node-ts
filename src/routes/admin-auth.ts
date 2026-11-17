// Admin API: first-run setup, sessions, CSRF, passwords, invitations, own profile, public branding.
import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv, C } from "./common";
import { ctxOf, json, noContent, readObject, clientIp } from "./common";
import { ObxError, fieldError } from "../lib/problem";
import { loadSession, createSession, parseCookies, cookieFlags, newCsrf, SESSION_TTL_MS, type UserRow, type RetailerRow, type SessionInfo } from "../core/auth";
import { hashPassword, passwordProblem, verifyPassword } from "../lib/password";
import { dbLimit, dbPeek, enforce, limitHeaders } from "../core/ratelimit";
import { sha256Hex, timingSafeEqualStr, tokenHash } from "../lib/crypto";
import { b64url, canonicalJson, newId, randomBytes, slugify } from "../lib/util";
import { V, LANG_RE } from "../core/validate";
import { defaultSettings } from "../core/ctx";
import { findInvite, userJson } from "../core/accounts";
import { sendEmail, pickLanguage } from "../core/mail";
import { visibleBrands } from "../core/read";
import { logoUrl } from "./protocol";
import { serveStored } from "./files";
import { blobKey } from "../core/blobs";
import type { Ctx } from "../core/ctx";
import { isAudited, writeAudit, type AuditActor } from "../core/audit";
import { matchedRoutes } from "hono/route";
import { demoInfo } from "../core/demo";

export const adminAuth = new Hono<AppEnv>();

function isSecure(c: C): boolean {
  const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
  return proto === "https";
}

export function setSessionCookies(c: C, sid: string | null, csrf: string) {
  const secure = isSecure(c);
  if (sid !== null) c.header("set-cookie", `obx_session=${sid}; ${cookieFlags(secure, sid ? Math.floor(SESSION_TTL_MS / 1000) : 0)}`, { append: true });
  c.header("set-cookie", `obx_csrf=${csrf}; ${cookieFlags(secure, null)}`, { append: true });
}

function sessionJson(setupRequired: boolean, csrf: string, s: SessionInfo | { user: UserRow; retailer: RetailerRow | null } | null) {
  return {
    authenticated: !!s,
    csrf_token: csrf,
    setup_required: setupRequired,
    user: s ? userJson(s.user) : null,
    retailer: s?.retailer ? { id: s.retailer.id, name: s.retailer.name } : null,
  };
}

/** Prints a one-time setup code to the log if none exists yet (OBX_SETUP_CODE wins). */
export async function ensureSetupCode(ctx: Ctx, rotate = false): Promise<void> {
  // Demo mode sets itself up (core/demo.ts); there is no setup wizard to unlock.
  if (ctx.config.setupCode || ctx.config.demo || (await ctx.isSetUp())) return;
  if (!rotate && (await ctx.meta("setup_code_hash"))) return;
  const raw = b64url(randomBytes(9)).replace(/[-_]/g, "x").toUpperCase().slice(0, 12);
  const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  await ctx.setMeta("setup_code_hash", await sha256Hex(code));
  const where = ctx.config.publicUrl ? `open ${ctx.config.publicUrl.replace(/\/+$/, "")} in your browser` : "open the portal in your browser";
  ctx.log("info", `First-run setup code: ${code}  (${where} and enter it in the setup wizard)`);
}

async function checkSetupCode(ctx: Ctx, code: string): Promise<boolean> {
  // Case and surrounding spaces never matter: people read the code from a log or a password manager
  // and type it on whatever keyboard they have.
  if (ctx.config.setupCode) return timingSafeEqualStr(code.trim().toUpperCase(), ctx.config.setupCode.trim().toUpperCase());
  const h = await ctx.meta("setup_code_hash");
  return !!h && timingSafeEqualStr(await sha256Hex(code.trim().toUpperCase()), h);
}

/** Session + CSRF + setup gating for everything under /admin/api. */
export const adminMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ctx = ctxOf(c);
  const path = c.req.path;
  const session = await loadSession(ctx, c.req.header("cookie"));
  c.set("session", session);
  const open = ["/admin/api/public/branding", "/admin/api/public/logo", "/admin/api/setup", "/admin/api/session"];
  if (!(await ctx.isSetUp()) && !open.includes(path)) throw new ObxError("setup_required", "Complete the first-run setup first.");
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const header = c.req.header("x-csrf-token") ?? "";
    const cookie = parseCookies(c.req.header("cookie")).obx_csrf ?? "";
    const ok = header.length >= 16 && timingSafeEqualStr(header, cookie) && (!session || timingSafeEqualStr(header, session.csrf));
    if (!ok) throw new ObxError("csrf_failed", "Missing or wrong X-CSRF-Token. Reload the page and try again.");
  }
  await next();
  if (isAudited(c.req.method, path)) await audit(c);
};

export function actorOf(u: UserRow): AuditActor {
  return { type: "user", id: u.id, name: u.name || u.email, role: u.role };
}

/** One audit entry for this request (after the handler ran, with its status). Never fails the request. */
async function audit(c: C) {
  const ctx = ctxOf(c);
  const route = matchedRoutes(c).filter((r) => r.method !== "ALL").at(-1)?.path ?? c.req.path;
  const s = c.get("session");
  const actor: AuditActor = c.get("auditActor") ?? (s ? actorOf(s.user) : { type: "anonymous", id: null, name: null, role: null });
  const params = c.req.param() as Record<string, string>;
  const targetId = params.id ?? params.external_id ?? params.sha256 ?? null;
  const details: Record<string, unknown> = { ...(c.get("auditDetails") ?? {}) };
  if (s?.retailer) details.retailer_id = s.retailer.id;
  try {
    await writeAudit(ctx, { actor, method: c.req.method, route, targetId, status: c.res.status, requestId: ctx.requestId, ip: clientIp(c), details });
  } catch (e) {
    ctx.log("error", "audit log write failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

export function requireUser(c: C): SessionInfo {
  const s = c.get("session");
  if (!s) throw new ObxError("unauthorized", "Please log in.");
  return s;
}

export function requireAdmin(c: C): SessionInfo {
  const s = requireUser(c);
  if (s.user.role !== "admin") throw new ObxError("forbidden", "Only the brand's administrators can do this.");
  return s;
}

adminAuth.get("/admin/api/public/branding", async (c) => {
  const ctx = ctxOf(c);
  const setUp = await ctx.isSetUp();
  const s = setUp ? await ctx.settings() : defaultSettings();
  return json(c, {
    name: s.branding.display_name || s.company.name || "Open Brand Exchange",
    logo_url: setUp ? await logoUrl(c) : null,
    accent_color: s.branding.accent_color,
    welcome_text: s.branding.welcome_text,
    portal_name: s.branding.portal_name,
    languages: s.portal.languages,
    default_language: s.portal.default_language,
    access_requests_enabled: setUp && s.portal.access_requests_enabled,
    setup_required: !setUp,
    brands: setUp ? (await visibleBrands(ctx, null)).map((b) => ({ id: b.id, name: b.name })) : [],
    // Demo mode only (docs/demo.md): the UI shows the demo banner and the one-click sign-in buttons.
    ...(ctx.config.demo ? { "x-obx-demo": await demoInfo(ctx) } : {}),
  });
});

adminAuth.get("/admin/api/public/logo", async (c) => {
  const ctx = ctxOf(c);
  const s = await ctx.settings();
  if (!s.branding.logo_sha) throw new ObxError("not_found", "No logo.");
  return serveStored(ctx, c.req.raw, {
    key: blobKey(s.branding.logo_sha),
    size: (await ctx.db.first<{ bytes: number }>("SELECT bytes FROM blobs WHERE sha256 = ?", [s.branding.logo_sha]))?.bytes ?? 0,
    contentType: s.branding.logo_type ?? "image/png",
    filename: `logo.${(s.branding.logo_type ?? "image/png").split("/")[1]}`,
    disposition: "inline",
    sha256: s.branding.logo_sha,
    cacheControl: "public, max-age=86400",
  });
});

adminAuth.get("/admin/api/setup", async (c) => json(c, { required: !(await ctxOf(c).isSetUp()) }));

adminAuth.post("/admin/api/setup", async (c) => {
  const ctx = ctxOf(c);
  const rl = await dbLimit(ctx, `setup:${clientIp(c)}`, 10, 900);
  c.set("rl", limitHeaders(rl));
  enforce(rl, "setup attempts");
  if (await ctx.isSetUp()) throw new ObxError("setup_completed", "This portal is already set up. Log in instead.");
  const body = await readObject(c);
  const v = new V();
  const code = v.str(body.setup_code, "/setup_code", { required: true, min: 6, max: 64 });
  const co = (body.company ?? {}) as Record<string, unknown>;
  const ad = (body.admin ?? {}) as Record<string, unknown>;
  const name = v.str(co.name, "/company/name", { required: true, min: 1, max: 200 });
  const firstBrand = v.str(co.first_brand_name, "/company/first_brand_name", { max: 200 });
  const website = v.url(co.website, "/company/website");
  const contact = v.email(co.contact_email, "/company/contact_email");
  const defLang = v.str(co.default_language, "/company/default_language", { required: true, pattern: LANG_RE, msg: "Use a language tag such as nl or en." });
  let langs: string[] = [];
  if (Array.isArray(co.languages)) langs = co.languages.filter((l): l is string => typeof l === "string" && LANG_RE.test(l));
  const accent = v.str(co.accent_color, "/company/accent_color", { pattern: /^#[0-9a-fA-F]{6}$/, msg: "Use a colour like #1F4E5F." });
  const adminName = v.str(ad.name, "/admin/name", { required: true, min: 1, max: 200 });
  const email = v.email(ad.email, "/admin/email", true);
  const pwProblem = passwordProblem(ad.password);
  if (pwProblem) v.err("/admin/password", pwProblem);
  if (!v.ok) throw new ObxError("validation_failed", "Some fields are invalid.", v.errors);
  if (!(await checkSetupCode(ctx, code!))) throw new ObxError("forbidden", "The setup code is wrong. You find it in the server log, or in OBX_SETUP_CODE.", [fieldError("/setup_code", "Wrong setup code.")]);
  const s = defaultSettings();
  s.company = { name: name!, website, contact_email: contact, country: null };
  s.branding.display_name = name!;
  s.branding.accent_color = accent;
  const languages = [defLang!, ...langs.filter((l) => l !== defLang)];
  s.portal.languages = languages;
  s.portal.default_language = defLang!;
  const now = ctx.iso();
  const brandName = firstBrand || name!;
  const brandId = newId("brd");
  const userId = newId("usr");
  const stored = JSON.stringify({ description: null, logo_url: null, name: brandName, website: website ?? null });
  const origin = new URL(c.req.url).origin;
  await ctx.db.batch([
    ctx.metaStmt("settings", JSON.stringify(s)),
    ctx.metaStmt("origin", origin),
    {
      sql: "INSERT INTO brands (id, external_id, status, stored, rep_hash, etag, created_at, updated_at, modified_at) VALUES (?, ?, 'published', ?, '', ?, ?, ?, ?)",
      params: [brandId, slugify(brandName) || "brand", stored, `"${(await sha256Hex(canonicalJson({ ...JSON.parse(stored), status: "published" }))).slice(0, 32)}"`, now, now, now],
    },
    {
      sql: "INSERT INTO changes (type, op, obj_id, external_id, brand_id, product_id, updated_at, created_at) VALUES ('brand', 'upsert', ?, ?, ?, NULL, ?, ?)",
      params: [brandId, slugify(brandName) || "brand", brandId, now, now],
    },
    {
      sql: "INSERT INTO users (id, email, name, role, retailer_id, status, language, password_hash, created_at) VALUES (?, ?, ?, 'admin', NULL, 'active', ?, ?, ?)",
      params: [userId, email!, adminName!, pickLanguage(c.req.header("accept-language"), defLang!.split("-")[0]), await hashPassword(ad.password as string), now],
    },
    ctx.metaStmt("setup_completed_at", now),
  ]);
  await ctx.db.run("DELETE FROM meta WHERE key = 'setup_code_hash'");
  ctx.invalidateSettings();
  const { sid, csrf } = await createSession(ctx, userId);
  setSessionCookies(c, sid, csrf);
  const user = (await ctx.db.first<UserRow>("SELECT * FROM users WHERE id = ?", [userId]))!;
  c.set("auditActor", actorOf(user));
  return json(c, sessionJson(false, csrf, { user, retailer: null }), 201);
});

adminAuth.get("/admin/api/session", async (c) => {
  const ctx = ctxOf(c);
  const s = c.get("session");
  let csrf = s?.csrf ?? parseCookies(c.req.header("cookie")).obx_csrf ?? "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(csrf)) csrf = newCsrf();
  setSessionCookies(c, null, csrf);
  return json(c, sessionJson(!(await ctx.isSetUp()), csrf, s));
});

export async function loginAs(c: C, user: UserRow) {
  const ctx = ctxOf(c);
  c.set("auditActor", actorOf(user));
  const { sid, csrf } = await createSession(ctx, user.id);
  setSessionCookies(c, sid, csrf);
  const retailer = user.retailer_id ? await ctx.db.first<RetailerRow>("SELECT * FROM retailers WHERE id = ?", [user.retailer_id]) : null;
  return sessionJson(false, csrf, { user: (await ctx.db.first<UserRow>("SELECT * FROM users WHERE id = ?", [user.id]))!, retailer });
}

adminAuth.post("/admin/api/session/login", async (c) => {
  const ctx = ctxOf(c);
  const body = await readObject(c);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  // Only failed attempts count: 10 per 15 minutes per address and per account. Colleagues behind
  // one office connection can sign in as often as they like.
  const ipKey = `login:${clientIp(c)}`;
  const accountKey = `login:${await sha256Hex(email)}`;
  enforce(await dbPeek(ctx, ipKey, 10, 900), "login attempts");
  enforce(await dbPeek(ctx, accountKey, 10, 900), "login attempts for this account");
  const user = email ? await ctx.db.first<UserRow>("SELECT * FROM users WHERE email = ?", [email]) : null;
  c.set("auditActor", user ? actorOf(user) : { type: "anonymous", id: null, name: null, role: null });
  if (!user) c.set("auditDetails", { unknown_account: true });
  const ok = await verifyPassword(password.slice(0, 200), user?.password_hash);
  if (!user || !ok) {
    await dbLimit(ctx, ipKey, 10, 900);
    await dbLimit(ctx, accountKey, 10, 900);
    throw new ObxError("invalid_credentials", "E-mail address or password is wrong.");
  }
  if (user.status === "blocked") throw new ObxError("account_blocked", "This account is blocked. Contact the brand.");
  if (user.status !== "active") throw new ObxError("invalid_credentials", "E-mail address or password is wrong.");
  if (user.retailer_id) {
    const r = await ctx.db.first<RetailerRow>("SELECT * FROM retailers WHERE id = ?", [user.retailer_id]);
    if (!r || r.status !== "active") throw new ObxError("account_blocked", "Access for your company is blocked. Contact the brand.");
  }
  if (c.get("session")) await ctx.db.run("DELETE FROM sessions WHERE id_hash = ?", [c.get("session")!.sessionHash]);
  return json(c, await loginAs(c, user));
});

adminAuth.post("/admin/api/session/logout", async (c) => {
  const ctx = ctxOf(c);
  const s = c.get("session");
  if (s) await ctx.db.run("DELETE FROM sessions WHERE id_hash = ?", [s.sessionHash]);
  setSessionCookies(c, "", newCsrf());
  return noContent(c);
});

adminAuth.post("/admin/api/password/forgot", async (c) => {
  const ctx = ctxOf(c);
  const rl = await dbLimit(ctx, `forgot:${clientIp(c)}`, 5, 900);
  enforce(rl, "requests");
  const body = await readObject(c);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const user = email ? await ctx.db.first<UserRow>("SELECT * FROM users WHERE email = ? AND status = 'active'", [email]) : null;
  if (user) {
    const token = b64url(randomBytes(32));
    await ctx.db.run("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [await tokenHash(token), user.id, ctx.iso(3600_000)]);
    ctx.p.defer(sendEmail(ctx, { to: user.email, lang: user.language, template: "passwordReset", name: user.name, vars: {}, link: `${await ctx.mailBaseUrl()}/reset-password/${token}` }));
  }
  return new Response(null, { status: 202 });
});

adminAuth.post("/admin/api/password/reset", async (c) => {
  const ctx = ctxOf(c);
  const rl = await dbLimit(ctx, `reset:${clientIp(c)}`, 10, 900);
  enforce(rl, "attempts");
  const body = await readObject(c);
  const token = typeof body.token === "string" ? body.token : "";
  const problem = passwordProblem(body.password);
  if (problem) throw new ObxError("validation_failed", problem, [fieldError("/password", problem)]);
  const h = await tokenHash(token);
  const r = await ctx.db.first<{ user_id: string; expires_at: string; used_at: string | null }>("SELECT * FROM password_resets WHERE token_hash = ?", [h]);
  if (!r || r.used_at || Date.parse(r.expires_at) < ctx.now()) throw new ObxError("invite_invalid", "This link has expired or was already used. Ask for a new one.");
  const claimed = await ctx.db.run("UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL", [ctx.iso(), h]);
  if (!claimed.changes) throw new ObxError("invite_invalid", "This link was already used.");
  const user = await ctx.db.first<UserRow>("SELECT * FROM users WHERE id = ?", [r.user_id]);
  if (!user || user.status !== "active") throw new ObxError("invite_invalid", "This account is not active.");
  await ctx.db.batch([
    { sql: "UPDATE users SET password_hash = ? WHERE id = ?", params: [await hashPassword(body.password as string), user.id] },
    { sql: "DELETE FROM sessions WHERE user_id = ?", params: [user.id] },
  ]);
  return json(c, await loginAs(c, user));
});

adminAuth.get("/admin/api/invites/:token", async (c) => {
  const ctx = ctxOf(c);
  const rl = await dbLimit(ctx, `inv:${clientIp(c)}`, 30, 900);
  enforce(rl, "requests");
  const u = await findInvite(ctx, c.req.param("token"));
  const r = u.retailer_id ? await ctx.db.first<RetailerRow>("SELECT * FROM retailers WHERE id = ?", [u.retailer_id]) : null;
  return json(c, { email: u.email, name: u.name || null, role: u.role, retailer_name: r?.name ?? null, expires_at: u.invite_expires_at });
});

adminAuth.post("/admin/api/invites/:token/accept", async (c) => {
  const ctx = ctxOf(c);
  const rl = await dbLimit(ctx, `inv:${clientIp(c)}`, 30, 900);
  enforce(rl, "requests");
  const u = await findInvite(ctx, c.req.param("token"));
  const body = await readObject(c);
  const problem = passwordProblem(body.password);
  if (problem) throw new ObxError("validation_failed", problem, [fieldError("/password", problem)]);
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 200) : u.name;
  const lang = typeof body.language === "string" && LANG_RE.test(body.language) ? body.language : u.language;
  const claimed = await ctx.db.run(
    "UPDATE users SET status = 'active', password_hash = ?, name = ?, language = ?, invite_token_hash = NULL, invite_expires_at = NULL WHERE id = ? AND status = 'invited' AND invite_token_hash IS NOT NULL",
    [await hashPassword(body.password as string), name || u.email, lang, u.id],
  );
  if (!claimed.changes) throw new ObxError("invite_invalid", "This link was already used.");
  return json(c, await loginAs(c, u));
});

adminAuth.patch("/admin/api/me", async (c) => {
  const ctx = ctxOf(c);
  const s = requireUser(c);
  const body = await readObject(c);
  const v = new V();
  const name = v.str(body.name, "/name", { min: 1, max: 200 });
  const lang = v.str(body.language, "/language", { pattern: LANG_RE, msg: "Use a language tag such as nl or en." });
  let newHash: string | null = null;
  if (body.new_password !== undefined) {
    const problem = passwordProblem(body.new_password);
    if (problem) v.err("/new_password", problem);
    else if (!(await verifyPassword(String(body.current_password ?? ""), s.user.password_hash))) throw new ObxError("invalid_credentials", "Your current password is wrong.", [fieldError("/current_password", "Wrong password.", "invalid_credentials")]);
    else newHash = await hashPassword(body.new_password as string);
  }
  if (!v.ok) throw new ObxError("validation_failed", "Some fields are invalid.", v.errors);
  const stmts = [{ sql: "UPDATE users SET name = COALESCE(?, name), language = COALESCE(?, language), password_hash = COALESCE(?, password_hash) WHERE id = ?", params: [name, lang, newHash, s.user.id] }];
  if (newHash) stmts.push({ sql: "DELETE FROM sessions WHERE user_id = ? AND id_hash != ?", params: [s.user.id, s.sessionHash] });
  await ctx.db.batch(stmts);
  const user = (await ctx.db.first<UserRow>("SELECT * FROM users WHERE id = ?", [s.user.id]))!;
  return json(c, sessionJson(false, s.csrf, { user, retailer: s.retailer }));
});
