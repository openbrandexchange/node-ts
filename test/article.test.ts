// Article data (spec 0.2, terms with names since 0.3): protocol.md §5.9, import-format.md §1.4–1.6 and
// rules 9 and 10, ingest.md §3.4.
// The cases of fixtures/imports are the spec's own vectors (conformance I-IMP-7 and I-IMP-8).
import { describe, expect, test, beforeAll } from "bun:test";
import { TestNode, importKestrel, addRenditions, fixtureText, formData, match, type Browser } from "./helpers";
import { parseCsv } from "../src/lib/csv";
import { CARE_VOCAB, MATERIAL_NAMES, PART_NAMES, QUALIFIER_NAMES, labelWarnings, parseFeatureCell, parseStrapCell, parseMeasurementCell, parseCertificationsCell, parseFootwearCell } from "../src/core/article";
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

  test("every product and variant carries the article data properties; terms with the vocabulary's names; no empty objects", async () => {
    const { entries } = await node.feed(at);
    for (const e of entries) {
      if (e.type === "product") {
        for (const p of ["item_subtype", "contains_animal_origin", "footwear_materials", "certifications", "features"]) expect({ ext: e.external_id, p, has: p in e.data }).toEqual({ ext: e.external_id, p, has: true });
        for (const part of e.data.materials ?? []) {
          expect(Object.keys(part)).toEqual(["part", "fibers"]);
          if (PART_NAMES.has(part.part.code)) expect(part.part).toEqual({ code: part.part.code, name: PART_NAMES.get(part.part.code) });
          if (part.part.code === "main") expect(part.part.name).toBeNull();
          for (const f of part.fibers) {
            expect(Object.keys(f)).toEqual(["material", "percentage", "qualifier"]);
            expect(f.material.code).not.toMatch(/^(recycled|organic)_/);
            if (MATERIAL_NAMES.has(f.material.code)) expect(f.material.name).toEqual(MATERIAL_NAMES.get(f.material.code));
            if (f.qualifier) expect(f.qualifier).toEqual({ code: f.qualifier.code, name: QUALIFIER_NAMES.get(f.qualifier.code) });
          }
        }
        for (const c of e.data.care ?? []) {
          expect(Object.keys(c)).toEqual(["code", "category", "symbol", "name", "text"]);
          const v = CARE_VOCAB.get(c.code);
          if (v) expect([c.category, c.symbol, c.name]).toEqual([v.category, v.symbol, v.name]);
        }
        expect(JSON.stringify(e.data)).not.toContain('""');
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
    expect(ko1003.data.materials).toEqual([
      { part: { code: "main", name: null }, fibers: [{ material: { code: "cotton", name: MATERIAL_NAMES.get("cotton") }, percentage: 100, qualifier: { code: "organic", name: QUALIFIER_NAMES.get("organic") } }] },
    ]);
    expect(ko1003.data.certifications).toEqual([
      { scheme: "gots", licence_number: "CU 200301", scope: "product" },
      { scheme: "oeko_tex_standard_100", licence_number: "26.KST.20003", scope: "product" },
    ]);
    const disc = await node.request("GET", "/.well-known/obx");
    expect(disc.json).toMatchObject({  obx_version: "0.3", spec_version: "0.3.0" });
  });
});

describe("imports of the article data columns (I-IMP-7, I-IMP-8)", () => {
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
    expect(labelWarnings({ item_type: "watch", materials: [{ part: { code: "main" }, fibers: [{ material: { code: "metal" }, percentage: 50 }] }] })).toEqual([]);
    expect(labelWarnings({ item_type: "sweater", materials: [{ part: { code: "main" }, fibers: [{ material: { code: "lambswool" }, percentage: 100 }] }] }).map((w) => w.code)).toEqual(["animal_origin_unknown"]);
    // The material code decides, also with a qualifier or written as a 0.1 key.
    expect(labelWarnings({ item_type: "coat", materials: [{ part: { code: "main" }, fibers: [{ material: { code: "recycled_wool" }, percentage: 100 }] }] }).map((w) => w.code)).toEqual(["animal_origin_unknown"]);
    expect(labelWarnings({ item_type: "coat", materials: [{ part: { code: "main" }, fibers: [{ material: { code: "cotton" }, percentage: 100, qualifier: { code: "regenerative" } }] }] })).toEqual([]);
    expect(labelWarnings({ item_type: "boots", footwear_materials: { upper: "leather", lining_and_sock: "textile", outer_sole: "other" } })).toEqual([]);
  });
});

describe("Ingest API (ingest.md §3.4)", () => {
  const base = { brand_external_id: "kestrel", style_number: "KX-9", name: { en: "Test bag" } };

  test("terms: names of known codes from the vocabularies, unknown codes keep what was written, 0.1 keys become a qualifier; round trip", async () => {
    const r = await node.api(token, "PUT", "/obx/v1/ingest/products/KX-9", {
      json: {
        ...base,
        item_type: "bag",
        features: {},
        certifications: [],
        materials: [
          {
            part: { code: "outer", name: { en: "Ignored" } },
            fibers: [
              { material: { code: "organic_cotton" }, percentage: 60, qualifier: { code: "recycled" } },
              { material: { code: "polyester" }, percentage: 20, qualifier: null },
              { material: { code: "pinatex", name: { en: "Piñatex", nl: "Piñatex" } }, percentage: 10, qualifier: { code: "upcycled", name: { en: "Upcycled" } } },
            ],
          },
        ],
        care: [{ code: "wash_30", name: { en: "Ignored" }, text: { en: "Wash inside out" } }, { code: "steam_only", category: "ironing", symbol: "4_S", name: { en: "Steam only" } }, { code: "air_out" }],
      },
    });
    expect(r.status).toBe(201);
    expect(r.json.warning_details).toEqual([{ code: "fibre_percentages_not_100", pointer: "/materials/0", detail: expect.any(String) }]);
    expect(r.json.warnings.some((w: string) => w.startsWith("fibre_percentages_not_100: "))).toBe(true);
    // Stored: codes, plus what was written for codes outside the vocabularies.
    const stored = JSON.parse((await node.platform.db.first<{ stored: string }>("SELECT stored FROM products WHERE external_id = 'KX-9'"))!.stored);
    expect(stored.materials[0].part).toEqual({ code: "outer" });
    expect(stored.care[0]).toEqual({ code: "wash_30", text: { en: "Wash inside out" } });
    const expected = [
      {
        part: { code: "outer", name: PART_NAMES.get("outer") },
        fibers: [
          // The 0.1 key wins over the qualifier that was also given (ingest.md §3.4).
          { material: { code: "cotton", name: MATERIAL_NAMES.get("cotton") }, percentage: 60, qualifier: { code: "organic", name: QUALIFIER_NAMES.get("organic") } },
          { material: { code: "polyester", name: MATERIAL_NAMES.get("polyester") }, percentage: 20, qualifier: null },
          { material: { code: "pinatex", name: { en: "Piñatex", nl: "Piñatex" } }, percentage: 10, qualifier: { code: "upcycled", name: { en: "Upcycled" } } },
        ],
      },
    ];
    const care = [
      { code: "wash_30", category: "washing", symbol: CARE_VOCAB.get("wash_30")!.symbol, name: CARE_VOCAB.get("wash_30")!.name, text: { en: "Wash inside out" } },
      { code: "steam_only", category: "ironing", symbol: "4_S", name: { en: "Steam only" }, text: null },
      { code: "air_out", category: null, symbol: null, name: null, text: null },
    ];
    const p = await productByExt("KX-9");
    expect([p.materials, p.care]).toEqual([expected, care]);
    expect([p.features, p.certifications, p.footwear_materials, p.contains_animal_origin, p.item_subtype]).toEqual([null, null, null, null, null]);
    const rec = (await node.api(token, "GET", "/obx/v1/ingest/products/KX-9")).json;
    expect([rec.data.materials, rec.data.care]).toEqual([expected, care]);
    // Round trip: the record's data PUT back is unchanged; so is the same data with codes only.
    const back = await node.api(token, "PUT", "/obx/v1/ingest/products/KX-9", { json: rec.data });
    expect(back.json.result).toBe("unchanged");
    const codesOnly = {
      ...rec.data,
      materials: [{ part: { code: "outer" }, fibers: [{ material: { code: "cotton" }, percentage: 60, qualifier: { code: "organic" } }, { material: { code: "polyester" }, percentage: 20 }, expected[0].fibers[2]] }],
      care: [{ code: "wash_30", text: { en: "Wash inside out" } }, care[1], { code: "air_out" }],
    };
    expect((await node.api(token, "PUT", "/obx/v1/ingest/products/KX-9", { json: codesOnly })).json.result).toBe("unchanged");
    // A write without label problems has no warning_details at all.
    const ok = await node.api(token, "PUT", "/obx/v1/ingest/products/KX-9", { json: { ...base, item_type: "home" } });
    expect(ok.json.result).toBe("updated");
    expect("warning_details" in ok.json).toBe(false);
  });

  test("0.2 shapes and malformed terms are 422", async () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ ...base, materials: [{ part: "main", fibers: [{ material: { code: "cotton" }, percentage: 100 }] }] }, "/materials/0/part"],
      [{ ...base, materials: [{ part: { code: "main" }, fibers: [{ fiber: "cotton", percentage: 100 }] }] }, "/materials/0/fibers/0/fiber"],
      [{ ...base, materials: [{ part: { code: "main" }, fibers: [{ material: { code: "polyester" }, percentage: 100, recycled: true }] }] }, "/materials/0/fibers/0/recycled"],
      [{ ...base, materials: [{ part: { code: "main" }, fibers: [{ material: { code: "cotton" }, percentage: 100, qualifier: "organic" }] }] }, "/materials/0/fibers/0/qualifier"],
      [{ ...base, materials: [{ part: { code: "Main" }, fibers: [{ material: { code: "cotton" }, percentage: 100 }] }] }, "/materials/0/part/code"],
      [{ ...base, materials: [{ part: { code: "main" }, fibers: [{ material: { code: "cotton", name: { en: "" } }, percentage: 100 }] }] }, "/materials/0/fibers/0/material/name/en"],
      [{ ...base, care: [{ code: "wash_30", category: "rinsing" }] }, "/care/0/category"],
      [{ ...base, care: [{ code: "wash_30", symbol: "C40" }] }, "/care/0/symbol"],
      [{ ...base, care: [{ code: "wash_30", colour: "red" }] }, "/care/0/colour"],
    ];
    for (const [json, pointer] of bad) {
      const r = await node.api(token, "PUT", "/obx/v1/ingest/products/KX-9", { json });
      expect({ pointer, status: r.status, code: r.json.obx_error }).toEqual({ pointer, status: 422, code: "validation_failed" });
      expect(r.json.errors.map((e: any) => e.pointer)).toContain(pointer);
    }
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

describe("upgrading a 0.1 or 0.2 database (migrations 0005_fibre_flags.sql and 0006_terms.sql)", () => {
  test("stored 0.1 fibre keys and 0.2 materials become terms; other 0.1 keys are normalised when read", async () => {
    const { sqliteDb } = await import("../src/adapters/bun/sqlite");
    const { migrate, resetMigrationCache } = await import("../src/db/migrate");
    const { productRep } = await import("../src/core/reps");
    resetMigrationCache();
    const db = sqliteDb(":memory:");
    await migrate(db);
    const t = "2026-09-28T10:00:00Z";
    const insert = (id: string, stored: unknown) =>
      db.run(
        "INSERT INTO products (id, external_id, brand_id, style_number, status, stored, rep_hash, etag, created_at, updated_at, content_updated_at, modified_at) VALUES (?, ?, 'brd_x', ?, 'published', ?, '', '', ?, ?, ?, ?)",
        [id, id, id, JSON.stringify(stored), t, t, t, t],
      );
    // Written by 0.1.
    await insert("OLD-1", {
      style_number: "OLD-1",
      name: { en: "Old" },
      materials: [
        { part: "outer", fibers: [{ fiber: "recycled_polyester", percentage: 60 }, { fiber: "organic_cotton", percentage: 40 }] },
        { part: "lining", fibers: [{ fiber: "recycled_wool", percentage: 100 }] },
      ],
      care: [{ code: "wash_30", text: null }],
    });
    // Written by 0.2.
    await insert("OLD-2", {
      style_number: "OLD-2",
      name: { en: "Old" },
      materials: [{ part: "main", fibers: [{ fiber: "cotton", percentage: 95, organic: true }, { fiber: "elastane", percentage: 5, "x-acme-lot": "7" }] }],
    });
    await db.run("DELETE FROM d1_migrations WHERE name IN ('0005_fibre_flags.sql', '0006_terms.sql')");
    resetMigrationCache();
    await migrate(db);
    const row = async (id: string) => (await db.first<{ id: string; external_id: string; brand_id: string; stored: string; created_at: string; updated_at: string }>("SELECT * FROM products WHERE id = ?", [id]))!;
    const old1 = await row("OLD-1");
    expect(JSON.parse(old1.stored).materials).toEqual([
      { part: { code: "outer" }, fibers: [{ material: { code: "polyester" }, percentage: 60, qualifier: { code: "recycled" } }, { material: { code: "cotton" }, percentage: 40, qualifier: { code: "organic" } }] },
      { part: { code: "lining" }, fibers: [{ material: { code: "recycled_wool" }, percentage: 100 }] },
    ]);
    expect(JSON.parse((await row("OLD-2")).stored).materials).toEqual([
      { part: { code: "main" }, fibers: [{ material: { code: "cotton" }, percentage: 95, qualifier: { code: "organic" } }, { material: { code: "elastane" }, percentage: 5, "x-acme-lot": "7" }] },
    ]);
    const rep = productRep(old1) as any;
    expect(rep.materials[1]).toEqual({
      part: { code: "lining", name: PART_NAMES.get("lining") },
      fibers: [{ material: { code: "wool", name: MATERIAL_NAMES.get("wool") }, percentage: 100, qualifier: { code: "recycled", name: QUALIFIER_NAMES.get("recycled") } }],
    });
    expect(rep.care).toEqual([{ code: "wash_30", category: "washing", symbol: CARE_VOCAB.get("wash_30")!.symbol, name: CARE_VOCAB.get("wash_30")!.name, text: null }]);
    resetMigrationCache();
  });
});
