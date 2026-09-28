// E-mail over a plain HTTPS API, so it works on Workers and Bun alike.
// OBX_MAIL_PROVIDER: resend | postmark | sendgrid | mailchannels | webhook | console (development only).
import type { Mailer, MailMessage } from "../../platform";

export interface MailEnv {
  provider?: string;
  apiKey?: string;
  from?: string;
  webhookUrl?: string;
  log?: (msg: string) => void;
  /** Waits between attempts (tests shorten them). */
  retryDelaysMs?: number[];
}

/** Three attempts: network errors, 429 and 5xx are retried after 1 s and 4 s (or the provider's Retry-After, up to 10 s). */
export const RETRY_DELAYS_MS = [1000, 4000];

async function postWithRetry(url: string, headers: Record<string, string>, body: unknown, delays: number[]) {
  let last = "";
  for (let attempt = 0; ; attempt++) {
    let retryAfterMs: number | null = null;
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        await r.body?.cancel().catch(() => {});
        return;
      }
      await r.body?.cancel().catch(() => {});
      last = `mail provider answered ${r.status}`;
      if (r.status !== 429 && r.status < 500) throw new PermanentMailError(last);
      const ra = Number(r.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra * 1000, 10_000);
    } catch (err) {
      if (err instanceof PermanentMailError) throw err;
      last = last || (err instanceof Error ? err.message : String(err));
    }
    if (attempt >= delays.length) throw new Error(`${last} (after ${attempt + 1} attempts)`);
    await new Promise((res) => setTimeout(res, retryAfterMs ?? delays[attempt]));
    last = "";
  }
}

class PermanentMailError extends Error {}

export function httpMailer(e: MailEnv): Mailer {
  const provider = (e.provider ?? "").toLowerCase();
  const from = e.from ?? "";
  const configured = !!provider && (provider === "console" || (!!from && (provider === "webhook" ? !!e.webhookUrl : !!e.apiKey)));
  const post = (url: string, headers: Record<string, string>, body: unknown) => postWithRetry(url, headers, body, e.retryDelaysMs ?? RETRY_DELAYS_MS);
  return {
    configured,
    async send(m: MailMessage) {
      if (!configured) return;
      switch (provider) {
        case "resend":
          return post("https://api.resend.com/emails", { authorization: `Bearer ${e.apiKey}` }, { from, to: [m.to], subject: m.subject, text: m.text, html: m.html });
        case "postmark":
          return post("https://api.postmarkapp.com/email", { "x-postmark-server-token": e.apiKey!, accept: "application/json" }, { From: from, To: m.to, Subject: m.subject, TextBody: m.text, HtmlBody: m.html, MessageStream: "outbound" });
        case "sendgrid":
          return post(
            "https://api.sendgrid.com/v3/mail/send",
            { authorization: `Bearer ${e.apiKey}` },
            { personalizations: [{ to: [{ email: m.to }] }], from: { email: from }, subject: m.subject, content: [{ type: "text/plain", value: m.text }, { type: "text/html", value: m.html }] },
          );
        case "mailchannels":
          return post(
            "https://api.mailchannels.net/tx/v1/send",
            { "x-api-key": e.apiKey! },
            { personalizations: [{ to: [{ email: m.to }] }], from: { email: from }, subject: m.subject, content: [{ type: "text/plain", value: m.text }, { type: "text/html", value: m.html }] },
          );
        case "webhook":
          return post(e.webhookUrl!, e.apiKey ? { authorization: `Bearer ${e.apiKey}` } : {}, { from, to: m.to, subject: m.subject, text: m.text, html: m.html });
        case "console":
          // Development only: prints the message, including links (which contain one-time tokens).
          (e.log ?? console.log)(`[mail] to=${m.to} subject=${m.subject}\n${m.text}`);
          return;
      }
    },
  };
}
