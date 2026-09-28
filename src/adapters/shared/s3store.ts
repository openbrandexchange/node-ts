// S3-compatible BlobStore (AWS S3, MinIO, Backblaze, R2 over S3 API) using aws4fetch.
import { AwsClient } from "aws4fetch";
import type { BlobStore } from "../../platform";

export interface S3Options {
  endpoint: string; // e.g. https://s3.eu-central-1.amazonaws.com or http://localhost:9000
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  pathStyle?: boolean;
}

/** Creates the bucket if it does not exist yet (used by the Docker Compose setup with a local S3 server). */
export async function ensureBucket(o: S3Options): Promise<void> {
  const aws = new AwsClient({ accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey, service: "s3", region: o.region });
  const url = `${o.endpoint.replace(/\/+$/, "")}/${o.bucket}`;
  const head = await aws.fetch(url, { method: "HEAD" });
  if (head.ok) return;
  const r = await aws.fetch(url, { method: "PUT" });
  if (!r.ok && r.status !== 409) throw new Error(`could not create bucket ${o.bucket}: ${r.status}`);
}

export function s3Store(o: S3Options): BlobStore {
  const aws = new AwsClient({ accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey, service: "s3", region: o.region });
  const ep = o.endpoint.replace(/\/+$/, "");
  const base = o.pathStyle !== false ? `${ep}/${o.bucket}` : ep.replace("://", `://${o.bucket}.`);
  const pre = (o.prefix ?? "").replace(/^\/+|\/+$/g, "");
  const full = (k: string) => (pre ? `${pre}/${k}` : k);
  const url = (k: string) => `${base}/${full(k).split("/").map(encodeURIComponent).join("/")}`;
  const call = async (u: string, init: RequestInit = {}) => {
    const res = await aws.fetch(u, init);
    return res;
  };
  const text = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? null;
  return {
    async put(key, data, contentType) {
      const r = await call(url(key), { method: "PUT", body: data as BodyInit, headers: contentType ? { "content-type": contentType } : {} });
      if (!r.ok) throw new Error(`S3 put ${r.status}`);
    },
    async get(key, range) {
      const r = await call(url(key), { headers: range ? { range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {} });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`S3 get ${r.status}`);
      return r.body;
    },
    async getRange(key, offset, length) {
      const r = await call(url(key), { headers: { range: `bytes=${offset}-${offset + length - 1}` } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`S3 get ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async head(key) {
      const r = await call(url(key), { method: "HEAD" });
      if (!r.ok) return null;
      return { size: Number(r.headers.get("content-length") ?? 0) };
    },
    async delete(keys) {
      for (const k of keys) await call(url(k), { method: "DELETE" });
    },
    async list(prefix, cursor) {
      const q = `${base}/?list-type=2&prefix=${encodeURIComponent(full(prefix))}${cursor ? `&continuation-token=${encodeURIComponent(cursor)}` : ""}`;
      const xml = await (await call(q)).text();
      const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => m[1].replace(/&amp;/g, "&")).map((k) => (pre ? k.slice(pre.length + 1) : k));
      return { keys, cursor: /<IsTruncated>true/.test(xml) ? text(xml, "NextContinuationToken") : null };
    },
    async createMultipart(key, contentType) {
      const r = await call(`${url(key)}?uploads`, { method: "POST", headers: contentType ? { "content-type": contentType } : {} });
      const id = text(await r.text(), "UploadId");
      if (!r.ok || !id) throw new Error(`S3 multipart create ${r.status}`);
      return { key, uploadId: id };
    },
    async uploadPart(h, n, data) {
      const r = await call(`${url(h.key)}?partNumber=${n}&uploadId=${encodeURIComponent(h.uploadId)}`, { method: "PUT", body: data as BodyInit });
      if (!r.ok) throw new Error(`S3 upload part ${r.status}`);
      return { partNumber: n, etag: r.headers.get("etag") ?? "" };
    },
    async completeMultipart(h, parts) {
      const body = `<CompleteMultipartUpload>${[...parts]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
        .join("")}</CompleteMultipartUpload>`;
      const r = await call(`${url(h.key)}?uploadId=${encodeURIComponent(h.uploadId)}`, { method: "POST", body, headers: { "content-type": "application/xml" } });
      const t = await r.text();
      if (!r.ok || t.includes("<Error>")) throw new Error(`S3 multipart complete ${r.status}`);
    },
    async abortMultipart(h) {
      await call(`${url(h.key)}?uploadId=${encodeURIComponent(h.uploadId)}`, { method: "DELETE" });
    },
  };
}
