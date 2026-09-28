// Minimal ZIP support.
// Writer: "stored" entries (images are already compressed) with sizes and CRC-32 known up front,
// ZIP64 when offsets/sizes/counts need it, UTF-8 names. Reader: central directory via range reads,
// stored and deflate entries, with zip-slip and zip-bomb protection.

import { utf8, fromUtf8 } from "./util";

const MAX32 = 0xffffffff;

export interface ZipEntryInfo {
  name: string;
  size: number;
  crc: number;
  /** Offset of the local header in the archive (set by the writer). */
  offset?: number;
  mtime?: number;
}

function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

class Buf {
  private b: number[] = [];
  u16(v: number) {
    this.b.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v: number) {
    this.b.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  u64(v: number) {
    this.u32(v % 0x100000000);
    this.u32(Math.floor(v / 0x100000000));
    return this;
  }
  bytes(a: Uint8Array) {
    for (let i = 0; i < a.length; i++) this.b.push(a[i]);
    return this;
  }
  out(): Uint8Array {
    return new Uint8Array(this.b);
  }
}

export function localHeader(e: ZipEntryInfo): Uint8Array {
  const name = utf8(e.name);
  const big = e.size >= MAX32;
  const { time, date } = dosDateTime(e.mtime ?? Date.UTC(2026, 0, 1));
  const b = new Buf()
    .u32(0x04034b50)
    .u16(big ? 45 : 20)
    .u16(0x0800)
    .u16(0)
    .u16(time)
    .u16(date)
    .u32(e.crc >>> 0)
    .u32(big ? MAX32 : e.size)
    .u32(big ? MAX32 : e.size)
    .u16(name.length)
    .u16(big ? 20 : 0)
    .bytes(name);
  if (big) b.u16(0x0001).u16(16).u64(e.size).u64(e.size);
  return b.out();
}

export function localHeaderLength(e: ZipEntryInfo): number {
  return 30 + utf8(e.name).length + (e.size >= MAX32 ? 20 : 0);
}

export function centralHeader(e: ZipEntryInfo): Uint8Array {
  const name = utf8(e.name);
  const offset = e.offset ?? 0;
  const bigSize = e.size >= MAX32;
  const bigOff = offset >= MAX32;
  const extra = new Buf();
  if (bigSize) extra.u64(e.size).u64(e.size);
  if (bigOff) extra.u64(offset);
  const extraBody = extra.out();
  const extraAll = extraBody.length ? new Buf().u16(0x0001).u16(extraBody.length).bytes(extraBody).out() : new Uint8Array(0);
  const zip64 = bigSize || bigOff;
  const { time, date } = dosDateTime(e.mtime ?? Date.UTC(2026, 0, 1));
  return new Buf()
    .u32(0x02014b50)
    .u16((3 << 8) | (zip64 ? 45 : 20))
    .u16(zip64 ? 45 : 20)
    .u16(0x0800)
    .u16(0)
    .u16(time)
    .u16(date)
    .u32(e.crc >>> 0)
    .u32(bigSize ? MAX32 : e.size)
    .u32(bigSize ? MAX32 : e.size)
    .u16(name.length)
    .u16(extraAll.length)
    .u16(0)
    .u16(0)
    .u16(0)
    .u32((0o100644 << 16) >>> 0)
    .u32(bigOff ? MAX32 : offset)
    .bytes(name)
    .bytes(extraAll)
    .out();
}

export function endRecords(count: number, cdOffset: number, cdSize: number): Uint8Array {
  const need64 = count >= 0xffff || cdOffset >= MAX32 || cdSize >= MAX32;
  const b = new Buf();
  if (need64) {
    const eocd64Offset = cdOffset + cdSize;
    b.u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0).u64(count).u64(count).u64(cdSize).u64(cdOffset);
    b.u32(0x07064b50).u32(0).u64(eocd64Offset).u32(1);
  }
  b.u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(need64 ? 0xffff : count)
    .u16(need64 ? 0xffff : count)
    .u32(cdSize >= MAX32 ? MAX32 : cdSize)
    .u32(cdOffset >= MAX32 ? MAX32 : cdOffset)
    .u16(0);
  return b.out();
}

/** Makes names unique within one archive: "a.jpg", "a (2).jpg", … */
export function uniqueNamer() {
  const used = new Set<string>();
  return (name: string): string => {
    let n = name;
    let i = 2;
    while (used.has(n.toLowerCase())) {
      const dot = name.lastIndexOf(".");
      const slash = name.lastIndexOf("/");
      n = dot > slash + 0 && dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
      i++;
    }
    used.add(n.toLowerCase());
    return n;
  };
}

export interface StreamEntry extends ZipEntryInfo {
  open(): Promise<ReadableStream<Uint8Array> | Uint8Array>;
}

/** Total archive size for the given entries (lets downloads send Content-Length). */
export function zipSize(entries: ZipEntryInfo[]): number {
  let off = 0;
  const withOff = entries.map((e) => {
    const x = { ...e, offset: off };
    off += localHeaderLength(e) + e.size;
    return x;
  });
  let cd = 0;
  for (const e of withOff) cd += centralHeader(e).length;
  return off + cd + endRecords(entries.length, off, cd).length;
}

/** A streaming zip of stored entries. Missing bytes are an error (the size is promised up front). */
export function zipStream(entries: StreamEntry[]): ReadableStream<Uint8Array> {
  let i = 0;
  let offset = 0;
  const written: ZipEntryInfo[] = [];
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let remaining = 0;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (finished) return;
      if (reader) {
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          if (remaining !== 0) {
            ctrl.error(new Error("zip entry shorter than declared"));
            return;
          }
          return;
        }
        remaining -= value.length;
        ctrl.enqueue(value);
        return;
      }
      if (i < entries.length) {
        const e = entries[i++];
        const hdr = localHeader(e);
        written.push({ ...e, offset });
        offset += hdr.length + e.size;
        ctrl.enqueue(hdr);
        const body = await e.open();
        if (body instanceof Uint8Array) {
          if (body.length !== e.size) {
            ctrl.error(new Error("zip entry size mismatch"));
            return;
          }
          if (body.length) ctrl.enqueue(body);
        } else {
          reader = body.getReader();
          remaining = e.size;
        }
        return;
      }
      const parts: Uint8Array[] = written.map(centralHeader);
      const cdSize = parts.reduce((a, p) => a + p.length, 0);
      for (const p of parts) ctrl.enqueue(p);
      ctrl.enqueue(endRecords(written.length, offset, cdSize));
      finished = true;
      ctrl.close();
    },
    cancel() {
      reader?.cancel().catch(() => {});
    },
  });
}

// ---------------------------------------------------------------- reader

export interface ZipReadEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  localOffset: number;
  isDir: boolean;
  isSymlink: boolean;
  encrypted: boolean;
}

export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u64 = (v: DataView, o: number) => v.getUint32(o, true) + v.getUint32(o + 4, true) * 0x100000000;

export class ZipError extends Error {}

/** Parses the central directory. Throws ZipError when the file is not a readable zip. */
export async function readZipDirectory(read: RangeReader, total: number, maxEntries = 100_000): Promise<ZipReadEntry[]> {
  if (total < 22) throw new ZipError("not a zip file");
  const tailLen = Math.min(total, 65557);
  const tail = await read(total - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip file (no end of central directory)");
  const v = dv(tail);
  let count = v.getUint16(eocd + 10, true);
  let cdSize = v.getUint32(eocd + 12, true);
  let cdOffset = v.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === MAX32 || cdOffset === MAX32) {
    const loc = eocd - 20;
    if (loc < 0 || v.getUint32(loc, true) !== 0x07064b50) throw new ZipError("broken zip64 locator");
    const e64off = u64(v, loc + 8);
    const e64 = dv(await read(e64off, 56));
    if (e64.getUint32(0, true) !== 0x06064b50) throw new ZipError("broken zip64 record");
    count = u64(e64, 32);
    cdSize = u64(e64, 40);
    cdOffset = u64(e64, 48);
  }
  if (count > maxEntries) throw new ZipError(`too many entries (${count} > ${maxEntries})`);
  if (cdOffset + cdSize > total) throw new ZipError("central directory out of range");
  const cd = await read(cdOffset, cdSize);
  const c = dv(cd);
  const out: ZipReadEntry[] = [];
  let o = 0;
  for (let n = 0; n < count; n++) {
    if (o + 46 > cd.length || c.getUint32(o, true) !== 0x02014b50) throw new ZipError("broken central directory");
    const flags = c.getUint16(o + 8, true);
    const method = c.getUint16(o + 10, true);
    const crc = c.getUint32(o + 16, true);
    let csize = c.getUint32(o + 20, true);
    let usize = c.getUint32(o + 24, true);
    const nameLen = c.getUint16(o + 28, true);
    const extraLen = c.getUint16(o + 30, true);
    const commentLen = c.getUint16(o + 32, true);
    const madeBy = c.getUint16(o + 4, true) >> 8;
    const ext = c.getUint32(o + 38, true);
    let local = c.getUint32(o + 42, true);
    const nameBytes = cd.subarray(o + 46, o + 46 + nameLen);
    const name = flags & 0x0800 ? fromUtf8(nameBytes) : Array.from(nameBytes, (x) => String.fromCharCode(x)).join("");
    let eo = o + 46 + nameLen;
    const eend = eo + extraLen;
    while (eo + 4 <= eend) {
      const id = c.getUint16(eo, true);
      const sz = c.getUint16(eo + 2, true);
      if (id === 0x0001) {
        let p = eo + 4;
        if (usize === MAX32) {
          usize = u64(c, p);
          p += 8;
        }
        if (csize === MAX32) {
          csize = u64(c, p);
          p += 8;
        }
        if (local === MAX32) local = u64(c, p);
      }
      eo += 4 + sz;
    }
    const unixMode = madeBy === 3 ? (ext >>> 16) & 0o170000 : 0;
    out.push({
      name,
      method,
      compressedSize: csize,
      size: usize,
      crc,
      localOffset: local,
      isDir: name.endsWith("/"),
      isSymlink: unixMode === 0o120000,
      encrypted: (flags & 1) === 1,
    });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Zip-slip check (security.md §6). Returns null when safe, else the reason. */
export function unsafeEntryReason(e: ZipReadEntry): string | null {
  const n = e.name.replace(/\\/g, "/");
  if (e.isSymlink) return "symbolic links are not allowed";
  if (n.startsWith("/")) return "absolute paths are not allowed";
  if (/^[a-zA-Z]:/.test(n)) return "drive letters are not allowed";
  const segs = n.split("/");
  if (segs.some((s) => s === "..")) return '".." path segments are not allowed';
  if (segs.some((s) => /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(s))) return "device names are not allowed";
  if (/[\x00-\x1f]/.test(n)) return "control characters are not allowed";
  return null;
}

/** Entries the import ignores (import-format.md §3). */
export function ignoredEntry(name: string): boolean {
  const n = name.replace(/\\/g, "/");
  if (n.startsWith("__MACOSX/") || n.includes("/__MACOSX/")) return true;
  const base = n.split("/").pop() ?? "";
  return base === "" || base.startsWith(".") || base === "Thumbs.db" || base === "desktop.ini";
}

export async function readZipEntry(read: RangeReader, e: ZipReadEntry, maxBytes: number): Promise<Uint8Array> {
  if (e.encrypted) throw new ZipError("encrypted entries are not supported");
  if (e.size > maxBytes || e.compressedSize > maxBytes) throw new ZipError("entry too large");
  const lh = dv(await read(e.localOffset, 30));
  if (lh.getUint32(0, true) !== 0x04034b50) throw new ZipError("broken local header");
  const dataStart = e.localOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  const raw = await read(dataStart, e.compressedSize);
  if (e.method === 0) return raw;
  if (e.method !== 8) throw new ZipError(`compression method ${e.method} is not supported`);
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(ds);
  const r = stream.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    got += value.length;
    if (got > e.size || got > maxBytes) {
      await r.cancel();
      throw new ZipError("entry larger than declared (zip bomb?)");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(got);
  let p = 0;
  for (const ch of chunks) {
    out.set(ch, p);
    p += ch.length;
  }
  return out;
}

/** Build a zip in memory (small archives, tests). Entries are stored. */
export async function zipBytes(files: { name: string; data: Uint8Array }[], crc: (b: Uint8Array) => number): Promise<Uint8Array> {
  const s = zipStream(files.map((f) => ({ name: f.name, size: f.data.length, crc: crc(f.data), open: async () => f.data })));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
