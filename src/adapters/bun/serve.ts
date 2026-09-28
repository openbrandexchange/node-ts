// The Bun.serve fetch handler: client address header, then the API or the static UI.
import type { Server } from "bun";
import { isApiPath } from "../../app";

export function serverFetch(o: { app: { fetch(req: Request): Response | Promise<Response> }; serveUi: (req: Request) => Promise<Response>; trustProxy: boolean }) {
  return (req: Request, srv: Server<unknown>) => {
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.delete("x-obx-client-ip");
    const fwd = o.trustProxy ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() : null;
    headers.set("x-obx-client-ip", fwd || srv.requestIP(req)?.address || "unknown");
    if (!o.trustProxy) headers.delete("x-forwarded-proto");
    const r = new Request(req, { headers });
    if (isApiPath(url.pathname) || url.pathname === "/healthz") return o.app.fetch(r);
    return o.serveUi(r);
  };
}
