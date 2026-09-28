# Privacy notice template for your retailer portal

A starting point for the privacy notice a brand shows the retailers who use its portal. Fill in the
parts in **[brackets]**, remove what you do not use, and have it checked by whoever advises you on
data protection: this template is not legal advice. It describes what this software stores by
default; if you change settings (retention, e-mail provider, hosting) update the notice.

---

## Privacy notice: [Brand] · [portal name]

**Who is responsible.** [Company name], [address], [e-mail] ("we") runs this portal for retailers who
sell our products. We are the controller of the personal data described here. [If you have a data
protection officer: contact details.]

**What we store, and why.**

| Data | Why | Legal basis | How long |
|---|---|---|---|
| Your name, business e-mail address, preferred language and the company you work for, when you ask for access or we invite you | to decide on your request, create your account and write to you about it | our legitimate interest in supplying our retail partners (Art. 6(1)(f) GDPR) / performance of our agreement with your company (Art. 6(1)(b)) | while your account exists; a declined or approved request after **[365]** days |
| Your password (stored only as a one-way hash) and sign-in sessions | to keep your account secure | performance of the agreement | sessions end after 30 days of inactivity |
| Which images and article data you download, when, and for which company | to see which content our partners use and improve it | legitimate interest | **[730]** days; your name is removed from these records after **[400]** days |
| A record of actions in the portal's administration (for example sign-ins) with the network address they came from | security and to investigate misuse | legitimate interest | **[365]** days; network addresses after 30 days |
| Your selection of articles | so you can download them together | performance of the agreement | until you clear it or your account is deleted |

We do not use the data for advertising, do not sell it, and do not use tracking cookies. The portal
uses two cookies that are needed for signing in (a session cookie and a security token).

**Who else receives it.** Our hosting provider **[Cloudflare, Inc. / your hosting company]** stores the
portal and its data on our behalf; e-mails are sent through **[e-mail provider]**. Both process the
data only on our instructions under a data processing agreement. [If data leaves the EEA: the
safeguards, for example the EU–US Data Privacy Framework or standard contractual clauses.]

**Your rights.** You can ask us for a copy of your data, to correct or delete it, to restrict or
object to its use, and for a copy in a machine-readable form (we can export everything the portal
stores about you or your company as one file). Write to **[e-mail]**. You may also
complain to your data protection authority ([in the Netherlands: Autoriteit Persoonsgegevens,
autoriteitpersoonsgegevens.nl]).

**Changes.** We will update this notice when we change what we store. Last updated: **[date]**.

---

### For the brand: where these numbers come from

- Retention periods are the defaults of Settings → retention (`download_events_days` 730,
  `audit_log_days` 365, `ip_days` 30, `access_requests_days` 365); change the table when you change them.
- Exports and erasure: [operations.md](operations.md#data-retention-and-personal-data). The API also
  lets signed-in people download (`GET /admin/api/me/export`) or delete (`DELETE /admin/api/me`) their
  own data; mention it in the notice once your portal's screens offer it.
- The software stores no IP addresses except in the audit log (cleared after 30 days) and sets no
  analytics cookies. Your reverse proxy or Cloudflare may log more; include that if so.
