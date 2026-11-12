// Article data (spec 0.2): protocol.md §5.9, import-format.md §1.6 and rules 9 and 10, ingest.md §3.4.
// The cases of fixtures/imports are the spec's own vectors (conformance I-IMP-7 and I-IMP-8).
import { describe, expect, test, beforeAll } from "bun:test";
import { TestNode, importKestrel, addRenditions, fixtureText, formData, match, type Browser } from "./helpers";
import { parseCsv } from "../src/lib/csv";
import { labelWarnings, parseFeatureCell, parseStrapCell, parseMeasurementCell, parseCertificationsCell, parseFootwearCell } from "../src/core/article";
import { parseBool, parseProductsCsv } from "../src/core/importformat";

let node: TestNode;
let admin: Browser;
let token: string;
let at: string;

async function importCsv(file: string, csv: string, options: Record<string, unknown> = {}) {
  const f = formData([
    { name: "csv", filename: "products.csv", type: "text/csv", data: csv },
    { name: "options", data: JSON.stringify({ mode: "upsert", ...options }) },
  ]);
  const r = await node.api(token, "POST", "/obx/v1/ingest/imports", { body: f.body, headers: { "content-type": f.contentType } });
  expect({ file, status: r.status }).toEqual({ file, status: 202 });
  await node.drain();
  const job = (await node.api(token, "GET", `/obx/v1/ingest/jobs/${r.json.id}`)).json;
  const items = (await node.api(token, "GET", `/obx/v1/ingest/jobs/${r.json.id}/results?limit=500`)).json.items;
  return { job, items };
}

async function productByExt(ext: string) {
  const id = (await node.platform.db.first<{ id: string }>("SELECT id FROM products WHERE external_id = ?", [ext]))!.id;
  return (await node.api(at, "GET", `/obx/v1/products/${id}`)).json;
}

beforeAll(async () => {
  node = new TestNode();
  admin = await node.setup();
  token = await node.ingestToken(admin);
  const cl = await node.retailerClient(admin);
  at = await node.accessToken(cl.clientId, cl.secret);
  const job = await importKestrel(node, token);
  expect(job.import_run.counts.errors).toBe(0);
  await addRenditions(node, token);
}, 120_000);

describe("article data in the protocol (P-CAT-5, P-CAT-6)", () => {
  test("KO-1008, KO-1009, KO-1010 and KT-2001 match expected/product-*.json", async () => {
    for (const style of ["KO-1001", "KO-1005", "KO-1008", "KO-1009", "KO-1010", "KT-2001"]) {
      const exp = JSON.parse(fixtureText(`expected/product-${style}.json`));
      expect({ style, problems: match(exp, await productByExt(style)) }).toEqual({ style, problems: [] });
    }
  });

  test("every product and variant carries the 0.2 properties; no 0.1 fibre keys, no empty objects", async () => {
    const { entries } = await node.feed(at);
    for (const e of entries) {
      if (e.type === "product") {
        for (const p of ["item_subtype", "contains_animal_origin", "footwear_materials", "certifications", "features"]) expect({ ext: e.external_id, p, has: p in e.data }).toEqual({ ext: e.external_id, p, has: true });
        for (const part of e.data.materials ?? [])
          for (const f of part.fibers) {
            expect(f.fiber).not.toMatch(/^(recycled|organic)_/);
            for (const flag of ["recycled", "organic"]) if (flag in f) expect(f[flag]).toBe(true);
          }
        if (e.data.features) expect(Object.keys(e.data.features).length).toBeGreaterThan(0);
        if (e.data.footwear_materials) expect(Object.keys(e.data.footwear_materials).sort()).toEqual(["lining_and_sock", "outer_sole", "upper"]);
      }
      if (e.type === "variant") {
        for (const p of ["size_length", "measurements"]) expect(p in e.data).toBe(true);
        expect("family" in e.data.color).toBe(true);
        if (e.data.measurements) expect(Object.keys(e.data.measurements).length).toBeGreaterThan(0);
      }
    }
    const ko1004 = entries.filter((e) => e.type === "variant" && e.data.sku?.startsWith("KO-1004"));
    expect(ko1004.map((e) => [e.data.size, e.data.size_length, e.data.measurements]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ["30", "32", { inseam_cm: 81 }],
      ["32", "32", { inseam_cm: 81 }],
      ["34", "32", { inseam_cm: 81 }],
    ]);
    const ko1003 = entries.find((e) => e.type === "product" && e.external_id === "KO-1003");
    expect(ko1003.data.materials).toEqual([{ part: "main", fibers: [{ fiber: "cotton", percentage: 100, organic: true }] }]);
    expect(ko1003.data.certifications).toEqual([
      { scheme: "gots", licence_number: "CU 200301", scope: "product" },
      { scheme: "oeko_tex_standard_100", licence_number: "26.KST.20003", scope: "product" },
    ]);
    const disc = await node.request("GET", "/.well-known/obx");
    expect(disc.json).toMatchObject({ obx_version: "0.2", spec_version: "0.2.0" });
  });
});

describe("imports of the 0.2 columns (I-IMP-7, I-IMP-8)", () => {
  test("fixtures/imports 1 to 6: counts, errors, change entries and fields of expected.json", async () => {
    const exp = JSON.parse(fixtureText("imports/expected.json"));
    for (const c of exp.cases) {
      const { cursor } = await node.feed(at);
      const { job, items } = await importCsv(c.file, fixtureText(`imports/${c.file}`));
      expect({ file: c.file, status: job.status }).toEqual({ file: c.file, status: "succeeded" });
      const k = job.import_run.counts;
      expect({ file: c.file, counts: { rows: k.rows, created: k.created, updated: k.updated, unchanged: k.unchanged, errors: k.errors } }).toEqual({ file: c.file, counts: c.counts });
      const errs = items.filter((i: any) => i.severity === "error").map((i: any) => ({ file: i.file, row: i.row, column: i.column, severity: i.severity, obx_error: i.obx_error, value: i.value }));
      expect({ file: c.file, errs }).toEqual({ file: c.file, errs: c.errors });
      const live = (await node.feed(at, cursor)).entries.map((e: any) => ({ type: e.type, op: e.op, external_id: e.external_id }));
      expect({ file: c.file, live }).toEqual({ file: c.file, live: c.changes });
      for (const [ext, fields] of Object.entries(c.products as Record<string, Record<string, unknown>>)) {
        const p = await productByExt(ext);
        for (const [f, v] of Object.entries(fields)) expect({ file: c.file, ext, f, v: p[f] }).toEqual({ file: c.file, ext, f, v });
      }
      for (const [ext, fields] of Object.entries(c.variants as Record<string, Record<string, unknown>>)) {
        const rec = (await node.api(token, "GET", `/obx/v1/ingest/variants/${ext}`)).json;
        const p = await productByExt(rec.data.product_external_id);
        const v = p.variants.find((x: any) => x.external_id === ext);
        for (const [f, val] of Object.entries(fields)) expect({ file: c.file, ext, f, v: v[f] }).toEqual({ file: c.file, ext, f, v: val });
      }
    }
  });

  test("label-warnings.csv as a dry run: exactly the expected codes, nothing written; the Kestrel import has none", async () => {
    const exp = JSON.parse(fixtureText("imports/label-warnings.expected.json"));
    const { cursor } = await node.feed(at);
    const { job, items } = await importCsv("label-warnings.csv", fixtureText("imports/label-warnings.csv"), { dry_run: true });
    expect(job.status).toBe("succeeded");
    expect(items.filter((i: any) => i.severity === "error")).toEqual([]);
    const coded = items.filter((i: any) => exp.warnings.some((w: any) => w.obx_error === i.obx_error) || /^(fibre|animal|footwear)_/.test(i.obx_error));
    expect(coded.map((i: any) => ({ file: i.file, row: i.row, column: i.column, severity: i.severity, obx_error: i.obx_error }))).toEqual(exp.warnings);
    expect(job.import_run.counts.warnings).toBeGreaterThanOrEqual(5);
    expect((await node.feed(at, cursor)).entries).toEqual([]);
    expect((await node.api(token, "GET", "/obx/v1/ingest/products/KL-8001")).status).toBe(404);
    const again = await importKestrel(node, token);
    const all = (await node.api(token, "GET", `/obx/v1/ingest/jobs/${again.id}/results?limit=500`)).json.items;
    expect(all.filter((i: any) => /^(fibre|animal|footwear)_/.test(i.obx_error))).toEqual([]);
  });

  test("cell grammar of import-format.md §1.6", () => {
    expect(parseMeasurementCell("2,6")).toEqual({ value: 2.6 });
    expect("error" in parseMeasurementCell("2.6 kg")).toBe(true);
    expect("error" in parseMeasurementCell("1.000,5")).toBe(true);
    expect("error" in parseMeasurementCell("0")).toBe(true);
    expect(parseStrapCell("80-130")).toEqual({ value: { min: 80, max: 130 } });
    expect(parseStrapCell("120")).toEqual({ value: { min: 120, max: 120 } });
    expect("error" in parseStrapCell("130-80")).toBe(true);
    expect(parseCertificationsCell("RWS:CU 200101 (material); gots")).toEqual({
      value: [
        { scheme: "rws", licence_number: "CU 200101", scope: "material" },
        { scheme: "gots", licence_number: null, scope: "product" },
      ],
    });
    expect(parseFootwearCell("Upper: Coated Leather; outer_sole: other")).toEqual({ value: { upper: "coated_leather", lining_and_sock: null, outer_sole: "other" } });
    expect("error" in parseFootwearCell("upper: plastic")).toBe(true);
    expect("error" in parseFootwearCell("heel: leather")).toBe(true);
    expect(parseFeatureCell("wheels", "4", parseBool)).toEqual({ value: 4 });
    expect("error" in parseFeatureCell("wheels", "3", parseBool)).toBe(true);
    expect(parseFeatureCell("expandable", "yes", parseBool)).toEqual({ value: true });
    expect(parseFeatureCell("detachable_parts", "Shoulder Strap|lining|lining", parseBool)).toEqual({ value: ["shoulder_strap", "lining"] });
    expect(parseFeatureCell("lock", "TSA combination", parseBool)).toEqual({ value: "tsa_combination" });
    expect(parseFeatureCell("heel_type", "Block", parseBool)).toEqual({ value: "Block" });
  });

  test("products.csv: unknown feature keys warn once per column, variant-only cells on product rows warn, colour family differences warn", () => {
    const csv =
      "style_number,name:en,feature:heel_type,gtin,color_code,color_family,weight_kg\n" +
      "KX-1,Shoe,block,,,,1.2\n" +
      "KX-1,Shoe,block,2000100101018,BLK,black,\n" +
      "KX-1,Shoe,block,2000100101025,BLK,gray,\n";
    const r = parseProductsCsv(csv, "products.csv", "en");
    expect(r.groups[0].product.features).toEqual({ heel_type: "block" });
    const w = r.errors.filter((e) => e.severity === "warning").map((e) => `${e.row}|${e.column}`);
    expect(w).toEqual(["null|feature:heel_type", "1|weight_kg", "3|color_family"]);
    expect(r.groups[0].variants.map((v) => (v.data.color as any).family)).toEqual(["black", "grey"]);
  });

  test("label warnings apply to textile and footwear item types only", () => {
    expect(labelWarnings({ item_type: "home" })).toEqual([]);
    expect(labelWarnings({ item_type: "watch", materials: [{ part: "main", fibers: [{ fiber: "metal", percentage: 50 }] }] })).toEqual([]);
    expect(labelWarnings({ item_type: "sweater", materials: [{ part: "main", fibers: [{ fiber: "lambswool", percentage: 100 }] }] }).map((w) => w.code)).toEqual(["animal_origin_unknown"]);
    expect(labelWarnings({ item_type: "boots", footwear_materials: { upper: "leather", lining_and_sock: "textile", outer_sole: "other" } })).toEqual([]);
  });
});

describe("Ingest API (ingest.md §3.4)", () => {
  const base = { brand_external_id: "kestrel", style_number: "KX-9", name: { en: "Test bag" } };

  test("0.1 fibre keys are normalised, empty objects are null, warning_details carry the label codes", async () => {
    const r = await node.api(token, "PUT", "/obx/v1/ingest/products/KX-9", {
      json: { ...base, item_type: "bag", features: {}, certifications: [], materials: [{ part: "outer", fibers: [{ fiber: "organic_cotton", percentage: 60 }, { fiber: "polyester", percentage: 30, recycled: false }] }] },
    });
    expect(r.status).toBe(201);
    expect(r.json.warning_details).toEqual([{ code: "fibre_percentages_not_100", pointer: "/materials/0", detail: expect.any(String) }]);
    expect(r.json.warnings.some((w: string) => w.startsWith("fibre_percentages_not_100: "))).toBe(true);
    const rec = (await node.api(token, "GET", "/obx/v1/ingest/products/KX-9")).json;
    expect(rec.data.materials).toEqual([{ part: "outer", fibers: [{ fiber: "cotton", percentage: 60, organic: true }, { fiber: "polyester", percentage: 30 }] }]);
    const p = await productByExt("KX-9");
    expect([p.features, p.certifications, p.footwear_materials, p.contains_animal_origin, p.item_subtype]).toEqual([null, null, null, null, null]);
    // Round trip: the record's data PUT back is unchanged.
    const back = await node.api(token, "PUT", "/obx/v1/ingest/products/KX-9", { json: rec.data });
    expect(back.json.result).toBe("unchanged");
    // A write without label problems has no warning_details at all.
    const ok = await node.api(token, "PUT", "/obx/v1/ingest/products/KX-9", { json: { ...base, item_type: "home" } });
    expect(ok.json.result).toBe("updated");
    expect("warning_details" in ok.json).toBe(false);
  });

  test("registry values, measurements, footwear materials and colour families outside their lists are 422", async () => {
    const bad: [string, Record<string, unknown>, string][] = [
      ["products/KX-9", { ...base, features: { wheels: 3 } }, "/features/wheels"],
      ["products/KX-9", { ...base, features: { lock: "padlock" } }, "/features/lock"],
      ["products/KX-9", { ...base, features: { detachable_parts: ["hood", "hood"] } }, "/features/detachable_parts"],
      ["products/KX-9", { ...base, footwear_materials: { upper: "plastic" } }, "/footwear_materials/upper"],
      ["products/KX-9", { ...base, certifications: [{ scheme: "gots" }] }, "/certifications/0/scope"],
    ];
    for (const [path, json, pointer] of bad) {
      const r = await node.api(token, "PUT", `/obx/v1/ingest/${path}`, { json });
      expect({ pointer, status: r.status, code: r.json.obx_error }).toEqual({ pointer, status: 422, code: "validation_failed" });
      expect(r.json.errors.map((e: any) => e.pointer)).toContain(pointer);
    }
    const v = { product_external_id: "KX-9", color: { code: "BLK", family: "navy" } };
    const r1 = await node.api(token, "PUT", "/obx/v1/ingest/variants/KX-9-BLK", { json: v });
    expect(r1.status).toBe(422);
    const r2 = await node.api(token, "PUT", "/obx/v1/ingest/variants/KX-9-BLK", { json: { ...v, color: { code: "BLK" }, measurements: { weight_kg: -1 } } });
    expect(r2.json.errors[0].pointer).toBe("/measurements/weight_kg");
    const strap = await node.api(token, "PUT", "/obx/v1/ingest/variants/KX-9-BLK", { json: { ...v, color: { code: "BLK" }, measurements: { strap_length_cm: { min: 130, max: 80 } } } });
    expect([strap.status, strap.json.errors[0].pointer]).toEqual([422, "/measurements/strap_length_cm"]);
    const ok = await node.api(token, "PUT", "/obx/v1/ingest/variants/KX-9-BLK", {
      json: { ...v, color: { code: "BLK", family: "black" }, size_length: "B", measurements: { strap_length_cm: { min: 80, max: 120 }, height_cm: 30 } },
    });
    expect(ok.status).toBe(201);
    const empty = await node.api(token, "PUT", "/obx/v1/ingest/variants/KX-9-RED", { json: { product_external_id: "KX-9", color: { code: "RED" }, measurements: {} } });
    expect(empty.status).toBe(201);
    const p = await productByExt("KX-9");
    const blk = p.variants.find((x: any) => x.external_id === "KX-9-BLK");
    expect(blk.measurements).toEqual({ height_cm: 30, strap_length_cm: { min: 80, max: 120 } });
    expect(Object.keys(blk.measurements)).toEqual(["height_cm", "strap_length_cm"]);
    expect([blk.color.family, blk.size_length]).toEqual(["black", "B"]);
    expect(p.variants.find((x: any) => x.external_id === "KX-9-RED").measurements).toBeNull();
    await node.api(token, "DELETE", "/obx/v1/ingest/products/KX-9");
  });
});

describe("article data CSV for retailers (admin-ui node-integration.md)", () => {
  test("the 0.2 columns in the order of the import format, re-importable", async () => {
    const r1 = await admin.req("POST", "/admin/api/retailers", { json: { name: "CSV Shop" } });
    const inv = await admin.req("POST", "/admin/api/users/invites", { json: { email: "csv@shop.example", name: "C", role: "retailer", retailer_id: r1.json.id, language: "en" } });
    const tok = inv.json.invite_url.split("/invite/")[1];
    const b = await node.browser();
    await b.req("POST", `/admin/api/invites/${tok}/accept`, { json: { password: "a very good password" } });
    const csv = await b.req("GET", "/admin/api/portal/products/data.csv?q=KO-1008");
    const parsed = parseCsv(csv.text);
    const h = parsed.header;
    const pos = (c: string) => h.indexOf(c);
    for (const c of ["item_subtype", "contains_animal_origin", "footwear_materials", "certifications", "feature:shell", "feature:neckline", "color_family", "size_length", "height_cm", "inseam_cm"]) expect(pos(c)).toBeGreaterThan(-1);
    expect(pos("item_type")).toBeLessThan(pos("item_subtype"));
    expect(pos("materials")).toBeLessThan(pos("contains_animal_origin"));
    expect(pos("country_of_origin")).toBeLessThan(pos("certifications"));
    expect(pos("dpp_url")).toBeLessThan(pos("feature:shell"));
    expect(pos("color_family")).toBeLessThan(pos("supplier_color"));
    expect(pos("size")).toBeLessThan(pos("size_length"));
    expect(pos("size_system")).toBeLessThan(pos("height_cm"));
    expect(h.at(-1)).toBe("image_files");
    const row = parsed.rows.find((r) => r.cells.includes("2000100801017"))!.cells;
    const get = (c: string) => row[pos(c)];
    expect([get("item_subtype"), get("feature:wheels"), get("feature:expandable"), get("materials"), get("color_family"), get("weight_kg"), get("strap_length_cm")]).toEqual([
      "cabin",
      "4",
      "yes",
      "shell: 100% polypropylene; lining: 100% polyester (recycled)",
      "black",
      "2.6",
      "",
    ]);
    // The export imports again without changes (the import format's promise).
    const { job } = await importCsv("data.csv", csv.text);
    expect(job.import_run.counts).toMatchObject({ errors: 0, created: 0, updated: 0 });
  });
});

describe("upgrading a 0.1 database (migrations/0005_fibre_flags.sql)", () => {
  test("stored 0.1 fibre keys become the fibre with its flag; other keys are normalised when read", async () => {
    const { sqliteDb } = await import("../src/adapters/bun/sqlite");
    const { migrate, resetMigrationCache } = await import("../src/db/migrate");
    const { productRep } = await import("../src/core/reps");
    resetMigrationCache();
    const db = sqliteDb(":memory:");
    await migrate(db);
    const stored = JSON.stringify({
      style_number: "OLD-1",
      name: { en: "Old" },
      materials: [
        { part: "outer", fibers: [{ fiber: "recycled_polyester", percentage: 60 }, { fiber: "organic_cotton", percentage: 40 }] },
        { part: "lining", fibers: [{ fiber: "recycled_wool", percentage: 100 }] },
      ],
    });
    const t = "2026-09-28T10:00:00Z";
    await db.run(
      "INSERT INTO products (id, external_id, brand_id, style_number, status, stored, rep_hash, etag, created_at, updated_at, content_updated_at, modified_at) VALUES ('prd_old', 'OLD-1', 'brd_x', 'OLD-1', 'published', ?, '', '', ?, ?, ?, ?)",
      [stored, t, t, t, t],
    );
    await db.run("DELETE FROM d1_migrations WHERE name = '0005_fibre_flags.sql'");
    resetMigrationCache();
    await migrate(db);
    const row = (await db.first<{ id: string; external_id: string; brand_id: string; stored: string; created_at: string; updated_at: string }>("SELECT * FROM products WHERE id = 'prd_old'"))!;
    expect(JSON.parse(row.stored).materials[0].fibers).toEqual([
      { fiber: "polyester", recycled: true, percentage: 60 },
      { fiber: "cotton", organic: true, percentage: 40 },
    ]);
    expect((productRep(row).materials as any)[1].fibers).toEqual([{ fiber: "wool", percentage: 100, recycled: true }]);
    resetMigrationCache();
  });
});
