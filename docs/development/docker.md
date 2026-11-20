# Docker (local development only)

> **Not for production.** The `Dockerfile` and `compose.yaml` exist for local development and for the
> tests in CI. To run a real portal, use your own server with the installer
> ([hosting-standalone.md](../hosting-standalone.md)) or Cloudflare Workers
> ([hosting-cloudflare.md](../hosting-cloudflare.md)).

The quickest local run needs no Docker at all: `bun install && bun run dev` (see the README). Use
Docker when you want to try the container build, the local S3 server or the backup test.

```sh
docker compose up -d              # builds the image; portal on http://localhost:8080
docker compose logs portal        # shows the setup code for the wizard
```

The image runs as the unprivileged user `bun`, keeps everything under `/data` (database, files,
generated secret key), answers `/healthz` for Docker's health check and stops gracefully on
`docker stop -t 30`. It is built for `linux/amd64` and `linux/arm64`.

## Settings

Put settings in a `.env` file next to `compose.yaml` (`cp .env.example .env`). Port 8080 already
taken? Set `OBX_PORT=8090`. All variables: [operations.md](../operations.md#configuration). The
container checks every setting at start and exits with code 78 and one sentence per problem.

## Images in a local S3 server

`OBX_STORAGE=s3` in `.env`, then `docker compose --profile s3 up -d` (starts RustFS next to the portal).

## Backup and restore in the container

```sh
docker compose exec portal bun src/adapters/bun/backup.ts backup /data/backups/$(date +%F)
docker compose stop portal
docker compose run --rm portal bun src/adapters/bun/backup.ts restore /data/backups/<date>
docker compose start portal
```

`scripts/backup-restore-test.sh` runs this procedure against the image in CI.
