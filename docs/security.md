# Security

How this portal protects brands, retailers and their data. The normative rules for every Open Brand
Exchange node are in the spec's [security.md](https://github.com/openbrandexchange/spec/blob/main/docs/security.md);
this page says how this edition meets them. Report problems to **security@openbrandexchange.com**
([SECURITY.md](../SECURITY.md)).

## Accounts and sessions

- Passwords: argon2id (19 MiB, t=2) on Bun, bcrypt (cost 10) on Workers; 10 to 72 characters, common passwords refused.
- Sessions: random ids stored as hashes, `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS, 30 days
  sliding; changing a password ends the other sessions; blocking an account or retailer ends them at once.
- CSRF: every non-GET admin request needs `X-CSRF-Token` equal to the `obx_csrf` cookie and the session.
- First-run setup needs the setup code, so nobody else can claim a freshly deployed portal.
- Failed sign-ins: 10 per 15 minutes per address and per account; other sensitive endpoints are
  limited per address in the database.

## API access

- Retailers' software: OAuth2 client credentials; secrets shown once, stored hashed, rotatable;
  access tokens live one hour and every request re-checks the key, the retailer and its grant, so a
  revoke or block works at the next request.
- Automatic-upload keys (`obxi_…`): hashed, scoped (`ingest:read|write|delete`), optionally limited to
  brands; they only work on the ingest API, never on the admin API or the protocol API.
- Image links are signed per viewer (HMAC-SHA256 over method, path, expiry and actor), valid 60–90
  minutes, re-checked on use (visibility and the actor still being active).

## Data at rest and in transit

- Credentials of scheduled imports and webhook secrets are encrypted with a key derived from
  `OBX_SECRET_KEY` (AES-GCM); they are never returned by the API.
- HTTPS: Cloudflare always; on Bun put a TLS proxy in front. `Strict-Transport-Security` is sent on
  HTTPS requests only.
- The portal stores no IP addresses except in the audit log, where they are cleared after 30 days.

## Outbound requests (SSRF)

Import URLs, S3 endpoints, SFTP hosts and webhook URLs are checked before every request and every
redirect: only `https` (and `sftp`), no loopback, private, CGNAT, link-local, multicast or cloud
metadata address in any spelling, for every address a name resolves to. On Bun the connection is made
to the address that passed the check (DNS rebinding cannot swap it); on Workers private networks are
unreachable. `OBX_ALLOW_PRIVATE_URLS=true` (development only) allows `http`, loopback and private
addresses but never link-local or metadata addresses. All outbound calls have timeouts (15 s by
default, 10 s webhooks, 10 min imports); webhooks follow no redirects.

## Uploads and files

Size limits before buffering; declared SHA-256 verified; images recognised by their bytes (no SVG
logos); zip imports checked against zip bombs and path traversal; CSV exports neutralise formulas;
the static web interface cannot serve files outside its folder.

## Browser protection

The admin UI is served with a strict Content-Security-Policy (no inline scripts, `frame-ancestors 'none'`),
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Cross-Origin-Opener-Policy: same-origin` and a `Permissions-Policy` that turns off camera,
microphone, location and payment. API responses carry `Content-Security-Policy: default-src 'none'`.
CORS headers are sent only on the public discovery document (`/.well-known/obx`).

## Operations

- Configuration is validated at start; a database from a newer version is refused.
- Every admin action is in the audit log; personal data can be exported and erased; retention is
  configurable (see [operations.md](operations.md)).
- Dependencies: few, audited on every CI run (`bun audit`) and licence-checked; Dependabot proposes updates.
- The Docker image runs as a non-root user; releases ship an SBOM, checksums and build provenance.

## Verified by

`obx-conformance all` including the security profile (S-HDR, S-TOK, S-SESS, S-ISO, S-URL, S-SSRF,
S-UPL, S-CSV, S-PATH, S-URLS, S-RATE) on Bun and on the Workers runtime, and the tests in `test/`.
