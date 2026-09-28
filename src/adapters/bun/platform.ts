// Builds the Platform for the Bun runtime (self-hosting, Docker, Cloud Run, tests).
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { lookup } from "node:dns/promises";
import type { BlobStore, Platform } from "../../platform";
import { sqliteDb } from "./sqlite";
import { diskStore } from "./disk";
import { s3Store } from "../shared/s3store";
import { httpMailer } from "../shared/mailer";
import { configFromEnv, secretProblem, type EnvLike } from "../shared/config";
import { b64url, randomBytes } from "../../lib/util";
import { bunSftp } from "./sftp";

export interface BunPlatformOptions {
  env: EnvLike;
  dataDir: string;
  uiDir: string;
  dbPath?: string;
  now?: () => number;
  quiet?: boolean;
  onKick?: () => void;
}

export function loadOrCreateSecret(env: EnvLike, dataDir: string, log: (m: string) => void): string {
  if (env.OBX_SECRET_KEY) {
    const p = secretProblem(env.OBX_SECRET_KEY);
    if (p) throw new Error(p);
    return env.OBX_SECRET_KEY;
  }
  const f = join(dataDir, "secret.key");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  const k = b64url(randomBytes(48));
  writeFileSync(f, k + "\n", { mode: 0o600 });
  try {
    chmodSync(f, 0o600);
  } catch {
    /* best effort */
  }
  log(`OBX_SECRET_KEY was not set: generated one and stored it in ${f}. Back up this file together with the database.`);
  return k;
}

export function storeFromEnv(env: EnvLike, dataDir: string): BlobStore {
  if ((env.OBX_STORAGE ?? "disk").toLowerCase() === "s3") {
    const need = ["OBX_S3_BUCKET", "OBX_S3_ACCESS_KEY_ID", "OBX_S3_SECRET_ACCESS_KEY"].filter((k) => !env[k]);
    if (need.length) throw new Error(`OBX_STORAGE=s3 needs ${need.join(", ")}`);
    const region = env.OBX_S3_REGION ?? "us-east-1";
    return s3Store({
      endpoint: env.OBX_S3_ENDPOINT ?? `https://s3.${region}.amazonaws.com`,
      bucket: env.OBX_S3_BUCKET!,
      region,
      accessKeyId: env.OBX_S3_ACCESS_KEY_ID!,
      secretAccessKey: env.OBX_S3_SECRET_ACCESS_KEY!,
      prefix: env.OBX_S3_PREFIX,
      pathStyle: env.OBX_S3_PATH_STYLE ? /^(1|true)$/i.test(env.OBX_S3_PATH_STYLE) : true,
    });
  }
  const dir = resolve(env.OBX_FILES_DIR ?? join(dataDir, "files"));
  mkdirSync(dir, { recursive: true });
  return diskStore(dir);
}

export function createBunPlatform(o: BunPlatformOptions): Platform & { pending: Set<Promise<unknown>>; db: ReturnType<typeof sqliteDb> } {
  mkdirSync(o.dataDir, { recursive: true });
  const log = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => {
    if (o.quiet && level !== "error") return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...(extra ?? {}) });
    if (level === "error") console.error(line);
    else console.log(line);
  };
  const secret = loadOrCreateSecret(o.env, o.dataDir, (m) => log("warn", m));
  const db = sqliteDb(o.dbPath ?? join(o.dataDir, "obx.sqlite"));
  const pending = new Set<Promise<unknown>>();
  const uiDir = resolve(o.uiDir);
  return {
    db,
    blobs: storeFromEnv(o.env, o.dataDir),
    mailer: httpMailer({ provider: o.env.OBX_MAIL_PROVIDER, apiKey: o.env.OBX_MAIL_API_KEY, from: o.env.OBX_MAIL_FROM, webhookUrl: o.env.OBX_MAIL_WEBHOOK_URL, log: (m) => log("info", m) }),
    config: configFromEnv(o.env, "bun", secret),
    async readAsset(path) {
      if (path.includes("..")) return null;
      const f = Bun.file(join(uiDir, path));
      return (await f.exists()) ? f.text() : null;
    },
    sftp: bunSftp,
    resolveHost: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
    defer(p) {
      const q = p.catch((e) => log("error", "background task failed", { error: e instanceof Error ? e.message : String(e) })).finally(() => pending.delete(q));
      pending.add(q);
    },
    kickJobs() {
      o.onKick?.();
    },
    now: o.now ?? (() => Date.now()),
    log,
    pending,
  };
}
