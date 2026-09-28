// Behaviour that only shows over a real HTTP server (Bun.serve), not through app.request().
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { join } from "node:path";
import { serverFetch } from "../src/adapters/bun/serve";
import { staticHandler } from "../src/adapters/bun/static";
import { TestNode } from "./helpers";

const node = new TestNode();
let server: ReturnType<typeof Bun.serve>;
let token = "";

beforeAll(async () => {
  const admin = await node.setup();
  token = await node.ingestToken(admin);
  server = Bun.serve({ port: 0, fetch: serverFetch({ app: node.app, serveUi: staticHandler(join(import.meta.dir, "..", "public")), trustProxy: false }) });
});
afterAll(() => server.stop(true));

/** A PUT the way curl and Go send large bodies: in chunks, after an "Expect: 100-continue" handshake. */
function rawPut(port: number, path: string, headers: Record<string, string>, body: Uint8Array): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1");
    let buf = "";
    let sent = false;
    const timer = setTimeout(() => (sock.destroy(), reject(new Error("no answer within 5 s"))), 5000);
    sock.on("error", reject);
    sock.on("connect", () => {
      const h = Object.entries({ ...headers, host: `localhost:${port}`, "content-length": String(body.length), expect: "100-continue" }).map(([k, v]) => `${k}: ${v}`);
      sock.write(`PUT ${path} HTTP/1.1\r\n${h.join("\r\n")}\r\n\r\n`);
    });
    sock.on("data", async (d) => {
      buf += d.toString("latin1");
      if (!sent && buf.startsWith("HTTP/1.1 100")) {
        sent = true;
        buf = buf.slice(buf.indexOf("\r\n\r\n") + 4);
        for (let off = 0; off < body.length; off += 256 * 1024) {
          sock.write(body.subarray(off, off + 256 * 1024));
          await Bun.sleep(1);
        }
      }
      const m = buf.match(/^HTTP\/1\.1 (\d{3})(?!.*^HTTP)/s);
      if (m && m[1] !== "100" && buf.includes("\r\n\r\n")) {
        const len = Number(buf.match(/content-length: (\d+)/i)?.[1] ?? 0);
        const bodyText = buf.slice(buf.indexOf("\r\n\r\n") + 4);
        if (bodyText.length >= len) {
          clearTimeout(timer);
          sock.end();
          resolve({ status: Number(m[1]), text: bodyText });
        }
      }
    });
  });
}

test("uploading a file the node already has answers at once", async () => {
  // A real PNG followed by 3 MiB of padding: large enough that the body is still streaming.
  const png = new Uint8Array(await Bun.file(new URL("./fixtures/kestrel/images/KO-1001_NVY_1_front.png", import.meta.url)).arrayBuffer());
  const bytes = new Uint8Array(png.length + 3 * 1024 * 1024);
  bytes.set(png);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const put = () => rawPut(server.port!, `/obx/v1/ingest/blobs/${sha}`, { authorization: `Bearer ${token}`, "content-type": "image/png" }, bytes);
  expect((await put()).status).toBe(201);
  const again = await put();
  expect(again.status).toBe(200);
  expect(JSON.parse(again.text).created).toBe(false);
  const wrong = new Uint8Array(bytes);
  wrong[wrong.length - 1] = 1;
  const bad = await rawPut(server.port!, `/obx/v1/ingest/blobs/${sha}`, { authorization: `Bearer ${token}`, "content-type": "image/png" }, wrong);
  expect(bad.status).toBe(422);
  expect(JSON.parse(bad.text).obx_error).toBe("checksum_mismatch");
});

test("the admin UI is served at every route, with the API next to it", async () => {
  const base = `http://localhost:${server.port}`;
  for (const path of ["/", "/admin/catalog", "/invite/abc", "/request-access"]) {
    const res = await fetch(base + path, { headers: { accept: "text/html" } });
    expect({ path, status: res.status }).toEqual({ path, status: 200 });
    expect(await res.text()).toContain('<div id="app">');
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  }
  const en = await fetch(`${base}/locales/en.json`);
  expect((await en.json()).email.invite.subject).toContain("{{portal}}");
  expect((await fetch(`${base}/admin/api/session`)).headers.get("content-type")).toContain("json");
});

test("UI files follow admin-ui's integration guide: strict CSP, caching, no HTML for missing files", async () => {
  const base = `http://localhost:${server.port}`;
  const html = await fetch(`${base}/admin`, { headers: { accept: "text/html" } });
  const csp = html.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("style-src 'self';");
  expect(csp).not.toContain("unsafe-inline");
  expect(html.headers.get("cache-control")).toBe("no-cache");
  const asset = (await html.text()).match(/assets\/[^"]+\.js/)![0];
  expect((await fetch(`${base}/${asset}`)).headers.get("cache-control")).toContain("immutable");
  for (const path of ["/assets/Gone-12345678.js", "/locales/xx.json"]) {
    const res = await fetch(base + path, { headers: { accept: "text/html,*/*" } });
    expect({ path, status: res.status }).toEqual({ path, status: 404 });
  }
  for (const path of ["/LICENSE", "/NOTICE", "/THIRD-PARTY-LICENSES.txt"]) {
    const res = await fetch(base + path);
    expect({ path, status: res.status, type: res.headers.get("content-type")?.replace(/;\s*/, "; ") }).toEqual({ path, status: 200, type: "text/plain; charset=utf-8" });
  }
  const api = await fetch(`${base}/admin/api/session`, { headers: { origin: "https://elsewhere.example" } });
  expect(api.headers.get("access-control-allow-origin")).toBeNull();
});
