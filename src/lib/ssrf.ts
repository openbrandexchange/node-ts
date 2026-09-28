// Outbound request safety (security.md §5): https only, no private/loopback/link-local targets,
// re-checked on every redirect, bounded redirects and time.
import { ObxError } from "./problem";

export type Resolver = (host: string) => Promise<string[]>;

function v4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return true;
  for (const [base, bits] of V4_BLOCKED) {
    const b = v4ToInt(base)!;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) >>> 0 === (b & mask) >>> 0) return true;
  }
  return false;
}

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  let tailV4: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const n = v4ToInt(s.slice(lastColon + 1));
    if (n === null) return null;
    tailV4 = [(n >>> 16) & 0xffff, n & 0xffff];
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const parts = [...head, ...Array(Math.max(0, fill)).fill("0"), ...tail];
  if (parts.length !== 8) return null;
  const nums = parts.map((p) => parseInt(p || "0", 16));
  if (nums.some((x) => Number.isNaN(x) || x < 0 || x > 0xffff)) return null;
  if (tailV4.length) {
    nums[6] = tailV4[0];
    nums[7] = tailV4[1];
  }
  return nums;
}

export function isBlockedIp(ip: string): boolean {
  if (ip.includes(".") && !ip.includes(":")) return v4Blocked(ip);
  const n = expandV6(ip.replace(/^\[|\]$/g, ""));
  if (!n) return true;
  if (n.every((x) => x === 0)) return true; // ::
  if (n.slice(0, 7).every((x) => x === 0) && n[7] === 1) return true; // ::1
  if ((n[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((n[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((n[0] & 0xff00) === 0xff00) return true; // multicast
  const mapped = n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff;
  const nat64 = n[0] === 0x64 && n[1] === 0xff9b && n.slice(2, 6).every((x) => x === 0);
  if (mapped || nat64) return v4Blocked(`${n[6] >> 8}.${n[6] & 0xff}.${n[7] >> 8}.${n[7] & 0xff}`);
  if (n[0] === 0x2001 && n[1] === 0x0db8) return true; // documentation
  return false;
}

/**
 * Link-local and cloud-metadata targets: refused even when OBX_ALLOW_PRIVATE_URLS is on, because
 * local development never needs them and they hand out cloud credentials.
 */
export function isAlwaysBlockedIp(ip: string): boolean {
  if (ip.includes(".") && !ip.includes(":")) {
    const n = v4ToInt(ip);
    if (n === null) return true;
    return (n >>> 16) === 0xa9fe || ip === "100.100.100.200"; // 169.254.0.0/16, Alibaba metadata
  }
  const n = expandV6(ip.replace(/^\[|\]$/g, ""));
  if (!n) return true;
  if ((n[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if (n[0] === 0xfd00 && n[1] === 0x0ec2 && n.slice(2, 7).every((x) => x === 0) && n[7] === 0x254) return true; // AWS IPv6 metadata
  const mapped = n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff;
  if (mapped) return isAlwaysBlockedIp(`${n[6] >> 8}.${n[6] & 0xff}.${n[7] >> 8}.${n[7] & 0xff}`);
  return false;
}

const METADATA_NAMES = /^(metadata|metadata\.google\.internal|instance-data|instance-data\.ec2\.internal)$/i;

export interface UrlPolicy {
  allowPrivate: boolean;
  resolve: Resolver | null;
  schemes?: string[];
  /**
   * Connect to the address that was checked instead of resolving the name again (closes the DNS
   * rebinding window between check and connect). Used on Bun; Workers cannot reach private networks.
   */
  pin?: boolean;
}

export interface CheckedUrl {
  url: URL;
  /** The checked address to connect to, or null for IP literals and when nothing was resolved. */
  address: string | null;
}

const LOCAL_NAMES = /^(localhost|localhost\.localdomain|ip6-localhost|ip6-loopback)$|\.(localhost|local|internal|intranet|home\.arpa|lan)$/i;

/** IPv4 first: it is reachable from every container network; IPv6 often is not. */
function preferV4(ips: string[]): string | null {
  return ips.find((ip) => !ip.includes(":")) ?? ips[0] ?? null;
}

/** Throws 422 unsafe_url unless the URL is allowed. */
export async function assertSafeUrl(raw: string, policy: UrlPolicy): Promise<URL> {
  return (await checkUrl(raw, policy)).url;
}

/** Checks a URL like assertSafeUrl and returns the resolved address that passed the check. */
export async function checkUrl(raw: string, policy: UrlPolicy): Promise<CheckedUrl> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ObxError("unsafe_url", "This is not a valid web address.");
  }
  const schemes = policy.schemes ?? ["https:"];
  const scheme = u.protocol;
  const devHttp = policy.allowPrivate && scheme === "http:";
  if (!schemes.includes(scheme) && !devHttp) throw new ObxError("unsafe_url", "Only https:// addresses are allowed.");
  if (u.username || u.password) throw new ObxError("unsafe_url", "Put credentials in the credential fields, not in the address.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (policy.allowPrivate) {
    const unsafe = "Link-local and cloud metadata addresses are never allowed.";
    if (METADATA_NAMES.test(host)) throw new ObxError("unsafe_url", unsafe);
    if (/^[\d.]+$/.test(host) || host.includes(":")) {
      if (isAlwaysBlockedIp(host)) throw new ObxError("unsafe_url", unsafe);
      return { url: u, address: null };
    }
    if (policy.resolve) {
      const ips = await policy.resolve(host).catch(() => [] as string[]);
      if (ips.some(isAlwaysBlockedIp)) throw new ObxError("unsafe_url", unsafe);
      return { url: u, address: preferV4(ips) };
    }
    return { url: u, address: null };
  }
  if (LOCAL_NAMES.test(host)) throw new ObxError("unsafe_url", "Addresses on a local or private network are not allowed.");
  const literal = /^[\d.]+$/.test(host) || host.includes(":");
  if (literal) {
    if (isBlockedIp(host)) throw new ObxError("unsafe_url", "Addresses on a local or private network are not allowed.");
    return { url: u, address: null };
  }
  if (policy.resolve) {
    let ips: string[] = [];
    try {
      ips = await policy.resolve(host);
    } catch {
      throw new ObxError("unsafe_url", "The host name could not be resolved.");
    }
    if (!ips.length) throw new ObxError("unsafe_url", "The host name could not be resolved.");
    if (ips.some(isBlockedIp)) throw new ObxError("unsafe_url", "This address points to a local or private network.");
    return { url: u, address: preferV4(ips) };
  }
  return { url: u, address: null };
}

/**
 * The request to send for a checked URL. With pinning, the URL's host is replaced by the checked
 * address; the Host header and (for https) the TLS server name keep the original name, so virtual
 * hosting and certificate verification work exactly as before.
 */
export function pinnedRequest(checked: CheckedUrl, pin: boolean): { url: string; host: string | null; serverName: string | null } {
  const u = checked.url;
  if (!pin || !checked.address) return { url: u.toString(), host: null, serverName: null };
  const target = new URL(u.toString());
  target.hostname = checked.address.includes(":") ? `[${checked.address}]` : checked.address;
  return { url: target.toString(), host: u.host, serverName: u.protocol === "https:" ? u.hostname : null };
}

/** fetch() with the SSRF policy applied to the URL and to every redirect hop (max 5). */
export async function safeFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number; followRedirects?: boolean },
  policy: UrlPolicy,
): Promise<Response> {
  let current = url;
  const follow = init.followRedirects ?? true;
  for (let hop = 0; hop <= 5; hop++) {
    const target = pinnedRequest(await checkUrl(current, policy), !!policy.pin);
    const headers = new Headers(init.headers);
    if (target.host) headers.set("host", target.host);
    const req: RequestInit & { tls?: { serverName?: string } } = {
      ...init,
      headers,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 15_000),
    };
    if (target.serverName) req.tls = { serverName: target.serverName };
    const res = await fetch(target.url, req);
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (!follow) return res;
      current = new URL(res.headers.get("location")!, current).toString();
      await res.body?.cancel();
      continue;
    }
    return res;
  }
  throw new ObxError("unsafe_url", "Too many redirects.");
}

/** DNS over HTTPS resolver (used on Workers, which has no raw DNS API). */
export const dohResolver: Resolver = async (host) => {
  const out: string[] = [];
  for (const type of ["A", "AAAA"]) {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) continue;
    const j = (await res.json()) as { Answer?: { type: number; data: string }[] };
    for (const a of j.Answer ?? []) if (a.type === 1 || a.type === 28) out.push(a.data);
  }
  return out;
};
