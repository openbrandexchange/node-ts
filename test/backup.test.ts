// Backup and restore of the Bun edition: a backup taken while the portal runs, restored into an
// empty data folder, gives the same catalog, images, accounts and secret key.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { TestNode, importKestrel } from "./helpers";
import { backup, restore, verify, pathsFromEnv } from "../src/adapters/bun/backup";
import { resetMigrationCache } from "../src/db/migrate";

describe("backup and restore", () => {
  test("a running portal's backup restores into an empty folder with catalog, images, accounts and key", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "obx-bk-src-"));
    // No OBX_SECRET_KEY: the key is generated into the data folder, as on a fresh Docker volume.
    const node = new TestNode({ OBX_SECRET_KEY: "" }, { dataDir, dbPath: join(dataDir, "obx.sqlite") });
    const admin = await node.setup();
    const token = await node.ingestToken(admin);
    const job = await importKestrel(node, token);
    expect(job.import_run.counts.errors).toBe(0);
    const before = await node.platform.db.first<Record<string, number>>("SELECT (SELECT COUNT(*) FROM products) AS p, (SELECT COUNT(*) FROM assets) AS a, (SELECT COUNT(*) FROM blobs) AS b");

    const dir = join(mkdtempSync(join(tmpdir(), "obx-bk-")), "backup-1");
    const m = backup(pathsFromEnv({ OBX_DATA_DIR: dataDir }), dir, "test");
    expect(m.counts.products).toBe(before!.p);
    expect(m.files).toBeGreaterThanOrEqual(before!.b);
    expect(m.secret_key_included).toBe(true);
    // The portal keeps working while and after the backup is taken.
    expect((await admin.req("GET", "/admin/api/catalog/products")).status).toBe(200);

    const target = mkdtempSync(join(tmpdir(), "obx-bk-dst-"));
    restore(pathsFromEnv({ OBX_DATA_DIR: target }), dir);
    resetMigrationCache();
    const back = new TestNode({ OBX_SECRET_KEY: "" }, { dataDir: target, dbPath: join(target, "obx.sqlite") });
    expect(readFileSync(join(target, "secret.key"), "utf8")).toBe(readFileSync(join(dataDir, "secret.key"), "utf8"));
    const b = await back.browser();
    const login = await b.req("POST", "/admin/api/session/login", { json: { email: "admin@kestrel.example", password: "correct horse battery staple" } });
    expect(login.status).toBe(200);
    const after = await back.platform.db.first<Record<string, number>>("SELECT (SELECT COUNT(*) FROM products) AS p, (SELECT COUNT(*) FROM assets) AS a, (SELECT COUNT(*) FROM blobs) AS b");
    expect(after).toEqual(before);
    // Images are served from the restored files, and the old ingest token (hashed with the same key) still works.
    const asset = (await back.platform.db.first<{ id: string }>("SELECT id FROM assets WHERE external_id = 'KO-1001_NVY_1'"))!;
    const detail = await b.req("GET", `/admin/api/catalog/products/KO-1001`);
    expect(detail.status).toBe(200);
    const cl = await back.retailerClient(b);
    const at = await back.accessToken(cl.clientId, cl.secret);
    const a = await back.api(at, "GET", `/obx/v1/assets/${asset.id}`);
    const original = await back.request("GET", new URL(a.json.renditions.original.url).pathname + new URL(a.json.renditions.original.url).search);
    expect(original.status).toBe(200);
    expect(original.bytes.length).toBe(a.json.renditions.original.bytes);
    expect((await back.api(token, "GET", "/obx/v1/ingest")).status).toBe(200);
  });

  test("verify refuses a damaged copy and a backup from a newer version", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "obx-bk-v-"));
    const node = new TestNode({}, { dataDir, dbPath: join(dataDir, "obx.sqlite") });
    await node.setup();
    const dir = join(mkdtempSync(join(tmpdir(), "obx-bk-")), "b");
    backup(pathsFromEnv({ OBX_DATA_DIR: dataDir }), dir, "test");
    expect(verify(dir).format).toBe("obx-node-ts-backup/1");

    const db = new Database(join(dir, "obx.sqlite"));
    db.exec("INSERT INTO d1_migrations (name) VALUES ('0099_future.sql')");
    db.close();
    expect(() => verify(dir)).toThrow("does not match the checksum");
    const mf = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    mf.database_sha256 = new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, "obx.sqlite"))).digest("hex");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(mf));
    expect(() => verify(dir)).toThrow("newer version");
  });
});
