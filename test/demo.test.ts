// Demo mode (OBX_DEMO, docs/demo.md): off by default; on, it signs visitors in with one click,
// refuses risky actions and resets to the Kestrel fixtures.
import { describe, expect, test, beforeAll } from "bun:test";
import { join } from "node:path";
import { TestNode, FIX, type Browser } from "./helpers";
import { buildSeed } from "../scripts/demo-seed";
import { fakeJpeg } from "../src/lib/image";
import { DEMO, demoRefusal } from "../src/core/demo";

const counts = async (node: TestNode) =>
  node.platform.db.first<Record<string, number>>(
    "SELECT (SELECT COUNT(*) FROM brands) AS brands, (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM variants) AS variants, (SELECT COUNT(*) FROM assets) AS assets",
  );

/** Runs the minute tick (reset / finish) and the background jobs until the demo is ready. */
async function settle(node: TestNode) {
  for (let i = 0; i < 20; i++) {
    await node.worker.tick(60_000);
    await node.drain();
    const st = JSON.parse((await node.platform.db.first<{ value: string }>("SELECT value FROM meta WHERE key = 'demo_state'"))?.value ?? "null");
    if (st?.phase === "ready") return st;
    if (st?.phase === "failed") throw new Error(`demo reset failed: ${st.error}`);
  }
  throw new Error("demo did not become ready");
}

describe("demo mode off (default)", () => {
  let node: TestNode;
  beforeAll(async () => {
    node = new TestNode();
    await node.setup();
  });

  test("no demo routes, no demo in the branding", async () => {
    const b = await node.browser();
    expect((await b.req("GET", "/admin/api/demo")).status).toBe(404);
    expect((await b.req("POST", "/admin/api/demo/login", { json: { as: "brand" } })).status).toBe(404);
    expect((await b.req("POST", "/admin/api/demo/reset", { json: {} })).status).toBe(404);
    const br = await b.req("GET", "/admin/api/public/branding");
    expect(br.json["x-obx-demo"]).toBeUndefined();
    const disc = await node.request("GET", "/.well-known/obx");
    expect(disc.json.capabilities).toContain("webhooks");
  });
});

describe("demo mode on", () => {
  let node: TestNode;
  let brand: Browser;
  let retailer: Browser;

  beforeAll(async () => {
    node = new TestNode({ OBX_DEMO: "true", OBX_SETUP_CODE: "" });
    // The seed archive as scripts/demo-seed.ts makes it, with placeholder JPEGs instead of drawn ones.
    let n = 0;
    const seed = await buildSeed(join(FIX, "kestrel"), async (_orig, name, sizes) => fakeJpeg(sizes[name].width, sizes[name].height, ++n));
    await node.platform.blobs.put(DEMO.seedKey, seed, "application/zip");
    await settle(node);
    brand = await node.browser();
    retailer = await node.browser();
  }, 120_000);

  test("the reset imports the fixtures and creates the demo accounts", async () => {
    expect(await counts(node)).toEqual({ brands: 2, products: 11, variants: 46, assets: 35 });
    const st = await node.platform.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM download_events");
    expect(st!.n).toBeGreaterThan(50);
    const br = await brand.req("GET", "/admin/api/public/branding");
    expect(br.json["x-obx-demo"].ready).toBe(true);
    expect(br.json["x-obx-demo"].api.client_id).toBe(DEMO.clientId);
    const disc = await node.request("GET", "/.well-known/obx");
    expect(disc.json.capabilities).not.toContain("webhooks");
    expect(disc.json.capabilities).not.toContain("ingest");
    expect(disc.json.capabilities).not.toContain("usage");
    expect(disc.json.ingest_url).toBeNull();
  });

  test("one-click sign-in as the brand and as the retailer", async () => {
    const b = await brand.req("POST", "/admin/api/demo/login", { json: { as: "brand" } });
    expect(b.status).toBe(200);
    expect(b.json.user.role).toBe("admin");
    expect((await brand.req("GET", "/admin/api/stats")).status).toBe(200);
    expect((await brand.req("GET", "/admin/api/retailers")).json.items.length).toBe(3);
    const r = await retailer.req("POST", "/admin/api/demo/login", { json: { as: "retailer" } });
    expect(r.status).toBe(200);
    expect(r.json.retailer.id).toBe(DEMO.retailer);
    const list = await retailer.req("GET", "/admin/api/portal/products");
    expect(list.status).toBe(200);
    expect(list.json.items.length).toBeGreaterThan(0);
    expect((await retailer.req("GET", "/admin/api/portal/products/data.csv")).status).toBe(200);
    expect((await retailer.req("POST", "/admin/api/demo/login", { json: { as: "nobody" } })).status).toBe(422);
    expect((await retailer.req("POST", "/admin/api/demo/login", { json: { as: "brand" }, noCsrf: true })).status).toBe(403);
  });

  test("risky actions are refused", async () => {
    const refused = async (b: Browser, method: string, path: string, json?: unknown) => {
      const r = await b.req(method, path, json === undefined ? {} : { json });
      expect([403, 501, 413]).toContain(r.status);
      expect(r.json["x-obx-demo"]).toBe(true);
      return r;
    };
    await refused(brand, "PATCH", "/admin/api/me", { current_password: "x", new_password: "a much better password" });
    await refused(brand, "DELETE", "/admin/api/me");
    await refused(brand, "POST", "/admin/api/password/forgot", { email: "brand@kestrel.example" });
    await refused(brand, "POST", "/admin/api/users/invites", { email: "x@example.com", role: "admin" });
    await refused(brand, "PATCH", `/admin/api/users/${DEMO.retailerUser}`, { status: "blocked" });
    await refused(brand, "PATCH", `/admin/api/retailers/${DEMO.retailer}`, { status: "blocked" });
    await refused(brand, "DELETE", `/admin/api/retailers/${DEMO.retailer}`);
    await refused(brand, "POST", "/admin/api/api-clients", { retailer_id: DEMO.retailer, name: "mine" });
    await refused(brand, "POST", `/admin/api/api-clients/${DEMO.client}/rotate`);
    await refused(brand, "POST", "/admin/api/ingest-tokens", { name: "x", scopes: ["ingest:read"] });
    await refused(brand, "POST", "/admin/api/webhooks", { url: "https://example.com/hook", events: ["catalog.changed"] });
    await refused(brand, "POST", "/admin/api/import-sources", { name: "pull", kind: "https_url" });
    await refused(brand, "PATCH", "/admin/api/settings", { branding: { display_name: "Something else" } });
    await refused(brand, "DELETE", "/admin/api/catalog/products/KO-1001");
    await refused(brand, "POST", "/admin/api/access-requests/acr_demo_fjord/approve", { create_api_client: true });
    await refused(retailer, "POST", "/admin/api/portal/api-clients", { name: "mine" });
    const big = await retailer.req("POST", "/admin/api/imports", { body: new Uint8Array(3 * 1048576), headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(3 * 1048576) } });
    expect(big.status).toBe(413);
    // Harmless changes stay possible: the demo is for trying things out.
    expect((await brand.req("PATCH", "/admin/api/me", { json: { language: "nl" } })).status).toBe(200);
    expect((await brand.req("PATCH", "/admin/api/retailers/rtl_demo_harbour", { json: { allow_original: true } })).status).toBe(200);
    expect(node.mails.length).toBe(0);
  });

  test("the public key reads the API and cannot write", async () => {
    const tok = await node.accessToken(DEMO.clientId, DEMO.clientSecret);
    const products = await node.api(tok, "GET", "/obx/v1/products?limit=100");
    expect(products.status).toBe(200);
    expect(products.json.items.length).toBe(11);
    const feed = await node.feed(tok);
    expect(feed.entries.length).toBeGreaterThan(90);
    const one = products.json.items.find((p: any) => p.style_number === "KO-1001");
    const asset = (await node.api(tok, "GET", `/obx/v1/products/${one.id}`)).json.assets[0];
    const web = await node.api(tok, "GET", `/obx/v1/assets/${asset.id}/renditions/web`);
    expect(web.status).toBe(200);
    expect(web.headers.get("x-obx-fallback")).toBeNull();
    expect((await node.api(tok, "POST", "/obx/v1/usage", { json: { events: [{ asset_id: asset.id, event: "published", at: new Date().toISOString() }] } })).status).toBe(501);
    expect((await node.api(tok, "POST", "/obx/v1/webhooks", { json: { url: "https://example.com/h", events: ["changes.available"] } })).status).toBe(501);
    expect((await node.api(tok, "GET", "/obx/v1/ingest")).status).toBe(501);
    const bad = await node.request("POST", "/obx/v1/oauth/token", {
      headers: { authorization: `Basic ${btoa(`${DEMO.clientId}:${DEMO.clientSecret}`)}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&scope=usage:write",
    });
    expect(bad.status).toBe(400);
  });

  test("the reset puts the fixtures back and keeps the demo sessions", async () => {
    const tok = await node.accessToken(DEMO.clientId, DEMO.clientSecret);
    const before = await node.feed(tok);
    expect((await brand.req("PATCH", "/admin/api/catalog/products/KO-1001", { json: { name: { en: "Broken by a visitor" } } })).status).toBe(200);
    expect((await brand.req("POST", "/admin/api/retailers", { json: { name: "Visitor's shop" } })).status).toBe(201);
    const harbour = await brand.req("DELETE", "/admin/api/retailers/rtl_demo_harbour");
    expect(harbour.status).toBe(204);
    const r = await brand.req("POST", "/admin/api/demo/reset", { json: {} });
    expect(r.status).toBe(202);
    expect((await brand.req("POST", "/admin/api/demo/reset", { json: {} })).status).toBe(429);
    await settle(node);
    expect(await counts(node)).toEqual({ brands: 2, products: 11, variants: 46, assets: 35 });
    const names = (await node.platform.db.all<{ name: string }>("SELECT name FROM retailers ORDER BY name")).map((x) => x.name);
    expect(names).toEqual(["Harbour & Co", "Lumen Concept Store", "Northwind Stores"]);
    const p = await node.platform.db.first<{ stored: string }>("SELECT stored FROM products WHERE external_id = 'KO-1001'");
    expect(JSON.parse(p!.stored).name.en).toBe("Merino Crew Sweater");
    // Still signed in after the reset.
    expect((await brand.req("GET", "/admin/api/settings")).status).toBe(200);
    expect((await retailer.req("GET", "/admin/api/portal/viewer")).status).toBe(200);
    // An old feed cursor cannot continue into the new catalog.
    const cont = await node.api(tok, "GET", `/obx/v1/changes?cursor=${encodeURIComponent(before.cursor)}`);
    expect(cont.status).toBe(410);
  });

  test("the reset runs on schedule", async () => {
    const st1 = JSON.parse((await node.platform.db.first<{ value: string }>("SELECT value FROM meta WHERE key = 'demo_state'"))!.value);
    node.clock.offset += 61 * 60_000;
    const st2 = await settle(node);
    expect(Date.parse(st2.reset_at)).toBeGreaterThan(Date.parse(st1.reset_at));
  });
});

describe("demo rules", () => {
  test("reads are allowed, the shared accounts are protected", () => {
    expect(demoRefusal("GET", "/admin/api/portal/products", null)).toBeNull();
    expect(demoRefusal("GET", "/admin/api/invites/abc", null)?.code).toBe("forbidden");
    expect(demoRefusal("PATCH", "/admin/api/me", { language: "de" })).toBeNull();
    expect(demoRefusal("PATCH", "/admin/api/me", { new_password: "x" })?.code).toBe("forbidden");
    expect(demoRefusal("PATCH", "/admin/api/settings", { portal: { allow_original_download: false } })).toBeNull();
    expect(demoRefusal("PUT", "/admin/api/catalog/products/KO-1001", null)).toBeNull();
    expect(demoRefusal("DELETE", "/admin/api/webhooks/whk_1", null)).toBeNull();
    expect(demoRefusal("POST", "/admin/api/access-requests/acr_1/approve", { create_api_client: false, invite_portal_user: true })).toBeNull();
    expect(demoRefusal("GET", "/obx/v1/webhooks", null)?.code).toBe("not_implemented");
  });
});
