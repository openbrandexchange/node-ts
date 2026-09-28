// Local-disk BlobStore (Bun). Keys map to files under a root directory; multipart parts are staged files.
import { mkdir, readdir, rename, rm, stat, open } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { BlobStore, MultipartHandle, UploadedPart } from "../../platform";
import { b64url, randomBytes } from "../../lib/util";

function safeKey(root: string, key: string): string {
  if (!key || key.includes("\0") || key.split("/").some((s) => s === ".." || s === "")) throw new Error("invalid storage key");
  const p = join(root, ...key.split("/"));
  if (!p.startsWith(root + sep)) throw new Error("invalid storage key");
  return p;
}

export function diskStore(root: string): BlobStore {
  const mp = join(root, ".multipart");
  return {
    async put(key, data) {
      const p = safeKey(root, key);
      await mkdir(dirname(p), { recursive: true });
      const tmp = `${p}.${b64url(randomBytes(6))}.tmp`;
      await Bun.write(tmp, data);
      await rename(tmp, p);
    },
    async get(key, range) {
      const f = Bun.file(safeKey(root, key));
      if (!(await f.exists())) return null;
      return (range ? f.slice(range.offset, range.offset + range.length) : f).stream() as ReadableStream<Uint8Array>;
    },
    async getRange(key, offset, length) {
      const f = Bun.file(safeKey(root, key));
      if (!(await f.exists())) return null;
      return new Uint8Array(await f.slice(offset, offset + length).arrayBuffer());
    },
    async head(key) {
      try {
        const s = await stat(safeKey(root, key));
        return { size: s.size };
      } catch {
        return null;
      }
    },
    async delete(keys) {
      for (const k of keys) await rm(safeKey(root, k), { force: true });
    },
    async list(prefix, cursor) {
      const out: string[] = [];
      const walk = async (dir: string) => {
        let ents;
        try {
          ents = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of ents) {
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            if (full !== mp) await walk(full);
          } else if (!e.name.endsWith(".tmp")) {
            const k = relative(root, full).split(sep).join("/");
            if (k.startsWith(prefix)) out.push(k);
          }
        }
      };
      const base = prefix.includes("/") ? join(root, ...prefix.split("/").slice(0, -1)) : root;
      await walk(base);
      out.sort();
      const start = cursor ? out.findIndex((k) => k > cursor) : 0;
      const page = start < 0 ? [] : out.slice(start, start + 1000);
      return { keys: page, cursor: start >= 0 && start + 1000 < out.length ? page[page.length - 1] : null };
    },
    async createMultipart(key) {
      safeKey(root, key);
      const uploadId = b64url(randomBytes(12));
      await mkdir(join(mp, uploadId), { recursive: true });
      return { key, uploadId };
    },
    async uploadPart(h: MultipartHandle, n: number, data: Uint8Array): Promise<UploadedPart> {
      if (!/^[A-Za-z0-9_-]+$/.test(h.uploadId)) throw new Error("bad upload id");
      await Bun.write(join(mp, h.uploadId, String(n)), data);
      return { partNumber: n, etag: String(n) };
    },
    async completeMultipart(h, parts) {
      const p = safeKey(root, h.key);
      await mkdir(dirname(p), { recursive: true });
      const tmp = `${p}.${b64url(randomBytes(6))}.tmp`;
      const fh = await open(tmp, "w");
      try {
        for (const part of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
          const data = new Uint8Array(await Bun.file(join(mp, h.uploadId, String(part.partNumber))).arrayBuffer());
          await fh.write(data);
        }
      } finally {
        await fh.close();
      }
      await rename(tmp, p);
      await rm(join(mp, h.uploadId), { recursive: true, force: true });
    },
    async abortMultipart(h) {
      if (/^[A-Za-z0-9_-]+$/.test(h.uploadId)) await rm(join(mp, h.uploadId), { recursive: true, force: true });
    },
  };
}
