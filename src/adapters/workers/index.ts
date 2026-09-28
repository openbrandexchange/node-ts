// Cloudflare Workers entry: D1 (database), R2 (files), static assets (admin UI), Cron Trigger (every
// minute: scheduled imports, jobs, webhooks), optional Queue (run jobs right away), e-mail over HTTPS.
import { createApp, createWorker, isApiPath } from "../../app";
import type { BlobStore, Db, Platform, Stmt, SqlValue } from "../../platform";
import { configFromEnv, logAllowed, logLevelOf, validateEnv } from "../shared/config";
import { httpMailer } from "../shared/mailer";
import { s3Store } from "../shared/s3store";
import { dohResolver } from "../../lib/ssrf";
import { UNDERLYING_DB } from "../../db/migrate";
import type { D1Database, ExecutionContext, Fetcher, MessageBatch, Queue, R2Bucket } from "./types";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS?: Fetcher;
  JOBS?: Queue;
  [key: string]: unknown;
}

const dbCache = new WeakMap<D1Database, Db>();

/** One Db wrapper per D1 binding, so the "migrations applied" check runs once per isolate. */
export function d1Db(d1: D1Database): Db {
  const hit = dbCache.get(d1);
  if (hit) return hit;
  const db = makeD1Db(d1);
  dbCache.set(d1, db);
  return db;
}

function makeD1Db(d1: D1Database): Db {
  const prep = (sql: string, params?: SqlValue[]) => {
    const s = d1.prepare(sql);
    return params && params.length ? s.bind(...params.map((p) => (p === undefined ? null : p))) : s;
  };
  return {
    async all<T>(sql: string, params?: SqlValue[]) {
      return (await prep(sql, params).all<T>()).results;
    },
    async first<T>(sql: string, params?: SqlValue[]) {
      return (await prep(sql, params).first<T>()) ?? null;
    },
    async run(sql: string, params?: SqlValue[]) {
      return { changes: (await prep(sql, params).run()).meta.changes ?? 0 };
    },
    async batch(stmts: Stmt[]) {
      if (!stmts.length) return [];
      const out: { changes: number }[] = [];
      // D1 runs a batch as one transaction; very large batches are split (each part still atomic).
      for (let i = 0; i < stmts.length; i += 500) {
        const res = await d1.batch(stmts.slice(i, i + 500).map((s) => prep(s.sql, s.params)));
        out.push(...res.map((r) => ({ changes: r.meta?.changes ?? 0 })));
      }
      return out;
    },
  };
}

/** A Db that reports how many statements it ran (per invocation, for the D1 query cap). */
export function countingDb(db: Db, add: (n: number) => void): Db {
  const counted: Db & { [UNDERLYING_DB]: Db } = {
    [UNDERLYING_DB]: db,
    all: (sql, params) => (add(1), db.all(sql, params)),
    first: (sql, params) => (add(1), db.first(sql, params)),
    run: (sql, params) => (add(1), db.run(sql, params)),
    batch: (stmts) => (add(stmts.length), db.batch(stmts)),
  };
  return counted;
}

export function r2Store(b: R2Bucket): BlobStore {
  return {
    async put(key, data, contentType) {
      await b.put(key, data, contentType ? { httpMetadata: { contentType } } : undefined);
    },
    async get(key, range) {
      const o = await b.get(key, range ? { range } : undefined);
      return o ? o.body : null;
    },
    async getRange(key, offset, length) {
      const o = await b.get(key, { range: { offset, length } });
      return o ? new Uint8Array(await o.arrayBuffer()) : null;
    },
    async head(key) {
      const h = await b.head(key);
      return h ? { size: h.size } : null;
    },
    async delete(keys) {
      for (let i = 0; i < keys.length; i += 1000) await b.delete(keys.slice(i, i + 1000));
    },
    async list(prefix, cursor) {
      const r = await b.list({ prefix, cursor, limit: 1000 });
      return { keys: r.objects.map((o) => o.key), cursor: r.truncated ? (r.cursor ?? null) : null };
    },
    async createMultipart(key, contentType) {
      const u = await b.createMultipartUpload(key, contentType ? { httpMetadata: { contentType } } : undefined);
      return { key: u.key, uploadId: u.uploadId };
    },
    async uploadPart(h, n, data) {
      const p = await b.resumeMultipartUpload(h.key, h.uploadId).uploadPart(n, data);
      return { partNumber: p.partNumber, etag: p.etag };
    },
    async completeMultipart(h, parts) {
      await b.resumeMultipartUpload(h.key, h.uploadId).complete([...parts].sort((a, x) => a.partNumber - x.partNumber));
    },
    async abortMultipart(h) {
      await b.resumeMultipartUpload(h.key, h.uploadId).abort();
    },
  };
}

function strEnv(env: Env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}

let warnedPrivate = false;

class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`The portal is not configured correctly: ${problems.join(" ")}`);
  }
}

function makePlatform(env: Env, ctx: ExecutionContext): Platform {
  const e = strEnv(env);
  const problems = validateEnv(e, "workers");
  if (problems.length) throw new ConfigError(problems);
  const minLevel = logLevelOf(e);
  const log = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => {
    if (!logAllowed(minLevel, level)) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...(extra ?? {}) });
    if (level === "error") console.error(line);
    else console.log(line);
  };
  let kicked = false;
  if (/^(1|true|yes|on)$/i.test(e.OBX_ALLOW_PRIVATE_URLS ?? "") && !warnedPrivate) {
    warnedPrivate = true;
    log("warn", "OBX_ALLOW_PRIVATE_URLS is on: imports and webhooks may use http:// addresses. Use this only for local development.");
  }
  // D1 allows 1,000 queries per invocation on Workers Paid (50 on Free). Background steps stop and
  // checkpoint well before that; OBX_D1_QUERY_BUDGET tunes the threshold.
  let queries = 0;
  const budget = Number(e.OBX_D1_QUERY_BUDGET?.trim() || 800);
  const db = countingDb(d1Db(env.DB), (n) => (queries += n));
  const platform: Platform = {
    db,
    queryBudgetLeft: () => budget - queries,
    blobs:
      e.OBX_STORAGE === "s3"
        ? s3Store({
            endpoint: e.OBX_S3_ENDPOINT ?? `https://s3.${e.OBX_S3_REGION ?? "us-east-1"}.amazonaws.com`,
            bucket: e.OBX_S3_BUCKET ?? "",
            region: e.OBX_S3_REGION ?? "auto",
            accessKeyId: e.OBX_S3_ACCESS_KEY_ID ?? "",
            secretAccessKey: e.OBX_S3_SECRET_ACCESS_KEY ?? "",
            prefix: e.OBX_S3_PREFIX,
          })
        : r2Store(env.FILES),
    mailer: httpMailer({ provider: e.OBX_MAIL_PROVIDER, apiKey: e.OBX_MAIL_API_KEY, from: e.OBX_MAIL_FROM, webhookUrl: e.OBX_MAIL_WEBHOOK_URL, log: (m) => log("info", m) }),
    config: configFromEnv(e, "workers", e.OBX_SECRET_KEY!),
    async readAsset(path) {
      if (!env.ASSETS || path.includes("..")) return null;
      const r = await env.ASSETS.fetch(new Request(`https://assets.invalid/${path}`));
      return r.ok ? r.text() : null;
    },
    sftp: null,
    resolveHost: dohResolver,
    // Workers cannot reach private networks and cannot set a TLS server name for an IP target.
    pinConnections: false,
    defer(p) {
      ctx.waitUntil(p.catch((err) => log("error", "background task failed", { error: err instanceof Error ? err.message : String(err) })));
    },
    kickJobs() {
      if (kicked) return;
      kicked = true;
      if (env.JOBS) ctx.waitUntil(env.JOBS.send({ kick: Date.now() }).catch(() => {}));
      else ctx.waitUntil(createWorker(platform).runJobs(20_000).catch((err) => log("error", "jobs failed", { error: String(err) })));
    },
    now: () => Date.now(),
    log,
  };
  return platform;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (!isApiPath(path) && env.ASSETS) return env.ASSETS.fetch(req);
    let platform: Platform;
    try {
      platform = makePlatform(env, ctx);
    } catch (e) {
      const detail = e instanceof Error ? e.message : "misconfigured";
      console.error(JSON.stringify({ time: new Date().toISOString(), level: "error", msg: detail }));
      if (path === "/healthz") return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ type: "https://openbrandexchange.com/errors/service_unavailable", title: "Service unavailable", status: 503, detail, obx_error: "service_unavailable" }), {
        status: 503,
        headers: { "content-type": "application/problem+json", "cache-control": "no-store" },
      });
    }
    return createApp(platform).fetch(req);
  },
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    const platform = makePlatform(env, ctx);
    ctx.waitUntil(createWorker(platform).tick(25_000));
  },
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    const platform = makePlatform(env, ctx);
    const steps = await createWorker(platform).runJobs(25_000);
    for (const m of batch.messages) m.ack();
    // More work left? Queue another wake-up so long jobs keep going without waiting for the cron.
    if (steps > 0 && env.JOBS) await env.JOBS.send({ kick: Date.now() });
  },
};
