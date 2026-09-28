// SFTP for scheduled imports (Bun/Docker edition only). ssh2-sftp-client is an optional dependency.
// Connections are reused for a short while, so importing a folder of images needs one SSH login.
import type { SftpClient, SftpConfig } from "../../platform";
import { createHash } from "node:crypto";

interface Conn {
  list(p: string): Promise<{ name: string; type: string; size: number; modifyTime: number }[]>;
  get(p: string): Promise<Buffer>;
  end(): Promise<unknown>;
}

const pool = new Map<string, { conn: Conn; seen: string | null; timer: ReturnType<typeof setTimeout> | null; busy: number }>();

async function open(cfg: SftpConfig) {
  let Client: new () => Conn & { connect(o: unknown): Promise<unknown> };
  try {
    Client = (await import("ssh2-sftp-client")).default as never;
  } catch {
    throw new Error("SFTP support is not installed (optional dependency ssh2-sftp-client).");
  }
  const c = new Client();
  let seen: string | null = null;
  let mismatch = false;
  try {
    await c.connect({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      password: cfg.password ?? undefined,
      privateKey: cfg.privateKey ?? undefined,
      readyTimeout: 15000,
      hostVerifier: (key: Buffer) => {
        seen = "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
        mismatch = !!cfg.hostKeyFingerprint && cfg.hostKeyFingerprint !== seen;
        return !mismatch;
      },
    });
  } catch (e) {
    if (mismatch) throw new Error(`The server's host key (${seen}) does not match the pinned key. If the server was replaced on purpose, clear the pinned key.`);
    throw e;
  }
  return { conn: c as Conn, seen };
}

async function withConn<T>(cfg: SftpConfig, f: (c: Conn) => Promise<T>): Promise<{ result: T; seen: string | null }> {
  const key = JSON.stringify([cfg.host, cfg.port, cfg.username, cfg.password ?? "", cfg.privateKey ?? "", cfg.hostKeyFingerprint ?? ""]);
  let e = pool.get(key);
  if (!e) {
    const o = await open(cfg);
    e = { conn: o.conn, seen: o.seen, timer: null, busy: 0 };
    pool.set(key, e);
  }
  if (e.timer) clearTimeout(e.timer);
  e.busy++;
  try {
    return { result: await f(e.conn), seen: e.seen };
  } catch (err) {
    pool.delete(key);
    await e.conn.end().catch(() => {});
    throw err;
  } finally {
    e.busy--;
    const entry = e;
    if (pool.get(key) === entry && entry.busy === 0)
      entry.timer = setTimeout(() => {
        pool.delete(key);
        entry.conn.end().catch(() => {});
      }, 30_000);
  }
}

export const bunSftp: SftpClient = {
  async list(cfg, root) {
    const { result, seen } = await withConn(cfg, async (c) => {
      const files: { path: string; size: number; modifiedAt: string | null }[] = [];
      const walk = async (dir: string, depth: number) => {
        if (depth > 6 || files.length > 100000) return;
        for (const e of await c.list(dir)) {
          if (e.name.startsWith(".")) continue;
          const p = `${dir.replace(/\/+$/, "")}/${e.name}`;
          if (e.type === "d") await walk(p, depth + 1);
          else if (e.type === "-") files.push({ path: p, size: e.size, modifiedAt: new Date(e.modifyTime).toISOString() });
        }
      };
      await walk(root, 0);
      return files;
    });
    return { files: result, hostKeyFingerprint: seen };
  },
  async read(cfg, path) {
    const { result } = await withConn(cfg, async (c) => new Uint8Array(await c.get(path)));
    return result;
  },
};
