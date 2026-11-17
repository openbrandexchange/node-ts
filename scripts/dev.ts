// Runs the portal on your computer with SQLite and the Kestrel example catalog: one command, no Docker.
//
//   bun run dev          set up (first run only) with a known setup code, admin and retailer account,
//                        the Kestrel products and images; then the portal keeps running (restarts on code changes)
//   bun run dev:demo     demo mode (docs/demo.md): one-click sign-in, resets to the Kestrel fixtures
//
// Data lives in ./data-dev (./data-demo for demo mode); delete the folder to start over. PORT (default 8080)
// and OBX_DATA_DIR override the defaults; every other OBX_* variable is passed to the portal as it is.
// Image renditions (web, square, thumb) are drawn with macOS `sips` or ImageMagick (`magick`), as the
// admin UI and the obx tool do for real catalogs; without either tool the images show as "waiting for files".
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildSeed, commandRenderer, renditionSizes } from "./demo-seed";
import { parseImageName } from "../src/core/importformat";
import { imageSize, sniffType } from "../src/lib/image";

const ROOT = resolve(import.meta.dir, "..");
const FIXTURES = join(ROOT, "test", "fixtures", "kestrel");
const args = new Set(process.argv.slice(2));
const demo = args.has("--demo");
const watch = args.has("--watch");

export const LOCAL = {
  setupCode: "KESTREL-LOCAL",
  admin: { name: "Ada Admin", email: "admin@kestrel.example", password: "kestrel-local-admin" },
  retailer: { name: "Rita Retail", email: "retailer@northwind.example", password: "northwind-local-retailer", company: "Northwind Stores" },
};

const port = Number(process.env.PORT?.trim() || 8080);
const dataDir = resolve(process.env.OBX_DATA_DIR?.trim() || join(ROOT, demo ? "data-demo" : "data-dev"));
const base = `http://127.0.0.1:${port}`;
const shown = `http://localhost:${port}`;
mkdirSync(dataDir, { recursive: true });

// A fixed secret per data folder (made once), so sessions and download links survive restarts.
const secretFile = join(dataDir, ".dev-secret");
if (!existsSync(secretFile)) writeFileSync(secretFile, Buffer.from(crypto.getRandomValues(new Uint8Array(36))).toString("base64"));

const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  PORT: String(port),
  HOST: process.env.HOST ?? "127.0.0.1",
  OBX_DATA_DIR: dataDir,
  OBX_SECRET_KEY: process.env.OBX_SECRET_KEY ?? readFileSync(secretFile, "utf8").trim(),
  OBX_SETUP_CODE: process.env.OBX_SETUP_CODE ?? LOCAL.setupCode,
  OBX_MAIL_PROVIDER: process.env.OBX_MAIL_PROVIDER ?? "console",
  OBX_ACCESS_LOG: process.env.OBX_ACCESS_LOG ?? "false",
  ...(demo ? { OBX_DEMO: "true" } : {}),
};

if (demo) {
  // The demo resets from <data>/files/demo/seed.zip (docs/demo.md); build it once from the fixtures.
  const seed = join(dataDir, "files", "demo", "seed.zip");
  if (!existsSync(seed)) {
    console.log("Building the demo seed archive from the Kestrel fixtures …");
    mkdirSync(dirname(seed), { recursive: true });
    writeFileSync(seed, await buildSeed(FIXTURES, commandRenderer()));
  }
}

const child = Bun.spawn(["bun", ...(watch ? ["--watch"] : []), join(ROOT, "src", "adapters", "bun", "main.ts")], { cwd: ROOT, env, stdout: "inherit", stderr: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));

try {
  await waitReady();
  if (!demo) await seedOnce();
  banner();
} catch (e) {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  child.kill("SIGTERM");
  process.exit(1);
}
process.exit(await child.exited);

// ------------------------------------------------------------------ helpers

async function waitReady() {
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error("The portal stopped while starting; see the messages above.");
    try {
      if ((await fetch(`${base}/readyz`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(100);
  }
  throw new Error(`The portal did not answer on ${base} within 30 seconds (is the port in use? set PORT=…).`);
}

/** A tiny browser: cookies plus the CSRF token, as the admin UI sends them. */
class Session {
  cookies = new Map<string, string>();
  csrf = "";
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const h: Record<string, string> = { ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (method !== "GET" && this.csrf) h["x-csrf-token"] = this.csrf;
    let b: BodyInit | undefined;
    if (body instanceof FormData || body instanceof Uint8Array) b = body as BodyInit;
    else if (body !== undefined) {
      b = JSON.stringify(body);
      h["content-type"] = "application/json";
    }
    const r = await fetch(base + path, { method, headers: h, body: b });
    for (const sc of r.headers.getSetCookie()) {
      const [kv] = sc.split(";");
      const i = kv.indexOf("=");
      this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    const text = await r.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (json && typeof json.csrf_token === "string") this.csrf = json.csrf_token;
    return { status: r.status, json };
  }
  async must(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    const r = await this.req(method, path, body, headers);
    if (r.status >= 300) throw new Error(`${method} ${path} answered ${r.status}: ${JSON.stringify(r.json)}`);
    return r.json;
  }
}

/** First run only: setup wizard, the Kestrel import with renditions, and a retailer account. */
async function seedOnce() {
  const s = new Session();
  await s.must("GET", "/admin/api/session");
  if (!(await s.must("GET", "/admin/api/setup")).required) return;
  console.log("First run: setting up the portal with the Kestrel example catalog …");
  await s.must("POST", "/admin/api/setup", {
    setup_code: env.OBX_SETUP_CODE,
    company: { name: "Kestrel Outfitters", first_brand_name: "Kestrel", default_language: "en", languages: ["en", "nl", "de", "fr"], contact_email: "trade@kestrel.example", website: "https://kestrel.example" },
    admin: LOCAL.admin,
  });
  const token = (await s.must("POST", "/admin/api/ingest-tokens", { name: "Local development", scopes: ["ingest:read", "ingest:write", "ingest:delete"], brand_external_ids: null })).secret as string;
  const api = (method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) => fetch(base + path, { method, body, headers: { authorization: `Bearer ${token}`, ...headers } });

  const form = new FormData();
  form.append("csv", new Blob([readFileSync(join(FIXTURES, "products.csv"))], { type: "text/csv" }), "products.csv");
  form.append("assets_csv", new Blob([readFileSync(join(FIXTURES, "assets.csv"))], { type: "text/csv" }), "assets.csv");
  const images = readdirSync(join(FIXTURES, "images")).sort();
  for (const name of images) form.append("images", new Blob([readFileSync(join(FIXTURES, "images", name))], { type: "image/png" }), name);
  const started = await api("POST", "/obx/v1/ingest/imports", form);
  if (started.status !== 202) throw new Error(`The Kestrel import was refused: ${started.status} ${await started.text()}`);
  const jobId = ((await started.json()) as { id: string }).id;
  for (let i = 0; ; i++) {
    const job = (await (await api("GET", `/obx/v1/ingest/jobs/${jobId}`)).json()) as { status: string; import_run?: { counts?: Record<string, number> } };
    if (job.status === "succeeded") break;
    if (job.status === "failed" || i > 600) throw new Error(`The Kestrel import did not finish: ${JSON.stringify(job)}`);
    await Bun.sleep(200);
  }

  let render: ReturnType<typeof commandRenderer> | null = null;
  try {
    render = commandRenderer();
  } catch (e) {
    console.warn(`No renditions: ${(e as Error).message}`);
  }
  if (render) {
    for (const name of images) {
      const p = parseImageName(name);
      if ("error" in p) continue;
      const bytes = new Uint8Array(readFileSync(join(FIXTURES, "images", name)));
      const type = sniffType(bytes);
      const dims = type && imageSize(bytes, type);
      if (!dims) continue;
      const ext = `${p.style}_${p.color ?? "ALL"}_${p.position}`;
      const sizes = renditionSizes(dims.width, dims.height);
      for (const r of ["web", "square", "thumb"] as const) {
        const res = await api("PUT", `/obx/v1/ingest/assets/${encodeURIComponent(ext)}/files/${r}`, (await render(bytes, r, sizes)) as BodyInit, { "content-type": "image/jpeg" });
        if (!res.ok) throw new Error(`Rendition ${r} of ${name} was refused: ${res.status} ${await res.text()}`);
      }
    }
  }

  const retailer = await s.must("POST", "/admin/api/retailers", { name: LOCAL.retailer.company });
  const invite = await s.must("POST", "/admin/api/users/invites", { email: LOCAL.retailer.email, name: LOCAL.retailer.name, role: "retailer", retailer_id: retailer.id, language: "en" });
  const inviteToken = String(invite.invite_url).split("/invite/")[1];
  const r = new Session();
  await r.must("GET", "/admin/api/session");
  await r.must("POST", `/admin/api/invites/${inviteToken}/accept`, { password: LOCAL.retailer.password });
}

function banner() {
  const lines = demo
    ? [`Open Brand Exchange portal (demo mode) on ${shown}`, "", "Sign in with one click as the retailer or as the brand.", "Public read-only API key: obxc_demo-portal-read-only / obxs_demo-portal-read-only-public"]
    : [
        `Open Brand Exchange portal on ${shown}`,
        "",
        `Brand admin:  ${LOCAL.admin.email} / ${LOCAL.admin.password}`,
        `Retailer:     ${LOCAL.retailer.email} / ${LOCAL.retailer.password}`,
        `Setup code:   ${env.OBX_SETUP_CODE} (used on the first run)`,
      ];
  lines.push("", `Data: ${dataDir} (delete it to start over). Stop with Ctrl+C.`);
  const w = Math.max(...lines.map((l) => l.length));
  console.log(`\n┌${"─".repeat(w + 2)}┐\n${lines.map((l) => `│ ${l.padEnd(w)} │`).join("\n")}\n└${"─".repeat(w + 2)}┘\n`);
}
