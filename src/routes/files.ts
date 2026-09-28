// Serving stored bytes with Range, ETag and safe Content-Disposition.
import type { Ctx } from "../core/ctx";
import { ObxError } from "../lib/problem";
import { contentDisposition } from "../lib/util";

export interface ServeOptions {
  key: string;
  size: number;
  contentType: string;
  filename: string;
  disposition: "inline" | "attachment";
  sha256?: string | null;
  cacheControl?: string;
  extraHeaders?: Record<string, string>;
}

function parseRange(h: string | null | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!h) return null;
  const m = h.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null; // multiple or malformed ranges: serve the whole file
  let start: number;
  let end: number;
  if (m[1] === "" && m[2] === "") return null;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

export async function serveStored(ctx: Ctx, req: Request, o: ServeOptions): Promise<Response> {
  const etag = o.sha256 ? `"${o.sha256}"` : null;
  const base: Record<string, string> = {
    "content-type": o.contentType,
    "accept-ranges": "bytes",
    "content-disposition": contentDisposition(o.disposition, o.filename),
    "cache-control": o.cacheControl ?? "private, max-age=3600",
    "x-content-type-options": "nosniff",
    ...(etag ? { etag, "obx-content-sha256": o.sha256! } : {}),
    ...(o.extraHeaders ?? {}),
  };
  const inm = req.headers.get("if-none-match");
  if (etag && inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag || t.trim() === "*")) {
    return new Response(null, { status: 304, headers: base });
  }
  const range = parseRange(req.headers.get("range"), o.size);
  const ifRange = req.headers.get("if-range");
  const useRange = range && (!ifRange || ifRange === etag);
  if (range === "invalid") return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${o.size}` } });
  if (useRange && range) {
    const len = range.end - range.start + 1;
    const body = await ctx.blobs.get(o.key, { offset: range.start, length: len });
    if (!body) throw new ObxError("not_found", "The file is not available.");
    return new Response(body, { status: 206, headers: { ...base, "content-length": String(len), "content-range": `bytes ${range.start}-${range.end}/${o.size}` } });
  }
  const body = await ctx.blobs.get(o.key);
  if (!body) throw new ObxError("not_found", "The file is not available.");
  return new Response(req.method === "HEAD" ? null : body, { status: 200, headers: { ...base, "content-length": String(o.size) } });
}
