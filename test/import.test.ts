import { describe, expect, test } from "bun:test";
import { TestNode, importKestrel, addRenditions, fixtureText, kestrelImages, formData, uploadBlob, match } from "./helpers";
import { zipBytes } from "../src/lib/zip";
import { crc32 } from "../src/lib/crypto";
import { sha256Hex } from "../src/lib/crypto";

async function kestrelNode() {
  const node = new TestNode();
  const admin = await node.setup();
  const token = await node.ingestToken(admin);
  const cl = await node.retailerClient(admin);
  const at = await node.accessToken(cl.clientId, cl.secret);
  return { node, admin, token, at, cl };
}

const counts = (entries: any[]) => {
  const c: Record<string, number> = { brand: 0, product: 0, variant: 0, asset: 0 };
  for (const e of entries) if (e._phase === "snapshot") c[e.type]++;
  return c;
};

describe("canonical import (I-IMP-1..4)", () => {
  test("fixtures/kestrel as csv + assets_csv + images: expected objects; re-import is unchanged", async () => {
    const { node, token, at } = await kestrelNode();
    const job = await importKestrel(node, token);
    expect(job.status).toBe("succeeded");
    expect(job.import_run.counts.errors).toBe(0);
    expect(job.import_run.counts.rows).toBe(40);
    expect(job.import_run.counts.files).toBe(27);
    const expected = JSON.parse(fixtureText("expected/counts.json"));
    const snap = await node.feed(at);
    expect(counts(snap.entries)).toEqual({ brand: expected.brands, product: expected.products, variant: expected.variants, asset: expected.assets });
    // type order in the snapshot, then a live page
    const order = snap.entries.filter((e) => e._phase === "snapshot").map((e) => e.type);
    expect(order).toEqual([...order].sort((a, b) => ["brand", "product", "variant", "asset"].indexOf(a) - ["brand", "product", "variant", "asset"].indexOf(b)));
    expect(snap.phases.at(-1)).toBe("live");

    const again = await importKestrel(node, token);
    expect(again.import_run.counts.created + again.import_run.counts.updated).toBe(0);
    expect(again.import_run.counts.unchanged).toBeGreaterThan(70);
    expect((await node.feed(at, snap.cursor)).entries).toEqual([]);
  });

  test("an image named with colour ALL belongs to every colour: {style}_ALL_{position}, colour null", async () => {
    const { node, token } = await kestrelNode();
    const img = kestrelImages().find((i) => i.name === "KO-1005_COG_1_front.png")!;
    const job = await importKestrel(node, token, [{ name: "images", filename: "KO-1005_all_9_size_chart.png", type: "image/png", data: img.bytes } as never]);
    expect(job.import_run.counts.errors).toBe(0);
    const a = await node.platform.db.first<{ external_id: string; color_code: string | null; stored: string }>("SELECT external_id, color_code, stored FROM assets WHERE external_id = 'KO-1005_ALL_9'");
    expect(a).toMatchObject({ external_id: "KO-1005_ALL_9", color_code: null });
    expect(JSON.parse(a!.stored)).toMatchObject({ role: "size_chart", view: null });
  });

  test("products match expected/product-*.json once renditions exist (P-CAT-1, P-MEDIA-1)", async () => {
    const { node, token, at } = await kestrelNode();
    await importKestrel(node, token);
    await addRenditions(node, token);
    for (const style of ["KO-1001", "KO-1005"]) {
      const id = (await node.platform.db.first<{ id: string }>("SELECT id FROM products WHERE external_id = ?", [style]))!.id;
      const r = await node.api(at, "GET", `/obx/v1/products/${id}`);
      expect(r.status).toBe(200);
      const exp = JSON.parse(fixtureText(`expected/product-${style}.json`));
      expect(match(exp, r.json)).toEqual([]);
      expect(r.headers.get("etag")).toMatch(/^"[a-f0-9]{64}"$/);
      const nm = await node.api(at, "GET", `/obx/v1/products/${id}`, { headers: { "if-none-match": r.headers.get("etag")! } });
      expect(nm.status).toBe(304);
    }
    for (const [file, ext] of [
      ["asset-ai-generated", "KO-1003_RST_3"],
      ["asset-embargoed", "KO-1002_BLK_2"],
      ["asset-large-original", "KO-1002_OLV_1"],
    ]) {
      const id = (await node.platform.db.first<{ id: string }>("SELECT id FROM assets WHERE external_id = ?", [ext]))!.id;
      const r = await node.api(at, "GET", `/obx/v1/assets/${id}`);
      expect({ file, problems: match(JSON.parse(fixtureText(`expected/${file}.json`)), r.json) }).toEqual({ file, problems: [] });
    }
  });

  test("package zip and images_manifest give the same result (I-IMP-1, I-IMP-2)", async () => {
    const { node, token, at } = await kestrelNode();
    const zip = await zipBytes(
      [
        { name: "export/products.csv", data: new TextEncoder().encode(fixtureText("kestrel/products.csv")) },
        { name: "export/assets.csv", data: new TextEncoder().encode(fixtureText("kestrel/assets.csv")) },
        ...kestrelImages().map((i) => ({ name: `export/images/${i.name}`, data: i.bytes })),
        { name: "__MACOSX/._KO-1001_NVY_1_front.png", data: new Uint8Array([1, 2, 3]) },
      ],
      crc32,
    );
    const f = formData([{ name: "package", filename: "kestrel.zip", type: "application/zip", data: zip }]);
    const r = await node.api(token, "POST", "/obx/v1/ingest/imports", { body: f.body, headers: { "content-type": f.contentType } });
    expect(r.status).toBe(202);
    await node.drain();
    const job = (await node.api(token, "GET", `/obx/v1/ingest/jobs/${r.json.id}`)).json;
    expect(job.status).toBe("succeeded");
    expect(job.import_run.counts.errors).toBe(0);
    expect(counts((await node.feed(at)).entries)).toEqual({ brand: 2, product: 8, variant: 40, asset: 27 });

    // A second node imports with a manifest of already-uploaded blobs instead of image bytes.
    const b = await kestrelNode();
    const manifest = [];
    for (const i of kestrelImages()) manifest.push({ file: i.name, sha256: await uploadBlob(b.node, b.token, i.bytes) });
    const f2 = formData([
      { name: "csv", filename: "products.csv", data: fixtureText("kestrel/products.csv") },
      { name: "assets_csv", filename: "assets.csv", data: fixtureText("kestrel/assets.csv") },
      { name: "images_manifest", type: "application/json", data: JSON.stringify(manifest) },
      { name: "options", type: "application/json", data: JSON.stringify({ mode: "upsert" }) },
    ]);
    const r2 = await b.node.api(b.token, "POST", "/obx/v1/ingest/imports", { body: f2.body, headers: { "content-type": f2.contentType } });
    await b.node.drain();
    const job2 = (await b.node.api(b.token, "GET", `/obx/v1/ingest/jobs/${r2.json.id}`)).json;
    expect(job2.import_run.counts.errors).toBe(0);
    expect(counts((await b.node.feed(b.at)).entries)).toEqual({ brand: 2, product: 8, variant: 40, asset: 27 });
    const sha = await sha256Hex(kestrelImages()[0].bytes);
    const row = await b.node.platform.db.first<{ files: string }>("SELECT files FROM assets WHERE external_id = 'KO-1001_NVY_1'");
    expect(JSON.parse(row!.files).original.sha256).toBe(sha);
  });

  test("mirror: unpublishes exactly the missing product; refuses a mass unpublish; zip-slip writes nothing (I-IMP-3)", async () => {
    const { node, token, at } = await kestrelNode();
    await importKestrel(node, token);
    const lines = fixtureText("kestrel/products.csv").trim().split("\n");
    const header = lines[0];
    const rows = lines.slice(1);
    const ko1006 = rows.filter((l) => !l.includes(",KO-1006,"));
    const snap = await node.feed(at);
    const f = formData([
      { name: "csv", filename: "products.csv", data: [header, ...ko1006].join("\n") },
      { name: "options", type: "application/json", data: JSON.stringify({ mode: "mirror" }) },
    ]);
    const r = await node.api(token, "POST", "/obx/v1/ingest/imports", { body: f.body, headers: { "content-type": f.contentType } });
    await node.drain();
    const job = (await node.api(token, "GET", `/obx/v1/ingest/jobs/${r.json.id}`)).json;
    expect(job.status).toBe("succeeded");
    expect(job.import_run.counts.unpublished).toBe(1);
    const live = await node.feed(at, snap.cursor);
    const productDeletes = live.entries.filter((e) => e.type === "product" && e.op === "delete").map((e) => e.external_id);
    expect(productDeletes).toEqual(["KO-1006"]);

    const one = rows.filter((l) => l.includes(",KO-1001,"));
    const f2 = formData([
      { name: "csv", filename: "products.csv", data: [header, ...one].join("\n") },
      { name: "options", type: "application/json", data: JSON.stringify({ mode: "mirror" }) },
    ]);
    const r2 = await node.api(token, "POST", "/obx/v1/ingest/imports", { body: f2.body, headers: { "content-type": f2.contentType } });
    await node.drain();
    const job2 = (await node.api(token, "GET", `/obx/v1/ingest/jobs/${r2.json.id}`)).json;
    expect(job2.status).toBe("failed");
    expect(job2.import_run.error.obx_error).toBe("mass_unpublish_refused");

    const evil = await zipBytes(
      [
        { name: "products.csv", data: new TextEncoder().encode([header, ...rows].join("\n").replace(/Merino Crew Sweater/g, "Changed Name")) },
        { name: "../evil.jpg", data: new Uint8Array([0xff, 0xd8, 0xff]) },
      ],
      crc32,
    );
    const before = await node.feed(at, (await node.feed(at, snap.cursor)).cursor);
    const f3 = formData([{ name: "package", filename: "evil.zip", data: evil }]);
    const r3 = await node.api(token, "POST", "/obx/v1/ingest/imports", { body: f3.body, headers: { "content-type": f3.contentType } });
    await node.drain();
    const job3 = (await node.api(token, "GET", `/obx/v1/ingest/jobs/${r3.json.id}`)).json;
    expect(job3.status).toBe("failed");
    expect(job3.import_run.error.obx_error).toBe("import_invalid");
    expect((await node.feed(at, before.cursor)).entries).toEqual([]);
  });

  test("row errors carry file, row, column and code; the job still succeeds (I-IMP-4)", async () => {
    const { node, token } = await kestrelNode();
    const csv = [
      "style_number,name:en,gtin,color_code,size,materials",
      "ZZ-1,Good Tee,2000100101018,BLK,M,100% cotton",
      "ZZ-2,Bad Gtin,2.00010010102E+12,BLK,M,",
      "ZZ-3,Bad Check,2000100101019,BLK,M,",
      "ZZ-4,Bad Materials,,BLK,M,cotton",
    ].join("\n");
    const f = formData([
      { name: "csv", filename: "products.csv", data: csv },
      { name: "images", filename: "ZZ-1_BLK_front.jpg", data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
      { name: "images", filename: "QQ-9_BLK_1.jpg", data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
    ]);
    const r = await node.api(token, "POST", "/obx/v1/ingest/imports", { body: f.body, headers: { "content-type": f.contentType } });
    await node.drain();
    const job = (await node.api(token, "GET", `/obx/v1/ingest/jobs/${r.json.id}`)).json;
    expect(job.status).toBe("succeeded");
    const errs = (await node.api(token, "GET", `/obx/v1/ingest/jobs/${r.json.id}/results?errors_only=true`)).json.items;
    const pick = (e: any) => `${e.file}|${e.row}|${e.column}|${e.obx_error}`;
    expect(errs.map(pick)).toEqual(
      expect.arrayContaining(["products.csv|2|gtin|invalid_gtin", "products.csv|3|gtin|invalid_gtin", "products.csv|4|materials|validation_failed", "ZZ-1_BLK_front.jpg|null|null|validation_failed"]),
    );
    expect(errs.some((e: any) => e.file === "QQ-9_BLK_1.jpg" && (e.obx_error === "unknown_parent" || e.obx_error === "unsupported_media_type"))).toBe(true);
    expect(job.import_run.counts.created).toBeGreaterThanOrEqual(3);
  });
});
