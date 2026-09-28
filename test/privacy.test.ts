// Audit log, personal-data export and erasure, and retention of logs and statistics.
import { describe, expect, test } from "bun:test";
import { TestNode } from "./helpers";
import { Ctx } from "../src/core/ctx";
import { housekeeping } from "../src/core/cron";

async function withRetailerUser() {
  const node = new TestNode();
  const admin = await node.setup();
  const r = await admin.req("POST", "/admin/api/retailers", { json: { name: "Outdoor Shop Utrecht" } });
  const inv = await admin.req("POST", "/admin/api/users/invites", { json: { email: "sam@outdoorshop.example", name: "Sam Winkel", role: "retailer", retailer_id: r.json.id, language: "nl" } });
  expect(inv.status).toBe(201);
  const link = node.mails.at(-1)!.text.match(/\/invite\/([A-Za-z0-9_-]+)/)![1];
  const shop = await node.browser();
  const acc = await shop.req("POST", `/admin/api/invites/${link}/accept`, { json: { password: "a long retailer password", name: "Sam Winkel" } });
  expect(acc.status).toBe(200);
  return { node, admin, shop, retailerId: r.json.id as string, userId: acc.json.user.id as string };
}

describe("audit log of admin actions", () => {
  test("changes are recorded with actor, action, target and outcome; bodies and passwords never", async () => {
    const node = new TestNode();
    const admin = await node.setup();
    const r = await admin.req("POST", "/admin/api/retailers", { json: { name: "Audit Retailer" } });
    await admin.req("PATCH", `/admin/api/retailers/${r.json.id}`, { json: { status: "blocked" } });
    await admin.req("PATCH", "/admin/api/settings", { json: { portal: { allow_original_download: false } } });
    const bad = await admin.req("PATCH", "/admin/api/settings", { json: { branding: { accent_color: "red" } } });
    expect(bad.status).toBe(422);
    const other = await node.browser();
    await other.req("POST", "/admin/api/session/login", { json: { email: "admin@kestrel.example", password: "wrong password here" } });

    const log = await admin.req("GET", "/admin/api/audit-log?limit=50");
    expect(log.status).toBe(200);
    const items = log.json.items as any[];
    const actions = items.map((i) => `${i.action}:${i.status}`);
    expect(actions).toContain("setup.complete:201");
    expect(actions).toContain("retailers.create:201");
    expect(actions).toContain("retailers.update:200");
    expect(actions).toContain("settings.update:200");
    expect(actions).toContain("settings.update:422");
    expect(actions).toContain("session.login:401");
    const upd = items.find((i) => i.action === "retailers.update");
    expect(upd).toMatchObject({ actor: { type: "user", name: "Ada Admin", role: "admin" }, method: "PATCH", route: "/admin/api/retailers/:id", target: { type: "retailer", id: r.json.id }, target_id: r.json.id, succeeded: true });
    expect(upd.request_id).toMatch(/^req_/);
    const failedLogin = items.find((i) => i.action === "session.login" && i.status === 401);
    expect(failedLogin.actor).toMatchObject({ type: "user", name: "Ada Admin" });
    expect(JSON.stringify(items)).not.toContain("wrong password here");
    expect(JSON.stringify(items)).not.toContain("correct horse battery staple");
    // Reads are not audited (except exports); filters work.
    expect(actions.some((a) => a.startsWith("settings.read"))).toBe(false);
    const failed = await admin.req("GET", "/admin/api/audit-log?outcome=failed");
    expect((failed.json.items as any[]).every((i) => i.status >= 400)).toBe(true);
    const onlyRetailer = await admin.req("GET", `/admin/api/audit-log?target_id=${r.json.id}`);
    expect((onlyRetailer.json.items as any[]).map((i) => i.action).sort()).toEqual(["retailers.update"]);
    const page = await admin.req("GET", "/admin/api/audit-log?limit=2");
    expect(page.json.items).toHaveLength(2);
    const next = await admin.req("GET", `/admin/api/audit-log?limit=2&cursor=${encodeURIComponent(page.json.next_cursor)}`);
    expect(next.json.items[0].id).not.toBe(page.json.items[0].id);
  });

  test("retailers cannot read the audit log; their browsing is not logged", async () => {
    const { shop, admin } = await withRetailerUser();
    expect((await shop.req("GET", "/admin/api/audit-log")).status).toBe(403);
    await shop.req("PUT", "/admin/api/portal/selection", { json: { product_ids: [] } });
    const items = (await admin.req("GET", "/admin/api/audit-log?limit=200")).json.items as any[];
    expect(items.some((i) => i.route.startsWith("/admin/api/portal/selection"))).toBe(false);
    expect(items.some((i) => i.action === "invites.accept" && i.actor.name === "Sam Winkel")).toBe(true);
  });
});

describe("personal data: export and erasure", () => {
  test("a retailer's export lists its people, keys, requests and downloads, without secrets", async () => {
    const { node, admin, retailerId } = await withRetailerUser();
    const key = await admin.req("POST", "/admin/api/api-clients", { json: { retailer_id: retailerId, name: "Shop sync" } });
    const secret = key.json.client_secret as string;
    const r = await admin.req("GET", `/admin/api/retailers/${retailerId}/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="personal-data-outdoor-shop-utrecht-\d{4}-\d{2}-\d{2}\.json"$/);
    const d = JSON.parse(r.text);
    expect(d.format).toBe("obx-personal-data-export/1");
    expect(d.controller.name).toBe("Kestrel Outfitters");
    expect(d.retailer.name).toBe("Outdoor Shop Utrecht");
    expect(d.users.map((u: any) => u.email)).toEqual(["sam@outdoorshop.example"]);
    expect(d.api_clients.map((k: any) => k.name)).toEqual(["Shop sync"]);
    expect(d.audit_log.some((e: any) => e.action === "invites.accept")).toBe(true);
    expect(d.retention).toEqual({ download_stats_days: 730, audit_log_days: 365, ip_days: 30, access_requests_days: 365 });
    expect(r.text).not.toContain(secret);
    expect(r.text).not.toContain("password_hash");
    expect(r.text).not.toContain("argon2");
    const log = (await admin.req("GET", "/admin/api/audit-log?action=retailers.export")).json.items;
    expect(log).toHaveLength(1);
    void node;
  });

  test("anyone signed in can download their own data", async () => {
    const { shop } = await withRetailerUser();
    const r = await shop.req("GET", "/admin/api/me/export");
    expect(r.status).toBe(200);
    const d = JSON.parse(r.text);
    expect(d.user).toMatchObject({ email: "sam@outdoorshop.example", name: "Sam Winkel", role: "retailer" });
    expect(d.retailer.name).toBe("Outdoor Shop Utrecht");
  });

  test("deleting a retailer erases its people from accounts, requests, statistics and the audit log", async () => {
    const { node, admin, shop, retailerId, userId } = await withRetailerUser();
    const pub = await node.request("POST", "/obx/v1/access-requests", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ retailer: { name: "Outdoor Shop Utrecht" }, contact: { name: "Sam Winkel", email: "sam@outdoorshop.example" }, access: ["portal"] }),
    });
    expect(pub.status).toBe(202);
    await node.platform.db.run("INSERT INTO download_events (id, at, kind, retailer_id, retailer_name, actor_type, actor_name, files) VALUES ('dle_1', ?, 'image', ?, 'Outdoor Shop Utrecht', 'user', 'Sam Winkel', 1)", [new Date().toISOString(), retailerId]);
    expect((await admin.req("DELETE", `/admin/api/retailers/${retailerId}`)).status).toBe(204);
    const db = node.platform.db;
    expect(await db.first("SELECT id FROM users WHERE id = ?", [userId])).toBeNull();
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM access_requests WHERE contact LIKE '%sam@outdoorshop.example%'"))!.n).toBe(0);
    expect(await db.first<Record<string, unknown>>("SELECT retailer_id, actor_name, retailer_name FROM download_events WHERE id = 'dle_1'")).toEqual({ retailer_id: null, actor_name: null, retailer_name: "Outdoor Shop Utrecht" });
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE actor_id = ? AND (actor_name IS NOT NULL OR ip IS NOT NULL)", [userId]))!.n).toBe(0);
    expect((await shop.req("GET", "/admin/api/session")).json.authenticated).toBe(false);
  });

  test("a retailer's person can delete their own account; an administrator cannot", async () => {
    const { node, admin, shop, userId } = await withRetailerUser();
    expect((await admin.req("DELETE", "/admin/api/me")).status).toBe(403);
    expect((await shop.req("DELETE", "/admin/api/me")).status).toBe(204);
    expect(await node.platform.db.first("SELECT id FROM users WHERE id = ?", [userId])).toBeNull();
    expect((await shop.req("GET", "/admin/api/session")).json.authenticated).toBe(false);
  });
});

describe("retention", () => {
  test("settings validate retention periods", async () => {
    const node = new TestNode();
    const admin = await node.setup();
    const bad = await admin.req("PATCH", "/admin/api/settings", { json: { retention: { audit_log_days: 5 } } });
    expect(bad.status).toBe(422);
    expect(bad.json.errors[0].pointer).toBe("/retention/audit_log_days");
    const ok = await admin.req("PATCH", "/admin/api/settings", { json: { retention: { download_stats_days: 90 } } });
    expect(ok.json.retention).toEqual({ download_stats_days: 90, audit_log_days: 365, ip_days: 30, access_requests_days: 365 });
    const unknown = await admin.req("PATCH", "/admin/api/settings", { json: { retention: { forever: 1 } } });
    expect(unknown.status).toBe(422);
    expect(unknown.json.errors[0].pointer).toBe("/retention/forever");
  });

  test("housekeeping deletes old statistics, old audit entries, decided requests and clears IPs after ip_days", async () => {
    const node = new TestNode();
    const admin = await node.setup();
    await admin.req("PATCH", "/admin/api/settings", { json: { retention: { download_stats_days: 60, audit_log_days: 90, ip_days: 7, access_requests_days: 30 } } });
    const db = node.platform.db;
    const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
    await db.run("INSERT INTO download_events (id, at, kind, retailer_id, retailer_name, actor_type, actor_name, files) VALUES ('old', ?, 'image', NULL, 'Shop', 'user', 'Old Name', 1), ('new', ?, 'image', NULL, 'Shop', 'user', 'New Name', 1)", [ago(61), ago(1)]);
    await db.run("INSERT INTO audit_log (id, at, actor_type, action, method, route, status, ip) VALUES ('a_old', ?, 'user', 'x.update', 'PATCH', '/x', 200, '198.51.100.1'), ('a_mid', ?, 'user', 'x.update', 'PATCH', '/x', 200, '198.51.100.2'), ('a_new', ?, 'user', 'x.update', 'PATCH', '/x', 200, '198.51.100.3'), ('a_week', ?, 'user', 'x.update', 'PATCH', '/x', 200, '198.51.100.4')", [ago(91), ago(31), ago(1), ago(8)]);
    await db.run("INSERT INTO access_requests (id, status, retailer, contact, access, request_token_hash, created_at, decided_at) VALUES ('ar_old', 'rejected', '{}', '{\"email\":\"a@b.example\"}', '[]', 'h1', ?, ?), ('ar_pending', 'pending', '{}', '{}', '[]', 'h2', ?, NULL)", [ago(40), ago(31), ago(40)]);
    await housekeeping(new Ctx(node.platform));
    expect((await db.all<{ id: string }>("SELECT id FROM download_events ORDER BY id")).map((r) => r.id)).toEqual(["new"]);
    expect(await db.all("SELECT id, ip FROM audit_log WHERE id IN ('a_old', 'a_mid', 'a_new', 'a_week') ORDER BY id")).toEqual([
      { id: "a_mid", ip: null },
      { id: "a_new", ip: "198.51.100.3" },
      { id: "a_week", ip: null },
    ]);
    expect((await db.all<{ id: string }>("SELECT id FROM access_requests ORDER BY id")).map((r) => r.id)).toEqual(["ar_pending"]);
  });
});
