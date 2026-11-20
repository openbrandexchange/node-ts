// Per-node context: platform + keys + settings. Created once per request (cheap) or per background run.
import type { Platform } from "../platform";
import { Keyring } from "../lib/crypto";
import { isoNow, safeJsonParse, mergePatch, isPlainObject, newId } from "../lib/util";
import { migrate, UNDERLYING_DB } from "../db/migrate";
import type { UrlPolicy } from "../lib/ssrf";

export type Rights = {
  license: "retailer-use" | "custom";
  license_text: string | null;
  channels: string[];
  territories: string[] | null;
  embargo_until: string | null;
  expires_at: string | null;
  credit: string | null;
  model_release: boolean | null;
};

export const SPEC_DEFAULT_RIGHTS: Rights = {
  license: "retailer-use",
  license_text: null,
  channels: ["webshop", "marketplace", "social"],
  territories: null,
  embargo_until: null,
  expires_at: null,
  credit: null,
  model_release: null,
};

export interface SettingsData {
  company: { name: string; website: string | null; contact_email: string | null; country: string | null };
  branding: {
    display_name: string;
    logo_sha: string | null;
    logo_type: string | null;
    accent_color: string | null;
    welcome_text: Record<string, string> | null;
    portal_name: Record<string, string> | null;
    favicon_sha: string | null;
    favicon_type: string | null;
    /** Portal appearance (core/branding.ts); stored as sent, unknown members included. */
    theme: Record<string, unknown> | null;
    login: Record<string, unknown> | null;
    home: Record<string, unknown> | null;
  };
  portal: {
    access_requests_enabled: boolean;
    allow_original_download: boolean;
    allow_article_data_export: boolean;
    retailer_api_self_service: boolean;
    languages: string[];
    default_language: string;
  };
  defaults: { rights: Rights; ingest_status: "published" | "unpublished" };
  /** How long personal and usage data is kept (days). See docs/privacy-notice-template.md. */
  retention: {
    /** Download statistics (per retailer, per article). Names of the people who downloaded are removed after 400 days or sooner. */
    download_events_days: number;
    /** Audit log of admin actions. */
    audit_log_days: number;
    /** IP addresses in the audit log (at most 30 days, security.md §9). */
    ip_days: number;
    /** Decided (approved or declined) access requests with their contact details. */
    access_requests_days: number;
  };
}

/** Allowed ranges in days, the same in every node edition. */
export const RETENTION_LIMITS: Record<keyof SettingsData["retention"], [number, number]> = {
  download_events_days: [30, 3650],
  audit_log_days: [30, 3650],
  ip_days: [1, 30],
  access_requests_days: [30, 3650],
};

export function defaultSettings(): SettingsData {
  return {
    company: { name: "", website: null, contact_email: null, country: null },
    branding: {
      display_name: "",
      logo_sha: null,
      logo_type: null,
      accent_color: null,
      welcome_text: null,
      portal_name: null,
      favicon_sha: null,
      favicon_type: null,
      theme: null,
      login: null,
      home: null,
    },
    portal: {
      access_requests_enabled: true,
      allow_original_download: true,
      allow_article_data_export: true,
      retailer_api_self_service: false,
      languages: ["en"],
      default_language: "en",
    },
    defaults: { rights: { ...SPEC_DEFAULT_RIGHTS }, ingest_status: "published" },
    retention: { download_events_days: 730, audit_log_days: 365, ip_days: 30, access_requests_days: 365 },
  };
}

/**
 * Meta rows that nearly every request reads (settings, setup flag, demo state, origin, node id).
 * They are loaded together in one query and shared by the requests of this isolate/process for
 * META_TTL_MS: on D1 every query is a network round trip. Writes through Ctx update the shared copy
 * at once; another Workers isolate sees a change after at most META_TTL_MS.
 */
const HOT_META = ["settings", "setup_completed_at", "demo_state", "demo_dirty", "origin", "node_id"];
export const META_TTL_MS = 5000;
const sharedMeta = new WeakMap<object, { at: number; values: Map<string, string | null> }>();

function metaKeyOf(db: object): object {
  return (db as Record<symbol, object>)[UNDERLYING_DB] ?? db;
}

/** Forget the shared meta rows of a database (after writing meta outside Ctx, e.g. in tests). */
export function invalidateSharedMeta(db: object) {
  sharedMeta.delete(metaKeyOf(db));
}

export class Ctx {
  readonly keys: Keyring;
  private settingsCache: SettingsData | null = null;
  private metaCache = new Map<string, string | null>();
  /** Origin of the current request, used when OBX_PUBLIC_URL is not set. */
  requestOrigin: string | null = null;
  /** X-Request-Id of the current request (added to every log line); null in background runs. */
  requestId: string | null = null;

  constructor(public readonly p: Platform) {
    this.keys = new Keyring(p.config.secretKey);
  }

  get db() {
    return this.p.db;
  }
  get blobs() {
    return this.p.blobs;
  }
  get config() {
    return this.p.config;
  }

  now(): number {
    return this.p.now();
  }
  /**
   * True when a background step should checkpoint now: its time is up, or (on Workers) this
   * invocation is close to D1's cap on queries per invocation (1,000 on Workers Paid).
   */
  overBudget(deadline: number): boolean {
    return this.p.now() >= deadline || (this.p.queryBudgetLeft?.() ?? Infinity) <= 0;
  }
  iso(offsetMs = 0): string {
    return isoNow(this.p.now() + offsetMs);
  }

  async ready(): Promise<void> {
    await migrate(this.p.db);
  }

  async meta(key: string): Promise<string | null> {
    if (this.metaCache.has(key)) return this.metaCache.get(key)!;
    if (HOT_META.includes(key)) {
      const dbKey = metaKeyOf(this.db);
      let hit = sharedMeta.get(dbKey);
      if (!hit || Date.now() - hit.at >= META_TTL_MS) {
        const rows = await this.db.all<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key IN (${HOT_META.map(() => "?").join(", ")})`, HOT_META);
        const values = new Map<string, string | null>(HOT_META.map((k) => [k, null]));
        for (const r of rows) values.set(r.key, r.value);
        hit = { at: Date.now(), values };
        sharedMeta.set(dbKey, hit);
      }
      for (const [k, v] of hit.values) if (!this.metaCache.has(k)) this.metaCache.set(k, v);
      return this.metaCache.get(key) ?? null;
    }
    const row = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]);
    const v = row?.value ?? null;
    this.metaCache.set(key, v);
    return v;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
    this.cacheMeta(key, value);
  }

  private cacheMeta(key: string, value: string | null) {
    this.metaCache.set(key, value);
    if (HOT_META.includes(key)) sharedMeta.get(metaKeyOf(this.db))?.values.set(key, value);
  }

  /** Forget cached meta rows (this request's and the shared copy) after deleting them with SQL. */
  forgetMeta() {
    this.metaCache.clear();
    this.settingsCache = null;
    invalidateSharedMeta(this.db);
  }

  metaStmt(key: string, value: string): { sql: string; params: (string | number | null)[] } {
    this.cacheMeta(key, value);
    return { sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params: [key, value] };
  }

  async isSetUp(): Promise<boolean> {
    return (await this.meta("setup_completed_at")) !== null;
  }

  async nodeId(): Promise<string> {
    let id = await this.meta("node_id");
    if (!id) {
      id = newId("node");
      await this.db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('node_id', ?)", [id]);
      this.metaCache.delete("node_id");
      invalidateSharedMeta(this.db);
      id = (await this.meta("node_id"))!;
    }
    return id;
  }

  async settings(): Promise<SettingsData> {
    if (this.settingsCache) return this.settingsCache;
    const raw = await this.meta("settings");
    const base = defaultSettings();
    const stored = safeJsonParse<Partial<SettingsData>>(raw, {});
    // Until 0.1.0 the download-statistics retention was stored as download_stats_days; the other
    // portals (and the settings API now) call it download_events_days.
    const ret = stored.retention as (Partial<SettingsData["retention"]> & { download_stats_days?: number }) | undefined;
    if (ret && ret.download_stats_days !== undefined) {
      ret.download_events_days ??= ret.download_stats_days;
      delete ret.download_stats_days;
    }
    const merged = mergePatch(base, stored) as SettingsData;
    if (!isPlainObject(merged.defaults.rights)) merged.defaults.rights = { ...SPEC_DEFAULT_RIGHTS };
    this.settingsCache = merged;
    return merged;
  }

  async saveSettings(s: SettingsData): Promise<void> {
    await this.setMeta("settings", JSON.stringify(s));
    this.settingsCache = s;
  }

  invalidateSettings() {
    this.settingsCache = null;
    this.metaCache.delete("settings");
    invalidateSharedMeta(this.db);
  }

  /** Public base URL without trailing slash. */
  async baseUrl(): Promise<string> {
    const configured = this.config.publicUrl;
    if (configured) return configured.replace(/\/+$/, "");
    if (this.requestOrigin) return this.requestOrigin;
    return ((await this.meta("origin")) ?? "http://localhost:8080").replace(/\/+$/, "");
  }

  /**
   * Base URL for links in e-mails: OBX_PUBLIC_URL, else the address the node
   * was set up at. Never the Host of an arbitrary later request: a forged
   * Host header must not end up in password-reset or invitation links.
   */
  async mailBaseUrl(): Promise<string> {
    const configured = this.config.publicUrl;
    if (configured) return configured.replace(/\/+$/, "");
    const recorded = await this.meta("origin");
    if (recorded) return recorded.replace(/\/+$/, "");
    return this.baseUrl();
  }

  urlPolicy(schemes?: string[]): UrlPolicy {
    return { allowPrivate: this.config.allowPrivateUrls, resolve: this.p.resolveHost, schemes, pin: this.p.pinConnections };
  }

  log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) {
    this.p.log(level, msg, this.requestId ? { request_id: this.requestId, ...(extra ?? {}) } : extra);
  }
}
