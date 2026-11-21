# Upgrading

Versions follow [Semantic Versioning](https://semver.org/):

- **Patch** (0.1.0 → 0.1.1): fixes only. Replace the software; nothing else to do.
- **Minor** (0.1 → 0.2): new features, possibly new migrations (applied automatically) and new optional
  settings. Read the "Upgrading" notes of that version in [CHANGELOG.md](../CHANGELOG.md).
- **Major** (0.x → 1.0): may need a manual step; the changelog says which.

Protocol compatibility is separate: every 0.3.x portal speaks OBX protocol 0.3 (0.2.x spoke 0.2, 0.1.x spoke 0.1).
0.2 only added fields, so software written for 0.1 kept working; 0.3 changes the shape of `materials` and `care`
(terms with names, spec proposal 0004), so retailers' software that reads those fields must move to 0.3 too. Everything
else keeps working across portal updates.

## Before every upgrade

1. Read the changelog entries between your version and the new one.
2. Take a backup ([operations.md](operations.md#backup-and-restore)); on Cloudflare note the time (D1
   Time Travel can go back to it) or run `wrangler d1 export`.
3. Upgrade during a quiet moment: migrations run at start and the portal is briefly unavailable
   (usually seconds).

## Cloudflare

- **Deploy button copy:** merge the release into your repository (`git pull https://github.com/openbrandexchange/node-ts v0.2.1`)
  and push; Workers Builds runs `bun run deploy` (deploy, then migrations).
- **From your computer:** `git fetch --tags && git checkout v0.2.1 && bun install && bun run deploy`.
- **Prebuilt bundle:** unpack the new `obx-node-ts-cloudflare-<version>.tar.gz` over the old folder and run `bun run deploy` (or `npm run deploy` with only Node.js).

Rolling back the code: `bunx wrangler rollback` (Workers keeps earlier versions). If the new version
ran a migration, roll the database back as well (`wrangler d1 time-travel restore` to the time before
the upgrade), because an older version refuses a database migrated by a newer one.

## Your own server

Take a backup ([hosting-standalone.md](hosting-standalone.md#backups)), then run the install command again:

```sh
curl -fsSL https://openbrandexchange.com/install.sh | sudo sh -s -- --edition ts --domain portal.yourbrand.com
sudo journalctl -u obx-portal -f                       # migrations and "listening"
curl -fs https://portal.yourbrand.com/readyz
```

It keeps the settings and data and restarts the service. Add `--version 0.3.1` to install a specific
release instead of the latest (also to go back to an earlier version after restoring its backup).
Installed by hand (manual install)? Stop the service, replace the contents of `/opt/obx-portal` with
the new release and start it again.

## If an upgrade fails

- The portal refuses to start with a configuration message: fix the named setting (new versions may
  validate more strictly) and start again.
- A migration fails: the portal does not start and nothing is half-applied (each migration runs in
  one transaction). Restore the backup, start the previous version, and report the log to
  hello@openbrandexchange.com or in an issue.
- Downgrading after a successful migration: restore the backup taken before the upgrade, then run the
  old version. Starting an old version on a newer database is refused on purpose.
