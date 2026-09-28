// Per-node context: platform + keys + settings. Created once per request (cheap) or per background run.
import type { Platform } from "../platform";
import { Keyring } from "../lib/crypto";
import { isoNow, safeJsonParse, mergePatch, isPlainObject, newId } from "../lib/util";
import { migrate } from "../db/migrate";
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
}

export function defaultSettings(): SettingsData {
  return {
    company: { name: "", website: null, contact_email: null, country: null },
    branding: { display_name: "", logo_sha: null, logo_type: null, accent_color: null, welcome_text: null, portal_name: null },
    portal: {
      access_requests_enabled: true,
      allow_original_download: true,
      allow_article_data_export: true,
      retailer_api_self_service: false,
      languages: ["en"],
      default_language: "en",
    },
    defaults: { rights: { ...SPEC_DEFAULT_RIGHTS }, ingest_status: "published" },
  };
}

export class Ctx {
  readonly keys: Keyring;
  private settingsCache: SettingsData | null = null;
  private metaCache = new Map<string, string | null>();
  /** Origin of the current request, used when OBX_PUBLIC_URL is not set. */
  requestOrigin: string | null = null;

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
  iso(offsetMs = 0): string {
    return isoNow(this.p.now() + offsetMs);
  }

  async ready(): Promise<void> {
    await migrate(this.p.db);
  }

  async meta(key: string): Promise<string | null> {
    if (this.metaCache.has(key)) return this.metaCache.get(key)!;
    const row = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]);
    const v = row?.value ?? null;
    this.metaCache.set(key, v);
    return v;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
    this.metaCache.set(key, value);
  }

  metaStmt(key: string, value: string): { sql: string; params: (string | number | null)[] } {
    this.metaCache.set(key, value);
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
      id = (await this.meta("node_id"))!;
    }
    return id;
  }

  async settings(): Promise<SettingsData> {
    if (this.settingsCache) return this.settingsCache;
    const raw = await this.meta("settings");
    const base = defaultSettings();
    const stored = safeJsonParse<Partial<SettingsData>>(raw, {});
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
    this.p.log(level, msg, extra);
  }
}
