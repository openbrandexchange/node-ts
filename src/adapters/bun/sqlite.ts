// bun:sqlite implementation of Db.
import { Database } from "bun:sqlite";
import type { Db, SqlValue, Stmt } from "../../platform";

export function sqliteDb(path: string): Db & { raw: Database } {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = OFF;");
  const cache = new Map<string, ReturnType<Database["query"]>>();
  const q = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.query(sql);
      if (cache.size > 500) cache.clear();
      cache.set(sql, s);
    }
    return s;
  };
  const args = (p?: SqlValue[]) => (p ?? []).map((v) => (v === undefined ? null : v)) as never[];
  const tx = db.transaction((stmts: Stmt[]) => stmts.map((s) => ({ changes: q(s.sql).run(...args(s.params)).changes })));
  return {
    raw: db,
    async all<T>(sql: string, params?: SqlValue[]) {
      return q(sql).all(...args(params)) as T[];
    },
    async first<T>(sql: string, params?: SqlValue[]) {
      return (q(sql).get(...args(params)) as T | null) ?? null;
    },
    async run(sql: string, params?: SqlValue[]) {
      return { changes: q(sql).run(...args(params)).changes };
    },
    async batch(stmts: Stmt[]) {
      return tx(stmts);
    },
  };
}
