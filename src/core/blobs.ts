// Content-addressed file storage: every image byte lives once under its sha256.
import type { Ctx } from "./ctx";
import { ObxError } from "../lib/problem";
import { crc32, crc32Update, sha256Hex, sha256Hasher } from "../lib/crypto";
import { ACCEPTED_TYPES, imageSize, sniffType } from "../lib/image";
import type { FileRef } from "./reps";
import { newId } from "../lib/util";

export const blobKey = (sha: string) => `blobs/${sha.slice(0, 2)}/${sha}`;

export interface BlobRow {
  sha256: string;
  bytes: number;
  content_type: string;
  width: number | null;
  height: number | null;
  crc32: number;
  created_at: string;
}

export function blobJson(r: BlobRow, created: boolean) {
  return { sha256: r.sha256, bytes: r.bytes, content_type: r.content_type, width: r.width, height: r.height, created };
}

export function fileRef(r: BlobRow): FileRef {
  return { sha256: r.sha256, bytes: r.bytes, content_type: r.content_type, width: r.width, height: r.height, crc32: r.crc32 };
}

export async function getBlob(ctx: Ctx, sha: string): Promise<BlobRow | null> {
  return ctx.db.first<BlobRow>("SELECT * FROM blobs WHERE sha256 = ?", [sha]);
}

/** Reads a request body up to `max` bytes (413 above). */
export async function readBody(req: Request, max: number): Promise<Uint8Array> {
  const len = req.headers.get("content-length");
  if (len && Number(len) > max) throw new ObxError("payload_too_large", `This file is larger than the limit of ${Math.floor(max / 1048576)} MB. Use a resumable upload (/uploads) for large files.`);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new ObxError("payload_too_large", `This file is larger than the limit of ${Math.floor(max / 1048576)} MB.`);
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Stores image bytes (dedupe by sha256). Verifies a declared sha and the image signature. */
export async function storeBlob(ctx: Ctx, bytes: Uint8Array, declaredSha?: string | null): Promise<{ row: BlobRow; created: boolean }> {
  if (!bytes.length) throw new ObxError("invalid_request", "The body is empty.");
  const sha = await sha256Hex(bytes);
  if (declaredSha && declaredSha.toLowerCase() !== sha) throw new ObxError("checksum_mismatch", "The uploaded bytes do not match the declared sha256.");
  const existing = await getBlob(ctx, sha);
  if (existing) return { row: existing, created: false };
  const type = sniffType(bytes);
  if (!type) throw new ObxError("unsupported_media_type", `Only ${ACCEPTED_TYPES.join(", ")} images are accepted (checked by file signature).`);
  const dims = imageSize(bytes, type);
  if (!dims || dims.width < 1 || dims.height < 1) throw new ObxError("unsupported_media_type", "The image header could not be read.");
  if (dims.width * dims.height > 250_000_000) throw new ObxError("validation_failed", "The image has too many pixels (over 250 megapixels).");
  const row: BlobRow = { sha256: sha, bytes: bytes.length, content_type: type, width: dims.width, height: dims.height, crc32: crc32(bytes), created_at: ctx.iso() };
  await ctx.blobs.put(blobKey(sha), bytes, type);
  await ctx.db.run("INSERT OR IGNORE INTO blobs (sha256, bytes, content_type, width, height, crc32, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    row.sha256,
    row.bytes,
    row.content_type,
    row.width,
    row.height,
    row.crc32,
    row.created_at,
  ]);
  return { row, created: true };
}

// ------------------------------------------------------------------ resumable multipart uploads

export const PART_BYTES = 8 * 1024 * 1024;
export const MAX_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;

export interface UploadRow {
  id: string;
  owner: string;
  sha256: string;
  bytes: number;
  content_type: string;
  part_bytes: number;
  parts_total: number;
  received: string;
  status: string;
  expires_at: string;
}

export function uploadJson(u: UploadRow) {
  const expired = u.status === "open" && Date.parse(u.expires_at) < Date.now();
  return {
    id: u.id,
    sha256: u.sha256,
    bytes: u.bytes,
    content_type: u.content_type,
    part_bytes: u.part_bytes,
    parts_total: u.parts_total,
    received_parts: (JSON.parse(u.received) as number[]).sort((a, b) => a - b),
    status: expired ? "expired" : u.status,
    expires_at: u.expires_at,
  };
}

export async function createUpload(ctx: Ctx, owner: string, body: { sha256?: unknown; bytes?: unknown; content_type?: unknown }) {
  const sha = typeof body.sha256 === "string" ? body.sha256.toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new ObxError("validation_failed", "sha256 must be 64 lowercase hex characters.");
  if (typeof body.bytes !== "number" || !Number.isInteger(body.bytes) || body.bytes < 1) throw new ObxError("validation_failed", "bytes must be a positive whole number.");
  if (body.bytes > MAX_OBJECT_BYTES) throw new ObxError("payload_too_large", "This file is larger than the node accepts.");
  const ct = typeof body.content_type === "string" ? body.content_type.toLowerCase() : "";
  if (!(ACCEPTED_TYPES as readonly string[]).includes(ct)) throw new ObxError("unsupported_media_type", `Accepted: ${ACCEPTED_TYPES.join(", ")}.`);
  const existing = await getBlob(ctx, sha);
  if (existing) return { blob: existing };
  const u: UploadRow = {
    id: newId("upl"),
    owner,
    sha256: sha,
    bytes: body.bytes,
    content_type: ct,
    part_bytes: PART_BYTES,
    parts_total: Math.max(1, Math.ceil(body.bytes / PART_BYTES)),
    received: "[]",
    status: "open",
    expires_at: ctx.iso(24 * 3600 * 1000),
  };
  await ctx.db.run("INSERT INTO uploads (id, owner, sha256, bytes, content_type, part_bytes, parts_total, received, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    u.id,
    u.owner,
    u.sha256,
    u.bytes,
    u.content_type,
    u.part_bytes,
    u.parts_total,
    u.received,
    u.status,
    u.expires_at,
  ]);
  return { upload: u };
}

export async function getUpload(ctx: Ctx, owner: string, id: string): Promise<UploadRow> {
  const u = await ctx.db.first<UploadRow>("SELECT * FROM uploads WHERE id = ? AND owner = ?", [id, owner]);
  if (!u) throw new ObxError("not_found", "Unknown upload.");
  return u;
}

export async function putUploadPart(ctx: Ctx, u: UploadRow, n: number, data: Uint8Array) {
  if (u.status !== "open" || Date.parse(u.expires_at) < ctx.now()) throw new ObxError("conflict", "This upload is no longer open.");
  if (!Number.isInteger(n) || n < 1 || n > u.parts_total) throw new ObxError("validation_failed", `Part numbers run from 1 to ${u.parts_total}.`);
  const expected = n < u.parts_total ? u.part_bytes : u.bytes - u.part_bytes * (u.parts_total - 1);
  if (data.length !== expected) throw new ObxError("validation_failed", `Part ${n} must be exactly ${expected} bytes.`);
  await ctx.blobs.put(`uploads/${u.id}/${n}`, data);
  const received = new Set(JSON.parse(u.received) as number[]);
  received.add(n);
  u.received = JSON.stringify([...received]);
  await ctx.db.run("UPDATE uploads SET received = ? WHERE id = ?", [u.received, u.id]);
  return u;
}

/** Assembles parts into a blob, verifying size and sha256. */
export async function completeUpload(ctx: Ctx, u: UploadRow): Promise<{ row: BlobRow; created: boolean }> {
  const existing = await getBlob(ctx, u.sha256);
  if (existing) {
    await ctx.db.run("UPDATE uploads SET status = 'completed' WHERE id = ?", [u.id]);
    return { row: existing, created: false };
  }
  if (u.status !== "open") throw new ObxError("conflict", "This upload is no longer open.");
  const received = new Set(JSON.parse(u.received) as number[]);
  const missing: number[] = [];
  for (let i = 1; i <= u.parts_total; i++) if (!received.has(i)) missing.push(i);
  if (missing.length) throw new ObxError("upload_incomplete", `Missing parts: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? "…" : ""}.`);
  const hasher = sha256Hasher();
  let crc = 0;
  let head: Uint8Array | null = null;
  const key = blobKey(u.sha256);
  const mp = await ctx.blobs.createMultipart(key, u.content_type);
  const parts = [];
  try {
    for (let i = 1; i <= u.parts_total; i++) {
      const stream = await ctx.blobs.get(`uploads/${u.id}/${i}`);
      if (!stream) throw new ObxError("upload_incomplete", `Part ${i} is missing.`);
      const data = new Uint8Array(await new Response(stream).arrayBuffer());
      if (!head) head = data.subarray(0, Math.min(data.length, 256 * 1024)).slice();
      hasher.update(data);
      crc = crc32Update(crc, data);
      parts.push(await ctx.blobs.uploadPart(mp, i, data));
    }
    const sha = hasher.hex();
    if (sha !== u.sha256) {
      await ctx.blobs.abortMultipart(mp);
      await ctx.db.run("UPDATE uploads SET status = 'aborted' WHERE id = ?", [u.id]);
      throw new ObxError("checksum_mismatch", "The assembled file does not match the declared sha256. The upload was aborted.");
    }
    const type = sniffType(head!);
    const dims = type ? imageSize(head!, type) : null;
    if (!type || !dims) {
      await ctx.blobs.abortMultipart(mp);
      throw new ObxError("unsupported_media_type", "The file is not a JPEG, PNG or WebP image.");
    }
    await ctx.blobs.completeMultipart(mp, parts);
    const row: BlobRow = { sha256: sha, bytes: u.bytes, content_type: type, width: dims.width, height: dims.height, crc32: crc, created_at: ctx.iso() };
    await ctx.db.batch([
      { sql: "INSERT OR IGNORE INTO blobs (sha256, bytes, content_type, width, height, crc32, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", params: [sha, row.bytes, type, dims.width, dims.height, crc, row.created_at] },
      { sql: "UPDATE uploads SET status = 'completed' WHERE id = ?", params: [u.id] },
    ]);
    const keys: string[] = [];
    for (let i = 1; i <= u.parts_total; i++) keys.push(`uploads/${u.id}/${i}`);
    await ctx.blobs.delete(keys);
    return { row, created: true };
  } catch (e) {
    if (!(e instanceof ObxError)) await ctx.blobs.abortMultipart(mp).catch(() => {});
    throw e;
  }
}

/** Copies an object in fixed-size parts (works on every store, bounded memory). */
export async function copyObject(ctx: Ctx, from: string, to: string, size: number) {
  if (size <= PART_BYTES) {
    const data = await ctx.blobs.getRange(from, 0, size);
    if (!data) throw new Error("copy source missing");
    await ctx.blobs.put(to, data);
    return;
  }
  const mp = await ctx.blobs.createMultipart(to);
  const parts = [];
  let n = 1;
  for (let off = 0; off < size; off += PART_BYTES) {
    const data = await ctx.blobs.getRange(from, off, Math.min(PART_BYTES, size - off));
    if (!data) throw new Error("copy source missing");
    parts.push(await ctx.blobs.uploadPart(mp, n++, data));
  }
  await ctx.blobs.completeMultipart(mp, parts);
}

export async function abortUpload(ctx: Ctx, u: UploadRow) {
  const keys: string[] = [];
  for (let i = 1; i <= u.parts_total; i++) keys.push(`uploads/${u.id}/${i}`);
  await ctx.blobs.delete(keys);
  await ctx.db.run("UPDATE uploads SET status = 'aborted' WHERE id = ?", [u.id]);
}

/** Removes blobs that no asset references and that are older than 24 hours. */
export async function gcBlobs(ctx: Ctx, limit = 200) {
  const cutoff = ctx.iso(-24 * 3600 * 1000);
  const after = (await ctx.meta("gc_blob_cursor")) ?? "";
  const rows = await ctx.db.all<{ sha256: string; created_at: string }>("SELECT sha256, created_at FROM blobs WHERE sha256 > ? ORDER BY sha256 LIMIT ?", [after, limit]);
  if (!rows.length) {
    await ctx.setMeta("gc_blob_cursor", "");
    return;
  }
  for (const r of rows) {
    if (r.created_at > cutoff) continue;
    const pat = `%"${r.sha256}"%`;
    const used = await ctx.db.first("SELECT 1 AS x FROM assets WHERE files LIKE ? OR staged LIKE ? LIMIT 1", [pat, pat]);
    if (used) continue;
    const logo = (await ctx.settings()).branding.logo_sha === r.sha256;
    if (logo) continue;
    await ctx.db.run("DELETE FROM blobs WHERE sha256 = ?", [r.sha256]);
    await ctx.blobs.delete([blobKey(r.sha256)]);
  }
  await ctx.setMeta("gc_blob_cursor", rows[rows.length - 1].sha256);
}
