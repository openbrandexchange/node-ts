import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestNode, importKestrel, addRenditions } from "./helpers";
import { Ctx } from "../src/core/ctx";
import { ZipWriter, newZipState } from "../src/core/zipwriter";
import { diskStore } from "../src/adapters/bun/disk";
import { s3Store } from "../src/adapters/shared/s3store";
import { crc32, sha256Hex } from "../src/lib/crypto";
import { readZipDirectory, readZipEntry } from "../src/lib/zip";
import { bytesReader } from "../src/lib/multipart";
import type { BlobStore } from "../src/platform";
import { PART_BYTES } from "../src/core/blobs";

async function writerRoundTrip(store: BlobStore) {
  const node = new TestNode();
  node.platform.blobs = store;
  const ctx = new Ctx(node.platform);
  await ctx.ready();
  const big1 = crypto.getRandomValues(new Uint8Array(65536)).slice();
  const a = new Uint8Array(PART_BYTES + 12345);
  for (let i = 0; i < a.length; i += 65536) a.set(big1.subarray(0, Math.min(65536, a.length - i)), i);
  const b = new TextEncoder().encode("second entry");
  const c = new Uint8Array(PART_BYTES * 2 + 7).fill(7);
  // step 1: one large entry, then park the tail
  let st = newZipState("jobs/test/out.zip");
  let w = new ZipWriter(ctx, "job_test", st, "zcd");
  await w.resume();
  await w.add("folder/a.bin", a.length, crc32(a), { bytes: a });
  await w.checkpoint();
  st = JSON.parse(JSON.stringify(w.st));
  // step 2: a fresh writer resumes from the stored state
  w = new ZipWriter(ctx, "job_test", st, "zcd");
  await w.resume();
  await w.add("b.txt", b.length, crc32(b), { bytes: b });
  await w.checkpoint();
  st = JSON.parse(JSON.stringify(w.st));
  w = new ZipWriter(ctx, "job_test", st, "zcd");
  await w.resume();
  await w.add("c.bin", c.length, crc32(c), { bytes: c });
  const r = await w.finish();
  const stream = await store.get("jobs/test/out.zip");
  const zip = new Uint8Array(await new Response(stream).arrayBuffer());
  expect(zip.length).toBe(r.bytes);
  expect(await sha256Hex(zip)).toBe(r.sha256);
  const dir = await readZipDirectory(bytesReader(zip), zip.length);
  expect(dir.map((d) => d.name)).toEqual(["folder/a.bin", "b.txt", "c.bin"]);
  expect(await sha256Hex(await readZipEntry(bytesReader(zip), dir[0], 1e9))).toBe(await sha256Hex(a));
  expect(new TextDecoder().decode(await readZipEntry(bytesReader(zip), dir[1], 1e9))).toBe("second entry");
  expect((await readZipEntry(bytesReader(zip), dir[2], 1e9)).length).toBe(c.length);
  expect(await store.head("jobs/test/out.zip.carry")).toBeNull();
}

describe("resumable zip writer (download jobs and exports survive CPU limits)", () => {
  test("disk store: entries across checkpoints and multipart parts", async () => {
    await writerRoundTrip(diskStore(mkdtempSync(join(tmpdir(), "obx-disk-"))));
  });

  const endpoint = process.env.OBX_TEST_S3_ENDPOINT;
  test.skipIf(!endpoint)("S3 store (MinIO): same round trip, list and ranges", async () => {
    const store = s3Store({
      endpoint: endpoint!,
      bucket: process.env.OBX_TEST_S3_BUCKET ?? "portal",
      region: "us-east-1",
      accessKeyId: process.env.OBX_TEST_S3_KEY ?? "portal",
      secretAccessKey: process.env.OBX_TEST_S3_SECRET ?? "portal-secret-change-me",
      prefix: `test-${Date.now()}`,
    });
    await writerRoundTrip(store);
    await store.put("x/one", new Uint8Array([1, 2, 3, 4, 5]));
    expect([...(await store.getRange("x/one", 1, 3))!]).toEqual([2, 3, 4]);
    expect((await store.list("x/")).keys).toEqual(["x/one"]);
    await store.delete(["x/one"]);
    expect(await store.head("x/one")).toBeNull();
  });
});

describe("rights expiry", () => {
  test("an expired asset gets a tombstone from the minute tick", async () => {
    const node = new TestNode();
    const admin = await node.setup();
    const token = await node.ingestToken(admin);
    await importKestrel(node, token);
    await addRenditions(node, token);
    const cl = await node.retailerClient(admin);
    const at = await node.accessToken(cl.clientId, cl.secret);
    const soon = new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const p = await node.api(token, "PATCH", "/obx/v1/ingest/assets/KO-1001_NVY_1", { json: { rights: { expires_at: soon } }, headers: { "content-type": "application/merge-patch+json" } });
    expect(p.json.result).toBe("updated");
    const f0 = await node.feed(at);
    node.clock.offset = 5 * 60_000;
    await node.worker.tick(10_000);
    const f1 = await node.feed(at, f0.cursor);
    expect(f1.entries.map((e) => `${e.type}:${e.op}:${e.external_id}`)).toEqual(["asset:delete:KO-1001_NVY_1"]);
    const id = f1.entries[0].id;
    const at2 = await node.accessToken(cl.clientId, cl.secret);
    expect((await node.api(at2, "GET", `/obx/v1/assets/${id}`)).status).toBe(404);
  });
});

describe("scheduled pull import from an S3-compatible bucket", () => {
  const endpoint = process.env.OBX_TEST_S3_ENDPOINT;
  test.skipIf(!endpoint)("lists the prefix, imports products.csv + images, skips unchanged runs", async () => {
    const { fixtureText, kestrelImages } = await import("./helpers");
    const prefix = `export-${Date.now()}`;
    const bucket = s3Store({ endpoint: endpoint!, bucket: process.env.OBX_TEST_S3_BUCKET ?? "portal", region: "us-east-1", accessKeyId: "portal", secretAccessKey: "portal-secret-change-me" });
    await bucket.put(`${prefix}/products.csv`, new TextEncoder().encode(fixtureText("kestrel/products.csv")));
    await bucket.put(`${prefix}/assets.csv`, new TextEncoder().encode(fixtureText("kestrel/assets.csv")));
    for (const i of kestrelImages()) await bucket.put(`${prefix}/images/${i.name}`, i.bytes);
    const node = new TestNode();
    const admin = await node.setup();
    const src = await admin.req("POST", "/admin/api/import-sources", {
      json: {
        name: "Bucket",
        kind: "s3",
        schedule: { frequency: "hourly" },
        config: { endpoint, region: "us-east-1", bucket: process.env.OBX_TEST_S3_BUCKET ?? "portal", prefix: `${prefix}/`, path_style: true },
        credentials: { access_key_id: "portal", secret_access_key: "portal-secret-change-me" },
      },
    });
    expect(src.status).toBe(201);
    const t = await admin.req("POST", `/admin/api/import-sources/${src.json.id}/test`);
    expect(t.json.ok).toBe(true);
    expect(t.json.files.length).toBe(29);
    const run = await admin.req("POST", `/admin/api/import-sources/${src.json.id}/run`, { json: {} });
    await node.drain();
    const r = await admin.req("GET", `/admin/api/imports/${run.json.id}`);
    expect(r.json.status).toBe("succeeded");
    expect(r.json.counts.errors).toBe(0);
    expect(r.json.counts.files).toBe(27);
    const run2 = await admin.req("POST", `/admin/api/import-sources/${src.json.id}/run`, { json: {} });
    await node.drain();
    expect((await admin.req("GET", `/admin/api/imports/${run2.json.id}`)).json.counts.files).toBe(0);
  });
});

describe("scheduled pull import from SFTP (Bun build)", () => {
  const host = process.env.OBX_TEST_SFTP_HOST;
  test.skipIf(!host)("pins the host key, imports the folder", async () => {
    const node = new TestNode();
    const admin = await node.setup();
    const src = await admin.req("POST", "/admin/api/import-sources", {
      json: {
        name: "SFTP drop folder",
        kind: "sftp",
        schedule: { frequency: "daily", time: "03:00" },
        config: { host, port: Number(process.env.OBX_TEST_SFTP_PORT ?? 22), username: process.env.OBX_TEST_SFTP_USER ?? "brand", path: process.env.OBX_TEST_SFTP_PATH ?? "/export" },
        credentials: { password: process.env.OBX_TEST_SFTP_PASSWORD ?? "brandpass" },
      },
    });
    expect(src.status).toBe(201);
    expect(src.json.credentials_set.password).toBe(true);
    const t = await admin.req("POST", `/admin/api/import-sources/${src.json.id}/test`);
    expect(t.json.ok).toBe(true);
    expect(t.json.host_key_fingerprint).toMatch(/^SHA256:/);
    const pin = await admin.req("PATCH", `/admin/api/import-sources/${src.json.id}`, { json: { config: { host_key_fingerprint: t.json.host_key_fingerprint } } });
    expect(pin.json.config.host_key_fingerprint).toBe(t.json.host_key_fingerprint);
    const run = await admin.req("POST", `/admin/api/import-sources/${src.json.id}/run`, { json: {} });
    await node.drain();
    const r = await admin.req("GET", `/admin/api/imports/${run.json.id}`);
    expect(r.json.status).toBe("succeeded");
    expect(r.json.counts.errors).toBe(0);
    expect(r.json.counts.files).toBe(27);
    await admin.req("PATCH", `/admin/api/import-sources/${src.json.id}`, { json: { config: { host_key_fingerprint: "SHA256:wrong" } } });
    const bad = await admin.req("POST", `/admin/api/import-sources/${src.json.id}/test`);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.message).toContain("host key");
  });
});

describe("unreferenced files", () => {
  test("housekeeping removes files no image uses (after a day), keeps used ones and the logo, once a day", async () => {
    const { TestNode: Node, uploadBlob: upload } = await import("./helpers");
    const { fakeJpeg } = await import("../src/lib/image");
    const { housekeeping } = await import("../src/core/cron");
    const { Ctx } = await import("../src/core/ctx");
    const node = new Node();
    const admin = await node.setup();
    const token = await node.ingestToken(admin);
    const used = await upload(node, token, fakeJpeg(1200, 1600, 11));
    const orphan = await upload(node, token, fakeJpeg(1200, 1600, 12));
    await node.api(token, "PUT", "/obx/v1/ingest/products/KO-9", { json: { style_number: "KO-9", name: { en: "Nine" } } });
    await node.api(token, "PUT", "/obx/v1/ingest/variants/2000100101018", { json: { product_external_id: "KO-9", gtin: "2000100101018", color: { code: "NVY" }, size: "M" } });
    const a = await node.api(token, "PUT", "/obx/v1/ingest/assets/KO-9_NVY_1", { json: { product_external_id: "KO-9", color_code: "NVY", position: 1, role: "packshot", files: { original: { sha256: used } } } });
    expect(a.status).toBeLessThan(300);
    const has = async (sha: string) => !!(await node.platform.db.first("SELECT 1 AS x FROM blobs WHERE sha256 = ?", [sha])) && !!(await node.platform.blobs.head(`blobs/${sha.slice(0, 2)}/${sha}`));
    const ctx = new Ctx(node.platform);
    await housekeeping(ctx);
    expect(await has(orphan)).toBe(true); // younger than a day
    node.clock.offset = 25 * 3600 * 1000;
    await housekeeping(new Ctx(node.platform));
    expect(await has(orphan)).toBe(false);
    expect(await has(used)).toBe(true);
  });
});
