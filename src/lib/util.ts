// Small, dependency-free helpers shared by every part of the node.

const te = new TextEncoder();
const td = new TextDecoder();

export const utf8 = (s: string): Uint8Array => te.encode(s);
export const fromUtf8 = (b: Uint8Array | ArrayBuffer): string =>
  td.decode(b instanceof Uint8Array ? b : new Uint8Array(b));

/** RFC 3339 timestamp in UTC without milliseconds, e.g. 2026-09-28T10:00:00Z. */
export function isoNow(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Normalise an RFC 3339 input or YYYY-MM-DD date to our canonical UTC form. Returns null when invalid. */
export function normDateTime(v: unknown): string | null {
  if (typeof v !== "string" || v.length < 10 || v.length > 40) return null;
  let s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T00:00:00Z";
  if (!/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/.test(s)) return null;
  const t = Date.parse(s.replace(" ", "T"));
  if (Number.isNaN(t)) return null;
  return isoNow(t);
}

export function toHex(b: ArrayBuffer | Uint8Array): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, "0");
  return s;
}

export function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export function b64url(b: Uint8Array | ArrayBuffer): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

const B32 = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford, lowercase

/** Time-sortable, opaque id with a readable prefix: prd_01j9zk3q7t5w… */
export function newId(prefix: string, nowMs = Date.now()): string {
  let t = Math.floor(nowMs);
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const r = randomBytes(10);
  let rand = "";
  for (let i = 0; i < 10; i++) rand += B32[r[i] & 31];
  return `${prefix}_${time}${rand}`;
}

/** A random secret with a recognisable prefix (>= 160 bits of entropy). */
export function newSecret(prefix: string, bytes = 24): string {
  return `${prefix}${b64url(randomBytes(bytes))}`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function intParam(v: string | undefined | null, def: number, lo: number, hi: number): number | null {
  if (v === undefined || v === null || v === "") return def;
  if (!/^\d+$/.test(v)) return null;
  const n = parseInt(v, 10);
  if (n < lo || n > hi) return null;
  return n;
}

/** Canonical JSON: object keys sorted, used for equality and hashing of representations. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** RFC 7396 JSON merge patch. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Slug rule from docs/ingest.md §2. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function safeJsonParse<T = unknown>(s: string | null | undefined, fallback: T): T {
  if (s === null || s === undefined || s === "") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Filename safe for Content-Disposition and zip entries: no path separators, no control characters. */
export function sanitizeFilename(name: string, fallback = "file"): string {
  let s = name.replace(/[\x00-\x1f\x7f]/g, "").replace(/[\\/:*?"<>|]/g, "_").trim();
  s = s.replace(/^\.+/, "");
  if (s === "" || s === "." || s === "..") s = fallback;
  return s.slice(0, 200);
}

export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");
  if (ascii === safe) return `${kind}; filename="${ascii}"`;
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
