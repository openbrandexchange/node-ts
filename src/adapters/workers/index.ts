// Cloudflare Workers entry: D1 (database), R2 (files), static assets (admin UI), Cron Trigger (every
// minute: scheduled imports, jobs, webhooks), optional Queue (run jobs right away), e-mail over HTTPS.
import { createApp, createWorker, isApiPath } from "../../app";
import type { BlobStore, Db, Platform, Stmt, SqlValue } from "../../platform";
import { configFromEnv, secretProblem } from "../shared/config";
import { httpMailer } from "../shared/mailer";
import { s3Store } from "../shared/s3store";
import { dohResolver } from "../../lib/ssrf";
import type { D1Database, ExecutionContext, Fetcher, MessageBatch, Queue, R2Bucket } from "./types";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS?: Fetcher;
  JOBS?: Queue;
  [key: string]: unknown;
}

export function d1Db(d1: D1Database): Db {
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

function makePlatform(env: Env, ctx: ExecutionContext): Platform {
  const e = strEnv(env);
  const problem = secretProblem(e.OBX_SECRET_KEY);
  if (problem) throw new Error(problem);
  const log = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => {
    const line = JSON.stringify({ level, msg, ...(extra ?? {}) });
    if (level === "error") console.error(line);
    else console.log(line);
  };
  let kicked = false;
  const platform: Platform = {
    db: d1Db(env.DB),
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
    if (!isApiPath(path) && path !== "/healthz" && env.ASSETS) return env.ASSETS.fetch(req);
    let platform: Platform;
    try {
      platform = makePlatform(env, ctx);
    } catch (e) {
      return new Response(JSON.stringify({ type: "https://openbrandexchange.com/errors/service_unavailable", title: "Service unavailable", status: 503, detail: e instanceof Error ? e.message : "misconfigured", obx_error: "service_unavailable" }), {
        status: 503,
        headers: { "content-type": "application/problem+json" },
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
