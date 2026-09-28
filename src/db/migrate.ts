import type { Db } from "../platform";
import { MIGRATIONS } from "./migrations.gen";

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

let migrated = new WeakSet<Db>();

/** Applies pending migrations once per database handle (cheap check afterwards). */
export async function migrate(db: Db): Promise<void> {
  if (migrated.has(db)) return;
  await db.run("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set((await db.all<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    const stmts = splitSql(m.sql).map((sql) => ({ sql }));
    stmts.push({ sql: "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)", params: [m.name, new Date().toISOString()] } as never);
    await db.batch(stmts);
  }
  migrated.add(db);
}

export function resetMigrationCache() {
  migrated = new WeakSet<Db>();
}
