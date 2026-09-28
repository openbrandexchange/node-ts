// Serves the vendored admin-ui build with SPA fallback and a strict Content-Security-Policy.
import { join, resolve, normalize, sep } from "node:path";

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

const UI_HEADERS = {
  "content-security-policy": CSP,
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

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
        const immutable = /\/assets\/.+\.[0-9a-f]{6,}\./i.test(path) || /-[A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/.test(path);
        return new Response(req.method === "HEAD" ? null : f, {
          headers: { ...UI_HEADERS, "content-type": f.type, "cache-control": immutable ? "public, max-age=31536000, immutable" : path.endsWith(".html") ? "no-cache" : "public, max-age=3600" },
        });
      }
    }
    const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
    const index = Bun.file(join(root, "index.html"));
    if (wantsHtml && (await index.exists())) return new Response(req.method === "HEAD" ? null : index, { headers: { ...UI_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    return new Response("Not found", { status: 404, headers: UI_HEADERS });
  };
}
