// Minimal structural types for the Cloudflare bindings we use (keeps the build free of global type clashes).
export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  meta: { changes: number };
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1Result>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(stmts: D1PreparedStatement[]): Promise<D1Result[]>;
}
export interface R2Object {
  key: string;
  size: number;
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface R2MultipartUpload {
  key: string;
  uploadId: string;
  uploadPart(n: number, data: Uint8Array | ArrayBuffer): Promise<{ partNumber: number; etag: string }>;
  complete(parts: { partNumber: number; etag: string }[]): Promise<unknown>;
  abort(): Promise<void>;
}
export interface R2Bucket {
  put(key: string, value: Uint8Array | ArrayBuffer | ReadableStream, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string, opts?: { range?: { offset: number; length: number } }): Promise<R2Object | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(opts: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  createMultipartUpload(key: string, opts?: { httpMetadata?: { contentType?: string } }): Promise<R2MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload;
}
export interface Fetcher {
  fetch(req: Request | string): Promise<Response>;
}
export interface Queue {
  send(msg: unknown): Promise<void>;
}
export interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
  passThroughOnException?(): void;
}
export interface MessageBatch {
  messages: { ack(): void }[];
}
