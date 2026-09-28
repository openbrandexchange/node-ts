// Backup and restore for the Bun edition (Docker, own server, Cloud Run with a disk).
//   bun src/adapters/bun/backup.ts backup  <dir>   consistent copy while the portal keeps running
//   bun src/adapters/bun/backup.ts restore <dir>   put a backup back (stop the portal first)
//   bun src/adapters/bun/backup.ts verify  <dir>   check a backup without touching the portal
// A backup is a folder: obx.sqlite (VACUUM INTO snapshot), files/ (images, when stored on disk),
// secret.key (when the key was generated into the data folder) and manifest.json.
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { MIGRATIONS } from "../../db/migrations.gen";

export interface BackupPaths {
  dataDir: string;
  dbPath: string;
  filesDir: string | null;
}

export interface Manifest {
  format: "obx-node-ts-backup/1";
  created_at: string;
  software_version: string;
  schema: string[];
  database_sha256: string;
  files: number | null;
  secret_key_included: boolean;
  counts: Record<string, number>;
}

export function pathsFromEnv(env: Record<string, string | undefined>): BackupPaths {
  const dataDir = resolve(env.OBX_DATA_DIR?.trim() || "./data");
  const s3 = (env.OBX_STORAGE ?? "disk").trim().toLowerCase() === "s3";
  return {
    dataDir,
    dbPath: resolve(env.OBX_DB_PATH?.trim() || join(dataDir, "obx.sqlite")),
    filesDir: s3 ? null : resolve(env.OBX_FILES_DIR?.trim() || join(dataDir, "files")),
  };
}

function sha256File(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".multipart") continue;
    n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  }
  return n;
}

function inspect(dbFile: string) {
  const db = new Database(dbFile, { readonly: true });
  try {
    const ok = (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    if (ok !== "ok") throw new Error(`the database copy is damaged: ${ok}`);
    const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    const schema = tables.has("d1_migrations") ? (db.query("SELECT name FROM d1_migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name) : [];
    const counts: Record<string, number> = {};
    for (const t of ["brands", "products", "variants", "assets", "blobs", "retailers", "users"]) if (tables.has(t)) counts[t] = (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return { schema, counts };
  } finally {
    db.close();
  }
}

/** Consistent backup of a running portal: database snapshot first, then the (immutable) image files. */
export function backup(p: BackupPaths, dir: string, version: string): Manifest {
  const out = resolve(dir);
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty; choose a new folder for the backup.`);
  mkdirSync(out, { recursive: true });
  const snap = join(out, "obx.sqlite");
  const src = new Database(p.dbPath);
  try {
    src.exec("PRAGMA busy_timeout = 10000");
    src.query("VACUUM INTO ?").run(snap);
  } finally {
    src.close();
  }
  const { schema, counts } = inspect(snap);
  let files: number | null = null;
  if (p.filesDir && existsSync(p.filesDir)) {
    // Files are content-addressed and never rewritten, so copying after the snapshot gives every file it references.
    cpSync(p.filesDir, join(out, "files"), { recursive: true, filter: (s) => !s.includes("/.multipart") });
    files = countFiles(join(out, "files"));
  }
  const key = join(p.dataDir, "secret.key");
  const withKey = existsSync(key);
  if (withKey) cpSync(key, join(out, "secret.key"));
  const m: Manifest = { format: "obx-node-ts-backup/1", created_at: new Date().toISOString(), software_version: version, schema, database_sha256: sha256File(snap), files, secret_key_included: withKey, counts };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
  return m;
}

/** Checks a backup folder: manifest, checksum, integrity and a schema this software can run. */
export function verify(dir: string): Manifest {
  const d = resolve(dir);
  const mf = join(d, "manifest.json");
  if (!existsSync(mf)) throw new Error(`${d} has no manifest.json; is this a backup folder?`);
  const m = JSON.parse(readFileSync(mf, "utf8")) as Manifest;
  if (m.format !== "obx-node-ts-backup/1") throw new Error(`unknown backup format ${m.format}`);
  const db = join(d, "obx.sqlite");
  if (sha256File(db) !== m.database_sha256) throw new Error("obx.sqlite does not match the checksum in manifest.json");
  const { schema } = inspect(db);
  const known = new Set(MIGRATIONS.map((x) => x.name));
  const newer = schema.filter((s) => !known.has(s));
  if (newer.length) throw new Error(`this backup comes from a newer version (migration ${newer.join(", ")}); restore it with that version or newer`);
  return m;
}

/** Puts a backup back. The portal must be stopped. The current data is kept next to it as *.before-restore. */
export function restore(p: BackupPaths, dir: string): Manifest {
  const d = resolve(dir);
  const m = verify(d);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(p.dataDir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(p.dbPath + suffix)) renameSync(p.dbPath + suffix, `${p.dbPath}${suffix}.before-restore-${stamp}`);
  cpSync(join(d, "obx.sqlite"), p.dbPath);
  if (p.filesDir && existsSync(join(d, "files"))) {
    if (existsSync(p.filesDir)) renameSync(p.filesDir, `${p.filesDir}.before-restore-${stamp}`);
    cpSync(join(d, "files"), p.filesDir, { recursive: true });
  }
  if (existsSync(join(d, "secret.key"))) {
    const key = join(p.dataDir, "secret.key");
    if (existsSync(key)) renameSync(key, `${key}.before-restore-${stamp}`);
    cpSync(join(d, "secret.key"), key);
  }
  return m;
}

/** Removes the *.before-restore-* copies once the restored portal works. */
export function cleanup(p: BackupPaths) {
  for (const f of readdirSync(p.dataDir)) if (f.includes(".before-restore-")) rmSync(join(p.dataDir, f), { recursive: true, force: true });
}

if (import.meta.main) {
  const [cmd, dir] = process.argv.slice(2);
  const p = pathsFromEnv(process.env);
  try {
    if (cmd === "backup" && dir) {
      if (!existsSync(p.dbPath)) throw new Error(`no database at ${p.dbPath} (set OBX_DATA_DIR or OBX_DB_PATH)`);
      const { VERSION } = await import("../shared/config");
      const m = backup(p, dir, VERSION);
      console.log(`backup written to ${resolve(dir)}: ${JSON.stringify(m.counts)}, ${m.files ?? "no"} files${m.secret_key_included ? ", secret key included" : ""}`);
      if (!p.filesDir) console.log("Images are in S3 storage: back up the bucket with the provider's versioning or replication (see docs/operations.md).");
      if (!m.secret_key_included) console.log("OBX_SECRET_KEY comes from the environment: keep a copy of it with this backup.");
    } else if (cmd === "verify" && dir) {
      const m = verify(dir);
      console.log(`backup ok: made ${m.created_at} by ${m.software_version}, ${JSON.stringify(m.counts)}`);
    } else if (cmd === "restore" && dir) {
      const m = restore(p, dir);
      console.log(`restored the backup of ${m.created_at} into ${p.dataDir}. Start the portal; when it works, delete the *.before-restore-* copies (or run: bun src/adapters/bun/backup.ts cleanup).`);
    } else if (cmd === "cleanup") {
      cleanup(p);
      console.log("removed the *.before-restore-* copies");
    } else {
      console.error("usage: bun src/adapters/bun/backup.ts backup|verify|restore <dir>  |  cleanup");
      process.exit(2);
    }
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
