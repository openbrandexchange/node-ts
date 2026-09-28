// Bun entry point: `bun src/adapters/bun/main.ts` (also used by the Docker image and Cloud Run).
import { createApp, createWorker, isApiPath } from "../../app";
import { createBunPlatform } from "./platform";
import { staticHandler } from "./static";

const env = process.env as Record<string, string | undefined>;
const port = Number(env.PORT ?? 8080);
const dataDir = env.OBX_DATA_DIR ?? "./data";
const uiDir = env.OBX_UI_DIR ?? new URL("../../../public", import.meta.url).pathname;
const trustProxy = /^(1|true|yes)$/i.test(env.OBX_TRUST_PROXY ?? "");

let kicked: ReturnType<typeof setTimeout> | null = null;
const platform = createBunPlatform({
  env,
  dataDir,
  uiDir,
  dbPath: env.OBX_DB_PATH,
  onKick: () => {
    if (kicked) return;
    kicked = setTimeout(() => {
      kicked = null;
      worker.runJobs(10 * 60_000).catch((e) => platform.log("error", "jobs failed", { error: String(e) }));
    }, 50);
  },
});
const app = createApp(platform);
const worker = createWorker(platform);
const serveUi = staticHandler(uiDir);

await worker.rotateSetupCode();
setInterval(() => worker.tick(50_000).catch((e) => platform.log("error", "tick failed", { error: String(e) })), 60_000);
setTimeout(() => worker.tick(50_000).catch(() => {}), 2000);

const server = Bun.serve({
  port,
  hostname: env.HOST ?? "0.0.0.0",
  maxRequestBodySize: 2 * 1024 * 1024 * 1024,
  idleTimeout: 255,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.delete("x-obx-client-ip");
    const fwd = trustProxy ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() : null;
    headers.set("x-obx-client-ip", fwd || srv.requestIP(req)?.address || "unknown");
    if (!trustProxy) headers.delete("x-forwarded-proto");
    const r = new Request(req, { headers });
    if (isApiPath(url.pathname) || url.pathname === "/healthz") return app.fetch(r);
    return serveUi(r);
  },
});

platform.log("info", `Open Brand Exchange portal listening on http://localhost:${server.port}`, { dataDir, uiDir });

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => {
    platform.log("info", "shutting down");
    server.stop();
    await Promise.allSettled([...platform.pending]);
    process.exit(0);
  });
