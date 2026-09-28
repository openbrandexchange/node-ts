// Scheduled pull imports: HTTPS URL, S3-compatible bucket, SFTP folder (SFTP on the Bun build only).
import { AwsClient } from "aws4fetch";
import type { Ctx } from "./ctx";
import { ObxError } from "../lib/problem";
import { safeFetch, assertSafeUrl } from "../lib/ssrf";
import { safeJsonParse } from "../lib/util";
import { sha256Hex } from "../lib/crypto";
import { streamToStore } from "./storeio";
import { IMAGE_EXT } from "./importformat";
import type { ImportInputs } from "./importjob";

export interface SourceRow {
  id: string;
  name: string;
  kind: "https_url" | "sftp" | "s3";
  enabled: number;
  schedule: string;
  mode: "upsert" | "mirror";
  allow_mass_unpublish: number;
  config: string;
  credentials_enc: string | null;
  credentials_set: string;
  fingerprint: string | null;
  last_run_id: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Credentials {
  password?: string | null;
  private_key?: string | null;
  access_key_id?: string | null;
  secret_access_key?: string | null;
  headers?: Record<string, string> | null;
}

const MAX_SOURCE_BYTES = 2 * 1024 * 1048576;

export async function credentialsOf(ctx: Ctx, src: SourceRow): Promise<Credentials> {
  if (!src.credentials_enc) return {};
  try {
    return JSON.parse(await ctx.keys.decrypt(src.credentials_enc)) as Credentials;
  } catch {
    throw new ObxError("internal_error", "Stored credentials could not be decrypted (was OBX_SECRET_KEY changed?). Enter them again.");
  }
}

// ------------------------------------------------------------------ S3

interface S3Object {
  key: string;
  etag: string;
  size: number;
  modified: string | null;
}

function xmlDecode(s: string) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function s3Base(cfg: Record<string, unknown>): string {
  const region = String(cfg.region || "us-east-1");
  const bucket = String(cfg.bucket);
  const endpoint = typeof cfg.endpoint === "string" && cfg.endpoint ? cfg.endpoint.replace(/\/+$/, "") : null;
  if (endpoint) {
    if (cfg.path_style === false) {
      const u = new URL(endpoint);
      return `${u.protocol}//${bucket}.${u.host}`;
    }
    return `${endpoint}/${bucket}`;
  }
  if (cfg.path_style === true) return `https://s3.${region}.amazonaws.com/${bucket}`;
  return `https://${bucket}.s3.${region}.amazonaws.com`;
}

function s3Client(cfg: Record<string, unknown>, cred: Credentials) {
  if (!cred.access_key_id || !cred.secret_access_key) throw new ObxError("validation_failed", "Enter an access key id and secret for the bucket.");
  return new AwsClient({ accessKeyId: cred.access_key_id, secretAccessKey: cred.secret_access_key, service: "s3", region: String(cfg.region || "auto") });
}

async function s3Fetch(ctx: Ctx, cfg: Record<string, unknown>, cred: Credentials, url: string, timeoutMs = 60_000): Promise<Response> {
  const aws = s3Client(cfg, cred);
  const signed = await aws.sign(url, { method: "GET" });
  const res = await safeFetch(signed.url, { method: "GET", headers: signed.headers, timeoutMs, followRedirects: false }, ctx.urlPolicy());
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? String(res.status);
    throw new ObxError("service_unavailable", `The bucket answered ${res.status} (${code}). Check bucket, prefix, region and key.`);
  }
  return res;
}

async function s3List(ctx: Ctx, cfg: Record<string, unknown>, cred: Credentials, max = 100_000): Promise<S3Object[]> {
  const base = s3Base(cfg);
  const prefix = String(cfg.prefix ?? "").replace(/^\/+/, "");
  const out: S3Object[] = [];
  let token: string | null = null;
  for (let page = 0; page < 200; page++) {
    const url: string = `${base}/?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`;
    const xml: string = await (await s3Fetch(ctx, cfg, cred, url)).text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const c = m[1];
      out.push({
        key: xmlDecode(c.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? ""),
        etag: xmlDecode(c.match(/<ETag>([\s\S]*?)<\/ETag>/)?.[1] ?? "").replace(/"/g, ""),
        size: Number(c.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0),
        modified: c.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? null,
      });
      if (out.length >= max) return out;
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    token = truncated ? xmlDecode(xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? "") : null;
    if (!token) break;
  }
  return out;
}

function s3ObjectUrl(cfg: Record<string, unknown>, key: string) {
  return `${s3Base(cfg)}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

// ------------------------------------------------------------------ folder listing (S3 / SFTP)

interface Listed {
  path: string;
  size: number;
  version: string;
  modified: string | null;
}

async function listFolder(ctx: Ctx, src: SourceRow): Promise<{ files: Listed[]; hostKey: string | null }> {
  const cfg = safeJsonParse<Record<string, unknown>>(src.config, {});
  const cred = await credentialsOf(ctx, src);
  if (src.kind === "s3") {
    const objs = await s3List(ctx, cfg, cred);
    return { files: objs.filter((o) => !o.key.endsWith("/")).map((o) => ({ path: o.key, size: o.size, version: o.etag || `${o.size}:${o.modified}`, modified: o.modified })), hostKey: null };
  }
  if (src.kind === "sftp") {
    if (!ctx.p.sftp) throw new ObxError("not_implemented", "SFTP imports need the self-hosted (Bun/Docker) edition. On Cloudflare, use a web address or an S3/R2 bucket.");
    await assertSafeUrl(`https://${String(cfg.host)}/`, ctx.urlPolicy());
    const r = await ctx.p.sftp.list(sftpConfig(cfg, cred), String(cfg.path ?? "/"));
    return { files: r.files.map((f) => ({ path: f.path, size: f.size, version: `${f.size}:${f.modifiedAt ?? ""}`, modified: f.modifiedAt })), hostKey: r.hostKeyFingerprint };
  }
  throw new ObxError("invalid_request", "Not a folder source.");
}

function sftpConfig(cfg: Record<string, unknown>, cred: Credentials) {
  return {
    host: String(cfg.host),
    port: Number(cfg.port ?? 22),
    username: String(cfg.username),
    password: cred.password ?? null,
    privateKey: cred.private_key ?? null,
    hostKeyFingerprint: (cfg.host_key_fingerprint as string) ?? null,
  };
}

export async function readRemoteFile(ctx: Ctx, sourceId: string, path: string, max: number): Promise<Uint8Array> {
  const src = await ctx.db.first<SourceRow>("SELECT * FROM import_sources WHERE id = ?", [sourceId]);
  if (!src) throw new ObxError("not_found", "The scheduled import was deleted.");
  const cfg = safeJsonParse<Record<string, unknown>>(src.config, {});
  const cred = await credentialsOf(ctx, src);
  if (src.kind === "s3") {
    const res = await s3Fetch(ctx, cfg, cred, s3ObjectUrl(cfg, path), 600_000);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > max) throw new ObxError("payload_too_large", `${path} is too large.`);
    return new Uint8Array(await res.arrayBuffer());
  }
  if (src.kind === "sftp") {
    if (!ctx.p.sftp) throw new ObxError("not_implemented", "SFTP needs the self-hosted edition.");
    await assertSafeUrl(`https://${String(cfg.host)}/`, ctx.urlPolicy());
    return ctx.p.sftp.read(sftpConfig(cfg, cred), path);
  }
  throw new ObxError("invalid_request", "Not a folder source.");
}

// ------------------------------------------------------------------ fetch for an import run

export interface FetchResult {
  inputs: ImportInputs;
  files: { name: string; bytes: number; sha256: string | null }[];
  fingerprint: string;
  unchanged: boolean;
  remoteImages: { name: string; path: string; version: string; size: number }[];
}

async function download(ctx: Ctx, url: string, headers: Record<string, string>, key: string) {
  const res = await safeFetch(url, { headers, timeoutMs: 600_000 }, ctx.urlPolicy());
  if (!res.ok || !res.body) throw new ObxError("service_unavailable", `${new URL(url).host} answered ${res.status}. Check the address and the login header.`);
  return streamToStore(ctx, key, res.body, MAX_SOURCE_BYTES);
}

export async function fetchSource(ctx: Ctx, src: SourceRow, jobId: string, force: boolean): Promise<FetchResult> {
  const cfg = safeJsonParse<Record<string, unknown>>(src.config, {});
  const inputs: ImportInputs = { csv: null, assets: null, zips: [], files: [], manifest: null };
  const files: FetchResult["files"] = [];
  if (src.kind === "https_url") {
    const cred = await credentialsOf(ctx, src);
    const headers = cred.headers ?? {};
    const main = await download(ctx, String(cfg.url), headers, `jobs/${jobId}/source`);
    const head = await ctx.blobs.getRange(`jobs/${jobId}/source`, 0, 4);
    const name = decodeURIComponent(new URL(String(cfg.url)).pathname.split("/").pop() || "download");
    const isZip = !!head && head[0] === 0x50 && head[1] === 0x4b;
    if (isZip) inputs.zips.push({ key: `jobs/${jobId}/source`, offset: 0, length: main.size, name });
    else inputs.csv = { key: `jobs/${jobId}/source`, offset: 0, length: main.size, name: name.endsWith(".csv") ? name : "products.csv" };
    files.push({ name, bytes: main.size, sha256: main.sha256 });
    let fp = main.sha256;
    if (typeof cfg.images_url === "string" && cfg.images_url) {
      const im = await download(ctx, cfg.images_url, headers, `jobs/${jobId}/images`);
      const iname = decodeURIComponent(new URL(cfg.images_url).pathname.split("/").pop() || "images.zip");
      inputs.zips.push({ key: `jobs/${jobId}/images`, offset: 0, length: im.size, name: iname });
      files.push({ name: iname, bytes: im.size, sha256: im.sha256 });
      fp += im.sha256;
    }
    const fingerprint = await sha256Hex(fp);
    return { inputs, files, fingerprint, unchanged: !force && src.fingerprint === fingerprint, remoteImages: [] };
  }
  const { files: listed } = await listFolder(ctx, src);
  const base = (p: string) => p.split("/").pop()!.toLowerCase();
  const csvs = listed.filter((f) => base(f.path).endsWith(".csv"));
  const prod = csvs.filter((f) => base(f.path) === "products.csv").sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0] ?? (csvs.filter((f) => base(f.path) !== "assets.csv").length === 1 ? csvs.find((f) => base(f.path) !== "assets.csv") : undefined);
  const ass = csvs.find((f) => base(f.path) === "assets.csv");
  const images = listed.filter((f) => IMAGE_EXT.test(f.path) && !base(f.path).startsWith("."));
  const fingerprint = await sha256Hex(
    listed
      .map((f) => `${f.path}\t${f.version}`)
      .sort()
      .join("\n"),
  );
  const unchanged = !force && src.fingerprint === fingerprint;
  if (unchanged) return { inputs, files: [], fingerprint, unchanged, remoteImages: [] };
  for (const [f, which] of [
    [prod, "csv"],
    [ass, "assets"],
  ] as const) {
    if (!f) continue;
    const bytes = await readRemoteFile(ctx, src.id, f.path, 64 * 1048576);
    const key = `jobs/${jobId}/${which}.csv`;
    await ctx.blobs.put(key, bytes, "text/csv");
    const loc = { key, offset: 0, length: bytes.length, name: base(f.path) };
    if (which === "csv") inputs.csv = loc;
    else inputs.assets = loc;
    files.push({ name: f.path, bytes: bytes.length, sha256: await sha256Hex(bytes) });
  }
  return {
    inputs,
    files,
    fingerprint,
    unchanged,
    remoteImages: images.map((f) => ({ name: f.path.split("/").pop()!, path: f.path, version: f.version, size: f.size })),
  };
}

export async function testSource(ctx: Ctx, src: SourceRow) {
  const cfg = safeJsonParse<Record<string, unknown>>(src.config, {});
  try {
    if (src.kind === "https_url") {
      const cred = await credentialsOf(ctx, src);
      const res = await safeFetch(String(cfg.url), { method: "GET", headers: cred.headers ?? {}, timeoutMs: 15_000 }, ctx.urlPolicy());
      const len = Number(res.headers.get("content-length") ?? 0);
      await res.body?.cancel();
      if (!res.ok) return { ok: false, message: `The address answered ${res.status}.`, host_key_fingerprint: null, files: [] };
      const name = decodeURIComponent(new URL(String(cfg.url)).pathname.split("/").pop() || "download");
      return { ok: true, message: null, host_key_fingerprint: null, files: [{ name, bytes: len, modified_at: res.headers.get("last-modified") ? new Date(res.headers.get("last-modified")!).toISOString() : null }] };
    }
    const r = await listFolder(ctx, src);
    const relevant = r.files.filter((f) => /\.csv$/i.test(f.path) || IMAGE_EXT.test(f.path));
    return {
      ok: true,
      message: relevant.length ? null : "The folder is reachable but contains no products.csv or images.",
      host_key_fingerprint: r.hostKey,
      files: relevant.slice(0, 100).map((f) => ({ name: f.path, bytes: f.size, modified_at: f.modified })),
    };
  } catch (e) {
    if (e instanceof ObxError) {
      if (e.code === "unsafe_url") throw e;
      return { ok: false, message: e.detail ?? e.message, host_key_fingerprint: null, files: [] };
    }
    return { ok: false, message: e instanceof Error ? e.message : "Connection failed.", host_key_fingerprint: null, files: [] };
  }
}

// ------------------------------------------------------------------ schedules

function zonedParts(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) + 1;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), wd };
}

function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  let guess = Date.UTC(y, m - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    const diff = asUtc - Date.UTC(y, m - 1, d, h, mi);
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function nextRunAt(schedule: { frequency: string; time?: string | null; weekday?: number | null; timezone?: string }, fromMs: number): number | null {
  const tz = schedule.timezone && validTimezone(schedule.timezone) ? schedule.timezone : "UTC";
  const [hh, mm] = (schedule.time ?? "02:00").split(":").map(Number);
  if (schedule.frequency === "manual") return null;
  if (schedule.frequency === "hourly") {
    const minute = Number.isFinite(mm) && schedule.time ? mm : 0;
    let t = Math.floor(fromMs / 3600_000) * 3600_000 + minute * 60_000;
    while (t <= fromMs) t += 3600_000;
    return t;
  }
  const p = zonedParts(fromMs, tz);
  for (let add = 0; add < 9; add++) {
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d + add));
    const cand = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh || 0, mm || 0, tz);
    if (cand <= fromMs) continue;
    if (schedule.frequency === "weekly") {
      const wd = zonedParts(cand, tz).wd;
      if (wd !== (schedule.weekday ?? 1)) continue;
    }
    return cand;
  }
  return null;
}
