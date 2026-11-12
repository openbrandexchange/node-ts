import { describe, expect, test, beforeAll } from "bun:test";
import { TestNode, importKestrel, addRenditions, fixtureText, fixtureBytes, match, type Browser } from "./helpers";
import { sha256Hex } from "../src/lib/crypto";
import { readZipDirectory, readZipEntry } from "../src/lib/zip";
import { bytesReader } from "../src/lib/multipart";

let node: TestNode;
let admin: Browser;
let token: string;
let full: { clientId: string; secret: string; retailer: any };
let at: string;
let brandIds: Record<string, string>;

beforeAll(async () => {
  node = new TestNode();
  admin = await node.setup();
  token = await node.ingestToken(admin);
  await importKestrel(node, token);
  await addRenditions(node, token);
  full = await node.retailerClient(admin, { name: "Full Retailer", scopes: ["catalog:read", "media:read", "media:original", "usage:write"] });
  at = await node.accessToken(full.clientId, full.secret);
  brandIds = Object.fromEntries((await node.platform.db.all<{ id: string; external_id: string }>("SELECT id, external_id FROM brands")).map((b) => [b.external_id, b.id]));
}, 120_000);

const productId = async (ext: string) => (await node.platform.db.first<{ id: string }>("SELECT id FROM products WHERE external_id = ?", [ext]))!.id;
const assetId = async (ext: string) => (await node.platform.db.first<{ id: string }>("SELECT id FROM assets WHERE external_id = ?", [ext]))!.id;

describe("OAuth2 token endpoint and bearer auth (P-AUTH-1, P-AUTH-2)", () => {
  test("client_secret_basic, client_secret_post, wrong secret, unknown scope", async () => {
    const form = (b: Record<string, string>, auth?: string) =>
      node.request("POST", "/obx/v1/oauth/token", { headers: { "content-type": "application/x-www-form-urlencoded", ...(auth ? { authorization: auth } : {}) }, body: new URLSearchParams(b).toString() });
    const ok = await form({ grant_type: "client_credentials" }, `Basic ${btoa(`${full.clientId}:${full.secret}`)}`);
    expect(ok.status).toBe(200);
    expect(ok.json.token_type).toBe("Bearer");
    expect(ok.json.expires_in).toBe(3600);
    expect(ok.json.scope.split(" ").sort()).toEqual(["catalog:read", "media:original", "media:read", "usage:write"]);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const plain = await node.retailerClient(admin, { name: "Default Scopes" });
    expect(plain.clientRow.scopes.sort()).toEqual(["catalog:read", "media:original", "media:read"]);
    const post = await form({ grant_type: "client_credentials", client_id: full.clientId, client_secret: full.secret, scope: "catalog:read" });
    expect(post.json.scope).toBe("catalog:read");
    const wrong = await form({ grant_type: "client_credentials" }, `Basic ${btoa(`${full.clientId}:obxs_wrong`)}`);
    expect(wrong.status).toBe(401);
    expect(wrong.json.error).toBe("invalid_client");
    expect(wrong.headers.get("www-authenticate")).toContain("Basic");
    const scope = await form({ grant_type: "client_credentials", scope: "catalog:write" }, `Basic ${btoa(`${full.clientId}:${full.secret}`)}`);
    expect(scope.status).toBe(400);
    expect(scope.json.error).toBe("invalid_scope");
    const grant = await form({ grant_type: "password" }, `Basic ${btoa(`${full.clientId}:${full.secret}`)}`);
    expect(grant.json.error).toBe("unsupported_grant_type");
  });

  test("missing, invalid and revoked tokens are problem+json 401s; scopes are enforced", async () => {
    const none = await node.request("GET", "/obx/v1/changes");
    expect(none.status).toBe(401);
    expect(none.headers.get("content-type")).toContain("application/problem+json");
    expect(none.json.obx_error).toBe("unauthorized");
    expect((await node.api("obxa_garbage", "GET", "/obx/v1/changes")).json.obx_error).toBe("invalid_token");
    const narrow = await node.accessToken(full.clientId, full.secret, "catalog:read");
    const id = await assetId("KO-1001_NVY_1");
    expect((await node.api(narrow, "GET", `/obx/v1/assets/${id}`)).json.obx_error).toBe("insufficient_scope");
    const tmp = await node.retailerClient(admin, { name: "Soon Revoked" });
    const t = await node.accessToken(tmp.clientId, tmp.secret);
    expect((await node.api(t, "GET", "/obx/v1/grant")).status).toBe(200);
    expect((await admin.req("DELETE", `/admin/api/api-clients/${tmp.clientRow.id}`)).status).toBe(204);
    const revoked = await node.api(t, "GET", "/obx/v1/grant");
    expect(revoked.status).toBe(401);
    expect(revoked.json.obx_error).toBe("access_revoked");
    const tmp2 = await node.retailerClient(admin, { name: "Soon Blocked" });
    const t2 = await node.accessToken(tmp2.clientId, tmp2.secret);
    await admin.req("PATCH", `/admin/api/retailers/${tmp2.retailer.id}`, { json: { status: "blocked" }, headers: { "content-type": "application/merge-patch+json" } });
    expect((await node.api(t2, "GET", "/obx/v1/changes")).json.obx_error).toBe("access_revoked");
  });
});

describe("change feed (P-FEED-1..4, P-FEED-6)", () => {
  test("limit=1 paging yields the same entries as limit=500; garbage cursor is cursor_invalid", async () => {
    const big = await node.feed(at, undefined, 500);
    const small = await node.feed(at, undefined, 1);
    const key = (e: any) => `${e.type}:${e.op}:${e.id}`;
    expect(small.entries.map(key)).toEqual(big.entries.map(key));
    const bad = await node.api(at, "GET", "/obx/v1/changes?cursor=not-a-cursor");
    expect(bad.status).toBe(400);
    expect(bad.json.obx_error).toBe("cursor_invalid");
  });

  test("a retailer restricted to kestrel never sees kestrel-trail (P-FEED-4, A-PORT-2)", async () => {
    const r = await node.retailerClient(admin, { name: "Kestrel Only", brand_ids: [brandIds["kestrel"]] });
    const t = await node.accessToken(r.clientId, r.secret);
    const f = await node.feed(t);
    expect(f.entries.length).toBeGreaterThan(0);
    expect(f.entries.every((e) => e.type === "grant" || e.brand_id === brandIds["kestrel"])).toBe(true);
    const trail = await node.platform.db.first<{ id: string }>("SELECT id FROM products WHERE brand_id = ?", [brandIds["kestrel-trail"]]);
    const notFound = await node.api(t, "GET", `/obx/v1/products/${trail!.id}`);
    expect(notFound.status).toBe(404);
    const gtin = await node.platform.db.first<{ gtin14: string }>("SELECT gtin14 FROM variants WHERE brand_id = ?", [brandIds["kestrel-trail"]]);
    const look = await node.api(t, "POST", "/obx/v1/products:by-gtin", { json: { gtins: [gtin!.gtin14] } });
    expect(look.json.results[0].status).toBe("unmatched");
    expect((await node.api(t, "GET", `/obx/v1/brands/${brandIds["kestrel-trail"]}`)).status).toBe(404);
    // grant change → grant entry with resync
    await admin.req("PATCH", `/admin/api/retailers/${r.retailer.id}`, { json: { brand_ids: null } });
    const after = await node.feed(t, f.cursor);
    const g = after.entries.find((e) => e.type === "grant");
    expect(g.resync).toBe(true);
    expect(g.data.brand_ids).toBeNull();
    // unpublishing a brand writes tombstones for it and everything under it
    const trailOnly = await node.feed(t);
    await node.api(token, "PATCH", "/obx/v1/ingest/brands/kestrel-trail", { json: { status: "unpublished" }, headers: { "content-type": "application/merge-patch+json" } });
    const tomb = await node.feed(t, trailOnly.cursor);
    expect(tomb.entries[0]).toMatchObject({ type: "brand", op: "delete", external_id: "kestrel-trail" });
    const trailCount = trailOnly.entries.filter((e) => e._phase === "snapshot" && e.brand_id === brandIds["kestrel-trail"]).length;
    expect(tomb.entries.filter((e) => e.op === "delete").length).toBe(trailCount);
    await node.api(token, "PATCH", "/obx/v1/ingest/brands/kestrel-trail", { json: { status: "published" }, headers: { "content-type": "application/merge-patch+json" } });
    const back = await node.feed(t, tomb.cursor);
    expect(back.entries.filter((e) => e.op === "upsert").length).toBe(trailCount);
  });
});

describe("catalog reads (P-CAT-2..4)", () => {
  test("keyset pagination is complete; ids filter omits unknown ids", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await node.api(at, "GET", `/obx/v1/products?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(r.status).toBe(200);
      seen.push(...r.json.items.map((p: any) => p.id));
      cursor = r.json.next_cursor;
    } while (cursor);
    expect(seen.length).toBe(11);
    expect([...seen].sort()).toEqual(seen);
    const ids = await node.api(at, "GET", `/obx/v1/products?ids=${seen[0]},prd_unknown,${seen[1]}`);
    expect(ids.json.items.map((p: any) => p.id)).toEqual([seen[0], seen[1]]);
  });

  test("GTIN lookup matches expected/gtin-lookup.json; 2001 codes is limit_exceeded", async () => {
    const req = JSON.parse(fixtureText("expected/gtin-lookup.request.json"));
    const r = await node.api(at, "POST", "/obx/v1/products:by-gtin", { json: req });
    const exp = JSON.parse(fixtureText("expected/gtin-lookup.json"));
    expect(match(exp.results, r.json.results)).toEqual([]);
    expect(r.json.products.length).toBe(exp.products.length);
    const many = await node.api(at, "POST", "/obx/v1/products:by-gtin", { json: { gtins: Array.from({ length: 2001 }, (_, i) => String(i)) } });
    expect(many.status).toBe(400);
    expect(many.json.obx_error).toBe("limit_exceeded");
    const get = await node.api(at, "GET", "/obx/v1/products:by-gtin?gtin=2000100101025");
    expect(get.json.results[0].status).toBe("matched");
  });

  test("an unpublished product is 404, never 403", async () => {
    await node.api(token, "PATCH", "/obx/v1/ingest/products/KO-1006", { json: { status: "unpublished" }, headers: { "content-type": "application/merge-patch+json" } });
    const r = await node.api(at, "GET", `/obx/v1/products/${await productId("KO-1006")}`);
    expect(r.status).toBe(404);
    expect(r.json.obx_error).toBe("not_found");
    await node.api(token, "PATCH", "/obx/v1/ingest/products/KO-1006", { json: { status: "published" }, headers: { "content-type": "application/merge-patch+json" } });
  });
});

describe("media (P-MEDIA-2, P-MEDIA-3, P-AUTH-3)", () => {
  test("renditions: hash, ETag, Range, If-None-Match, signed URL without Authorization; originals byte-identical", async () => {
    const id = await assetId("KO-1002_OLV_1");
    const a = (await node.api(at, "GET", `/obx/v1/assets/${id}`)).json;
    for (const name of ["original", "web", "square", "thumb"]) {
      const rend = a.renditions[name];
      const res = await node.request("GET", new URL(rend.url).pathname + new URL(rend.url).search);
      expect(res.status).toBe(200);
      expect(await sha256Hex(res.bytes)).toBe(rend.sha256);
      expect(res.headers.get("etag")).toBe(`"${rend.sha256}"`);
      expect(res.headers.get("obx-content-sha256")).toBe(rend.sha256);
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(res.headers.get("content-disposition")).toContain(name === "original" ? "KO-1002_OLV_1_front.png" : `KO-1002_OLV_1_front_${name}.jpg`);
    }
    const orig = fixtureBytes("kestrel/images/KO-1002_OLV_1_front.png");
    const path = `/obx/v1/assets/${id}/renditions/original`;
    const bearer = await node.api(at, "GET", path);
    expect(bearer.bytes).toEqual(orig);
    const range = await node.api(at, "GET", path, { headers: { range: "bytes=10-19" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 10-19/${orig.length}`);
    expect(range.bytes).toEqual(orig.slice(10, 20));
    const nm = await node.api(at, "GET", path, { headers: { "if-none-match": `"${a.sha256}"` } });
    expect(nm.status).toBe(304);
    const tampered = new URL(a.renditions.web.url);
    tampered.searchParams.set("exp", String(Number(tampered.searchParams.get("exp")) + 60));
    expect((await node.request("GET", tampered.pathname + tampered.search)).status).toBe(403);
    expect(a.renditions.web.width).toBe(1600);
    expect(a.renditions.web.height).toBe(2000);
  });

  test("a retailer without originals never gets the original rendition", async () => {
    const r = await node.retailerClient(admin, { name: "No Originals", allow_original: false });
    const t = await node.accessToken(r.clientId, r.secret);
    const id = await assetId("KO-1001_NVY_1");
    const a = await node.api(t, "GET", `/obx/v1/assets/${id}`);
    expect(match(JSON.parse(fixtureText("expected/asset-without-original-scope.json")), a.json)).toEqual([]);
    const o = await node.api(t, "GET", `/obx/v1/assets/${id}/renditions/original`);
    expect(o.status).toBe(403);
    const p = await node.api(t, "GET", `/obx/v1/products/${await productId("KO-1001")}`);
    expect(p.json.assets.every((x: any) => !x.renditions.original)).toBe(true);
  });
});

describe("access requests (P-ACC-1, A-RET-1)", () => {
  test("request → approve with API → credentials exactly once; reject shows the reason", async () => {
    const req = await node.request("POST", "/obx/v1/access-requests", {
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify({ retailer: { name: "Fictional Fashion BV", country: "NL" }, contact: { name: "Rita", email: "rita@fictional.example", language: "nl" }, access: ["portal", "api"] }),
    });
    expect(req.status).toBe(202);
    expect(req.json.request_token).toMatch(/^obxr_/);
    const poll = () => node.api(req.json.request_token, "GET", `/obx/v1/access-requests/${req.json.id}`);
    expect((await poll()).json.status).toBe("pending");
    expect((await node.api("obxr_wrong", "GET", `/obx/v1/access-requests/${req.json.id}`)).status).toBe(404);
    const list = await admin.req("GET", "/admin/api/access-requests?status=pending");
    expect(list.json.items.some((x: any) => x.id === req.json.id)).toBe(true);
    const ap = await admin.req("POST", `/admin/api/access-requests/${req.json.id}/approve`, { json: {} });
    expect(ap.status).toBe(200);
    expect(ap.json.api_client.client_id).toMatch(/^obxc_/);
    expect(JSON.stringify(ap.json)).not.toContain("obxs_");
    expect(ap.json.invite.email_sent).toBe(true);
    const first = (await poll()).json;
    expect(first.status).toBe("approved");
    expect(first.credentials.client_secret).toMatch(/^obxs_/);
    expect(first.credentials.claimed).toBe(false);
    expect(first.portal.invited).toBe(true);
    const second = (await poll()).json;
    expect(second.credentials.client_secret).toBeNull();
    expect(second.credentials.claimed).toBe(true);
    const tok = await node.accessToken(first.credentials.client_id, first.credentials.client_secret);
    expect((await node.api(tok, "GET", "/obx/v1/grant")).json.retailer.name).toBe("Fictional Fashion BV");
    expect(node.mails.some((m) => m.to === "rita@fictional.example" && /Beeldbank/.test(m.subject))).toBe(true);

    const req2 = await node.request("POST", "/obx/v1/access-requests", {
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.8" },
      body: JSON.stringify({ retailer: { name: "Other Shop" }, contact: { name: "Otto", email: "otto@other.example" } }),
    });
    await admin.req("POST", `/admin/api/access-requests/${req2.json.id}/reject`, { json: { reason: "We only supply through our distributor." } });
    const rej = (await node.api(req2.json.request_token, "GET", `/obx/v1/access-requests/${req2.json.id}`)).json;
    expect(rej.status).toBe("rejected");
    expect(rej.reason).toBe("We only supply through our distributor.");
    expect((await admin.req("POST", `/admin/api/access-requests/${req2.json.id}/approve`, { json: {} })).status).toBe(409);
  });
});

describe("access request from the web form: the brand shows the key", () => {
  test("renewing the secret in the admin retires the pending one, so software never gets a dead secret", async () => {
    const req = await node.request("POST", "/obx/v1/access-requests", {
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ retailer: { name: "Web Form Shop" }, contact: { name: "Wim", email: "wim@webform.example" }, access: ["api"] }),
    });
    const ap = await admin.req("POST", `/admin/api/access-requests/${req.json.id}/approve`, { json: {} });
    const rotated = await admin.req("POST", `/admin/api/api-clients/${ap.json.api_client.id}/rotate`);
    expect(rotated.status).toBe(200);
    const status = (await node.api(req.json.request_token, "GET", `/obx/v1/access-requests/${req.json.id}`)).json;
    expect(status.credentials.client_secret).toBeNull();
    expect(status.credentials.claimed).toBe(true);
    const tok = await node.accessToken(rotated.json.client.client_id, rotated.json.client_secret);
    expect((await node.api(tok, "GET", "/obx/v1/grant")).json.retailer.name).toBe("Web Form Shop");
  });
});

describe("exports, usage, rate limits (P-EXP-1, P-USE-1, P-RATE-1, P-ERR-1)", () => {
  test("export of brand kestrel with web renditions: manifest and zip parts agree", async () => {
    const r = await node.api(at, "POST", "/obx/v1/exports", { json: { filter: { brand_ids: [brandIds["kestrel"]] }, renditions: ["web"] } });
    expect(r.status).toBe(202);
    await node.drain();
    const e = (await node.api(at, "GET", `/obx/v1/exports/${r.json.id}`)).json;
    expect(e.status).toBe("succeeded");
    const man = await node.request("GET", new URL(e.manifest_url).pathname + new URL(e.manifest_url).search);
    const lines = man.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].type).toBe("header");
    const types = lines.map((l) => l.type);
    expect(types.indexOf("file")).toBeGreaterThan(types.lastIndexOf("asset"));
    expect(lines.filter((l) => l.type === "brand").every((l) => l.data.id === brandIds["kestrel"])).toBe(true);
    const part = e.parts[0];
    const zip = await node.request("GET", new URL(part.url).pathname + new URL(part.url).search);
    expect(await sha256Hex(zip.bytes)).toBe(part.sha256);
    const entries = await readZipDirectory(bytesReader(zip.bytes), zip.bytes.length);
    const files = lines.filter((l) => l.type === "file");
    expect(files.length).toBe(lines[0].counts.files);
    expect(entries.map((x) => x.name).sort()).toEqual(files.map((f) => f.path).sort());
    for (const f of files.slice(0, 5)) {
      const ent = entries.find((x) => x.name === f.path)!;
      expect(await sha256Hex(await readZipEntry(bytesReader(zip.bytes), ent, 1e9))).toBe(f.sha256);
    }
    const cont = await node.api(at, "GET", `/obx/v1/changes?cursor=${encodeURIComponent(lines[0].changes_cursor)}`);
    expect(cont.status).toBe(200);
    expect(cont.json.phase).toBe("live");
  });

  test("usage events are accepted and show up in the brand's statistics", async () => {
    const id = await assetId("KO-1001_NVY_1");
    const r = await node.api(at, "POST", "/obx/v1/usage", { json: { events: [{ asset_id: id, event: "published", channel: "webshop", at: "2026-09-28T10:00:00Z" }, { asset_id: "ast_unknown", event: "synced", at: "2026-09-28T10:00:00Z" }] } });
    expect(r.status).toBe(202);
    expect(r.json.accepted).toBe(1);
    await node.drain();
    const s = await admin.req("GET", "/admin/api/stats?days=365");
    expect(s.json.totals.usage_events).toBeGreaterThanOrEqual(1);
    const bad = await node.api(at, "POST", "/obx/v1/usage", { json: { events: [{ asset_id: id, event: "stolen", at: "x" }] } });
    expect(bad.status).toBe(422);
    expect(bad.json.errors.length).toBeGreaterThan(0);
  });

  test("rate limit headers, and 429 with Retry-After under a low limit", async () => {
    const r = await node.api(at, "GET", "/obx/v1/grant");
    expect(r.headers.get("ratelimit-limit")).toBe("600");
    expect(Number(r.headers.get("ratelimit-remaining"))).toBeGreaterThan(0);
    const low = new TestNode({ OBX_RATE_LIMIT_API: "2" });
    const a2 = await low.setup();
    const c2 = await low.retailerClient(a2);
    const t2 = await low.accessToken(c2.clientId, c2.secret);
    await low.api(t2, "GET", "/obx/v1/grant");
    await low.api(t2, "GET", "/obx/v1/grant");
    const limited = await low.api(t2, "GET", "/obx/v1/grant");
    expect(limited.status).toBe(429);
    expect(limited.json.obx_error).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
