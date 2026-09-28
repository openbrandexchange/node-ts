import type { Db } from "../platform";
import { MIGRATIONS } from "./migrations.gen";

/**
 * Forward-only schema migrations, applied automatically at start (and on Workers at the first
 * request of an isolate). Applied migrations are recorded in `d1_migrations`, the table
 * `wrangler d1 migrations apply` uses, so running that command (the Deploy to Cloudflare button
 * does) and the runtime never apply the same file twice. Databases created before v0.1.0 recorded
 * migrations in `schema_migrations`; both tables are read.
 */
export const MIGRATIONS_TABLE = "d1_migrations";

/** Split a migration file into statements ("-- comments" dropped, ";" at line end terminates). */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const raw of sql.split("\n")) {
    const line = raw.replace(/--.*$/, "").trimEnd();
    if (!line.trim()) continue;
    cur.push(line);
    if (line.endsWith(";")) {
      out.push(cur.join("\n"));
      cur = [];
    }
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

/** The database was migrated by a newer release than this one: refuse to run on it. */
export class SchemaTooNewError extends Error {
  constructor(public readonly unknown: string[]) {
    super(
      `The database was upgraded by a newer version of this software (it has migration ${unknown.join(", ")}, which this version does not know). ` +
        `Run that newer version, or restore the backup taken before the upgrade. Downgrades are not supported.`,
    );
    this.name = "SchemaTooNewError";
  }
}

export interface SchemaStatus {
  applied: string[];
  latest: string;
  pending: string[];
  unknown: string[];
}

async function appliedNames(db: Db): Promise<string[]> {
  const tables = new Set(
    (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('d1_migrations', 'schema_migrations')")).map((r) => r.name),
  );
  const names = new Set<string>();
  for (const t of ["d1_migrations", "schema_migrations"]) if (tables.has(t)) for (const r of await db.all<{ name: string }>(`SELECT name FROM ${t}`)) names.add(r.name);
  return [...names].sort();
}

export async function schemaStatus(db: Db): Promise<SchemaStatus> {
  const applied = await appliedNames(db);
  const known = new Set(MIGRATIONS.map((m) => m.name));
  return {
    applied,
    latest: MIGRATIONS[MIGRATIONS.length - 1].name,
    pending: MIGRATIONS.map((m) => m.name).filter((n) => !applied.includes(n)),
    unknown: applied.filter((n) => !known.has(n)),
  };
}

let migrated = new WeakSet<Db>();

/** Applies pending migrations once per database handle (cheap check afterwards). */
export async function migrate(db: Db): Promise<void> {
  if (migrated.has(db)) return;
  await db.run(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
  const status = await schemaStatus(db);
  if (status.unknown.length) throw new SchemaTooNewError(status.unknown);
  for (const m of MIGRATIONS) {
    if (!status.pending.includes(m.name)) continue;
    const stmts = splitSql(m.sql).map((sql) => ({ sql }));
    stmts.push({ sql: `INSERT OR IGNORE INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`, params: [m.name] } as never);
    await db.batch(stmts);
  }
  migrated.add(db);
}

export function resetMigrationCache() {
  migrated = new WeakSet<Db>();
}
