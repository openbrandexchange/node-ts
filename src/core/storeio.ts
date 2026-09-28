// Streaming helpers on top of BlobStore: unknown-length streams into fixed-size multipart parts.
import type { Ctx } from "./ctx";
import { ObxError } from "../lib/problem";
import { sha256Hasher } from "../lib/crypto";
import { PART_BYTES } from "./blobs";
import type { RangeReader } from "../lib/zip";

/** Writes a stream of unknown length to `key` (bounded memory), returning size and sha256. */
export async function streamToStore(ctx: Ctx, key: string, stream: ReadableStream<Uint8Array>, maxBytes: number, contentType?: string): Promise<{ size: number; sha256: string }> {
  const reader = stream.getReader();
  const hasher = sha256Hasher();
  let buf = new Uint8Array(PART_BYTES);
  let fill = 0;
  let total = 0;
  let mp: Awaited<ReturnType<typeof ctx.blobs.createMultipart>> | null = null;
  const parts: { partNumber: number; etag: string }[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new ObxError("payload_too_large", `The file is larger than ${Math.floor(maxBytes / 1048576)} MB.`);
      hasher.update(value);
      let off = 0;
      while (off < value.length) {
        const n = Math.min(value.length - off, PART_BYTES - fill);
        buf.set(value.subarray(off, off + n), fill);
        fill += n;
        off += n;
        if (fill === PART_BYTES) {
          mp ??= await ctx.blobs.createMultipart(key, contentType);
          parts.push(await ctx.blobs.uploadPart(mp, parts.length + 1, buf));
          buf = new Uint8Array(PART_BYTES);
          fill = 0;
        }
      }
    }
    if (!mp) {
      await ctx.blobs.put(key, buf.slice(0, fill), contentType);
    } else {
      if (fill > 0) parts.push(await ctx.blobs.uploadPart(mp, parts.length + 1, buf.slice(0, fill)));
      await ctx.blobs.completeMultipart(mp, parts);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    if (mp) await ctx.blobs.abortMultipart(mp).catch(() => {});
    throw e;
  }
  return { size: total, sha256: hasher.hex() };
}

export function storeReader(ctx: Ctx, key: string, base = 0): RangeReader {
  return async (offset, length) => {
    if (length <= 0) return new Uint8Array(0);
    const b = await ctx.blobs.getRange(key, base + offset, length);
    if (!b) throw new ObxError("internal_error", "A stored import file disappeared.");
    return b;
  };
}

export async function readText(ctx: Ctx, key: string, offset: number, length: number, max = 64 * 1048576): Promise<string> {
  if (length > max) throw new ObxError("payload_too_large", `CSV files may be at most ${Math.floor(max / 1048576)} MB.`);
  const b = await ctx.blobs.getRange(key, offset, length);
  if (!b) throw new ObxError("internal_error", "A stored import file disappeared.");
  return new TextDecoder().decode(b);
}
