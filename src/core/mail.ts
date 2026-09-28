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

const BUILTIN: Record<string, Strings> = {
  en: {
    "email.common.greeting": "Hello {name},",
    "email.common.greeting_anonymous": "Hello,",
    "email.common.footer": "You receive this e-mail because of your account at {portal}.",
    "email.common.ignore": "If you did not expect this e-mail, you can ignore it.",
    "email.invite.subject": "Your invitation to {portal}",
    "email.invite.body": "You have been invited to {portal}, where you find the product images and article data of {brand}. Choose a password to get started. The link works once and is valid until {expires}.",
    "email.invite.button": "Choose your password",
    "email.password_reset.subject": "Reset your password for {portal}",
    "email.password_reset.body": "Someone asked to reset the password of your account at {portal}. The link works once and is valid for one hour.",
    "email.password_reset.button": "Choose a new password",
    "email.access_request.subject": "{retailer} requests access to {portal}",
    "email.access_request.body": "{contact} of {retailer} requested access to {portal}. Approve or reject the request in your admin.",
    "email.access_request.button": "Review the request",
    "email.access_approved.subject": "Your access to {portal} was approved",
    "email.access_approved.body": "Good news: {brand} approved your request for access to {portal}.",
    "email.access_approved.body_portal": "You will receive a separate e-mail to choose your password.",
    "email.access_approved.body_api": "Your software can collect its API key once, with the request token it received when you asked for access.",
    "email.access_approved.button": "Open {portal}",
    "email.access_rejected.subject": "Your request for {portal}",
    "email.access_rejected.body": "{brand} did not approve your request for access to {portal}.",
    "email.access_rejected.reason": "Reason: {reason}",
    "email.zip_ready.subject": "Your download from {portal} is ready",
    "email.zip_ready.body": "Your zip file with {files} images is ready. It stays available for 7 days.",
    "email.zip_ready.button": "Download",
  },
  nl: {
    "email.common.greeting": "Hallo {name},",
    "email.common.greeting_anonymous": "Hallo,",
    "email.common.footer": "Je ontvangt deze e-mail vanwege je account bij {portal}.",
    "email.common.ignore": "Had je deze e-mail niet verwacht? Dan kun je hem negeren.",
    "email.invite.subject": "Je uitnodiging voor {portal}",
    "email.invite.body": "Je bent uitgenodigd voor {portal}, waar je de productfoto's en artikelgegevens van {brand} vindt. Kies een wachtwoord om te beginnen. De link werkt één keer en is geldig tot {expires}.",
    "email.invite.button": "Kies je wachtwoord",
    "email.password_reset.subject": "Nieuw wachtwoord voor {portal}",
    "email.password_reset.body": "Er is gevraagd om het wachtwoord van je account bij {portal} opnieuw in te stellen. De link werkt één keer en is een uur geldig.",
    "email.password_reset.button": "Kies een nieuw wachtwoord",
    "email.access_request.subject": "{retailer} vraagt toegang tot {portal}",
    "email.access_request.body": "{contact} van {retailer} heeft toegang gevraagd tot {portal}. Keur de aanvraag goed of af in je beheeromgeving.",
    "email.access_request.button": "Bekijk de aanvraag",
    "email.access_approved.subject": "Je toegang tot {portal} is goedgekeurd",
    "email.access_approved.body": "Goed nieuws: {brand} heeft je aanvraag voor toegang tot {portal} goedgekeurd.",
    "email.access_approved.body_portal": "Je krijgt een aparte e-mail om je wachtwoord te kiezen.",
    "email.access_approved.body_api": "Je software kan de API-sleutel één keer ophalen, met de aanvraagcode die hij bij je aanvraag kreeg.",
    "email.access_approved.button": "Open {portal}",
    "email.access_rejected.subject": "Je aanvraag voor {portal}",
    "email.access_rejected.body": "{brand} heeft je aanvraag voor toegang tot {portal} niet goedgekeurd.",
    "email.access_rejected.reason": "Reden: {reason}",
    "email.zip_ready.subject": "Je download van {portal} staat klaar",
    "email.zip_ready.body": "Je zipbestand met {files} foto's staat klaar. Het blijft 7 dagen beschikbaar.",
    "email.zip_ready.button": "Downloaden",
  },
  de: {
    "email.common.greeting": "Hallo {name},",
    "email.common.greeting_anonymous": "Hallo,",
    "email.common.footer": "Sie erhalten diese E-Mail wegen Ihres Kontos bei {portal}.",
    "email.common.ignore": "Falls Sie diese E-Mail nicht erwartet haben, können Sie sie ignorieren.",
    "email.invite.subject": "Ihre Einladung zum {portal}",
    "email.invite.body": "Sie wurden zum {portal} eingeladen. Dort finden Sie die Produktbilder und Artikeldaten von {brand}. Wählen Sie ein Passwort, um loszulegen. Der Link funktioniert einmal und gilt bis {expires}.",
    "email.invite.button": "Passwort wählen",
    "email.password_reset.subject": "Neues Passwort für {portal}",
    "email.password_reset.body": "Es wurde angefordert, das Passwort Ihres Kontos bei {portal} zurückzusetzen. Der Link funktioniert einmal und ist eine Stunde gültig.",
    "email.password_reset.button": "Neues Passwort wählen",
    "email.access_request.subject": "{retailer} bittet um Zugang zum {portal}",
    "email.access_request.body": "{contact} von {retailer} hat Zugang zum {portal} angefragt. Genehmigen oder ablehnen können Sie die Anfrage in Ihrer Verwaltung.",
    "email.access_request.button": "Anfrage ansehen",
    "email.access_approved.subject": "Ihr Zugang zum {portal} wurde genehmigt",
    "email.access_approved.body": "Gute Nachricht: {brand} hat Ihre Anfrage für den Zugang zum {portal} genehmigt.",
    "email.access_approved.body_portal": "Sie erhalten eine separate E-Mail, um Ihr Passwort zu wählen.",
    "email.access_approved.body_api": "Ihre Software kann den API-Schlüssel einmal abholen, mit dem Anfrage-Token, das sie bei der Anfrage erhalten hat.",
    "email.access_approved.button": "{portal} öffnen",
    "email.access_rejected.subject": "Ihre Anfrage für {portal}",
    "email.access_rejected.body": "{brand} hat Ihre Anfrage für den Zugang zum {portal} nicht genehmigt.",
    "email.access_rejected.reason": "Grund: {reason}",
    "email.zip_ready.subject": "Ihr Download vom {portal} ist bereit",
    "email.zip_ready.body": "Ihre ZIP-Datei mit {files} Bildern ist bereit. Sie bleibt 7 Tage verfügbar.",
    "email.zip_ready.button": "Herunterladen",
  },
  fr: {
    "email.common.greeting": "Bonjour {name},",
    "email.common.greeting_anonymous": "Bonjour,",
    "email.common.footer": "Vous recevez cet e-mail en raison de votre compte sur {portal}.",
    "email.common.ignore": "Si vous n'attendiez pas cet e-mail, vous pouvez l'ignorer.",
    "email.invite.subject": "Votre invitation à {portal}",
    "email.invite.body": "Vous êtes invité(e) à {portal}, où vous trouverez les photos produits et les données articles de {brand}. Choisissez un mot de passe pour commencer. Le lien fonctionne une seule fois et reste valable jusqu'au {expires}.",
    "email.invite.button": "Choisir mon mot de passe",
    "email.password_reset.subject": "Réinitialiser votre mot de passe pour {portal}",
    "email.password_reset.body": "Une demande de réinitialisation du mot de passe de votre compte sur {portal} a été faite. Le lien fonctionne une seule fois et reste valable une heure.",
    "email.password_reset.button": "Choisir un nouveau mot de passe",
    "email.access_request.subject": "{retailer} demande l'accès à {portal}",
    "email.access_request.body": "{contact} de {retailer} a demandé l'accès à {portal}. Acceptez ou refusez la demande dans votre espace d'administration.",
    "email.access_request.button": "Voir la demande",
    "email.access_approved.subject": "Votre accès à {portal} est accepté",
    "email.access_approved.body": "Bonne nouvelle : {brand} a accepté votre demande d'accès à {portal}.",
    "email.access_approved.body_portal": "Vous recevrez un e-mail séparé pour choisir votre mot de passe.",
    "email.access_approved.body_api": "Votre logiciel peut récupérer sa clé API une seule fois, avec le jeton reçu lors de la demande.",
    "email.access_approved.button": "Ouvrir {portal}",
    "email.access_rejected.subject": "Votre demande pour {portal}",
    "email.access_rejected.body": "{brand} n'a pas accepté votre demande d'accès à {portal}.",
    "email.access_rejected.reason": "Motif : {reason}",
    "email.zip_ready.subject": "Votre téléchargement depuis {portal} est prêt",
    "email.zip_ready.body": "Votre fichier zip avec {files} images est prêt. Il reste disponible 7 jours.",
    "email.zip_ready.button": "Télécharger",
  },
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
  return (key: string, vars: Record<string, string | number> = {}): string => {
    const raw = mine?.[key] ?? BUILTIN[l]?.[key] ?? en?.[key] ?? BUILTIN.en[key] ?? key;
    return raw.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
  };
}

export async function portalName(ctx: Ctx, lang: string): Promise<string> {
  const s = await ctx.settings();
  const l = normLang(lang);
  const word = s.branding.portal_word?.[l] ?? s.branding.portal_word?.en ?? (await vendored(ctx, l))?.["glossary.portal"] ?? PORTAL_WORD[l] ?? PORTAL_WORD.en;
  const brand = s.branding.display_name || s.company.name || "Brand";
  return `${brand} · ${word}`;
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface EmailSpec {
  to: string;
  lang: string;
  template: "invite" | "password_reset" | "access_request" | "access_approved" | "access_rejected" | "zip_ready";
  name?: string | null;
  vars: Record<string, string | number>;
  extraKeys?: string[];
  link?: string | null;
}

/** Renders and sends an e-mail. Never throws: failures are logged without the link (it holds a token). */
export async function sendEmail(ctx: Ctx, spec: EmailSpec): Promise<boolean> {
  if (!ctx.p.mailer.configured) return false;
  try {
    const t = await translator(ctx, spec.lang);
    const s = await ctx.settings();
    const portal = await portalName(ctx, spec.lang);
    const vars = { portal, brand: s.branding.display_name || s.company.name, ...spec.vars };
    const k = `email.${spec.template}`;
    const lines = [spec.name ? t("email.common.greeting", { name: spec.name }) : t("email.common.greeting_anonymous"), t(`${k}.body`, vars), ...(spec.extraKeys ?? []).map((x) => t(x, vars))];
    const button = spec.link ? t(`${k}.button`, vars) : null;
    const footer = [t("email.common.ignore"), t("email.common.footer", vars)];
    const text = [...lines, ...(spec.link ? [`${button}: ${spec.link}`] : []), "", ...footer, "", "Works with Open Brand Exchange"].join("\n\n");
    const accent = s.branding.accent_color ?? "#1F4E5F";
    const html = `<!doctype html><html lang="${esc(normLang(spec.lang))}"><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.5;max-width:560px;margin:0 auto;padding:24px">
<p style="font-weight:600;font-size:18px;margin:0 0 16px">${esc(portal)}</p>
${lines.map((l) => `<p>${esc(l)}</p>`).join("\n")}
${spec.link ? `<p style="margin:28px 0"><a href="${esc(spec.link)}" style="background:${esc(accent)};color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block">${esc(button!)}</a></p><p style="font-size:13px;color:#555;word-break:break-all">${esc(spec.link)}</p>` : ""}
<hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0 12px"><p style="font-size:12px;color:#666">${footer.map(esc).join("<br>")}</p>
<p style="font-size:11px;color:#999">Works with Open Brand Exchange</p></body></html>`;
    await ctx.p.mailer.send({ to: spec.to, subject: t(`${k}.subject`, vars), text, html });
    return true;
  } catch (e) {
    ctx.log("error", "e-mail could not be sent", { template: spec.template, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}
