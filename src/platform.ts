// The storage and runtime interface every adapter (Cloudflare Workers, Bun) implements.
// Business logic only talks to these interfaces, never to D1, R2, bun:sqlite or the disk directly.

export type SqlValue = string | number | null | Uint8Array;

export interface Stmt {
  sql: string;
  params?: SqlValue[];
}

/** A SQLite-dialect database (D1 or bun:sqlite). */
export interface Db {
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T | null>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  /** Runs all statements atomically, in order (D1 batch / SQLite transaction). */
  batch(stmts: Stmt[]): Promise<{ changes: number }[]>;
}

export interface BlobHead {
  size: number;
}

export interface MultipartHandle {
  key: string;
  uploadId: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/** Object storage (R2, local disk, S3-compatible). Keys use "/" separators. */
export interface BlobStore {
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  get(key: string, range?: { offset: number; length: number }): Promise<ReadableStream<Uint8Array> | null>;
  getRange(key: string, offset: number, length: number): Promise<Uint8Array | null>;
  head(key: string): Promise<BlobHead | null>;
  delete(keys: string[]): Promise<void>;
  list(prefix: string, cursor?: string): Promise<{ keys: string[]; cursor: string | null }>;
  /** Multipart writes: every part except the last MUST have the same size (R2 rule). */
  createMultipart(key: string, contentType?: string): Promise<MultipartHandle>;
  uploadPart(h: MultipartHandle, partNumber: number, data: Uint8Array): Promise<UploadedPart>;
  completeMultipart(h: MultipartHandle, parts: UploadedPart[]): Promise<void>;
  abortMultipart(h: MultipartHandle): Promise<void>;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  configured: boolean;
  send(msg: MailMessage): Promise<void>;
}

/** Read a static UI asset (used for vendored admin-ui locale files). */
export type AssetReader = (path: string) => Promise<string | null>;

export interface SftpEntry {
  path: string;
  size: number;
  modifiedAt: string | null;
}

export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  password?: string | null;
  privateKey?: string | null;
  hostKeyFingerprint?: string | null;
}

/** Only available on the Bun adapter. */
export interface SftpClient {
  list(cfg: SftpConfig, root: string): Promise<{ files: SftpEntry[]; hostKeyFingerprint: string | null }>;
  read(cfg: SftpConfig, path: string): Promise<Uint8Array>;
}

export interface Config {
  publicUrl: string | null;
  secretKey: string;
  setupCode: string | null;
  allowPrivateUrls: boolean;
  runtime: "workers" | "bun";
  software: string;
  version: string;
  maxUploadBytes: number;
  /** Batches with more operations than this become a background job. */
  syncBatchMax: number;
  /** Per-minute API rate limit per client (protocol). */
  apiRateLimit: number;
  renditionRateLimit: number;
  /** How long one background step may run before it checkpoints. */
  jobStepBudgetMs: number;
  /** One JSON log line per API request (method, path, status, duration, request id; never IPs or queries). */
  accessLog: boolean;
  /** Bearer token for GET /metrics; null disables the endpoint. */
  metricsToken: string | null;
  /** Bun: how long a graceful shutdown waits for running requests and job steps. */
  shutdownTimeoutMs: number;
  customDomainHelp: string;
}

export interface Platform {
  db: Db;
  blobs: BlobStore;
  mailer: Mailer;
  config: Config;
  readAsset: AssetReader;
  sftp: SftpClient | null;
  /** Host name → IP addresses, for SSRF checks (null: rely on the runtime's own network isolation). */
  resolveHost: ((host: string) => Promise<string[]>) | null;
  /** Workers: database queries this invocation may still make before background work should stop. */
  queryBudgetLeft?: () => number;
  /** Connect outbound requests to the address the SSRF check resolved (true on Bun). */
  pinConnections: boolean;
  /** Keep a promise alive after the response (Workers waitUntil); Bun just runs it. */
  defer(p: Promise<unknown>): void;
  /** Ask the runtime to run background jobs soon (queue message / in-process timer). */
  kickJobs(): void;
  now(): number;
  log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void;
}
