// A streamed zip must deliver every entry, also when entries come from chunked streams
// (on-disk files, R2, S3) and the stream is consumed over real HTTP.
import { expect, test } from "bun:test";
import { crc32 } from "../src/lib/crypto";
import { readZipDirectory, zipSize, zipStream, type StreamEntry } from "../src/lib/zip";

function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream({
    pull(c) {
      if (off >= bytes.length) return c.close();
      c.enqueue(bytes.slice(off, off + size));
      off += size;
    },
  });
}

function entries(): StreamEntry[] {
  return [1, 2, 3].map((n) => {
    const bytes = new Uint8Array(5000 * n).map((_, i) => (i * n) % 251);
    return { name: `KO-1001_NVY_${n}.png`, size: bytes.length, crc: crc32(bytes), offset: 0, open: async () => chunked(bytes, 1024) };
  });
}

test("streamed zip over HTTP contains all entries", async () => {
  const list = entries();
  const server = Bun.serve({ port: 0, fetch: () => new Response(zipStream(entries())) });
  try {
    const res = await fetch(`http://localhost:${server.port}/`, { signal: AbortSignal.timeout(10_000) });
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBe(zipSize(list));
    const dir = await readZipDirectory(async (o, l) => buf.slice(o, o + l), buf.length);
    expect(dir.map((e) => e.name)).toEqual(list.map((e) => e.name));
    expect(dir.map((e) => e.crc)).toEqual(list.map((e) => e.crc));
  } finally {
    server.stop(true);
  }
});
