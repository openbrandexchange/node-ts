// Hashing, HMAC signing, constant-time comparison and encryption at rest.
import { createHash, createHmac } from "node:crypto";
import { b64url, fromB64url, fromUtf8, randomBytes, toHex, utf8 } from "./util";

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** Incremental SHA-256 (node:crypto is available on Bun and on Workers with nodejs_compat). */
export function sha256Hasher() {
  const h = createHash("sha256");
  return {
    update(b: Uint8Array) {
      h.update(b);
    },
    hex(): string {
      return h.digest("hex");
    },
  };
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = utf8(a);
  const bb = utf8(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ (bb[i] ?? 0);
  return diff === 0;
}

/**
 * HMAC-SHA256 with node:crypto (Bun, and Workers with nodejs_compat). Synchronous under the hood:
 * WebCrypto's async sign costs ~20 µs per call, which dominated catalog pages with many signed URLs.
 */
export function hmacSha256Sync(secret: string | Uint8Array, message: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", secret).update(message).digest());
}

export async function hmacSha256(secret: string | Uint8Array, message: string | Uint8Array): Promise<Uint8Array> {
  return hmacSha256Sync(secret, message);
}

export async function hmacHex(secret: string | Uint8Array, message: string): Promise<string> {
  return toHex(await hmacSha256(secret, message));
}

/** Webhook signature per protocol.md §9: v1=hex(HMAC-SHA256(secret utf8, "<ts>.<body>")). */
export async function webhookSignature(secret: string, timestamp: string, rawBody: string): Promise<string> {
  return "v1=" + (await hmacHex(secret, `${timestamp}.${rawBody}`));
}

/** Derived purpose-specific keys from OBX_SECRET_KEY. */
export class Keyring {
  private derived = new Map<string, Uint8Array>();
  constructor(private readonly master: string) {}

  async key(purpose: string): Promise<Uint8Array> {
    const hit = this.derived.get(purpose);
    if (hit) return hit;
    const k = await hmacSha256(this.master, "obx-node-ts/" + purpose);
    this.derived.set(purpose, k);
    return k;
  }

  async sign(purpose: string, message: string): Promise<string> {
    return b64url(await hmacSha256(await this.key(purpose), message));
  }

  async verify(purpose: string, message: string, sig: string): Promise<boolean> {
    const expected = await this.sign(purpose, message);
    return timingSafeEqualStr(expected, sig);
  }

  /** Signed opaque token: b64url(json).sig */
  async seal(purpose: string, payload: unknown): Promise<string> {
    const body = b64url(utf8(JSON.stringify(payload)));
    return `${body}.${await this.sign(purpose, body)}`;
  }

  async unseal<T>(purpose: string, token: string): Promise<T | null> {
    const i = token.lastIndexOf(".");
    if (i <= 0) return null;
    const body = token.slice(0, i);
    const sig = token.slice(i + 1);
    if (!(await this.verify(purpose, body, sig))) return null;
    try {
      return JSON.parse(fromUtf8(fromB64url(body))) as T;
    } catch {
      return null;
    }
  }

  private async aesKey(): Promise<CryptoKey> {
    const raw = await this.key("aes-gcm-at-rest");
    return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  /** AES-256-GCM encryption for secrets that must be usable later (webhook secrets, import credentials). */
  async encrypt(plain: string): Promise<string> {
    const iv = randomBytes(12);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, await this.aesKey(), utf8(plain) as BufferSource);
    return `v1.${b64url(iv)}.${b64url(ct)}`;
  }

  async decrypt(sealed: string): Promise<string> {
    const [v, iv, ct] = sealed.split(".");
    if (v !== "v1" || !iv || !ct) throw new Error("bad ciphertext");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv) as BufferSource }, await this.aesKey(), fromB64url(ct) as BufferSource);
    return fromUtf8(pt);
  }
}

// CRC-32 (IEEE), needed for zip entries.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32Update(crc: number, buf: Uint8Array): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export function crc32(buf: Uint8Array): number {
  return crc32Update(0, buf);
}

/** Hash for high-entropy tokens (SHA-256 is sufficient per security.md §2). */
export async function tokenHash(token: string): Promise<string> {
  return sha256Hex(token);
}
