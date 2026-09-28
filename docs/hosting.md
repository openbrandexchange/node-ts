# Hosting options

This edition runs in two runtimes from the same code: **Cloudflare Workers** (D1 + R2) and **Bun**
(SQLite + disk or any S3-compatible storage). Pick one:

| Option | Good for | Guide |
|---|---|---|
| Cloudflare (Deploy button or `wrangler`) | No server to maintain; global; pay per use (Workers Paid, $5/month + storage) | [hosting-cloudflare.md](hosting-cloudflare.md) |
| Docker / Docker Compose on your own server | Full control; runs anywhere Docker runs; SFTP imports | [hosting-docker.md](hosting-docker.md) |
| Google Cloud Run | Managed containers on Google Cloud; database replicated to Cloud Storage | [hosting-cloud-run.md](hosting-cloud-run.md) |
| Standalone binary | One file per platform, no Docker, Bun or Node needed; a small VM or an office server | [hosting-standalone.md](hosting-standalone.md) |

All options run the same portal, pass the same conformance suite and can move to each other: export
the database and files from one and restore them in another (see [operations.md](operations.md#moving-between-hosting-options)).

The other editions of the portal (same protocol, same admin screens): **Portal for Google Cloud &
Docker** (`node-go`) and **Portal for web hosting** (`node-php`).
