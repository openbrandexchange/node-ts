// Portal appearance (spec node-admin.yaml, docs/node-admin.md "Portal appearance"): theme, login page,
// start page blocks, branding images and the favicon.
import { describe, expect, test, beforeAll } from "bun:test";
import { TestNode, fixtureText, formData, type Browser } from "./helpers";
import { fakeJpeg } from "../src/lib/image";

/** A PNG header (signature + IHDR) of the given size: enough for type sniffing and dimensions. */
function fakePng(width: number, height: number, seed = 0): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  b[24] = 8;
  b[25] = 6;
  b[40] = seed & 255;
  b[41] = (seed >> 8) & 255;
  return b;
}

async function upload(b: Browser, bytes: Uint8Array, name = "image.jpg") {
  const f = formData([{ name: "file", filename: name, type: "application/octet-stream", data: bytes }]);
  return b.req("POST", "/admin/api/settings/images", { body: f.body, headers: { "content-type": f.contentType } });
}

const FIXTURE = JSON.parse(fixtureText("examples/BrandingSettings.full.json"));

/** The fixture with its image ids replaced by images uploaded to this node. */
function withIds(x: unknown, ids: Map<string, string>): unknown {
  if (Array.isArray(x)) return x.map((y) => withIds(y, ids));
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, (k === "image" || k === "background_image") && typeof v === "string" ? ids.get(v) : withIds(v, ids)]));
  return x;
}

function imageIdsOf(x: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) for (const y of x) imageIdsOf(y, out);
  else if (x && typeof x === "object")
    for (const [k, v] of Object.entries(x)) {
      if ((k === "image" || k === "background_image") && typeof v === "string") out.add(v);
      else imageIdsOf(v, out);
    }
  return out;
}

describe("portal appearance", () => {
  let node: TestNode;
  let admin: Browser;
  let full: Record<string, any>;
  const ids = new Map<string, string>();

  beforeAll(async () => {
    node = new TestNode();
    admin = await node.setup();
    let n = 1;
    for (const id of imageIdsOf(FIXTURE)) {
      const r = await upload(admin, fakeJpeg(1600, 1000, n++));
      expect(r.status).toBe(201);
      ids.set(id, r.json.id);
    }
    full = withIds(FIXTURE, ids) as Record<string, any>;
  });

  test("the full fixture round-trips through the settings", async () => {
    const r = await admin.req("PATCH", "/admin/api/settings", { json: { branding: full } });
    expect(r.status).toBe(200);
    const got = (await admin.req("GET", "/admin/api/settings")).json.branding;
    expect(got).toMatchObject(full);
    expect(got.theme).toEqual(full.theme);
    expect(got.favicon_url).toBeNull();
    // Image ids and their URLs side by side.
    expect(got.login.background_image_url).toBe(`/admin/api/public/images/${full.login.background_image}`);
    expect(got.home.blocks[0].image_url).toBe(`/admin/api/public/images/${full.home.blocks[0].image}`);
    // Sending the response back unchanged changes nothing (the resolved URLs are ignored on write).
    const again = await admin.req("PATCH", "/admin/api/settings", { json: { branding: got } });
    expect(again.status).toBe(200);
    expect(again.json.branding).toEqual(got);
    const stored = JSON.parse((await node.platform.db.first<{ value: string }>("SELECT value FROM meta WHERE key = 'settings'"))!.value);
    expect(JSON.stringify(stored.branding)).not.toContain("image_url");
  });

  test("public branding has theme and login with the image URL, not the start page", async () => {
    const r = await node.request("GET", "/admin/api/public/branding");
    expect(r.json.theme).toEqual(full.theme);
    expect(r.json.login.background_image).toBe(full.login.background_image);
    expect(r.json.login.background_image_url).toBe(`/admin/api/public/images/${full.login.background_image}`);
    expect(r.json.home).toBeUndefined();
    expect(r.json).toHaveProperty("favicon_url", null);
  });

  test("the portal viewer gets the start page with every image resolved", async () => {
    const v = await admin.req("GET", "/admin/api/portal/viewer");
    expect(v.status).toBe(200);
    const blocks = v.json.branding.home.blocks;
    expect(blocks.map((b: any) => b.id)).toEqual(full.home.blocks.map((b: any) => b.id));
    expect(blocks[0].image).toBe(full.home.blocks[0].image);
    expect(blocks[0].image_url).toBe(`/admin/api/public/images/${full.home.blocks[0].image}`);
    const tiles = blocks.find((b: any) => b.type === "tiles");
    for (const it of tiles.items) expect(it.image_url).toBe(`/admin/api/public/images/${it.image}`);
    expect(v.json.branding.theme).toEqual(full.theme);
  });

  test("unknown members and unknown block types are stored and returned unchanged", async () => {
    const blocks = [
      ...full.home.blocks,
      { id: "lookbook", type: "lookbook_v2", pages: [{ image: "whatever", caption: { en: "x" } }], "x-acme": true },
      { id: "note", type: "text", body: { en: "Hello\n\nWorld" }, future_member: { a: 1 } },
    ];
    const r = await admin.req("PATCH", "/admin/api/settings", { json: { branding: { theme: { motion: "reduced", colors: { accent_2: "#123456" } }, login: { video: null, footer: "x" }, home: { blocks, layout_hint: "wide" } } } });
    expect(r.status).toBe(200);
    const got = (await admin.req("GET", "/admin/api/settings")).json.branding;
    expect(got.theme.motion).toBe("reduced");
    expect(got.theme.colors.accent_2).toBe("#123456");
    expect(got.theme.colors.primary).toBe(full.theme.colors.primary);
    expect(got.login.footer).toBe("x");
    expect(got.home.layout_hint).toBe("wide");
    const lb = got.home.blocks.find((b: any) => b.id === "lookbook");
    expect(lb.type).toBe("lookbook_v2");
    expect(lb["x-acme"]).toBe(true);
    expect(lb.pages[0].caption).toEqual({ en: "x" });
    expect(got.home.blocks.find((b: any) => b.id === "note").future_member).toEqual({ a: 1 });
    // A merge patch with null removes a member (back to the default).
    const cleared = await admin.req("PATCH", "/admin/api/settings", { json: { branding: { theme: { colors: { primary: null } } } } });
    expect(cleared.json.branding.theme.colors.primary).toBeNull();
  });

  test("validation: colours, enums, fonts, texts, links, blocks, image ids, size", async () => {
    const bad = async (branding: unknown, pointer: string) => {
      const r = await admin.req("PATCH", "/admin/api/settings", { json: { branding } });
      expect(r.status).toBe(422);
      expect(r.json.obx_error).toBe("validation_failed");
      expect(r.json.errors.map((e: any) => e.pointer)).toContain(pointer);
    };
    await bad({ theme: { colors: { primary: "red" } } }, "/branding/theme/colors/primary");
    await bad({ theme: { color_scheme: "sepia" } }, "/branding/theme/color_scheme");
    await bad({ theme: { heading_font: "comic-sans" } }, "/branding/theme/heading_font");
    await bad({ theme: { radius: "huge" } }, "/branding/theme/radius");
    await bad({ theme: { image_background: "#fff" } }, "/branding/theme/image_background");
    await bad({ theme: "dark" }, "/branding/theme");
    await bad({ login: { layout: "fullscreen" } }, "/branding/login/layout");
    await bad({ login: { background_image: "img_does_not_exist" } }, "/branding/login/background_image");
    await bad({ login: { background_image: "../etc/passwd" } }, "/branding/login/background_image");
    await bad({ login: { title: { en: "x".repeat(2001) } } }, "/branding/login/title/en");
    await bad({ login: { title: { en: "" } } }, "/branding/login/title/en");
    const block = (b: Record<string, unknown>) => ({ home: { blocks: [{ id: "b", ...b }] } });
    for (const link of ["javascript:alert(1)", "http://example.com", "//evil.example", "/\\evil.example", "mailto:a@b.c", "data:text/html,x", "https://", "/a b"])
      await bad(block({ type: "hero", link }), "/branding/home/blocks/0/link");
    await bad(block({ type: "hero", align: "right" }), "/branding/home/blocks/0/align");
    await bad(block({ type: "hero", image: "img_nope" }), "/branding/home/blocks/0/image");
    await bad(block({ type: "tiles", items: [] }), "/branding/home/blocks/0/items");
    await bad(block({ type: "tiles", items: [{ link: "ftp://x" }] }), "/branding/home/blocks/0/items/0/link");
    await bad(block({ type: "tiles", items: [{}], columns: 5 }), "/branding/home/blocks/0/columns");
    await bad(block({ type: "text", body: { en: "x".repeat(10001) } }), "/branding/home/blocks/0/body/en");
    await bad(block({ type: "products", style_numbers: Array(25).fill("KO-1001") }), "/branding/home/blocks/0/style_numbers");
    await bad(block({ type: "products", max: 25 }), "/branding/home/blocks/0/max");
    await bad(block({ type: "products", query: "?season=AW26" }), "/branding/home/blocks/0/query");
    await bad(block({ type: "announcement", tone: "danger" }), "/branding/home/blocks/0/tone");
    await bad(block({ type: "contact", email: "not-an-address" }), "/branding/home/blocks/0/email");
    await bad(block({ type: "Bad Type" }), "/branding/home/blocks/0/type");
    await bad({ home: { blocks: [{ type: "text" }] } }, "/branding/home/blocks/0/id");
    await bad({ home: { blocks: [{ id: "x".repeat(41), type: "text" }] } }, "/branding/home/blocks/0/id");
    await bad({ home: { blocks: [{ id: "a", type: "text" }, { id: "a", type: "text" }] } }, "/branding/home/blocks/1/id");
    await bad({ home: { blocks: Array.from({ length: 31 }, (_, i) => ({ id: `b${i}`, type: "text" })) } }, "/branding/home/blocks");
    await bad({ home: { blocks: "none" } }, "/branding/home/blocks");
    await bad({ home: { blocks: Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, type: "text", body: { en: "x".repeat(2500) } })) } }, "/branding");
    // Nothing of the failed patches was stored.
    expect((await admin.req("GET", "/admin/api/settings")).json.branding.login.layout).toBe("split");
    // Valid edge cases.
    const ok = await admin.req("PATCH", "/admin/api/settings", {
      json: { branding: { home: { blocks: [{ id: "p", type: "products", style_numbers: ["KO-1001"], query: "season=AW26", max: 24 }, { id: "h", type: "hero", link: "https://kestrel.example/about" }, { id: "t", type: "hero", link: "/products/KO-1001" }] } } },
    });
    expect(ok.status).toBe(200);
    await admin.req("PATCH", "/admin/api/settings", { json: { branding: full } });
  });

  test("branding images: upload, list with used, 409 while used, delete, public file", async () => {
    const r = await upload(admin, fakeJpeg(1920, 1080, 99), "hero.jpg");
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ url: `/admin/api/public/images/${r.json.id}`, width: 1920, height: 1080, content_type: "image/jpeg" });
    expect(r.json.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(r.json.bytes).toBeGreaterThan(0);
    const list = (await admin.req("GET", "/admin/api/settings/images")).json.items;
    expect(list.length).toBe(ids.size + 1);
    expect(list.find((i: any) => i.id === r.json.id).used).toBe(false);
    expect(list.find((i: any) => i.id === full.login.background_image).used).toBe(true);
    // Public, immutable, nosniff, no login needed.
    const pub = await node.request("GET", r.json.url);
    expect(pub.status).toBe(200);
    expect(pub.headers.get("content-type")).toBe("image/jpeg");
    expect(pub.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(pub.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pub.bytes.length).toBe(r.json.bytes);
    // Used images cannot be deleted.
    const used = await admin.req("DELETE", `/admin/api/settings/images/${full.login.background_image}`);
    expect(used.status).toBe(409);
    expect(used.json.obx_error).toBe("conflict");
    expect((await admin.req("DELETE", `/admin/api/settings/images/${r.json.id}`)).status).toBe(204);
    expect((await admin.req("DELETE", `/admin/api/settings/images/${r.json.id}`)).status).toBe(404);
    expect((await node.request("GET", r.json.url)).status).toBe(404);
    expect((await node.request("GET", "/admin/api/public/images/img_unknown")).status).toBe(404);
    // Content is checked, not the declared type; sizes are limited.
    const svg = await upload(admin, new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "x.png");
    expect(svg.status).toBe(415);
    const huge = await upload(admin, fakeJpeg(8001, 100, 3));
    expect(huge.status).toBe(422);
    const plain = await admin.req("POST", "/admin/api/settings/images", { body: fakeJpeg(10, 10, 1), headers: { "content-type": "image/jpeg" } });
    expect(plain.status).toBe(415);
    const nofile = formData([{ name: "other", data: "x" }]);
    expect((await admin.req("POST", "/admin/api/settings/images", { body: nofile.body, headers: { "content-type": nofile.contentType } })).status).toBe(422);
  });

  test("at most 200 images: then 409 limit_exceeded", async () => {
    const n = (await node.platform.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM branding_images"))!.n;
    const stmts = Array.from({ length: 200 - n }, (_, i) => ({
      sql: "INSERT INTO branding_images (id, sha256, content_type, width, height, bytes, created_at) VALUES (?, ?, 'image/jpeg', 1, 1, 1, '2026-01-01T00:00:00Z')",
      params: [`img_fill_${i}`, "0".repeat(64)],
    }));
    await node.platform.db.batch(stmts);
    const r = await upload(admin, fakeJpeg(20, 20, 7));
    expect(r.status).toBe(409);
    expect(r.json.obx_error).toBe("limit_exceeded");
    await node.platform.db.run("DELETE FROM branding_images WHERE id LIKE 'img_fill_%'");
  });

  test("favicon: square PNG or WebP, at most 1 MB", async () => {
    const jpg = await admin.req("PUT", "/admin/api/settings/favicon", { body: fakeJpeg(64, 64, 1), headers: { "content-type": "image/jpeg" } });
    expect(jpg.status).toBe(415);
    const wide = await admin.req("PUT", "/admin/api/settings/favicon", { body: fakePng(64, 32), headers: { "content-type": "image/png" } });
    expect(wide.status).toBe(422);
    const big = new Uint8Array(1048577);
    big.set(fakePng(512, 512));
    expect((await admin.req("PUT", "/admin/api/settings/favicon", { body: big, headers: { "content-type": "image/png" } })).status).toBe(413);
    const ok = await admin.req("PUT", "/admin/api/settings/favicon", { body: fakePng(180, 180, 5), headers: { "content-type": "image/png" } });
    expect(ok.status).toBe(200);
    expect(ok.json.branding.favicon_url).toMatch(/\/admin\/api\/public\/favicon\?v=[0-9a-f]{12}$/);
    const pub = await node.request("GET", "/admin/api/public/branding");
    expect(pub.json.favicon_url).toBe(ok.json.branding.favicon_url);
    const icon = await node.request("GET", new URL(ok.json.branding.favicon_url).pathname);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    // A favicon_url sent in a patch is ignored (read-only).
    const ro = await admin.req("PATCH", "/admin/api/settings", { json: { branding: { favicon_url: "https://evil.example/x.png", favicon_sha: "0".repeat(64) } } });
    expect(ro.json.branding.favicon_url).toBe(ok.json.branding.favicon_url);
    const del = await admin.req("DELETE", "/admin/api/settings/favicon");
    expect(del.json.branding.favicon_url).toBeNull();
    expect((await node.request("GET", "/admin/api/public/favicon")).status).toBe(404);
  });

  test("the daily file clean-up keeps branding images and the favicon", async () => {
    const { gcBlobs } = await import("../src/core/blobs");
    const { Ctx } = await import("../src/core/ctx");
    await admin.req("PUT", "/admin/api/settings/favicon", { body: fakePng(48, 48, 9), headers: { "content-type": "image/png" } });
    node.clock.offset += 2 * 24 * 3600_000;
    await gcBlobs(new Ctx(node.platform));
    const login = await node.request("GET", `/admin/api/public/images/${full.login.background_image}`);
    expect(login.status).toBe(200);
    const fav = (await admin.req("GET", "/admin/api/settings")).json.branding.favicon_url;
    expect((await node.request("GET", new URL(fav).pathname)).status).toBe(200);
    node.clock.offset = 0;
  });

  test("only signed-in brand admins change the appearance", async () => {
    const anon = await node.browser();
    expect((await upload(anon, fakeJpeg(10, 10, 1))).status).toBe(401);
    expect((await anon.req("PUT", "/admin/api/settings/favicon", { body: fakePng(16, 16), headers: { "content-type": "image/png" } })).status).toBe(401);
  });
});
