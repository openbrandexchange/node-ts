# Hosting options

This edition runs in two runtimes from the same code: **Cloudflare Workers** (D1 + R2) and **Bun**
(SQLite + disk or any S3-compatible storage). Pick one:

| Option | Good for | Guide |
|---|---|---|
| Your own server, with the one-line installer | A Linux VPS you control; HTTPS set up for you; SFTP imports | [hosting-standalone.md](hosting-standalone.md) |
| Cloudflare Workers (Deploy button or `wrangler`) | No server to maintain; global; pay per use (Workers Paid, $5/month + storage) | [hosting-cloudflare.md](hosting-cloudflare.md) |

On your own server:

```sh
curl -fsSL https://openbrandexchange.com/install.sh | sudo sh -s -- --edition ts --domain portal.yourbrand.com
```

Both options run the same portal, pass the same conformance suite and can move to each other: export
the database and files from one and restore them in another (see [operations.md](operations.md#moving-between-hosting-options)).

The other editions of the portal (same protocol, same admin screens):

- **Portal for your own server** ([node-go](https://github.com/openbrandexchange/node-go)): the
  default of the same installer (leave out `--edition ts`). One Go program with HTTPS built in.
- **Portal for web hosting** ([node-php](https://github.com/openbrandexchange/node-php)): a zip for
  ordinary web hosting with PHP (DirectAdmin, cPanel, Plesk), no server of your own needed.

The `Dockerfile` and `compose.yaml` in this repository are for local development and tests only, not
for production ([development/docker.md](development/docker.md)).
