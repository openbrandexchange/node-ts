import { describe, expect, test } from "bun:test";
import { TestNode, SETUP_CODE } from "./helpers";

describe("first-run setup (A-SETUP-1)", () => {
  test("before setup: discovery 503, admin 409 setup_required, setup needs the code", async () => {
    const node = new TestNode();
    const disc = await node.request("GET", "/.well-known/obx");
    expect(disc.status).toBe(503);
    expect(disc.json.obx_error).toBe("setup_required");
    const b = await node.browser();
    expect((await b.req("GET", "/admin/api/setup")).json).toEqual({ required: true });
    expect((await b.req("GET", "/admin/api/settings")).json.obx_error).toBe("setup_required");
    const wrong = await b.req("POST", "/admin/api/setup", {
      json: { setup_code: "WRONG-CODE", company: { name: "Kestrel Outfitters", default_language: "en" }, admin: { name: "A", email: "a@kestrel.example", password: "a long enough password" } },
    });
    expect(wrong.status).toBe(403);
    const weak = await b.req("POST", "/admin/api/setup", {
      json: { setup_code: SETUP_CODE, company: { name: "Kestrel Outfitters", default_language: "en" }, admin: { name: "A", email: "a@kestrel.example", password: "password123" } },
    });
    expect(weak.status).toBe(422);
    expect(weak.json.errors[0].pointer).toBe("/admin/password");
  });

  test("setup logs in, creates the first brand, then answers setup_completed", async () => {
    const node = new TestNode();
    const admin = await node.setup();
    const s = await admin.req("GET", "/admin/api/session");
    expect(s.json.authenticated).toBe(true);
    expect(s.json.user.role).toBe("admin");
    const brands = await admin.req("GET", "/admin/api/catalog/brands");
    expect(brands.json.items.map((b: any) => b.external_id)).toEqual(["kestrel"]);
    const again = await admin.req("POST", "/admin/api/setup", { json: { setup_code: SETUP_CODE, company: { name: "X", default_language: "en" }, admin: { name: "B", email: "b@x.example", password: "another long password" } } });
    expect(again.status).toBe(409);
    expect(again.json.obx_error).toBe("setup_completed");
    const disc = await node.request("GET", "/.well-known/obx");
    expect(disc.status).toBe(200);
    expect(disc.headers.get("access-control-allow-origin")).toBe("*");
    expect(disc.json.api_base.endsWith("/obx/v1")).toBe(true);
    expect(disc.json.capabilities).toEqual(expect.arrayContaining(["changes", "products", "by_gtin", "renditions"]));
    expect(disc.json.languages).toEqual(["nl", "en"]);
    expect(disc.json.brands.map((b: any) => b.name)).toEqual(["Kestrel"]);
    expect(disc.headers.get("obx-version")).toBe("0.3");
  });
});

describe("setup code as people type it", () => {
  test("a chosen OBX_SETUP_CODE matches whatever the case and surrounding spaces", async () => {
    const node = new TestNode({ OBX_SETUP_CODE: "Kestrel-2026" });
    const b = await node.browser();
    const r = await b.req("POST", "/admin/api/setup", {
      json: { setup_code: "  kestrel-2026 ", company: { name: "Kestrel Outfitters", default_language: "en" }, admin: { name: "A", email: "a@kestrel.example", password: "a long enough password" } },
    });
    expect(r.status).toBe(201);
  });

  test("the generated code is logged with the address to open", async () => {
    const node = new TestNode({ OBX_SETUP_CODE: "", OBX_PUBLIC_URL: "https://brands.kestrel.example/" });
    const lines: string[] = [];
    node.platform.log = (_level, msg) => void lines.push(msg);
    await node.worker.rotateSetupCode();
    const line = lines.find((l) => l.startsWith("First-run setup code: "));
    expect(line).toContain("open https://brands.kestrel.example in your browser");
    const code = line!.match(/code: (\S+)/)![1];
    const b = await node.browser();
    const r = await b.req("POST", "/admin/api/setup", {
      json: { setup_code: code.toLowerCase(), company: { name: "Kestrel Outfitters", default_language: "en" }, admin: { name: "A", email: "a@kestrel.example", password: "a long enough password" } },
    });
    expect(r.status).toBe(201);
  });
});

describe("sessions and CSRF (A-SESS-1)", () => {
  test("login, wrong password, CSRF required, cookie flags, logout", async () => {
    const node = new TestNode();
    await node.setup();
    const b = await node.browser();
    const noCsrf = await b.req("POST", "/admin/api/session/login", { json: { email: "admin@kestrel.example", password: "correct horse battery staple" }, noCsrf: true });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.json.obx_error).toBe("csrf_failed");
    const bad = await b.req("POST", "/admin/api/session/login", { json: { email: "admin@kestrel.example", password: "wrong password here" } });
    expect(bad.status).toBe(401);
    expect(bad.json.obx_error).toBe("invalid_credentials");
    const unknown = await b.req("POST", "/admin/api/session/login", { json: { email: "nobody@kestrel.example", password: "wrong password here" } });
    expect(unknown.json.obx_error).toBe("invalid_credentials");
    const ok = await node.request("POST", "/admin/api/session/login", {
      headers: { "content-type": "application/json", cookie: b.cookieHeader(), "x-csrf-token": b.csrf },
      body: JSON.stringify({ email: "admin@kestrel.example", password: "correct horse battery staple" }),
    });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.getSetCookie().find((c) => c.startsWith("obx_session="))!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    b.absorb(ok.headers);
    b.csrf = ok.json.csrf_token;
    expect((await b.req("GET", "/admin/api/settings")).status).toBe(200);
    expect((await b.req("POST", "/admin/api/session/logout")).status).toBe(204);
    expect((await b.req("GET", "/admin/api/settings")).status).toBe(401);
  });
});
