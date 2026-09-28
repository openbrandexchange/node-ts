import { describe, expect, test } from "bun:test";
import { TestNode, importKestrel, addRenditions, fixtureText, kestrelImages, fixtureBytes } from "./helpers";
import { webhookSignature, hmacHex } from "../src/lib/crypto";
import { zipBytes } from "../src/lib/zip";
import { crc32 } from "../src/lib/crypto";

describe("API keys and automatic-upload tokens (A-KEY-1)", () => {
  test("secret shown once, rotate invalidates the old one, revoke works", async () => {
    const node = new TestNode();
    const admin = await node.setup();
    const c = await node.retailerClient(admin);
    const list = await admin.req("GET", "/admin/api/api-clients");
    expect(JSON.stringify(list.json)).not.toContain(c.secret);
    const old = await node.accessToken(c.clientId, c.secret);
    const rot = await admin.req("POST", `/admin/api/api-clients/${c.clientRow.id}/rotate`);
    expect(rot.json.client_secret).not.toBe(c.secret);
    expect((await node.api(old, "GET", "/obx/v1/grant")).json.obx_error).toBe("invalid_token");
    const bad = await node.request("POST", "/obx/v1/oauth/token", { headers: { authorization: `Basic ${btoa(`${c.clientId}:${c.secret}`)}`, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
    expect(bad.json.error).toBe("invalid_client");
    const fresh = await node.accessToken(c.clientId, rot.json.client_secret);
    expect((await node.api(fresh, "GET", "/obx/v1/grant")).status).toBe(200);

    const t = await admin.req("POST", "/admin/api/ingest-tokens", { json: { name: "PIM nightly", scopes: ["ingest:read", "ingest:write"] } });
    expect(t.json.secret).toMatch(/^obxi_/);
    expect(t.json.token.prefix).toBe(t.json.secret.slice(0, 12));
    expect((await node.api(t.json.secret, "GET", "/obx/v1/ingest")).json.renditions.server_generated).toBe(false);
    const del = await node.api(t.json.secret, "DELETE", "/obx/v1/ingest/brands/kestrel");
    expect(del.json.obx_error).toBe("insufficient_scope");
    const r2 = await admin.req("POST", `/admin/api/ingest-tokens/${t.json.token.id}/rotate`);
    expect((await node.api(t.json.secret, "GET", "/obx/v1/ingest")).json.obx_error).toBe("invalid_token");
    await admin.req("DELETE", `/admin/api/ingest-tokens/${t.json.token.id}`);
    expect((await node.api(r2.json.secret, "GET", "/obx/v1/ingest")).json.obx_error).toBe("access_revoked");
  });

  test("a brand-restricted token cannot write another brand (I-AUTH-1)", async () => {
    const node = new TestNode();
    const admin = await node.setup();
    const all = await node.ingestToken(admin);
    await node.api(all, "PUT", "/obx/v1/ingest/brands/other", { json: { name: "Other" } });
    const only = await node.ingestToken(admin, ["ingest:read", "ingest:write"], ["kestrel"]);
    const ok = await node.api(only, "PUT", "/obx/v1/ingest/products/P-1", { json: { brand_external_id: "kestrel", style_number: "P-1", name: { en: "One" } } });
    expect(ok.status).toBe(201);
    const no = await node.api(only, "PUT", "/obx/v1/ingest/products/P-2", { json: { brand_external_id: "other", style_number: "P-2", name: { en: "Two" } } });
    expect(no.status).toBe(403);
    expect(no.json.obx_error).toBe("forbidden");
  });
});

describe("files and validation (I-FILE-1, I-FILE-2, I-VAL-1)", () => {
  test("blob dedupe, checksum mismatch, blob_missing, multipart resume", async () => {
    const node = new TestNode();
    const admin = await node.setup();
    const token = await node.ingestToken(admin);
    const img = fixtureBytes("kestrel/images/KO-1001_NVY_1_front.png");
    const { sha256Hex } = await import("../src/lib/crypto");
    const sha = await sha256Hex(img);
    expect((await node.api(token, "HEAD", `/obx/v1/ingest/blobs/${sha}`)).status).toBe(404);
    expect((await node.api(token, "PUT", `/obx/v1/ingest/blobs/${sha}`, { body: img, headers: { "content-type": "image/png" } })).status).toBe(201);
    expect((await node.api(token, "PUT", `/obx/v1/ingest/blobs/${sha}`, { body: img, headers: { "content-type": "image/png" } })).json.created).toBe(false);
    expect((await node.api(token, "HEAD", `/obx/v1/ingest/blobs/${sha}`)).status).toBe(200);
    const mismatch = await node.api(token, "PUT", `/obx/v1/ingest/blobs/${"a".repeat(64)}`, { body: img, headers: { "content-type": "image/png" } });
    expect(mismatch.json.obx_error).toBe("checksum_mismatch");
    await node.api(token, "PUT", "/obx/v1/ingest/products/KO-1", { json: { style_number: "KO-1", name: { en: "X" } } });
    const missing = await node.api(token, "PUT", "/obx/v1/ingest/assets/KO-1_A_1", { json: { product_external_id: "KO-1", color_code: "A", role: "packshot", position: 1, files: { original: { sha256: "b".repeat(64) } } } });
    expect(missing.status).toBe(422);
    expect(missing.json.obx_error).toBe("blob_missing");
    // 12 MiB file in 8 MiB parts: completing with a part missing is upload_incomplete, then resume.
    const big = new Uint8Array(12 * 1024 * 1024);
    big.set(img, 0);
    const bigSha = await sha256Hex(big);
    const up = await node.api(token, "POST", "/obx/v1/ingest/uploads", { json: { sha256: bigSha, bytes: big.length, content_type: "image/png" } });
    expect(up.status).toBe(201);
    expect(up.json.parts_total).toBe(2);
    await node.api(token, "PUT", `/obx/v1/ingest/uploads/${up.json.id}/parts/1`, { body: big.slice(0, up.json.part_bytes) });
    const early = await node.api(token, "POST", `/obx/v1/ingest/uploads/${up.json.id}/complete`);
    expect(early.json.obx_error).toBe("upload_incomplete");
    expect((await node.api(token, "GET", `/obx/v1/ingest/uploads/${up.json.id}`)).json.received_parts).toEqual([1]);
    await node.api(token, "PUT", `/obx/v1/ingest/uploads/${up.json.id}/parts/2`, { body: big.slice(up.json.part_bytes) });
    const done = await node.api(token, "POST", `/obx/v1/ingest/uploads/${up.json.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.json.sha256).toBe(bigSha);
    expect(done.json.width).toBe(1200);
    expect((await node.api(token, "HEAD", `/obx/v1/ingest/blobs/${bigSha}`)).status).toBe(200);
  });

  test("invalid GTIN, duplicate GTIN, position conflict, unknown parent", async () => {
    const node = new TestNode();
    const admin = await node.setup();
    const token = await node.ingestToken(admin);
    await node.api(token, "PUT", "/obx/v1/ingest/products/P", { json: { style_number: "P", name: { en: "P" } } });
    expect((await node.api(token, "PUT", "/obx/v1/ingest/variants/v1", { json: { product_external_id: "P", gtin: "2000100101019", color: { code: "A" } } })).json.obx_error).toBe("invalid_gtin");
    expect((await node.api(token, "PUT", "/obx/v1/ingest/variants/v1", { json: { product_external_id: "P", gtin: "2000100101018", color: { code: "A" } } })).status).toBe(201);
    const dup = await node.api(token, "PUT", "/obx/v1/ingest/variants/v2", { json: { product_external_id: "P", gtin: "02000100101018", color: { code: "A" } } });
    expect(dup.status).toBe(409);
    expect(dup.json.obx_error).toBe("gtin_conflict");
    expect((await node.api(token, "PUT", "/obx/v1/ingest/assets/a1", { json: { product_external_id: "P", color_code: "A", role: "packshot", position: 1 } })).status).toBe(201);
    const pos = await node.api(token, "PUT", "/obx/v1/ingest/assets/a2", { json: { product_external_id: "P", color_code: "A", role: "packshot", position: 1 } });
    expect(pos.json.obx_error).toBe("position_conflict");
    expect((await node.api(token, "PUT", "/obx/v1/ingest/assets/a2", { json: { product_external_id: "P", color_code: "A", role: "packshot", position: 2 } })).status).toBe(201);
    const order = await node.api(token, "PUT", "/obx/v1/ingest/products/P/asset-order", { json: { color_code: "A", asset_external_ids: ["a2", "a1"] } });
    expect(order.json.map((r: any) => r.result)).toEqual(["updated", "updated"]);
    expect((await node.api(token, "GET", "/obx/v1/ingest/assets/a1")).json.data.position).toBe(2);
    // IngestRecord.data has defaults applied (effective rights, provenance);
    // missing_files is present for assets only.
    const a1 = (await node.api(token, "GET", "/obx/v1/ingest/assets/a1")).json;
    expect(a1.data.rights).toMatchObject({ license: "retailer-use", channels: ["webshop", "marketplace", "social"], expires_at: null });
    expect(a1.data.provenance).toMatchObject({ ai_generated: false, source: "photo", c2pa: "none" });
    expect(a1.missing_files).toEqual(["original", "web", "square", "thumb"]);
    expect("missing_files" in (await node.api(token, "GET", "/obx/v1/ingest/products/P")).json).toBe(false);
    // Writing back what GET returned (defaults spelled out) changes nothing.
    expect((await node.api(token, "PUT", "/obx/v1/ingest/assets/a1", { json: a1.data })).json.result).toBe("unchanged");
    const parent = await node.api(token, "PUT", "/obx/v1/ingest/variants/v3", { json: { product_external_id: "NOPE", color: { code: "A" } } });
    expect(parent.json.obx_error).toBe("unknown_parent");
    const ifm = await node.api(token, "PUT", "/obx/v1/ingest/products/P", { json: { style_number: "P", name: { en: "Q" } }, headers: { "if-match": '"stale"' } });
    expect(ifm.status).toBe(412);
  });
});

describe("admin catalog = ingest semantics (A-CAT-1)", () => {
  test("admin writes give the same results and change entries", async () => {
    const node = new TestNode();
    const admin = await node.setup();
    const cl = await node.retailerClient(admin);
    const at = await node.accessToken(cl.clientId, cl.secret);
    const f0 = await node.feed(at);
    const put = await admin.req("PUT", "/admin/api/catalog/products/KO-9", { json: { style_number: "KO-9", name: { en: "Nine" } } });
    expect(put.status).toBe(201);
    expect(put.json.result).toBe("created");
    expect((await admin.req("PUT", "/admin/api/catalog/products/KO-9", { json: { style_number: "KO-9", name: { en: "Nine" } } })).json.result).toBe("unchanged");
    const f1 = await node.feed(at, f0.cursor);
    expect(f1.entries.map((e) => `${e.type}:${e.op}:${e.external_id}`)).toEqual(["product:upsert:KO-9"]);
    const list = await admin.req("GET", "/admin/api/catalog/products?q=nine");
    expect(list.json.total).toBe(1);
    const detail = await admin.req("GET", "/admin/api/catalog/products/KO-9");
    expect(detail.json.record.data.style_number).toBe("KO-9");
    await admin.req("PATCH", "/admin/api/catalog/products/KO-9", { json: { status: "unpublished" }, headers: { "content-type": "application/merge-patch+json" } });
    expect((await node.feed(at, f1.cursor)).entries.map((e) => `${e.type}:${e.op}`)).toEqual(["product:delete"]);
  });
});

describe("settings effects", () => {
  test("changing default rights writes asset upserts; toggling originals writes grant entries", async () => {
    const node = new TestNode();
    const admin = await node.setup();
    const token = await node.ingestToken(admin);
    await importKestrel(node, token);
    await addRenditions(node, token);
    const cl = await node.retailerClient(admin);
    const at = await node.accessToken(cl.clientId, cl.secret);
    const f0 = await node.feed(at);
    const s = await admin.req("PATCH", "/admin/api/settings", { json: { defaults: { rights: { channels: ["webshop", "marketplace", "social", "print"] } } }, headers: { "content-type": "application/merge-patch+json" } });
    expect(s.status).toBe(200);
    expect(s.json.defaults.rights.channels).toContain("print");
    await node.drain();
    const f1 = await node.feed(at, f0.cursor);
    expect(f1.entries.length).toBe(27);
    expect(f1.entries.every((e) => e.type === "asset" && e.op === "upsert" && e.data.rights.channels.includes("print"))).toBe(true);
    await admin.req("PATCH", "/admin/api/settings", { json: { portal: { allow_original_download: false } } });
    const f2 = await node.feed(at, f1.cursor);
    expect(f2.entries.map((e) => `${e.type}:${e.resync}`)).toEqual(["grant:true"]);
    expect(f2.entries[0].data.original_allowed).toBe(false);
  });

  test("last admin cannot be blocked; users can be invited and blocked", async () => {
    const node = new TestNode();
    const admin = await node.setup();
    const me = (await admin.req("GET", "/admin/api/session")).json.user;
    expect((await admin.req("PATCH", `/admin/api/users/${me.id}`, { json: { status: "blocked" } })).status).toBe(409);
    const inv = await admin.req("POST", "/admin/api/users/invites", { json: { email: "second@kestrel.example", role: "admin" } });
    expect(inv.json.email_sent).toBe(true);
    expect((await admin.req("POST", "/admin/api/users/invites", { json: { email: "second@kestrel.example", role: "admin" } })).status).toBe(409);
    const re = await admin.req("POST", `/admin/api/users/${inv.json.user.id}/resend-invite`);
    expect(re.json.invite_url).not.toBe(inv.json.invite_url);
    const oldTok = inv.json.invite_url.split("/invite/")[1];
    expect((await admin.req("GET", `/admin/api/invites/${oldTok}`)).json.obx_error).toBe("invite_invalid");
  });

  test("forgot password never reveals accounts; reset works once", async () => {
    const node = new TestNode();
    await node.setup();
    const b = await node.browser();
    expect((await b.req("POST", "/admin/api/password/forgot", { json: { email: "nobody@x.example" } })).status).toBe(202);
    expect((await b.req("POST", "/admin/api/password/forgot", { json: { email: "admin@kestrel.example" } })).status).toBe(202);
    await node.drain();
    const mail = node.mails.find((m) => m.to === "admin@kestrel.example")!;
    const tok = mail.text.match(/reset-password\/([A-Za-z0-9_-]+)/)![1];
    const r = await b.req("POST", "/admin/api/password/reset", { json: { token: tok, password: "brand new secret phrase" } });
    expect(r.status).toBe(200);
    expect((await b.req("POST", "/admin/api/password/reset", { json: { token: tok, password: "brand new secret phrase" } })).json.obx_error).toBe("invite_invalid");
  });
});

describe("e-mail links never follow a forged Host header", () => {
  test("password reset link uses the address the node was set up at", async () => {
    const node = new TestNode();
    await node.setup();
    const b = await node.browser();
    // Without OBX_PUBLIC_URL an attacker could otherwise send the victim a
    // reset link pointing at their own host (password reset poisoning).
    const r = await b.req("POST", "http://evil.example/admin/api/password/forgot", { json: { email: "admin@kestrel.example" } });
    expect(r.status).toBe(202);
    await node.drain();
    const mail = node.mails.find((m) => m.to === "admin@kestrel.example")!;
    expect(mail.text).not.toContain("evil.example");
    expect(mail.text).toContain("http://localhost/reset-password/");
  });
});

describe("webhooks (P-HOOK-1) and brand webhooks", () => {
  test("signature test vector", async () => {
    const v = JSON.parse(fixtureText("examples/webhook-signature-vector.json"));
    expect(await webhookSignature(v.secret, v.timestamp, v.raw_body)).toBe(v.header);
  });

  test("webhook.test arrives with a valid signature; private and http targets rejected without the dev switch", async () => {
    const got: { headers: Headers; body: string }[] = [];
    const server = Bun.serve({ port: 0, fetch: async (req) => (got.push({ headers: req.headers, body: await req.text() }), new Response("ok")) });
    try {
      const node = new TestNode();
      const admin = await node.setup();
      const cl = await node.retailerClient(admin);
      const at = await node.accessToken(cl.clientId, cl.secret);
      const sub = await node.api(at, "POST", "/obx/v1/webhooks", { json: { url: `http://127.0.0.1:${server.port}/hook`, events: ["changes.available"] } });
      expect(sub.status).toBe(201);
      expect(sub.json.secret).toMatch(/^whsec_/);
      const t = await node.api(at, "POST", `/obx/v1/webhooks/${sub.json.id}/test`);
      expect(t.json).toEqual({ delivered: true, status: 200 });
      const h = got[0].headers;
      const ts = h.get("obx-webhook-timestamp")!;
      expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(300);
      expect(h.get("obx-webhook-signature")).toBe(`v1=${await hmacHex(sub.json.secret, `${ts}.${got[0].body}`)}`);
      expect(JSON.parse(got[0].body).type).toBe("webhook.test");
      expect((await node.api(at, "GET", "/obx/v1/webhooks")).json.items[0].secret).toBeNull();

      // brand webhook: import_run.completed
      const hook = await admin.req("POST", "/admin/api/webhooks", { json: { url: `http://127.0.0.1:${server.port}/brand`, events: ["import_run.completed"] } });
      expect(hook.status).toBe(201);
      const token = await node.ingestToken(admin);
      await importKestrel(node, token);
      await node.drain();
      expect(got.some((g) => JSON.parse(g.body).type === "import_run.completed")).toBe(true);
      // changes.available wake-up after writes
      await node.worker.tick(10_000);
      await node.drain();
      expect(got.some((g) => JSON.parse(g.body).type === "changes.available")).toBe(true);
      const deliveries = await admin.req("GET", `/admin/api/webhooks/${hook.json.id}/deliveries`);
      expect(deliveries.json.items[0].success).toBe(true);

      const strict = new TestNode({ OBX_ALLOW_PRIVATE_URLS: "false" });
      const a2 = await strict.setup();
      const c2 = await strict.retailerClient(a2);
      const t2 = await strict.accessToken(c2.clientId, c2.secret);
      expect((await strict.api(t2, "POST", "/obx/v1/webhooks", { json: { url: "http://example.com/hook", events: ["changes.available"] } })).json.obx_error).toBe("unsafe_url");
      expect((await strict.api(t2, "POST", "/obx/v1/webhooks", { json: { url: "https://127.0.0.1/hook", events: ["changes.available"] } })).json.obx_error).toBe("unsafe_url");
      expect((await strict.api(t2, "POST", "/obx/v1/webhooks", { json: { url: "https://169.254.169.254/latest", events: ["changes.available"] } })).json.obx_error).toBe("unsafe_url");
      // A-SRC-1: import source to a private address is refused; credentials are never returned
      const src = await a2.req("POST", "/admin/api/import-sources", { json: { name: "Local", kind: "https_url", schedule: { frequency: "daily" }, config: { url: "https://127.0.0.1/export.csv" } } });
      expect(src.status).toBe(422);
      expect(src.json.obx_error).toBe("unsafe_url");
    } finally {
      server.stop(true);
    }
  });
});

describe("scheduled pull import (https URL)", () => {
  test("imports a package from a URL, skips unchanged files, credentials stay write-only", async () => {
    const zip = await zipBytes(
      [
        { name: "products.csv", data: new TextEncoder().encode(fixtureText("kestrel/products.csv")) },
        { name: "assets.csv", data: new TextEncoder().encode(fixtureText("kestrel/assets.csv")) },
        ...kestrelImages().map((i) => ({ name: `images/${i.name}`, data: i.bytes })),
      ],
      crc32,
    );
    let auth = "";
    const server = Bun.serve({ port: 0, fetch: (req) => ((auth = req.headers.get("authorization") ?? ""), new Response(zip as BodyInit, { headers: { "content-type": "application/zip" } })) });
    try {
      const node = new TestNode();
      const admin = await node.setup();
      const src = await admin.req("POST", "/admin/api/import-sources", {
        json: {
          name: "Nightly PIM export",
          kind: "https_url",
          schedule: { frequency: "daily", time: "02:30", timezone: "Europe/Amsterdam" },
          mode: "upsert",
          config: { url: `http://127.0.0.1:${server.port}/kestrel.zip` },
          credentials: { headers: { Authorization: "Bearer pim-secret" } },
        },
      });
      expect(src.status).toBe(201);
      expect(src.json.credentials_set.headers).toEqual(["Authorization"]);
      expect(JSON.stringify(src.json)).not.toContain("pim-secret");
      expect(src.json.next_run_at).toBeTruthy();
      const test1 = await admin.req("POST", `/admin/api/import-sources/${src.json.id}/test`);
      expect(test1.json.ok).toBe(true);
      const run = await admin.req("POST", `/admin/api/import-sources/${src.json.id}/run`, { json: {} });
      expect(run.status).toBe(202);
      await node.drain();
      expect(auth).toBe("Bearer pim-secret");
      const r = await admin.req("GET", `/admin/api/imports/${run.json.id}`);
      expect(r.json.status).toBe("succeeded");
      expect(r.json.trigger).toBe("manual_run");
      expect(r.json.counts.created).toBe(2 + 8 + 40 + 27 - 1);
      const run2 = await admin.req("POST", `/admin/api/import-sources/${src.json.id}/run`, { json: {} });
      await node.drain();
      const r2 = await admin.req("GET", `/admin/api/imports/${run2.json.id}`);
      expect(r2.json.status).toBe("succeeded");
      expect(r2.json.counts.unchanged + r2.json.counts.created + r2.json.counts.updated).toBe(0);
      const s = await admin.req("GET", `/admin/api/import-sources/${src.json.id}`);
      expect(s.json.last_run.id).toBe(run2.json.id);
    } finally {
      server.stop(true);
    }
  });
});

describe("sign-in throttling", () => {
  test("successful sign-ins are not limited; ten failures lock the account and the address for a while", async () => {
    const node = new TestNode();
    await node.setup();
    const login = async (password: string) => (await node.browser()).req("POST", "/admin/api/session/login", { json: { email: "admin@kestrel.example", password } });
    for (let i = 0; i < 12; i++) expect((await login("correct horse battery staple")).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await login("wrong password " + i)).status).toBe(401);
    const locked = await login("correct horse battery staple");
    expect(locked.status).toBe(429);
    expect(locked.json.obx_error).toBe("rate_limited");
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    node.clock.offset = 16 * 60_000;
    expect((await login("correct horse battery staple")).status).toBe(200);
  });
});
