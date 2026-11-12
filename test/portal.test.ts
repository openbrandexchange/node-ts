import { describe, expect, test, beforeAll } from "bun:test";
import { TestNode, importKestrel, addRenditions, type Browser } from "./helpers";
import { readZipDirectory, readZipEntry } from "../src/lib/zip";
import { bytesReader } from "../src/lib/multipart";
import { parseCsv } from "../src/lib/csv";

let node: TestNode;
let admin: Browser;
let token: string;
let retailer: Browser;
let restricted: Browser;
let brandIds: Record<string, string>;

async function inviteAndAccept(email: string, retailerId: string): Promise<Browser> {
  const inv = await admin.req("POST", "/admin/api/users/invites", { json: { email, name: "Rita Retail", role: "retailer", retailer_id: retailerId, language: "nl" } });
  expect(inv.status).toBe(201);
  const tokenPart = inv.json.invite_url.split("/invite/")[1];
  const b = await node.browser();
  const look = await b.req("GET", `/admin/api/invites/${tokenPart}`);
  expect(look.json.role).toBe("retailer");
  const acc = await b.req("POST", `/admin/api/invites/${tokenPart}/accept`, { json: { password: "a very good password" } });
  expect(acc.status).toBe(200);
  expect(acc.json.retailer.id).toBe(retailerId);
  expect((await b.req("POST", `/admin/api/invites/${tokenPart}/accept`, { json: { password: "a very good password" } })).json.obx_error).toBe("invite_invalid");
  return b;
}

beforeAll(async () => {
  node = new TestNode();
  admin = await node.setup();
  token = await node.ingestToken(admin);
  await importKestrel(node, token);
  await addRenditions(node, token);
  brandIds = Object.fromEntries((await node.platform.db.all<{ id: string; external_id: string }>("SELECT id, external_id FROM brands")).map((b) => [b.external_id, b.id]));
  const r1 = await admin.req("POST", "/admin/api/retailers", { json: { name: "Fictional Fashion" } });
  retailer = await inviteAndAccept("rita@fictional.example", r1.json.id);
  const r2 = await admin.req("POST", "/admin/api/retailers", { json: { name: "Kestrel Only Shop", brand_ids: [brandIds["kestrel"]], allow_original: false } });
  restricted = await inviteAndAccept("kim@kestrelonly.example", r2.json.id);
}, 120_000);

describe("retailer portal (A-INV-1, A-PORT-1, A-PORT-2)", () => {
  test("viewer, product list with filters and facets, detail", async () => {
    const v = await retailer.req("GET", "/admin/api/portal/viewer");
    expect(v.json.preview).toBe(false);
    expect(v.json.permissions.original_download).toBe(true);
    const list = await retailer.req("GET", "/admin/api/portal/products?limit=5");
    expect(list.json.total).toBe(11);
    expect(list.json.items.length).toBe(5);
    expect(list.json.next_cursor).toBeTruthy();
    expect(list.json.items[0].thumb_url).toContain("/renditions/thumb?");
    const more = await retailer.req("GET", `/admin/api/portal/products?limit=5&cursor=${encodeURIComponent(list.json.next_cursor)}`);
    expect(more.json.items.length).toBe(5);
    const last = await retailer.req("GET", `/admin/api/portal/products?limit=5&cursor=${encodeURIComponent(more.json.next_cursor)}`);
    expect(last.json.items.length).toBe(1);
    const q = await retailer.req("GET", "/admin/api/portal/products?q=merino");
    expect(q.json.items.map((p: any) => p.style_number)).toContain("KO-1001");
    const byGtin = await retailer.req("GET", "/admin/api/portal/products?q=2000100101025");
    expect(byGtin.json.items.map((p: any) => p.style_number)).toEqual(["KO-1001"]);
    const facets = await retailer.req("GET", `/admin/api/portal/facets?brand_id=${brandIds["kestrel"]}`);
    expect(facets.json.brands.length).toBe(2);
    expect(facets.json.item_types.length).toBeGreaterThan(0);
    const filtered = await retailer.req("GET", `/admin/api/portal/products?brand_id=${brandIds["kestrel"]}`);
    expect(filtered.json.total).toBe(9);
    const detail = await retailer.req("GET", `/admin/api/portal/products/${list.json.items[0].id}`);
    expect(detail.json.variants.length).toBeGreaterThan(0);
    const img = new URL(detail.json.assets[0].renditions.thumb.url);
    expect((await node.request("GET", img.pathname + img.search)).status).toBe(200);
  });

  test("restricted retailer never sees the other brand; originals hidden", async () => {
    const list = await restricted.req("GET", "/admin/api/portal/products?limit=50");
    expect(list.json.total).toBe(9);
    expect(list.json.items.every((p: any) => p.brand.id === brandIds["kestrel"])).toBe(true);
    const trail = await node.platform.db.first<{ id: string }>("SELECT id FROM products WHERE brand_id = ?", [brandIds["kestrel-trail"]]);
    expect((await restricted.req("GET", `/admin/api/portal/products/${trail!.id}`)).status).toBe(404);
    const facets = await restricted.req("GET", "/admin/api/portal/facets");
    expect(facets.json.brands.map((b: any) => b.value)).toEqual([brandIds["kestrel"]]);
    const v = await restricted.req("GET", "/admin/api/portal/viewer");
    expect(v.json.permissions.original_download).toBe(false);
    const detail = await restricted.req("GET", `/admin/api/portal/products/${list.json.items[0].id}`);
    expect(detail.json.assets.every((a: any) => !a.renditions.original)).toBe(true);
    const asset = detail.json.assets[0];
    expect((await restricted.req("GET", `/admin/api/portal/assets/${asset.id}/download?variant=original`)).json.obx_error).toBe("original_not_allowed");
    const csv = await restricted.req("GET", "/admin/api/portal/products/data.csv");
    expect(csv.text).not.toContain("KT-2001");
  });

  test("EAN paste, selection, product zip, selection zip and CSV", async () => {
    const paste = await retailer.req("POST", "/admin/api/portal/gtin-lookup", { json: { text: "2000100101025\n2000200101031; 2000999901010,12345" } });
    expect(paste.json.results.map((r: any) => r.status)).toEqual(["matched", "matched", "unmatched", "invalid"]);
    const ids = paste.json.products.map((p: any) => p.id);
    const sel = await retailer.req("PUT", "/admin/api/portal/selection", { json: { product_ids: [...ids, "prd_unknown"] } });
    expect(sel.json.product_ids).toEqual(ids);
    expect(sel.json.image_count).toBeGreaterThan(0);
    const zip = await retailer.req("GET", "/admin/api/portal/selection/download.zip?variant=web");
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(Number(zip.headers.get("content-length"))).toBe(zip.bytes.length);
    const all = await readZipDirectory(bytesReader(zip.bytes), zip.bytes.length);
    // The rights, embargo and AI provenance travel with the files: one assets.csv row per image.
    const assetsCsv = all.find((e) => e.name === "assets.csv");
    expect(assetsCsv).toBeTruthy();
    const csvText = new TextDecoder().decode(await readZipEntry(bytesReader(zip.bytes), assetsCsv!, 1_000_000));
    const entries = all.filter((e) => e.name !== "assets.csv");
    expect(entries.length).toBe(sel.json.image_count);
    expect(entries.every((e) => /^[A-Z]{2}-\d{4}\/.+_web\.jpg$/.test(e.name))).toBe(true);
    const lines = csvText.trim().split("\r\n");
    expect(lines[0].startsWith("file,style_number,color_code,position,role,view")).toBe(true);
    expect(lines.length).toBe(1 + entries.length);
    for (const e of entries) expect(lines.some((l) => l.startsWith(e.name.split("/").pop()! + ","))).toBe(true);
    const pz = await retailer.req("GET", `/admin/api/portal/products/${ids[0]}/download.zip`);
    const pe = await readZipDirectory(bytesReader(pz.bytes), pz.bytes.length);
    expect(pe.every((e) => !e.name.includes("/"))).toBe(true);
    expect(pe.some((e) => e.name.endsWith(".png"))).toBe(true);
    const csv = await retailer.req("GET", "/admin/api/portal/selection/data.csv?delimiter=semicolon");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect([...csv.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const parsed = parseCsv(csv.text);
    expect(parsed.delimiter).toBe(";");
    expect(parsed.header).toContain("name:nl");
    expect(parsed.header.at(-1)).toBe("image_files");
    expect(parsed.rows.some((r) => r.cells.includes("2000100101025"))).toBe(true);
    // stats: retailer downloads are logged, admin preview downloads are not (A-STAT-1)
    await node.drain();
    const before = (await admin.req("GET", "/admin/api/stats/events?limit=200")).json.items.length;
    await admin.req("GET", `/admin/api/portal/products/${ids[0]}/download.zip?variant=web`);
    await node.drain();
    const after = (await admin.req("GET", "/admin/api/stats/events?limit=200")).json.items;
    expect(after.length).toBe(before);
    expect(after.some((e: any) => e.kind === "selection_zip" && e.retailer_name === "Fictional Fashion")).toBe(true);
  });

  test("formula injection is escaped in CSV exports", async () => {
    await node.api(token, "PUT", "/obx/v1/ingest/products/KO-1001", {
      json: { brand_external_id: "kestrel", style_number: "KO-1001", name: { en: "=HYPERLINK(\"http://evil\")", nl: "Merino trui met ronde hals" } },
    });
    const csv = await retailer.req("GET", "/admin/api/portal/products/data.csv?q=KO-1001");
    expect(csv.text).toContain("'=HYPERLINK");
    expect(csv.text).toContain("2000100101025");
  });

  test("background download job with file and e-mail", async () => {
    const job = await retailer.req("POST", "/admin/api/portal/download-jobs", { json: { source: "filter", filter: { brand_id: [brandIds["kestrel"]] }, variant: "square" } });
    expect(job.status).toBe(202);
    await node.drain();
    const done = await retailer.req("GET", `/admin/api/portal/download-jobs/${job.json.id}`);
    expect(done.json.status).toBe("succeeded");
    expect(done.json.files).toBeGreaterThan(10);
    const file = await retailer.req("GET", done.json.file_url);
    expect(file.status).toBe(200);
    const entries = await readZipDirectory(bytesReader(file.bytes), file.bytes.length);
    expect(entries.some((e) => e.name === "data.csv")).toBe(true);
    expect(entries.some((e) => e.name === "assets.csv")).toBe(true);
    expect(entries.filter((e) => e.name.endsWith("_square.jpg")).length).toBe(done.json.files);
    expect((await restricted.req("GET", `/admin/api/portal/download-jobs/${job.json.id}`)).status).toBe(404);
    expect(node.mails.some((m) => m.to === "rita@fictional.example" && m.text.includes(String(done.json.files)))).toBe(true);
  });

  test("blocking a retailer ends its sessions (A-RET-2)", async () => {
    const r = await admin.req("POST", "/admin/api/retailers", { json: { name: "Soon Blocked" } });
    const b = await inviteAndAccept("blocked@shop.example", r.json.id);
    expect((await b.req("GET", "/admin/api/portal/viewer")).status).toBe(200);
    await admin.req("PATCH", `/admin/api/retailers/${r.json.id}`, { json: { status: "blocked" } });
    expect((await b.req("GET", "/admin/api/portal/viewer")).status).toBe(401);
    const login = await (await node.browser()).req("POST", "/admin/api/session/login", { json: { email: "blocked@shop.example", password: "a very good password" } });
    expect(login.json.obx_error).toBe("account_blocked");
  });

  test("retailers cannot use admin endpoints", async () => {
    expect((await retailer.req("GET", "/admin/api/settings")).json.obx_error).toBe("forbidden");
    expect((await retailer.req("GET", "/admin/api/retailers")).status).toBe(403);
  });
});
