// Serves the vendored admin-ui build with SPA fallback and a strict Content-Security-Policy.
import { join, resolve, normalize, sep } from "node:path";

// The policy admin-ui documents in docs/node-integration.md and enforces in its own Playwright runs.
// img-src https: allows image URLs on another host (object storage, a CDN).
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const UI_HEADERS = {
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/** UI headers for this request: HSTS only when it came over HTTPS (browsers ignore it over plain HTTP anyway). */
function headersFor(req: Request): Record<string, string> {
  const https = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  return https ? { ...UI_HEADERS, "strict-transport-security": "max-age=31536000" } : UI_HEADERS;
}

export function staticHandler(uiDir: string) {
  const root = resolve(uiDir);
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(root, path));
    if (file.startsWith(root + sep)) {
      const f = Bun.file(file);
      if (await f.exists()) {
        const plain = /^\/(LICENSE|NOTICE)$/.test(path);
        const immutable = /\/assets\/.+\.[0-9a-f]{6,}\./i.test(path) || /-[A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/.test(path);
        return new Response(req.method === "HEAD" ? null : f, {
          headers: { ...headersFor(req), "content-type": plain ? "text/plain; charset=utf-8" : f.type, "cache-control": immutable ? "public, max-age=31536000, immutable" : path.endsWith(".html") ? "no-cache" : "public, max-age=3600" },
        });
      }
    }
    // A missing file under /assets/ or /locales/ is a 404, never index.html: an open tab from an older
    // version must see that its file is gone (it then reloads once) instead of parsing HTML as code.
    const isFile = /^\/(assets|locales)\//.test(path);
    const wantsHtml = !isFile && (req.headers.get("accept") ?? "").includes("text/html");
    const index = Bun.file(join(root, "index.html"));
    if (wantsHtml && (await index.exists())) return new Response(req.method === "HEAD" ? null : index, { headers: { ...headersFor(req), "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    return new Response("Not found", { status: 404, headers: headersFor(req) });
  };
}
