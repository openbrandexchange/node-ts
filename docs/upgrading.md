# Upgrading

Versions follow [Semantic Versioning](https://semver.org/):

- **Patch** (0.1.0 → 0.1.1): fixes only. Replace the software; nothing else to do.
- **Minor** (0.1 → 0.2): new features, possibly new migrations (applied automatically) and new optional
  settings. Read the "Upgrading" notes of that version in [CHANGELOG.md](../CHANGELOG.md).
- **Major** (0.x → 1.0): may need a manual step; the changelog says which.

Protocol compatibility is separate: every 0.2.x portal speaks OBX protocol 0.2 (0.1.x spoke 0.1; 0.2 only adds
fields, so software written for 0.1 keeps working), and retailers' software
keeps working across portal updates.

## Before every upgrade

1. Read the changelog entries between your version and the new one.
2. Take a backup ([operations.md](operations.md#backup-and-restore)); on Cloudflare note the time (D1
   Time Travel can go back to it) or run `wrangler d1 export`.
3. Upgrade during a quiet moment: migrations run at start and the portal is briefly unavailable
   (usually seconds).

## Cloudflare

- **Deploy button copy:** merge the release into your repository (`git pull https://github.com/openbrandexchange/node-ts v0.2.1`)
  and push; Workers Builds runs `npm run deploy` (deploy, then migrations).
- **From your computer:** `git fetch --tags && git checkout v0.2.1 && bun install && bun run deploy`.
- **Prebuilt bundle:** unpack the new `obx-node-ts-cloudflare-<version>.tar.gz` over the old folder and run `npm run deploy`.

Rolling back the code: `bunx wrangler rollback` (Workers keeps earlier versions). If the new version
ran a migration, roll the database back as well (`wrangler d1 time-travel restore` to the time before
the upgrade), because an older version refuses a database migrated by a newer one.

## Docker

```sh
docker compose pull && docker compose up -d                 # published image
git pull && git checkout v0.2.1 && docker compose up -d --build   # built from source
docker compose logs -f portal                               # migrations and "listening"
curl -fs http://localhost:8080/readyz
```

Pin a version in production (`ghcr.io/openbrandexchange/node-ts:0.2.1` or `:0.2` for patches only)
rather than `latest`.

## Standalone binary and systemd

```sh
sudo systemctl stop brand-portal
sudo -u portal ./obx-portal-backup backup /var/backups/portal/before-0.2.1   # with OBX_DATA_DIR set
sudo tar -xzf obx-portal-0.2.1-linux-x64.tar.gz -C /opt && sudo ln -sfn /opt/obx-portal-0.2.1-linux-x64 /opt/brand-portal
sudo systemctl start brand-portal
```

## If an upgrade fails

- The portal refuses to start with a configuration message: fix the named setting (new versions may
  validate more strictly) and start again.
- A migration fails: the portal does not start and nothing is half-applied (each migration runs in
  one transaction). Restore the backup, start the previous version, and report the log to
  hello@openbrandexchange.com or in an issue.
- Downgrading after a successful migration: restore the backup taken before the upgrade, then run the
  old version. Starting an old version on a newer database is refused on purpose.
