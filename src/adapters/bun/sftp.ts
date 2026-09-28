// SFTP for scheduled imports (Bun/Docker edition only). ssh2-sftp-client is an optional dependency.
import type { SftpClient, SftpConfig } from "../../platform";
import { createHash } from "node:crypto";

async function connect(cfg: SftpConfig) {
  let Client: new () => {
    connect(o: unknown): Promise<unknown>;
    list(p: string): Promise<{ name: string; type: string; size: number; modifyTime: number }[]>;
    get(p: string): Promise<Buffer>;
    end(): Promise<unknown>;
  };
  try {
    Client = (await import("ssh2-sftp-client")).default as never;
  } catch {
    throw new Error("SFTP support is not installed (optional dependency ssh2-sftp-client).");
  }
  const c = new Client();
  let seen: string | null = null;
  await c.connect({
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    password: cfg.password ?? undefined,
    privateKey: cfg.privateKey ?? undefined,
    readyTimeout: 15000,
    hostVerifier: (key: Buffer) => {
      seen = "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
      return !cfg.hostKeyFingerprint || cfg.hostKeyFingerprint === seen;
    },
  });
  return { c, seen: () => seen };
}

export const bunSftp: SftpClient = {
  async list(cfg, root) {
    const { c, seen } = await connect(cfg);
    const files: { path: string; size: number; modifiedAt: string | null }[] = [];
    try {
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
    } finally {
      await c.end().catch(() => {});
    }
    return { files, hostKeyFingerprint: seen() };
  },
  async read(cfg, path) {
    const { c } = await connect(cfg);
    try {
      return new Uint8Array(await c.get(path));
    } finally {
      await c.end().catch(() => {});
    }
  },
};
