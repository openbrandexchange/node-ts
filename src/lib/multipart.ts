// multipart/form-data parsing by offsets over stored bytes, so large uploads never sit in memory.
import { utf8, fromUtf8 } from "./util";
import type { RangeReader } from "./zip";

export interface FormPart {
  name: string;
  filename: string | null;
  contentType: string | null;
  offset: number;
  length: number;
}

export function boundaryOf(contentType: string | null | undefined): string | null {
  if (!contentType || !/^multipart\/form-data/i.test(contentType)) return null;
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  return m ? (m[1] ?? m[2]) : null;
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0];
  let i = hay.indexOf(first, from);
  while (i >= 0 && i + needle.length <= hay.length) {
    let ok = true;
    for (let j = 1; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
    i = hay.indexOf(first, i + 1);
  }
  return -1;
}

function parseDisposition(h: string): { name: string | null; filename: string | null } {
  const name = h.match(/;\s*name="((?:[^"\\]|\\.)*)"/i)?.[1] ?? h.match(/;\s*name=([^;\s]+)/i)?.[1] ?? null;
  let filename = h.match(/;\s*filename="((?:[^"\\]|\\.)*)"/i)?.[1] ?? h.match(/;\s*filename=([^;\s]+)/i)?.[1] ?? null;
  const star = h.match(/;\s*filename\*=UTF-8''([^;\s]+)/i)?.[1];
  if (star) {
    try {
      filename = decodeURIComponent(star);
    } catch {
      /* keep plain filename */
    }
  }
  return { name, filename };
}

/** Finds all parts. Throws on malformed input. */
export async function scanMultipart(read: RangeReader, total: number, boundary: string): Promise<FormPart[]> {
  const delim = utf8("\r\n--" + boundary);
  const chunk = 1 << 20;
  const positions: number[] = [];
  // The first delimiter may start at 0 without the leading CRLF.
  const head = await read(0, Math.min(total, delim.length + 2));
  const firstDelim = utf8("--" + boundary);
  let firstAt = -1;
  if (indexOfBytes(head, firstDelim, 0) === 0) firstAt = 0;
  for (let off = 0; off < total; off += chunk) {
    const len = Math.min(chunk + delim.length, total - off);
    const buf = await read(off, len);
    let i = indexOfBytes(buf, delim, 0);
    while (i >= 0) {
      if (i < chunk || off + chunk >= total) {
        const abs = off + i;
        if (!positions.includes(abs)) positions.push(abs);
      }
      i = indexOfBytes(buf, delim, i + 1);
    }
  }
  const starts: number[] = [];
  if (firstAt === 0) starts.push(firstDelim.length);
  for (const p of positions) starts.push(p + delim.length);
  const parts: FormPart[] = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const after = await read(s, Math.min(2, total - s));
    if (after[0] === 0x2d && after[1] === 0x2d) break; // closing "--"
    const hdrStart = s + 2; // CRLF after the delimiter
    const end = k + 1 < starts.length ? (firstAt === 0 ? positions[k] : positions[k + 1]) : -1;
    if (end === undefined || end < 0) throw new Error("unterminated multipart body");
    const hdrBuf = await read(hdrStart, Math.min(16384, end - hdrStart));
    const hdrEnd = indexOfBytes(hdrBuf, utf8("\r\n\r\n"), 0);
    if (hdrEnd < 0) throw new Error("malformed multipart headers");
    const headers = fromUtf8(hdrBuf.subarray(0, hdrEnd)).split("\r\n");
    let disp = "";
    let ctype: string | null = null;
    for (const h of headers) {
      const [k2, ...v] = h.split(":");
      const key = k2.trim().toLowerCase();
      if (key === "content-disposition") disp = v.join(":").trim();
      if (key === "content-type") ctype = v.join(":").trim();
    }
    const { name, filename } = parseDisposition(disp);
    if (!name) throw new Error("multipart part without a name");
    const dataStart = hdrStart + hdrEnd + 4;
    parts.push({ name, filename, contentType: ctype, offset: dataStart, length: end - dataStart });
  }
  return parts;
}

export function bytesReader(b: Uint8Array): RangeReader {
  return async (o, l) => b.subarray(o, Math.min(b.length, o + l));
}
