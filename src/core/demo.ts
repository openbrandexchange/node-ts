// Demo mode (OBX_DEMO=true, off by default): a public portal people can look around in without an
// account. It offers a one-click sign-in as a fixed demo retailer and a fixed demo brand admin,
// refuses everything that could leave the demo or lock others out (passwords, e-mail, API keys,
// webhooks, scheduled pulls, large uploads) and puts the fictional catalog back on a schedule.
// Setup and operation: docs/demo.md.
import type { Ctx } from "./ctx";
import { defaultSettings } from "./ctx";
import { blobKey, storeBlob } from "./blobs";
import { getJob } from "./jobs";
import { startImport, type ImportInputs } from "./importjob";
import { storeReader } from "./storeio";
import { readZipDirectory, readZipEntry, type ZipReadEntry } from "../lib/zip";
import { sha256Hex, tokenHash } from "../lib/crypto";
import { canonicalJson, newId, safeJsonParse } from "../lib/util";
import { ObxError } from "../lib/problem";
import type { Stmt } from "../platform";

/** Fixed ids, so sessions survive a reset and the public API key never changes. */
export const DEMO = {
  brandId: "brd_demo_kestrel",
  brandUser: "usr_demo_brand",
  retailer: "rtl_demo_northwind",
  retailerUser: "usr_demo_retailer",
  client: "cli_demo_public",
  /** Published on purpose: it can only read the fictional catalog. */
  clientId: "obxc_demo-portal-read-only",
  clientSecret: "obxs_demo-portal-read-only-public",
  scopes: ["catalog:read", "media:read", "media:original"],
  /** Object key of the seed archive (fixtures + client renditions), see scripts/demo-seed.ts. */
  seedKey: "demo/seed.zip",
} as const;

const DEMO_USERS = [DEMO.brandUser, DEMO.retailerUser];

/** Tables the reset empties (sessions, blobs and rate limits are handled separately). */
const WIPE = [
  "brands",
  "products",
  "variants",
  "assets",
  "changes",
  "retailers",
  "users",
  "password_resets",
  "api_clients",
  "ingest_tokens",
  "access_requests",
  "webhooks",
  "webhook_deliveries",
  "jobs",
  "job_items",
  "import_sources",
  "source_files",
  "uploads",
  "selections",
  "download_events",
  "idempotency",
  "audit_log",
];

export interface DemoSeedManifest {
  products_csv: string;
  assets_csv: string | null;
  images: { file: string; sha256: string; path: string; renditions?: Record<string, { sha256: string; path: string }> }[];
}

export interface DemoState {
  phase: "resetting" | "importing" | "ready" | "failed";
  job_id: string | null;
  reset_at: string;
  error?: string;
}

export async function demoState(ctx: Ctx): Promise<DemoState | null> {
  return safeJsonParse<DemoState | null>(await ctx.meta("demo_state"), null);
}

async function setState(ctx: Ctx, s: DemoState) {
  await ctx.setMeta("demo_state", JSON.stringify(s));
}

/** When the next automatic reset is due (ISO), or null before the first one. */
export function nextResetAt(ctx: Ctx, s: DemoState | null): string | null {
  if (!s) return null;
  return new Date(Date.parse(s.reset_at) + ctx.config.demoResetMinutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** What the UI and the public branding show about the demo. */
export async function demoInfo(ctx: Ctx) {
  const s = await demoState(ctx);
  const base = await ctx.baseUrl();
  return {
    reset_every_minutes: ctx.config.demoResetMinutes,
    last_reset_at: s?.reset_at ?? null,
    next_reset_at: nextResetAt(ctx, s),
    ready: s?.phase === "ready",
    turnstile_site_key: ctx.config.demoTurnstileSiteKey,
    accounts: ["retailer", "brand"],
    api: {
      client_id: DEMO.clientId,
      client_secret: DEMO.clientSecret,
      scopes: [...DEMO.scopes],
      token_endpoint: `${base}/obx/v1/oauth/token`,
      discovery_url: `${base}/.well-known/obx`,
    },
  };
}

// ------------------------------------------------------------------ the seed archive

async function openSeed(ctx: Ctx): Promise<{ manifest: DemoSeedManifest; entries: Map<string, ZipReadEntry> } | null> {
  const head = await ctx.blobs.head(DEMO.seedKey);
  if (!head) return null;
  const read = storeReader(ctx, DEMO.seedKey);
  const dir = await readZipDirectory(read, head.size, 1000);
  const entries = new Map(dir.filter((e) => !e.isDir).map((e) => [e.name, e]));
  const m = entries.get("manifest.json");
  if (!m) throw new Error("demo seed has no manifest.json");
  const manifest = JSON.parse(new TextDecoder().decode(await readZipEntry(read, m, 1048576))) as DemoSeedManifest;
  return { manifest, entries };
}

async function seedEntry(ctx: Ctx, entries: Map<string, ZipReadEntry>, path: string, max = 32 * 1048576): Promise<Uint8Array> {
  const e = entries.get(path);
  if (!e) throw new Error(`demo seed has no ${path}`);
  return readZipEntry(storeReader(ctx, DEMO.seedKey), e, max);
}

// ------------------------------------------------------------------ reset

const DAY = 24 * 3600 * 1000;

/**
 * Puts the demo back to the fixtures: empties every table (keeping the sessions of the two demo
 * accounts and the seed's files), recreates accounts, retailers, the public API key and an access
 * request, and starts the import of the seed catalog. The import runs as a background job; once it
 * finished, demoTick adds example download statistics.
 */
export async function resetDemo(ctx: Ctx): Promise<DemoState> {
  const now = ctx.iso();
  // A reset can take longer than a minute (the first one stores the seed's images): the next
  // tick must not start another one meanwhile.
  await setState(ctx, { phase: "resetting", job_id: null, reset_at: now });
  const seed = await openSeed(ctx);
  const keepShas = new Set<string>();
  if (seed) for (const img of seed.manifest.images) {
    keepShas.add(img.sha256);
    for (const r of Object.values(img.renditions ?? {})) keepShas.add(r.sha256);
  }

  // 1. Empty the database. Old change-feed cursors must not continue into the new catalog.
  const floor = ((await ctx.db.first<{ m: number | null }>("SELECT MAX(seq) AS m FROM changes"))?.m ?? 0) + 1;
  const ph = DEMO_USERS.map(() => "?").join(", ");
  await ctx.db.batch([
    ...WIPE.map((t) => ({ sql: `DELETE FROM ${t}`, params: [] })),
    { sql: `DELETE FROM sessions WHERE user_id NOT IN (${ph})`, params: [...DEMO_USERS] },
    { sql: "DELETE FROM meta WHERE key IN ('settings', 'setup_completed_at', 'setup_code_hash', 'counts_snapshot')", params: [] },
    ctx.metaStmt("changes_floor_seq", String(floor)),
    ctx.metaStmt("demo_state", JSON.stringify({ phase: "resetting", job_id: null, reset_at: now } satisfies DemoState)),
  ]);
  ctx.invalidateSettings();

  // 2. Files: everything except the seed archive and the seed's images goes.
  const blobRows = await ctx.db.all<{ sha256: string }>("SELECT sha256 FROM blobs");
  const dropShas = blobRows.map((r) => r.sha256).filter((s) => !keepShas.has(s));
  for (let i = 0; i < dropShas.length; i += 90) {
    const chunk = dropShas.slice(i, i + 90);
    await ctx.db.run(`DELETE FROM blobs WHERE sha256 IN (${chunk.map(() => "?").join(", ")})`, chunk);
  }
  const keepKeys = new Set([...keepShas].map(blobKey));
  let cursor: string | undefined;
  do {
    const page = await ctx.blobs.list("", cursor);
    const drop = page.keys.filter((k) => !k.startsWith("demo/") && !keepKeys.has(k));
    if (drop.length) await ctx.blobs.delete(drop);
    cursor = page.cursor ?? undefined;
  } while (cursor);

  // 3. Accounts, retailers, the public API key, an open access request.
  const s = defaultSettings();
  s.company = { name: "Kestrel Outfitters", website: "https://kestrel.example", contact_email: "trade@kestrel.example", country: "NL" };
  s.branding.display_name = "Kestrel";
  s.branding.accent_color = "#1F4E5F";
  s.branding.welcome_text = {
    en: "Kestrel is a fictional brand. Everything in this demo is test data and is reset every hour.",
    nl: "Kestrel is een fictief merk. Alles in deze demo is testdata en wordt elk uur teruggezet.",
  };
  s.portal.languages = ["en", "nl"];
  s.portal.default_language = "en";
  s.portal.retailer_api_self_service = false;
  const stored = JSON.stringify({ description: null, logo_url: null, name: "Kestrel", website: "https://kestrel.example" });
  const brandEtag = `"${(await sha256Hex(canonicalJson({ ...JSON.parse(stored), status: "published" }))).slice(0, 32)}"`;
  const retailers: [string, string, string, string | null, number | null, "active" | "blocked"][] = [
    [DEMO.retailer, "Northwind Stores", "NWS-001", null, null, "active"],
    ["rtl_demo_harbour", "Harbour & Co", "HBR-014", JSON.stringify([DEMO.brandId]), 0, "active"],
    ["rtl_demo_lumen", "Lumen Concept Store", "LMN-207", null, null, "blocked"],
  ];
  const users: [string, string, string, "admin" | "retailer", string | null][] = [
    [DEMO.brandUser, "brand@kestrel.example", "Demo brand admin", "admin", null],
    [DEMO.retailerUser, "buyer@northwind.example", "Demo retailer", "retailer", DEMO.retailer],
    ["usr_demo_harbour", "orders@harbour.example", "Harbour buyer", "retailer", "rtl_demo_harbour"],
  ];
  const stmts: Stmt[] = [
    ctx.metaStmt("settings", JSON.stringify(s)),
    ctx.metaStmt("setup_completed_at", now),
    {
      sql: "INSERT INTO brands (id, external_id, status, stored, rep_hash, etag, created_at, updated_at, modified_at) VALUES (?, 'kestrel', 'published', ?, '', ?, ?, ?, ?)",
      params: [DEMO.brandId, stored, brandEtag, now, now, now],
    },
    { sql: "INSERT INTO changes (type, op, obj_id, external_id, brand_id, product_id, updated_at, created_at) VALUES ('brand', 'upsert', ?, 'kestrel', ?, NULL, ?, ?)", params: [DEMO.brandId, DEMO.brandId, now, now] },
    ...retailers.map(([id, name, ref, brands, orig, status]) => ({
      sql: "INSERT INTO retailers (id, name, reference, website, vat_number, country, notes, status, brand_ids, allow_original, grant_updated_at, created_at) VALUES (?, ?, ?, NULL, NULL, 'NL', 'Fictional retailer (demo).', ?, ?, ?, ?, ?)",
      params: [id, name, ref, status, brands, orig, now, now],
    })),
    ...users.map(([id, email, name, role, retailer]) => ({
      // No password: these accounts are only reachable through the demo sign-in buttons.
      sql: "INSERT INTO users (id, email, name, role, retailer_id, status, language, password_hash, created_at) VALUES (?, ?, ?, ?, ?, 'active', 'en', NULL, ?)",
      params: [id, email, name, role, retailer, now],
    })),
    {
      sql: "INSERT INTO api_clients (id, client_id, secret_hash, secret_version, name, retailer_id, scopes, status, created_by, created_at) VALUES (?, ?, ?, 1, 'Public demo key (read-only)', ?, ?, 'active', 'demo', ?)",
      params: [DEMO.client, DEMO.clientId, await tokenHash(DEMO.clientSecret), DEMO.retailer, JSON.stringify(DEMO.scopes), now],
    },
    {
      sql: "INSERT INTO access_requests (id, status, retailer, contact, access, requested_brand_ids, message, request_token_hash, created_at) VALUES ('acr_demo_fjord', 'pending', ?, ?, '[\"portal\",\"api\"]', NULL, ?, ?, ?)",
      params: [
        JSON.stringify({ name: "Fjord Outdoor", reference: null, website: "https://fjord.example", vat_number: null, country: "NO" }),
        JSON.stringify({ name: "Ingrid Berg", email: "ingrid@fjord.example", phone: null, language: "en" }),
        "We would like to sell the Kestrel collection in our three stores.",
        await tokenHash(`demo-${now}`),
        ctx.iso(-2 * 3600_000),
      ],
    },
  ];
  await ctx.db.batch(stmts);
  ctx.invalidateSettings();

  if (!seed) {
    ctx.log("warn", `demo: no seed archive at ${DEMO.seedKey}; the catalog stays empty (see docs/demo.md)`);
    const st: DemoState = { phase: "ready", job_id: null, reset_at: now };
    await setState(ctx, st);
    return st;
  }

  // 4. The seed's images (kept between resets, content-addressed) and the import of the catalog.
  const known = new Set<string>();
  const shas = [...keepShas];
  for (let i = 0; i < shas.length; i += 90) {
    const chunk = shas.slice(i, i + 90);
    for (const r of await ctx.db.all<{ sha256: string }>(`SELECT sha256 FROM blobs WHERE sha256 IN (${chunk.map(() => "?").join(", ")})`, chunk)) known.add(r.sha256);
  }
  for (const img of seed.manifest.images)
    for (const f of [{ sha256: img.sha256, path: img.path }, ...Object.values(img.renditions ?? {})])
      if (!known.has(f.sha256)) {
        await storeBlob(ctx, await seedEntry(ctx, seed.entries, f.path), f.sha256);
        known.add(f.sha256);
      }
  const jobId = newId("job");
  const put = async (name: string, bytes: Uint8Array) => {
    const key = `imports/${jobId}/${name}`;
    await ctx.blobs.put(key, bytes);
    return { key, offset: 0, length: bytes.length };
  };
  const csv = await seedEntry(ctx, seed.entries, seed.manifest.products_csv);
  const assets = seed.manifest.assets_csv ? await seedEntry(ctx, seed.entries, seed.manifest.assets_csv) : null;
  const list = seed.manifest.images.map((i) => ({ file: i.file, sha256: i.sha256, renditions: Object.fromEntries(Object.entries(i.renditions ?? {}).map(([k, r]) => [k, { sha256: r.sha256 }])) }));
  const inputs: ImportInputs = {
    csv: { ...(await put("products.csv", csv)), name: "products.csv" },
    assets: assets ? { ...(await put("assets.csv", assets)), name: "assets.csv" } : null,
    zips: [],
    files: [],
    manifest: await put("images_manifest.json", new TextEncoder().encode(JSON.stringify(list))),
  };
  await startImport(ctx, { trigger: "api", mode: "upsert", dry_run: false, allow_mass_unpublish: false, default_language: "en", allowed_brands: null, inputs, started_by: "admin" }, { owner: "admin", id: jobId });
  const st: DemoState = { phase: "importing", job_id: jobId, reset_at: now };
  await setState(ctx, st);
  ctx.log("info", "demo: reset, catalog import started", { job_id: jobId });
  return st;
}

/** Example download statistics over the last 30 days (deterministic, so every reset looks the same). */
async function seedStats(ctx: Ctx) {
  const products = await ctx.db.all<{ id: string }>("SELECT id FROM products ORDER BY external_id");
  const assets = await ctx.db.all<{ id: string; product_id: string }>("SELECT id, product_id FROM assets ORDER BY external_id");
  if (!products.length) return;
  let x = 20261112;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const who = [
    { id: DEMO.retailer, name: "Northwind Stores", actor: "user", actorName: "Demo retailer", weight: 0.6 },
    { id: DEMO.retailer, name: "Northwind Stores", actor: "api_client", actorName: "Public demo key (read-only)", weight: 0.85 },
    { id: "rtl_demo_harbour", name: "Harbour & Co", actor: "user", actorName: "Harbour buyer", weight: 1 },
  ];
  const kinds = ["image", "image", "image", "product_zip", "selection_zip", "csv", "api_rendition", "api_rendition", "usage"] as const;
  const stmts: Stmt[] = [];
  for (let i = 0; i < 140; i++) {
    const r = rnd();
    const w = who.find((v) => r <= v.weight)!;
    const kind = w.actor === "api_client" ? (rnd() < 0.8 ? "api_rendition" : "usage") : kinds[Math.floor(rnd() * 6)];
    const a = assets.length ? assets[Math.floor(rnd() * assets.length)] : null;
    const productId = a?.product_id ?? products[Math.floor(rnd() * products.length)].id;
    const files = kind === "product_zip" ? 4 + Math.floor(rnd() * 4) : kind === "selection_zip" ? 8 + Math.floor(rnd() * 12) : kind === "csv" ? 0 : 1;
    const variant = kind === "image" || kind === "api_rendition" ? ["web", "square", "thumb", "original"][Math.floor(rnd() * 4)] : kind === "usage" ? "web" : null;
    stmts.push({
      sql: "INSERT INTO download_events (id, at, kind, retailer_id, retailer_name, actor_type, actor_name, variant, product_id, asset_id, usage_event, files, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params: [
        newId("dle"),
        ctx.iso(-Math.floor(rnd() * 30 * DAY)),
        kind,
        w.id,
        w.name,
        w.actor,
        w.actorName,
        variant,
        kind === "csv" || kind === "selection_zip" ? null : productId,
        kind === "image" || kind === "api_rendition" || kind === "usage" ? (a?.id ?? null) : null,
        kind === "usage" ? (rnd() < 0.5 ? "published" : "synced") : null,
        files,
        files ? files * (60_000 + Math.floor(rnd() * 400_000)) : 4_000 + Math.floor(rnd() * 20_000),
      ],
    });
  }
  await ctx.db.batch(stmts);
  await ctx.db.run("UPDATE retailers SET last_activity_at = ? WHERE id IN (?, 'rtl_demo_harbour')", [ctx.iso(-3600_000), DEMO.retailer]);
}

/**
 * Called from the minute tick: resets when the interval passed (or the demo was never set up) and
 * finishes a reset once its catalog import is done.
 */
/** A reset still running (or one that died: after 10 minutes the next tick starts over). */
function resetting(ctx: Ctx, s: DemoState | null): boolean {
  return s?.phase === "resetting" && ctx.now() - Date.parse(s.reset_at) < 10 * 60_000;
}

export async function demoTick(ctx: Ctx): Promise<void> {
  const s = await demoState(ctx);
  if (resetting(ctx, s)) return;
  if (!s || !(await ctx.isSetUp()) || ctx.now() >= Date.parse(nextResetAt(ctx, s)!)) {
    await resetDemo(ctx);
    return;
  }
  if (s.phase === "importing" && s.job_id) await finishIfImported(ctx, s);
}

async function finishIfImported(ctx: Ctx, s: DemoState) {
  const job = await getJob(ctx, s.job_id!);
  if (!job || job.status === "queued" || job.status === "running") return;
  if (job.status === "succeeded") await seedStats(ctx);
  await setState(ctx, { ...s, phase: job.status === "succeeded" ? "ready" : "failed", ...(job.status === "succeeded" ? {} : { error: job.error ?? "import failed" }) });
}

/** Makes sure a demo exists before someone signs in (first visit after a deploy). */
export async function ensureDemo(ctx: Ctx): Promise<void> {
  const s = await demoState(ctx);
  if (resetting(ctx, s)) return;
  if (!s || !(await ctx.isSetUp())) await resetDemo(ctx);
  else if (s.phase === "importing" && s.job_id) await finishIfImported(ctx, s);
}

// ------------------------------------------------------------------ what the demo refuses

export type DemoRefusal = { code: "forbidden" | "not_implemented" | "payload_too_large"; detail: string };

const refuse = (detail: string): DemoRefusal => ({ code: "forbidden", detail: `${detail} This is not possible in the demo.` });

/**
 * The demo's rules for one request (null: allowed). `body` is the parsed JSON body for the few
 * routes whose answer depends on it.
 */
export function demoRefusal(method: string, path: string, body: Record<string, unknown> | null): DemoRefusal | null {
  const write = !["GET", "HEAD", "OPTIONS"].includes(method);
  const p = path.replace(/\/+$/, "");
  if (p.startsWith("/obx/v1/webhooks")) return { code: "not_implemented", detail: "The demo portal does not send webhooks." };
  if (p === "/obx/v1/usage") return { code: "not_implemented", detail: "The demo portal's key can only read, so it does not take usage events." };
  if (p === "/obx/v1/ingest" || p.startsWith("/obx/v1/ingest/")) return { code: "not_implemented", detail: "The demo portal has no Ingest API; try the Excel import as the demo brand." };
  if (!write) {
    if (p.startsWith("/admin/api/invites/")) return refuse("Invitations are switched off.");
    return null;
  }
  const rules: [RegExp, string][] = [
    [/^\/admin\/api\/setup$/, "The demo is already set up."],
    [/^\/admin\/api\/password\//, "Passwords cannot be reset."],
    [/^\/admin\/api\/invites\//, "Invitations are switched off."],
    [/^\/admin\/api\/me$/, "The demo accounts cannot be removed."],
    [/^\/admin\/api\/settings\/logo$/, "The logo cannot be changed."],
    [/^\/admin\/api\/import-sources(\/[^/]+(\/(run|test))?)?$/, "Scheduled imports from other servers are switched off."],
    [/^\/admin\/api\/users\/invites$/, "No e-mail is sent, so nobody can be invited."],
    [/^\/admin\/api\/users\/[^/]+\/resend-invite$/, "No e-mail is sent, so nobody can be invited."],
    [new RegExp(`^/admin/api/users/(${DEMO_USERS.join("|")})$`), "The demo accounts cannot be changed."],
    [new RegExp(`^/admin/api/retailers/${DEMO.retailer}$`), "Northwind Stores is the shared demo retailer and cannot be changed; try Harbour & Co."],
    [/^\/admin\/api\/(portal\/)?api-clients(\/|$)/, "No API keys can be created or changed; use the public read-only demo key."],
    [/^\/admin\/api\/ingest-tokens(\/|$)/, "No upload keys can be created or changed."],
    [/^\/admin\/api\/webhooks(\/[^/]+(\/test)?)?$/, "Webhooks are switched off."],
    [/^\/admin\/api\/catalog\/(brands|products|variants|assets)\/[^/]+$/, "Catalog records cannot be deleted (unpublish them instead)."],
  ];
  for (const [re, why] of rules) {
    if (!re.test(p)) continue;
    // Deleting things nobody else relies on stays possible.
    if (method === "DELETE" && /^\/admin\/api\/(import-sources|webhooks)\/[^/]+$/.test(p)) return null;
    if (p === "/admin/api/me" && method === "PATCH") break;
    if (p.startsWith("/admin/api/catalog/") && method !== "DELETE") continue;
    return refuse(why);
  }
  if (p === "/admin/api/me" && method === "PATCH" && body && ("new_password" in body || "current_password" in body || "email" in body))
    return refuse("The password and e-mail address of the demo accounts cannot be changed.");
  if (p === "/admin/api/settings" && method === "PATCH" && body && ("company" in body || "branding" in body))
    return refuse("The brand's name, colours and texts are the same for every visitor.");
  if (/^\/admin\/api\/access-requests\/[^/]+\/approve$/.test(p) && (!body || body.create_api_client !== false))
    return refuse("Approving with an API key would create a new key. Untick API access, or decline the request.");
  return null;
}

/** Routes whose refusal depends on the JSON body. */
export function demoNeedsBody(method: string, path: string): boolean {
  return (method === "PATCH" && (path === "/admin/api/me" || path === "/admin/api/settings")) || (method === "POST" && /^\/admin\/api\/access-requests\/[^/]+\/approve$/.test(path));
}

export function demoError(r: DemoRefusal): ObxError {
  return new ObxError(r.code, r.detail, [], { extensions: { "x-obx-demo": true } });
}

/** Turnstile check for the demo sign-in buttons (only when a secret is configured). */
export async function verifyTurnstile(ctx: Ctx, token: unknown, ip: string): Promise<void> {
  const secret = ctx.config.demoTurnstileSecret;
  if (!secret) return;
  if (typeof token !== "string" || !token || token.length > 4096) throw new ObxError("forbidden", "Confirm that you are a person first.", [], { extensions: { "x-obx-demo": true } });
  const body = new URLSearchParams({ secret, response: token });
  if (ip && ip !== "unknown") body.set("remoteip", ip);
  let ok = false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    ok = !!((await r.json()) as { success?: boolean }).success;
  } catch (e) {
    ctx.log("warn", "demo: Turnstile check failed", { error: e instanceof Error ? e.message : String(e) });
  }
  if (!ok) throw new ObxError("forbidden", "The check that you are a person failed. Reload the page and try again.", [], { extensions: { "x-obx-demo": true } });
}

