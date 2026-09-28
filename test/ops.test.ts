// Operations: health and readiness, request ids, security headers, metrics, configuration checks,
// schema version checks, jobs that survive a crash, and the graceful shutdown of the real process.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestNode } from "./helpers";
import { validateEnv } from "../src/adapters/shared/config";
import { migrate, resetMigrationCache, SchemaTooNewError } from "../src/db/migrate";
import { MIGRATIONS } from "../src/db/migrations.gen";
import { sqliteDb } from "../src/adapters/bun/sqlite";
import { Ctx } from "../src/core/ctx";
import { enqueueJob, getJob } from "../src/core/jobs";

describe("health, readiness and request ids", () => {
  test("/healthz answers without the database; /readyz checks database, schema and storage", async () => {
    const node = new TestNode();
    const h = await node.request("GET", "/healthz");
    expect(h.status).toBe(200);
    expect(h.json).toEqual({ ok: true });
    const r = await node.request("GET", "/readyz");
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.checks.database).toEqual({ ok: true, detail: MIGRATIONS.at(-1)!.name });
    expect(r.json.checks.storage.ok).toBe(true);
  });

  test("a sane incoming X-Request-Id is kept, anything else is replaced by a fresh one", async () => {
    const node = new TestNode();
    const kept = await node.request("GET", "/.well-known/obx", { headers: { "x-request-id": "proxy-1234-abcd" } });
    expect(kept.headers.get("x-request-id")).toBe("proxy-1234-abcd");
    const replaced = await node.request("GET", "/.well-known/obx", { headers: { "x-request-id": "has spaces and <html> in it" } });
    expect(replaced.headers.get("x-request-id")).toMatch(/^req_[A-Za-z0-9_-]{16}$/);
    const a = await node.request("GET", "/admin/api/session");
    const b = await node.request("GET", "/admin/api/session");
    expect(a.headers.get("x-request-id")).not.toBe(b.headers.get("x-request-id"));
  });

  test("errors carry the request id in the header and in the log line", async () => {
    const node = new TestNode();
    const lines: Record<string, unknown>[] = [];
    node.platform.log = (level, msg, extra) => void lines.push({ level, msg, ...(extra ?? {}) });
    node.platform.config.accessLog = true;
    await node.setup();
    const r = await node.request("GET", "/obx/v1/products", { headers: { "x-request-id": "trace-0000-1111" } });
    expect(r.status).toBe(401);
    expect(r.headers.get("x-request-id")).toBe("trace-0000-1111");
    const access = lines.find((l) => l.msg === "request" && l.path === "/obx/v1/products");
    expect(access).toMatchObject({ request_id: "trace-0000-1111", method: "GET", path: "/obx/v1/products", status: 401 });
    expect(JSON.stringify(access)).not.toContain("127.0.0.1");
  });
});

describe("security headers", () => {
  test("API answers forbid framing, sniffing and embedding; HSTS only over HTTPS", async () => {
    const node = new TestNode();
    await node.setup();
    const r = await node.request("GET", "/.well-known/obx");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("strict-transport-security")).toBeNull();
    const tls = await node.app.request("https://portal.example/.well-known/obx");
    expect(tls.headers.get("strict-transport-security")).toBe("max-age=31536000");
    const err = await node.app.request("https://portal.example/obx/v1/products");
    expect(err.status).toBe(401);
    expect(err.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(err.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  test("CORS is only offered on the discovery document", async () => {
    const node = new TestNode();
    await node.setup();
    const d = await node.request("GET", "/.well-known/obx", { headers: { origin: "https://shop.example" } });
    expect(d.headers.get("access-control-allow-origin")).toBe("*");
    for (const path of ["/obx/v1/products", "/admin/api/session", "/obx/v1/changes"]) {
      const r = await node.request("GET", path, { headers: { origin: "https://shop.example" } });
      expect({ path, cors: r.headers.get("access-control-allow-origin") }).toEqual({ path, cors: null });
    }
  });
});

describe("wrong methods", () => {
  test("an existing path answers 405 with Allow; an unknown path stays 404", async () => {
    const node = new TestNode();
    await node.setup();
    const del = await node.request("DELETE", "/obx/v1/changes");
    expect(del.status).toBe(405);
    expect(del.json.obx_error).toBe("method_not_allowed");
    expect(del.headers.get("allow")).toBe("GET, HEAD");
    const put = await node.request("PUT", "/obx/v1/assets/ast_1/renditions/web");
    expect(put.headers.get("allow")).toBe("GET, HEAD");
    expect((await node.request("PATCH", "/obx/v1/webhooks/wh_1")).headers.get("allow")).toBe("DELETE");
    const none = await node.request("GET", "/obx/v1/nothing-here");
    expect(none.status).toBe(404);
    expect(none.json.obx_error).toBe("not_found");
  });
});

describe("metrics", () => {
  test("/metrics does not exist without OBX_METRICS_TOKEN", async () => {
    const node = new TestNode();
    expect((await node.request("GET", "/metrics")).status).toBe(404);
  });

  test("with a token: 404 for a wrong token, Prometheus text for the right one", async () => {
    const node = new TestNode({ OBX_METRICS_TOKEN: "metrics-token-0123456789" });
    await node.setup();
    expect((await node.request("GET", "/metrics", { headers: { authorization: "Bearer wrong-token-000000000" } })).status).toBe(404);
    const r = await node.request("GET", "/metrics", { headers: { authorization: "Bearer metrics-token-0123456789" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");
    expect(r.text).toContain('obx_build_info{software="obx-node-ts"');
    expect(r.text).toMatch(/obx_http_requests_total\{group="admin",method="POST",status="2xx"\} \d+/);
    expect(r.text).toContain("obx_catalog_products 0");
    expect(r.text).toContain("obx_access_requests_pending 0");
  });
});

describe("configuration checks", () => {
  test("a clean configuration has no problems; blanks count as not set", () => {
    expect(validateEnv({}, "bun")).toEqual([]);
    expect(validateEnv({ OBX_MAIL_PROVIDER: "", OBX_SECRET_KEY: "", OBX_STORAGE: "disk", OBX_S3_ENDPOINT: "http://s3:9000" }, "bun")).toEqual([]);
    expect(validateEnv({ OBX_SECRET_KEY: "x".repeat(40), OBX_PUBLIC_URL: "https://brands.kestrel.example" }, "workers")).toEqual([]);
  });

  test("every problem is named in one sentence", () => {
    const p = validateEnv(
      {
        OBX_SECRET_KEY: "short",
        OBX_SETUP_CODE: "abc",
        OBX_PUBLIC_URL: "brands.kestrel.example/portal",
        PORT: "http",
        OBX_TRUST_PROXY: "maybe",
        OBX_STORAGE: "s3",
        OBX_MAIL_PROVIDER: "resend",
        OBX_LOG_LEVEL: "loud",
      },
      "bun",
    );
    expect(p).toEqual([
      "OBX_SECRET_KEY must be at least 32 characters. Generate one with: openssl rand -base64 48",
      "OBX_SETUP_CODE must be at least 6 characters (or leave it empty to get a code in the log).",
      'OBX_PUBLIC_URL must be a full address like https://brands.yourbrand.com (got "brands.kestrel.example/portal").',
      'OBX_TRUST_PROXY must be true or false (got "maybe").',
      'PORT must be a whole number from 1 to 65535 (got "http").',
      'OBX_LOG_LEVEL must be one of debug, info, warn, error (got "loud").',
      "OBX_STORAGE=s3 needs OBX_S3_BUCKET, OBX_S3_ACCESS_KEY_ID, OBX_S3_SECRET_ACCESS_KEY.",
      "OBX_MAIL_PROVIDER=resend needs OBX_MAIL_FROM (the sender address).",
      "OBX_MAIL_PROVIDER=resend needs OBX_MAIL_API_KEY.",
    ]);
  });

  test("Cloudflare requires the secret key; a path in OBX_PUBLIC_URL is refused", () => {
    expect(validateEnv({}, "workers")).toEqual(["OBX_SECRET_KEY is not set. Generate one with: openssl rand -base64 48"]);
    expect(validateEnv({ OBX_SECRET_KEY: "x".repeat(40), OBX_PUBLIC_URL: "https://kestrel.example/portal" }, "workers")[0]).toContain("no path");
  });
});

describe("schema versions", () => {
  test("migrations are recorded in wrangler's d1_migrations table and never applied twice", async () => {
    resetMigrationCache();
    const db = sqliteDb(":memory:");
    await migrate(db);
    expect((await db.all<{ name: string }>("SELECT name FROM d1_migrations ORDER BY id")).map((r) => r.name)).toEqual(MIGRATIONS.map((m) => m.name));
    resetMigrationCache();
    await migrate(db);
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM d1_migrations"))!.n).toBe(MIGRATIONS.length);
  });

  test("databases from before v0.1.0 (schema_migrations) are recognised", async () => {
    resetMigrationCache();
    const db = sqliteDb(":memory:");
    await migrate(db);
    await db.run("DELETE FROM d1_migrations");
    await db.run("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    await db.run("INSERT INTO schema_migrations VALUES ('0001_init.sql', '2026-09-01T00:00:00Z')");
    resetMigrationCache();
    await migrate(db);
    // 0001 is known from the old table; only the later ones are applied (and recorded) again.
    expect((await db.all<{ name: string }>("SELECT name FROM d1_migrations ORDER BY id")).map((r) => r.name)).toEqual(MIGRATIONS.slice(1).map((m) => m.name));
  });

  test("a database upgraded by a newer release is refused with a clear message", async () => {
    const node = new TestNode();
    await node.setup();
    await node.platform.db.run("INSERT INTO d1_migrations (name) VALUES ('0099_future.sql')");
    resetMigrationCache();
    await expect(migrate(node.platform.db)).rejects.toBeInstanceOf(SchemaTooNewError);
    const r = await node.request("GET", "/obx/v1/brands");
    expect(r.status).toBe(503);
    expect(r.json.detail).toContain("newer version");
    const ready = await node.request("GET", "/healthz");
    expect(ready.status).toBe(200);
    resetMigrationCache();
  });
});

describe("background jobs survive a crash", () => {
  test("a step whose worker died is picked up again once its lease runs out, and finishes once", async () => {
    const node = new TestNode();
    await node.setup();
    const ctx = new Ctx(node.platform);
    const job = await enqueueJob(ctx, { kind: "maintenance", owner: "admin", input: { task: "rights" } });
    // Simulate a worker that claimed the job and was killed mid-step.
    await node.platform.db.run("UPDATE jobs SET status = 'running', lease_until = ? WHERE id = ?", [ctx.iso(120_000), job.id]);
    expect(await node.worker.runJobs(5000)).toBe(0);
    expect((await getJob(ctx, job.id))!.status).toBe("running");
    node.clock.offset = 121_000;
    expect(await node.worker.runJobs(5000)).toBe(1);
    expect((await getJob(ctx, job.id))!.status).toBe("succeeded");
    expect(await node.worker.runJobs(5000)).toBe(0);
  });
});

describe("the Bun process", () => {
  const main = join(import.meta.dir, "..", "src", "adapters", "bun", "main.ts");

  test("refuses to start with a broken configuration and lists every problem", async () => {
    const p = Bun.spawn(["bun", main], { env: { ...process.env, OBX_DATA_DIR: mkdtempSync(join(tmpdir(), "obx-cfg-")), PORT: "70000", OBX_MAIL_PROVIDER: "carrier-pigeon" }, stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(78);
    const err = await new Response(p.stderr).text();
    expect(err).toContain("PORT must be a whole number from 1 to 65535");
    expect(err).toContain("OBX_MAIL_PROVIDER must be one of");
  });

  test("stops gracefully on SIGTERM: readiness drops, the process exits 0", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const p = Bun.spawn(["bun", main], {
      env: { ...process.env, OBX_DATA_DIR: mkdtempSync(join(tmpdir(), "obx-stop-")), PORT: String(port), HOST: "127.0.0.1", OBX_SECRET_KEY: "x".repeat(40), OBX_SHUTDOWN_TIMEOUT_MS: "5000" },
      stdout: "pipe",
      stderr: "pipe",
    });
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      ready = await fetch(`http://127.0.0.1:${port}/readyz`).then((r) => r.ok, () => false);
      if (!ready) await Bun.sleep(100);
    }
    expect(ready).toBe(true);
    p.kill("SIGTERM");
    expect(await p.exited).toBe(0);
    const out = await new Response(p.stdout).text();
    expect(out).toContain('"msg":"shutting down"');
  }, 20_000);
});
