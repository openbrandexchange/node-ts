# Hosting with Docker

## Quick start

```sh
git clone https://github.com/openbrandexchange/node-ts && cd node-ts
docker compose up -d              # builds the image; portal on http://localhost:8080
docker compose logs portal        # shows the setup code for the wizard
```

Or use the published image (once releases are public) without cloning:

```sh
docker volume create portal-data
docker run -d --name portal --restart unless-stopped -p 8080:8080 -v portal-data:/data \
  -e OBX_PUBLIC_URL=https://brands.yourbrand.com -e OBX_TRUST_PROXY=true \
  ghcr.io/openbrandexchange/node-ts:0.1
```

The image runs as the unprivileged user `bun`, keeps everything under `/data` (database, files,
generated secret key), answers `/healthz` for Docker's health check and stops gracefully on
`docker stop` (running requests and job steps finish within 20 s; give it 30 s: `docker stop -t 30`).
It is built for `linux/amd64` and `linux/arm64`.

## Settings

Put settings in a `.env` file next to `compose.yaml` (`cp .env.example .env`). The important ones:

| Variable | Why |
|---|---|
| `OBX_PUBLIC_URL` | the address people use, e.g. `https://brands.yourbrand.com` (links in e-mails and the API) |
| `OBX_SECRET_KEY` | optional: without it a key is generated into the volume (`/data/secret.key`); back it up |
| `OBX_SETUP_CODE` | optional: your own setup code instead of the one printed in the log |
| `OBX_MAIL_PROVIDER`, `OBX_MAIL_API_KEY`, `OBX_MAIL_FROM` | e-mail |
| `OBX_TRUST_PROXY=true` | behind a reverse proxy, so client addresses and HTTPS are recognised |

The container checks every setting at start and exits with code 78 and one sentence per problem
(`docker compose logs portal`). All variables: [operations.md](operations.md#configuration).

## HTTPS with Caddy

Put a reverse proxy with TLS in front. With [Caddy](https://caddyserver.com) (automatic certificates),
add to `compose.yaml`:

```yaml
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    command: caddy reverse-proxy --from brands.yourbrand.com --to portal:8080
    volumes: [caddy-data:/data]
```

(and `caddy-data:` under `volumes:`), remove the `ports:` of the portal service, and set
`OBX_PUBLIC_URL=https://brands.yourbrand.com` and `OBX_TRUST_PROXY=true`. The portal sends
`Strict-Transport-Security` as soon as requests arrive over HTTPS.

With nginx, pass `X-Forwarded-For` and `X-Forwarded-Proto`, allow large bodies
(`client_max_body_size 200m;`) and long requests (`proxy_read_timeout 3600s;` for big zips), and turn
off buffering for downloads (`proxy_buffering off;`).

## Resources

`compose.yaml` limits the portal to 2 CPUs and 1 GB of memory, which is plenty for a catalog of
10,000 products (see [performance.md](performance.md)). The database is SQLite in WAL mode on the
volume: use a local disk (not NFS or SMB).

## Images in S3-compatible storage

Set `OBX_STORAGE=s3` with `OBX_S3_ENDPOINT`, `OBX_S3_BUCKET`, `OBX_S3_REGION`, `OBX_S3_ACCESS_KEY_ID`
and `OBX_S3_SECRET_ACCESS_KEY` (AWS S3, Cloudflare R2, Backblaze B2, Google Cloud Storage, MinIO,
RustFS …). For a local S3 server in Compose: `OBX_STORAGE=s3` in `.env`, then
`docker compose --profile s3 up -d`.

## Backups, updates, monitoring

- Backup while running: `docker compose exec portal bun src/adapters/bun/backup.ts backup /data/backups/$(date +%F)`,
  then copy `/data/backups` off the machine. Restore and the full procedure: [operations.md](operations.md#backup-and-restore).
- Update: [upgrading.md](upgrading.md) (`docker compose pull && docker compose up -d`, or `git pull && docker compose up -d --build`).
- Monitoring: `/readyz` for uptime checks; `/metrics` with `OBX_METRICS_TOKEN`; JSON logs on stdout.
