// A resumable zip writer on object storage: entries are appended across job steps, bytes go out as
// equal-size multipart parts, the unfinished tail is parked in storage between steps.
import type { Ctx } from "./ctx";
import { PART_BYTES, blobKey } from "./blobs";
import { centralHeader, endRecords, localHeader, localHeaderLength, type ZipEntryInfo } from "../lib/zip";
import { jobItemStmt } from "./jobs";
import { sha256Hasher } from "../lib/crypto";
import type { UploadedPart } from "../platform";

export interface ZipWriterState {
  key: string;
  uploadId: string | null;
  parts: UploadedPart[];
  offset: number;
  entries: number;
  carryLen: number;
  /** sha256 state is not resumable across steps, so the archive hash is computed on completion. */
  done: boolean;
}

export function newZipState(key: string): ZipWriterState {
  return { key, uploadId: null, parts: [], offset: 0, entries: 0, carryLen: 0, done: false };
}

export class ZipWriter {
  private buf: Uint8Array;
  private fill = 0;
  constructor(
    private ctx: Ctx,
    private jobId: string,
    public st: ZipWriterState,
    private cdKind: string,
  ) {
    this.buf = new Uint8Array(PART_BYTES);
  }

  private carryKey() {
    return `${this.st.key}.carry`;
  }

  async resume() {
    if (this.st.carryLen > 0) {
      const c = await this.ctx.blobs.getRange(this.carryKey(), 0, this.st.carryLen);
      if (!c || c.length !== this.st.carryLen) throw new Error("zip carry lost");
      this.buf.set(c, 0);
      this.fill = c.length;
    }
  }

  private async push(data: Uint8Array) {
    let off = 0;
    while (off < data.length) {
      const n = Math.min(data.length - off, PART_BYTES - this.fill);
      this.buf.set(data.subarray(off, off + n), this.fill);
      this.fill += n;
      off += n;
      if (this.fill === PART_BYTES) await this.flushPart();
    }
  }

  private async flushPart() {
    if (!this.st.uploadId) {
      const h = await this.ctx.blobs.createMultipart(this.st.key, "application/zip");
      this.st.uploadId = h.uploadId;
    }
    const p = await this.ctx.blobs.uploadPart({ key: this.st.key, uploadId: this.st.uploadId }, this.st.parts.length + 1, this.buf.slice(0, this.fill));
    this.st.parts.push(p);
    this.fill = 0;
  }

  /** Size the archive would have after adding an entry of `size` bytes (for part splitting). */
  projected(name: string, size: number) {
    return this.st.offset + localHeaderLength({ name, size, crc: 0 }) + size;
  }

  async add(name: string, size: number, crc: number, source: { sha256: string } | { bytes: Uint8Array }): Promise<void> {
    const e: ZipEntryInfo = { name, size, crc, offset: this.st.offset };
    await this.push(localHeader(e));
    if ("bytes" in source) await this.push(source.bytes);
    else {
      const stream = await this.ctx.blobs.get(blobKey(source.sha256));
      if (!stream) throw new Error(`file ${source.sha256} missing from storage`);
      const r = stream.getReader();
      let got = 0;
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        got += value.length;
        await this.push(value);
      }
      if (got !== size) throw new Error("stored file has an unexpected size");
    }
    this.st.offset += localHeaderLength(e) + size;
    this.st.entries++;
    await this.ctx.db.batch([jobItemStmt(this.jobId, this.cdKind, this.st.entries, e)]);
  }

  /** Park the unfinished tail so the next step can continue. */
  async checkpoint() {
    this.st.carryLen = this.fill;
    if (this.fill > 0) await this.ctx.blobs.put(this.carryKey(), this.buf.slice(0, this.fill));
  }

  /** Writes the central directory and completes the object. Returns size and sha256. */
  async finish(): Promise<{ bytes: number; sha256: string }> {
    const cdStart = this.st.offset;
    let cdSize = 0;
    let after = 0;
    for (;;) {
      const rows = await this.ctx.db.all<{ idx: number; item: string }>("SELECT idx, item FROM job_items WHERE job_id = ? AND kind = ? AND idx > ? ORDER BY idx LIMIT 500", [
        this.jobId,
        this.cdKind,
        after,
      ]);
      if (!rows.length) break;
      for (const r of rows) {
        const h = centralHeader(JSON.parse(r.item) as ZipEntryInfo);
        cdSize += h.length;
        await this.push(h);
        after = r.idx;
      }
    }
    await this.push(endRecords(this.st.entries, cdStart, cdSize));
    const total = cdStart + cdSize + endRecords(this.st.entries, cdStart, cdSize).length;
    if (!this.st.uploadId) {
      await this.ctx.blobs.put(this.st.key, this.buf.slice(0, this.fill), "application/zip");
    } else {
      if (this.fill > 0) await this.flushPart();
      await this.ctx.blobs.completeMultipart({ key: this.st.key, uploadId: this.st.uploadId }, this.st.parts);
    }
    await this.ctx.blobs.delete([this.carryKey()]).catch(() => {});
    this.st.done = true;
    this.st.carryLen = 0;
    // Hash the finished archive (streamed, bounded memory).
    const hasher = sha256Hasher();
    const stream = await this.ctx.blobs.get(this.st.key);
    if (stream) {
      const r = stream.getReader();
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        hasher.update(value);
      }
    }
    return { bytes: total, sha256: hasher.hex() };
  }
}
