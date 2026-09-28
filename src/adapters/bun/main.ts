// Bun entry point: `bun src/adapters/bun/main.ts` (also used by the Docker image and Cloud Run).
import { createApp, createWorker } from "../../app";
import { serverFetch } from "./serve";
import { createBunPlatform, ensureBucketFromEnv } from "./platform";
import { staticHandler } from "./static";
import { validateEnv } from "../shared/config";
import { dirname, join } from "node:path";
import { markShuttingDown } from "../../core/ops";
import { requestJobsStop } from "../../core/jobs";

const env = process.env as Record<string, string | undefined>;

// Check every setting first and say exactly what is wrong, instead of failing later on a request.
const problems = validateEnv(env, "bun");
if (problems.length) {
  console.error(JSON.stringify({ time: new Date().toISOString(), level: "error", msg: "The portal cannot start: its configuration has problems.", problems }));
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(78); // EX_CONFIG
}

const port = Number(env.PORT?.trim() || 8080);
const dataDir = env.OBX_DATA_DIR?.trim() || "./data";
// The UI folder: OBX_UI_DIR, else public/ of the source tree, else (standalone binary) public/ next to the executable.
const uiDir = env.OBX_UI_DIR?.trim() || (import.meta.url.includes("$bunfs") ? join(dirname(process.execPath), "public") : new URL("../../../public", import.meta.url).pathname);
const trustProxy = /^(1|true|yes|on)$/i.test(env.OBX_TRUST_PROXY ?? "");

let kicked: ReturnType<typeof setTimeout> | null = null;
let stopping = false;
let jobRun: Promise<unknown> = Promise.resolve();
const platform = createBunPlatform({
  env,
  dataDir,
  uiDir,
  dbPath: env.OBX_DB_PATH?.trim() || undefined,
  onKick: () => {
    if (kicked || stopping) return;
    kicked = setTimeout(() => {
      kicked = null;
      jobRun = worker.runJobs(10 * 60_000).catch((e) => platform.log("error", "jobs failed", { error: String(e) }));
    }, 50);
  },
});
const app = createApp(platform);
const worker = createWorker(platform);
const serveUi = staticHandler(uiDir);

try {
  await worker.prepare();
} catch (e) {
  platform.log("error", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
if (platform.config.allowPrivateUrls)
  platform.log("warn", "OBX_ALLOW_PRIVATE_URLS is on: imports and webhooks may reach http:// and private addresses. Use this only for local development.");
await ensureBucketFromEnv(env).catch((e) => platform.log("error", "S3 bucket check failed", { error: String(e) }));
await worker.rotateSetupCode();

let tickRun: Promise<unknown> = Promise.resolve();
const runTick = () => {
  if (stopping) return;
  tickRun = worker.tick(50_000).catch((e) => platform.log("error", "tick failed", { error: String(e) }));
};
const ticker = setInterval(runTick, 60_000);
const firstTick = setTimeout(runTick, 2000);

const server = Bun.serve({
  port,
  hostname: env.HOST?.trim() || "0.0.0.0",
  maxRequestBodySize: 2 * 1024 * 1024 * 1024,
  idleTimeout: 255,
  fetch: serverFetch({ app, serveUi, trustProxy }),
});

// In a container the listen port is not the address people open, so name the public address too.
const openAt = platform.config.publicUrl?.replace(/\/+$/, "") ?? `http://localhost:${server.port}`;
platform.log("info", `Open Brand Exchange portal listening on port ${server.port}; open ${openAt} in your browser`, { dataDir, uiDir, version: platform.config.version });

// Graceful shutdown: /readyz turns 503, no new job steps start, in-flight requests and the running
// job step finish (bounded by OBX_SHUTDOWN_TIMEOUT_MS). A step cut off by the timeout resumes on
// the next start once its lease expires, because every step checkpoints.
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  markShuttingDown();
  requestJobsStop();
  clearInterval(ticker);
  clearTimeout(firstTick);
  if (kicked) clearTimeout(kicked);
  platform.log("info", "shutting down", { signal, timeout_ms: platform.config.shutdownTimeoutMs });
  const drained = Promise.allSettled([server.stop(false), jobRun, tickRun, ...platform.pending]);
  const timedOut = await Promise.race([drained.then(() => false), Bun.sleep(platform.config.shutdownTimeoutMs).then(() => true)]);
  if (timedOut) platform.log("warn", "shutdown timeout reached; unfinished job steps resume after the next start");
  server.stop(true);
  try {
    platform.db.raw.close();
  } catch {
    /* already closed */
  }
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void shutdown(sig));
