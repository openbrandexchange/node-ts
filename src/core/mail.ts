// E-mails in the recipient's language. Strings come from the vendored admin-ui locale files
// (public/locales/<lang>.json, keys email.*); built-in English/Dutch/German/French are the fallback.
import type { Ctx } from "./ctx";

export const UI_LANGUAGES = ["bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "ga", "hr", "hu", "it", "lt", "lv", "mt", "nl", "nb", "pl", "pt", "ro", "sk", "sl", "sv"];

/** The local word for the retailer portal (glossary): "<Brand> · <word>". */
export const PORTAL_WORD: Record<string, string> = {
  bg: "Портал за търговци",
  cs: "Portál pro prodejce",
  da: "Forhandlerportal",
  de: "Händlerportal",
  el: "Πύλη μεταπωλητών",
  en: "Brand portal",
  es: "Portal para distribuidores",
  et: "Edasimüüjate portaal",
  fi: "Jälleenmyyjäportaali",
  fr: "Espace revendeurs",
  ga: "Tairseach miondíoltóirí",
  hr: "Portal za trgovce",
  hu: "Viszonteladói portál",
  it: "Area rivenditori",
  lt: "Pardavėjų portalas",
  lv: "Tirgotāju portāls",
  mt: "Portal għall-bejjiegħa",
  nb: "Forhandlerportal",
  nl: "Beeldbank",
  pl: "Portal dla sprzedawców",
  pt: "Portal de revendedores",
  ro: "Portal pentru revânzători",
  sk: "Portál pre predajcov",
  sl: "Portal za trgovce",
  sv: "Återförsäljarportal",
};

type Strings = Record<string, string>;

/** English fallback, copied from the admin-ui locale file (scripts/update-ui.sh keeps the vendored files current). */
const BUILTIN_EN: Strings = {
  "email.greeting": "Hello {{name}},",
  "email.greetingNoName": "Hello,",
  "email.signoff": "Kind regards,\n{{brand}}",
  "email.footer": "You receive this email because of your account or request at {{portal}}.",
  "email.linkFallback": "Button not working? Copy this address into your browser: {{url}}",
  "email.invite.subject": "{{brand}} invites you to {{portal}}",
  "email.invite.heading": "You're invited",
  "email.invite.body": "{{brand}} has created an account for you. There you can find their final product images and article data, and download them whenever you need.",
  "email.invite.button": "Choose your password",
  "email.invite.expiry": "This link works once and is valid until {{expires}}.",
  "email.invite.ignore": "Not expecting this? Then you can ignore this email.",
  "email.accessRequestReceived.subject": "We received your request for {{portal}}",
  "email.accessRequestReceived.heading": "Request received",
  "email.accessRequestReceived.body": "Thank you for your request to {{brand}}. We will check it and email you as soon as it has been reviewed.",
  "email.accessRequestNew.subject": "New access request from {{retailer}}",
  "email.accessRequestNew.body": "{{contact}} from {{retailer}} has asked for access to {{portal}}.",
  "email.accessRequestNew.button": "Review the request",
  "email.accessApproved.subject": "Your access to {{portal}} is ready",
  "email.accessApproved.heading": "Welcome",
  "email.accessApproved.body": "{{brand}} has approved your request.",
  "email.accessApproved.button": "Open the portal",
  "email.accessApproved.apiNote": "Your software can now collect its API key using the request number it received.",
  "email.accessRejected.subject": "About your request for {{portal}}",
  "email.accessRejected.heading": "Your request",
  "email.accessRejected.body": "Unfortunately {{brand}} cannot give you access at the moment.",
  "email.accessRejected.reason": "Explanation: {{reason}}",
  "email.accessRejected.contact": "Questions? Reply to this email or contact {{brand}}.",
  "email.zipReady.subject": "Your download from {{portal}} is ready",
  "email.zipReady.heading": "Your download is ready",
  "email.zipReady.body": "The zip you asked for ({{files}} files) is ready.",
  "email.zipReady.button": "Download",
  "email.zipReady.expiry": "The file is available until {{expires}}.",
  "email.passwordReset.subject": "Choose a new password for {{portal}}",
  "email.passwordReset.heading": "New password",
  "email.passwordReset.body": "Someone asked to reset the password of your account. Choose a new one with the button below.",
  "email.passwordReset.button": "Choose a new password",
  "email.passwordReset.expiry": "This link works once and is valid for one hour.",
  "email.passwordReset.ignore": "Didn't ask for this? Then you can ignore this email; your password stays the same.",
  "glossary.portal": "Brand portal"
};

const localeCache = new Map<string, Strings | null>();

function flatten(obj: unknown, prefix = "", out: Strings = {}): Strings {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (typeof obj === "string") out[prefix] = obj;
  return out;
}

async function vendored(ctx: Ctx, lang: string): Promise<Strings | null> {
  if (localeCache.has(lang)) return localeCache.get(lang)!;
  let s: Strings | null = null;
  try {
    const txt = await ctx.p.readAsset(`locales/${lang}.json`);
    if (txt) s = flatten(JSON.parse(txt));
  } catch {
    s = null;
  }
  localeCache.set(lang, s);
  return s;
}

export function normLang(lang: string | null | undefined): string {
  const l = (lang ?? "").toLowerCase().split(/[-_]/)[0];
  if (l === "no" || l === "nn") return "nb";
  return UI_LANGUAGES.includes(l) ? l : "en";
}

/** Best UI language from an Accept-Language header. */
export function pickLanguage(acceptLanguage: string | null | undefined, fallback = "en"): string {
  if (!acceptLanguage) return fallback;
  const langs = acceptLanguage
    .split(",")
    .map((p) => {
      const [tag, q] = p.trim().split(";q=");
      return { tag: tag.trim(), q: q ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);
  for (const l of langs) {
    const n = l.tag.toLowerCase().split("-")[0];
    const m = n === "no" || n === "nn" ? "nb" : n;
    if (UI_LANGUAGES.includes(m)) return m;
  }
  return fallback;
}

export async function translator(ctx: Ctx, lang: string) {
  const l = normLang(lang);
  const [mine, en] = await Promise.all([vendored(ctx, l), l === "en" ? Promise.resolve(null) : vendored(ctx, "en")]);
  const lookup = (key: string): string | undefined => mine?.[key] ?? en?.[key] ?? BUILTIN_EN[key];
  const t = (key: string, vars: Record<string, string | number> = {}): string =>
    (lookup(key) ?? key).replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, (m, a, b) => {
      const k = a ?? b;
      return vars[k] !== undefined ? String(vars[k]) : m;
    });
  t.has = (key: string) => lookup(key) !== undefined;
  return t;
}

export async function portalName(ctx: Ctx, lang: string): Promise<string> {
  const s = await ctx.settings();
  const l = normLang(lang);
  const own = s.branding.portal_name;
  const word = own?.[l] ?? own?.en ?? (own ? Object.values(own)[0] : undefined) ?? (await vendored(ctx, l))?.["glossary.portal"] ?? PORTAL_WORD[l] ?? PORTAL_WORD.en;
  const brand = s.branding.display_name || s.company.name || "Brand";
  return `${brand} · ${word}`;
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** E-mail templates; the names are the admin-ui locale keys under `email.`. */
export type EmailTemplate = "invite" | "passwordReset" | "accessRequestNew" | "accessRequestReceived" | "accessApproved" | "accessRejected" | "zipReady";

export interface EmailSpec {
  to: string;
  lang: string;
  template: EmailTemplate;
  name?: string | null;
  vars: Record<string, string | number>;
  /** Extra paragraphs after the body, as keys relative to the template (e.g. "apiNote", "reason"). */
  extra?: string[];
  link?: string | null;
}

/** Paragraphs shown after the button, per template, when the locale file has them. */
const AFTER: Record<EmailTemplate, string[]> = {
  invite: ["expiry", "ignore"],
  passwordReset: ["expiry", "ignore"],
  accessRequestNew: [],
  accessRequestReceived: [],
  accessApproved: [],
  accessRejected: ["contact"],
  zipReady: ["expiry"],
};

/** Renders and sends an e-mail. Never throws: failures are logged without the link (it holds a token). */
export async function sendEmail(ctx: Ctx, spec: EmailSpec): Promise<boolean> {
  if (!ctx.p.mailer.configured) return false;
  try {
    const t = await translator(ctx, spec.lang);
    const s = await ctx.settings();
    const portal = await portalName(ctx, spec.lang);
    const brand = s.branding.display_name || s.company.name;
    const vars: Record<string, string | number> = { portal, brand, name: spec.name ?? "", url: spec.link ?? "", ...spec.vars };
    const k = `email.${spec.template}`;
    const opt = (key: string) => (t.has(key) ? [t(key, vars)] : []);
    const heading = t.has(`${k}.heading`) ? t(`${k}.heading`, vars) : null;
    const lines = [spec.name ? t("email.greeting", vars) : t("email.greetingNoName", vars), t(`${k}.body`, vars), ...(spec.extra ?? []).flatMap((x) => opt(`${k}.${x}`))];
    const button = spec.link ? t(`${k}.button`, vars) : null;
    const after = AFTER[spec.template].flatMap((x) => opt(`${k}.${x}`));
    const signoff = t("email.signoff", vars);
    const footer = t("email.footer", vars);
    const fallback = spec.link ? t("email.linkFallback", vars) : null;
    const text = [
      ...(heading ? [heading] : []),
      ...lines,
      ...(spec.link ? [`${button}: ${spec.link}`] : []),
      ...after,
      signoff,
      "--",
      footer,
      "Works with Open Brand Exchange",
    ].join("\n\n");
    const accent = /^#[0-9a-fA-F]{6}$/.test(s.branding.accent_color ?? "") ? s.branding.accent_color! : "#1F4E5F";
    const para = (l: string) => `<p>${esc(l).replace(/\n/g, "<br>")}</p>`;
    const html = `<!doctype html><html lang="${esc(normLang(spec.lang))}"><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.5;max-width:560px;margin:0 auto;padding:24px">
<p style="font-weight:600;font-size:14px;color:#555;margin:0 0 16px">${esc(portal)}</p>
${heading ? `<h1 style="font-size:22px;margin:0 0 16px">${esc(heading)}</h1>` : ""}
${lines.map(para).join("\n")}
${spec.link ? `<p style="margin:28px 0"><a href="${esc(spec.link)}" style="background:${accent};color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block">${esc(button!)}</a></p><p style="font-size:13px;color:#555;word-break:break-all">${esc(fallback!)}</p>` : ""}
${after.map(para).join("\n")}
${para(signoff)}
<hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0 12px"><p style="font-size:12px;color:#666">${esc(footer)}</p>
<p style="font-size:11px;color:#999">Works with Open Brand Exchange</p></body></html>`;
    await ctx.p.mailer.send({ to: spec.to, subject: t(`${k}.subject`, vars), text, html });
    return true;
  } catch (e) {
    ctx.log("error", "e-mail could not be sent", { template: spec.template, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}
