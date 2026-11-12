import type { Config } from "../../platform";

export const SOFTWARE = "obx-node-ts";
export const VERSION = "0.3.0";

export type EnvLike = Record<string, string | undefined>;

const bool = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? "");

export function configFromEnv(env: EnvLike, runtime: "workers" | "bun", secretKey: string): Config {
  const num = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);
  return {
    publicUrl: env.OBX_PUBLIC_URL ? env.OBX_PUBLIC_URL.replace(/\/+$/, "") : null,
    secretKey,
    setupCode: env.OBX_SETUP_CODE && env.OBX_SETUP_CODE.trim().length >= 6 ? env.OBX_SETUP_CODE.trim() : null,
    allowPrivateUrls: bool(env.OBX_ALLOW_PRIVATE_URLS),
    runtime,
    software: SOFTWARE,
    version: VERSION,
    maxUploadBytes: num(env.OBX_MAX_UPLOAD_BYTES, runtime === "workers" ? 32 * 1048576 : 100 * 1048576),
    syncBatchMax: num(env.OBX_SYNC_BATCH_MAX, runtime === "workers" ? 50 : 200),
    apiRateLimit: num(env.OBX_RATE_LIMIT_API, 600),
    renditionRateLimit: num(env.OBX_RATE_LIMIT_MEDIA, 3000),
    jobStepBudgetMs: num(env.OBX_JOB_STEP_MS, runtime === "workers" ? 20_000 : 60_000),
    // Cloudflare already records every invocation (Workers Logs), so the access log is off there by default.
    accessLog: env.OBX_ACCESS_LOG?.trim() ? bool(env.OBX_ACCESS_LOG) : runtime === "bun",
    metricsToken: env.OBX_METRICS_TOKEN?.trim() || null,
    shutdownTimeoutMs: num(env.OBX_SHUTDOWN_TIMEOUT_MS, 20_000),
    customDomainHelp:
      runtime === "workers"
        ? "In the Cloudflare dashboard open **Workers & Pages → your portal → Settings → Domains & Routes → Add → Custom domain**, enter e.g. `brands.yourbrand.com` and wait for the certificate. Then set `OBX_PUBLIC_URL` to that address (Settings → Variables) and redeploy."
        : "Point a DNS record (CNAME or A) for e.g. `brands.yourbrand.com` to your server or Cloud Run service, put HTTPS in front (Caddy, a load balancer or Cloud Run domain mapping), and set `OBX_PUBLIC_URL=https://brands.yourbrand.com`.",
  };
}

export function secretProblem(k: string | undefined): string | null {
  if (!k) return "OBX_SECRET_KEY is not set. Generate one with: openssl rand -base64 48";
  if (k.length < 32) return "OBX_SECRET_KEY must be at least 32 characters. Generate one with: openssl rand -base64 48";
  return null;
}

const BOOL_RE = /^(1|0|true|false|yes|no|on|off)$/i;
const MAIL_PROVIDERS = ["resend", "postmark", "sendgrid", "mailchannels", "webhook", "console"];
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Checks every setting before the node starts and returns one clear sentence per problem
 * (empty list: all good). Empty values count as "not set", so Compose files can pass blanks.
 */
export function validateEnv(env: EnvLike, runtime: "workers" | "bun"): string[] {
  const v = (k: string) => {
    const x = env[k];
    return x === undefined || x.trim() === "" ? undefined : x.trim();
  };
  const out: string[] = [];
  const secret = v("OBX_SECRET_KEY");
  if (runtime === "workers" || secret !== undefined) {
    const p = secretProblem(secret);
    if (p) out.push(p);
  }
  const code = v("OBX_SETUP_CODE");
  if (code !== undefined && code.length < 6) out.push("OBX_SETUP_CODE must be at least 6 characters (or leave it empty to get a code in the log).");
  const pub = v("OBX_PUBLIC_URL");
  if (pub !== undefined) {
    let u: URL | null = null;
    try {
      u = new URL(pub);
    } catch {
      /* reported below */
    }
    if (!u || !/^https?:$/.test(u.protocol)) out.push(`OBX_PUBLIC_URL must be a full address like https://brands.yourbrand.com (got "${pub}").`);
    else if (u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) out.push("OBX_PUBLIC_URL must be only scheme and host (no path, query or #), e.g. https://brands.yourbrand.com.");
  }
  for (const k of ["OBX_ALLOW_PRIVATE_URLS", "OBX_TRUST_PROXY", "OBX_S3_CREATE_BUCKET", "OBX_S3_PATH_STYLE", "OBX_ACCESS_LOG"])
    if (v(k) !== undefined && !BOOL_RE.test(v(k)!)) out.push(`${k} must be true or false (got "${v(k)}").`);
  const ints: [string, number, number][] = [
    ["PORT", 1, 65535],
    ["OBX_MAX_UPLOAD_BYTES", 1048576, 5 * 1024 ** 3],
    ["OBX_SYNC_BATCH_MAX", 1, 10000],
    ["OBX_RATE_LIMIT_API", 1, 1_000_000],
    ["OBX_RATE_LIMIT_MEDIA", 1, 1_000_000],
    ["OBX_JOB_STEP_MS", 1000, 600_000],
    ["OBX_SHUTDOWN_TIMEOUT_MS", 0, 600_000],
  ];
  for (const [k, lo, hi] of ints) {
    const x = v(k);
    if (x !== undefined && (!/^\d+$/.test(x) || Number(x) < lo || Number(x) > hi)) out.push(`${k} must be a whole number from ${lo} to ${hi} (got "${x}").`);
  }
  const level = v("OBX_LOG_LEVEL");
  if (level !== undefined && !(LOG_LEVELS as readonly string[]).includes(level.toLowerCase())) out.push(`OBX_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")} (got "${level}").`);
  const metrics = v("OBX_METRICS_TOKEN");
  if (metrics !== undefined && metrics.length < 16) out.push("OBX_METRICS_TOKEN must be at least 16 characters (it protects /metrics).");
  const storage = (v("OBX_STORAGE") ?? (runtime === "workers" ? "r2" : "disk")).toLowerCase();
  const storages = runtime === "workers" ? ["r2", "s3"] : ["disk", "s3"];
  if (!storages.includes(storage)) out.push(`OBX_STORAGE must be ${storages.join(" or ")} (got "${v("OBX_STORAGE")}").`);
  if (storage === "s3") {
    const need = ["OBX_S3_BUCKET", "OBX_S3_ACCESS_KEY_ID", "OBX_S3_SECRET_ACCESS_KEY"].filter((k) => v(k) === undefined);
    if (need.length) out.push(`OBX_STORAGE=s3 needs ${need.join(", ")}.`);
    const ep = v("OBX_S3_ENDPOINT");
    if (ep !== undefined && !/^https?:\/\/[^/]+/.test(ep)) out.push(`OBX_S3_ENDPOINT must be an address like https://s3.eu-central-1.amazonaws.com (got "${ep}").`);
  }
  const provider = v("OBX_MAIL_PROVIDER")?.toLowerCase();
  if (provider !== undefined) {
    if (!MAIL_PROVIDERS.includes(provider)) out.push(`OBX_MAIL_PROVIDER must be one of ${MAIL_PROVIDERS.join(", ")} (got "${provider}").`);
    else if (provider !== "console") {
      if (v("OBX_MAIL_FROM") === undefined) out.push(`OBX_MAIL_PROVIDER=${provider} needs OBX_MAIL_FROM (the sender address).`);
      if (provider === "webhook" && v("OBX_MAIL_WEBHOOK_URL") === undefined) out.push("OBX_MAIL_PROVIDER=webhook needs OBX_MAIL_WEBHOOK_URL.");
      if (provider !== "webhook" && v("OBX_MAIL_API_KEY") === undefined) out.push(`OBX_MAIL_PROVIDER=${provider} needs OBX_MAIL_API_KEY.`);
    }
  }
  return out;
}

export function logLevelOf(env: EnvLike): LogLevel {
  const l = (env.OBX_LOG_LEVEL ?? "").trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(l) ? (l as LogLevel) : "info";
}

export function logAllowed(min: LogLevel, level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(min);
}
