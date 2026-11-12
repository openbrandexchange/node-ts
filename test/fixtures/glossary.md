# Glossary: words people see

**Status:** v0.3.0. Non-normative, but binding for every user-facing text in this project: the shared admin UI, e-mails sent by nodes, plugins and the website. Machine-readable copy of the core terms: [`admin-ui/src/i18n/glossary.json`](https://github.com/openbrandexchange/admin-ui/blob/main/src/i18n/glossary.json) (the source of truth for those terms). `node tools/glossary.mjs --compare ../admin-ui/src/i18n/glossary.json` checks that the table below matches it; `npm run validate` checks that every language and every term is present.

The protocol has precise technical terms. People using a portal should never need them. A buyer in a shop wants *photos and article data*, not *renditions, grants and cursors*.

## Rules

1. **Never show protocol terms to users.** Not in labels, errors, e-mails or help text:

| Protocol / API term | Say instead |
|---|---|
| GTIN | say EAN in the UI (APIs keep gtin) |
| ingest | say automatic upload |
| client credentials | say API key for your software |
| grant | say what they may see / access |
| node | say portal (or the edition name in docs) |
| tombstone / cursor | never shown |

2. **The portal is called "<Brand name> · <portal word>"**, for example *Kestrel · Beeldbank* (Dutch) or *Kestrel · Brand portal* (English). The portal word below is the default per language. A brand MAY set its own word per language in its settings (`branding.portal_name`, a text per language); for a reader's language without its own text the portal uses the brand's `en` text, then its first text, then the word below.
3. **EAN, not GTIN**, everywhere a person reads it (APIs and CSV columns keep `gtin`).
4. **"Works with Open Brand Exchange"** appears only as a small badge in the footer. The project name is not a product name and does not appear in headings, e-mail subjects or page titles.
5. **Plain verbs.** "Download", "Request access", "Invite", "Block". Confirm success where the action happened; do not celebrate.
6. **Languages.** The UI ships the 24 official EU languages plus Norwegian Bokmål. English is the source. Choose the language from the browser (`navigator.languages`), let people switch it, and remember the choice on the device and on the account. Product texts fall back: reader's language, then English, then the first available.
7. **E-mails** use the `email.*` strings of the recipient's language from `dist/locales/<lang>.json` of the admin UI (placeholders `{{name}}`), falling back to English.

## Core terms per language

| Language | Portal word | API key for your software | Automatic upload | Request access | Article | Colour | Size |
|---|---|---|---|---|---|---|---|
| Български (`bg`) | Портал за търговци | API ключ за вашия софтуер | Автоматично качване | Заявка за достъп | Артикул | Цвят | Размер |
| Čeština (`cs`) | Portál pro prodejce | API klíč pro váš software | Automatické nahrávání | Požádat o přístup | Artikl | Barva | Velikost |
| Dansk (`da`) | Forhandlerportal | API-nøgle til jeres software | Automatisk upload | Anmod om adgang | Vare | Farve | Størrelse |
| Deutsch (`de`) | Händlerportal | API-Schlüssel für Ihre Software | Automatischer Upload | Zugang anfragen | Artikel | Farbe | Größe |
| Ελληνικά (`el`) | Πύλη μεταπωλητών | Κλειδί API για το λογισμικό σας | Αυτόματη μεταφόρτωση | Αίτημα πρόσβασης | Είδος | Χρώμα | Μέγεθος |
| English (`en`) | Brand portal | API key for your software | Automatic upload | Request access | Article | Colour | Size |
| Español (`es`) | Portal para distribuidores | Clave API para tu software | Subida automática | Solicitar acceso | Artículo | Color | Talla |
| Eesti (`et`) | Edasimüüjate portaal | API-võti teie tarkvarale | Automaatne üleslaadimine | Taotle juurdepääsu | Toode | Värv | Suurus |
| Suomi (`fi`) | Jälleenmyyjäportaali | API-avain ohjelmistollenne | Automaattinen lataus | Pyydä pääsyä | Tuote | Väri | Koko |
| Français (`fr`) | Espace revendeurs | Clé API pour votre logiciel | Envoi automatique | Demander l'accès | Article | Couleur | Taille |
| Gaeilge (`ga`) | Tairseach miondíoltóirí | Eochair API do do bhogearraí | Uaslódáil uathoibríoch | Iarr rochtain | Earra | Dath | Méid |
| Hrvatski (`hr`) | Portal za trgovce | API ključ za vaš softver | Automatsko učitavanje | Zatraži pristup | Artikl | Boja | Veličina |
| Magyar (`hu`) | Viszonteladói portál | API-kulcs a szoftveréhez | Automatikus feltöltés | Hozzáférés kérése | Termék | Szín | Méret |
| Italiano (`it`) | Area rivenditori | Chiave API per il tuo software | Caricamento automatico | Richiedi l'accesso | Articolo | Colore | Taglia |
| Lietuvių (`lt`) | Prekybininkų portalas | API raktas jūsų programinei įrangai | Automatinis įkėlimas | Prašyti prieigos | Prekė | Spalva | Dydis |
| Latviešu (`lv`) | Tirgotāju portāls | API atslēga jūsu programmatūrai | Automātiska augšupielāde | Pieprasīt piekļuvi | Prece | Krāsa | Izmērs |
| Malti (`mt`) | Portal għall-bejjiegħa | Ċavetta API għas-software tiegħek | Tlugħ awtomatiku | Itlob aċċess | Oġġett | Kulur | Daqs |
| Norsk bokmål (`nb`) | Forhandlerportal | API-nøkkel for programvaren deres | Automatisk opplasting | Be om tilgang | Vare | Farge | Størrelse |
| Nederlands (`nl`) | Beeldbank | API-sleutel voor je software | Automatisch uploaden | Toegang aanvragen | Artikel | Kleur | Maat |
| Polski (`pl`) | Portal dla sprzedawców | Klucz API do Twojego oprogramowania | Automatyczne przesyłanie | Poproś o dostęp | Artykuł | Kolor | Rozmiar |
| Português (`pt`) | Portal de revendedores | Chave de API para o seu software | Envio automático | Pedir acesso | Artigo | Cor | Tamanho |
| Română (`ro`) | Portal pentru comercianți | Cheie API pentru software-ul dvs. | Încărcare automată | Solicită acces | Articol | Culoare | Mărime |
| Slovenčina (`sk`) | Portál pre predajcov | API kľúč pre váš softvér | Automatické nahrávanie | Požiadať o prístup | Tovar | Farba | Veľkosť |
| Slovenščina (`sl`) | Portal za trgovce | API ključ za vašo programsko opremo | Samodejno nalaganje | Zaprosi za dostop | Artikel | Barva | Velikost |
| Svenska (`sv`) | Återförsäljarportal | API-nyckel för ert system | Automatisk uppladdning | Begär åtkomst | Artikel | Färg | Storlek |

"EAN" is written as-is in every language.

## The project and its publisher

The project name and the foundation's name are proper names: they are **never translated**, in any language.

- Project: **Open Brand Exchange** (short: OBX, only where space is tight or in technical text).
- Publisher: **Open Brand Exchange Foundation**. Until the foundation has been set up at a notary, the name is always followed by "(in formation)" in the reader's language, from the table below. The name itself stays English.
- Imprint line (website footer and imprint page, NOTICE files): *Open Brand Exchange Foundation (in formation)*, with `hello@openbrandexchange.com`. The imprint page says once that the foundation will be a Dutch *stichting*. No street address or phone number unless the publisher provides one.
- Contact addresses: `hello@openbrandexchange.com` (general) and `security@openbrandexchange.com` (vulnerability reports). No company addresses of implementers.

| Language | "(in formation)" |
|---|---|
| Български (`bg`) | (в процес на учредяване) |
| Čeština (`cs`) | (v založení) |
| Dansk (`da`) | (under stiftelse) |
| Deutsch (`de`) | (in Gründung) |
| Ελληνικά (`el`) | (υπό σύσταση) |
| English (`en`) | (in formation) |
| Español (`es`) | (en constitución) |
| Eesti (`et`) | (asutamisel) |
| Suomi (`fi`) | (perusteilla) |
| Français (`fr`) | (en cours de constitution) |
| Gaeilge (`ga`) | (á bunú) |
| Hrvatski (`hr`) | (u osnivanju) |
| Magyar (`hu`) | (alapítás alatt) |
| Italiano (`it`) | (in via di costituzione) |
| Lietuvių (`lt`) | (steigiama) |
| Latviešu (`lv`) | (dibināšanā) |
| Malti (`mt`) | (qed titwaqqaf) |
| Norsk bokmål (`nb`) | (under stiftelse) |
| Nederlands (`nl`) | (in oprichting) |
| Polski (`pl`) | (w organizacji) |
| Português (`pt`) | (em constituição) |
| Română (`ro`) | (în curs de constituire) |
| Slovenčina (`sk`) | (v založení) |
| Slovenščina (`sl`) | (v ustanavljanju) |
| Svenska (`sv`) | (under bildande) |

Example (German): *Open Brand Exchange Foundation (in Gründung)*. Once the foundation is registered, the "(in formation)" suffix is dropped in one change. The translations other than nl, de, fr and en still need a native review.

## Editions

When documentation needs to name a server implementation, use the edition name, not "node":

| Repository | Edition name |
|---|---|
| `node-ts` | Portal for Cloudflare |
| `node-go` | Portal for Google Cloud & Docker |
| `node-php` | Portal for web hosting |

## Changing the glossary

Edit `glossary.json` in the admin UI, update every locale (the admin UI test suite fails when a locale disagrees with the glossary), regenerate this page, and note the change in the changelog.
