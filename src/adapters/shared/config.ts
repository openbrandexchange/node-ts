import type { Config } from "../../platform";

export const SOFTWARE = "obx-node-ts";
export const VERSION = "0.1.0";

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
