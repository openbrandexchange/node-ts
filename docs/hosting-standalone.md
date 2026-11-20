# Your own server

Run the portal on a Linux server you rent or own. One command installs it, gets an HTTPS
certificate and starts it as a service. About 15 minutes, most of it waiting for DNS.

```sh
curl -fsSL https://openbrandexchange.com/install.sh | sudo sh -s -- --edition ts --domain portal.yourbrand.com
```

This installs this edition (TypeScript, the `obx-portal` program). Without `--edition ts` the same
installer installs the **Portal for your own server** ([node-go](https://github.com/openbrandexchange/node-go)),
which is the default for own servers. Both speak the same protocol and run the same admin screens.

## What you need

- A Linux server (VPS) with systemd: Ubuntu 22.04 or 24.04, Debian 12 or 13, or similar. Intel/AMD
  (amd64) or ARM (arm64). 1 GB of memory is enough to start.
- A public IPv4 address (IPv6 is optional) with ports 80 and 443 open.
- A domain or subdomain for the portal, for example `portal.yourbrand.com`.

Any VPS provider is fine, for example Hetzner Cloud, DigitalOcean, TransIP VPS or Scaleway.

## Step 1: point your domain at the server (DNS)

Add one record at the company that manages your domain:

| Type | Name | Value |
|---|---|---|
| A | portal | your server's IPv4 address, e.g. 203.0.113.10 |
| AAAA (only if the server has IPv6) | portal | your server's IPv6 address |

"portal" makes the address `portal.yourbrand.com`; choose another word if you like. Leave TTL at the
default (or 1 hour). Where to click (labels can differ slightly):

- **TransIP:** Control panel → Domains → your domain → DNS → add a record.
- **Hostnet:** Mijn Hostnet → Domeinnamen → your domain → DNS beheren → add record.
- **Strato:** Domains → Manage domain → gear icon → DNS → A record → Manage.
- **one.com:** Control panel → DNS settings → DNS records → Create new record.
- **Cloudflare DNS:** your domain → DNS → Records → Add record. Set "Proxy status" to "DNS only" (grey
  cloud): the portal then gets its own certificate. (If you want the orange cloud later, set SSL/TLS
  to "Full (strict)" first.)
- **GoDaddy:** My Products → your domain → DNS → Manage DNS → Add New Record.

Check: `dig +short portal.yourbrand.com` (or an online DNS checker such as dnschecker.org) must show the
server's address. Usually that takes 5 to 60 minutes; sometimes a few hours. The installer checks this
too and tells you what is missing.

## Step 2: run the installer

Log in to the server with SSH and run:

```sh
curl -fsSL https://openbrandexchange.com/install.sh | sudo sh -s -- --edition ts --domain portal.yourbrand.com
```

Want to see what it will do first? Add `--dry-run`: it prints every step and changes nothing.

The installer first checks that the server is Linux amd64/arm64 with systemd, that it runs as root,
that there is enough disk space, that `portal.yourbrand.com` points at this server, and that ports 80
and 443 are free. If a firewall (ufw or firewalld) blocks them, it prints the exact command to open
them. Then it:

1. downloads the latest release of `obx-portal` and checks its checksum;
2. creates the system user `obx` and installs the program in `/opt/obx-portal`;
3. installs [Caddy](https://caddyserver.com) (from your distribution or Caddy's package repository),
   which gets a Let's Encrypt certificate, renews it and sends `http://` to `https://`;
4. writes the settings to `/etc/obx-portal/obx-portal.env` and starts the service `obx-portal`.

At the end it prints the portal's address and the one-time **setup code**.

## Step 3: the setup wizard

Open `https://portal.yourbrand.com`, enter the setup code, your company, your languages and your admin
account. Lost the setup code? It is `OBX_SETUP_CODE` in `/etc/obx-portal/obx-portal.env`, or:

```sh
sudo journalctl -u obx-portal | grep "setup code"
```

## Installer options

| Option | What it does |
|---|---|
| `--domain NAME` | the portal's address, e.g. `portal.yourbrand.com` (required for install) |
| `--edition go\|ts` | `go` (default): the Portal for your own server; `ts`: this edition |
| `--email ADDRESS` | contact address for Let's Encrypt (optional) |
| `--version X.Y.Z` | a specific release instead of the latest |
| `--behind-proxy` | no HTTPS of its own: the portal listens on `127.0.0.1:8080` behind your own proxy |
| `--dry-run` | print what it would do, change nothing |
| `--uninstall` | remove the program and the service; keeps data and settings (add `--purge` to delete them) |

## Where everything is

| What | Where |
|---|---|
| Program and web interface | `/opt/obx-portal` (`obx-portal`, `obx-portal-backup`, `public/`) |
| Data (database, images, generated secret key) | `/var/lib/obx-portal` |
| Settings | `/etc/obx-portal/obx-portal.env` |
| Service | `obx-portal` (runs as user `obx`) |

Settings are environment variables; all of them are in [operations.md](operations.md#configuration).
After changing the settings file: `sudo systemctl restart obx-portal`. E-mail needs
`OBX_MAIL_PROVIDER`, `OBX_MAIL_FROM` and `OBX_MAIL_API_KEY`.

Useful commands:

```sh
sudo systemctl status obx-portal      # is it running?
sudo journalctl -u obx-portal -f      # the log (JSON lines)
curl -fs https://portal.yourbrand.com/readyz   # ready check, also for an uptime monitor
```

## Updating

Run the same install command again. It installs the latest release (or the one you name with
`--version`), keeps your settings and data, and restarts the service. Migrations run at start. Read
[upgrading.md](upgrading.md) and take a backup first.

## Backups

`obx-portal-backup` makes a consistent copy while the portal runs: the database, the images and the
generated secret key.

```sh
sudo -u obx env OBX_DATA_DIR=/var/lib/obx-portal \
  /opt/obx-portal/obx-portal-backup backup /var/lib/obx-portal/backups/$(date +%F)
```

Copy the backups off the server (another disk, a bucket, a backup service). If you set
`OBX_SECRET_KEY` in the settings file yourself, keep that key with the backups too. Restoring and the
full procedure: [operations.md](operations.md#backup-and-restore).

## Uninstalling

```sh
curl -fsSL https://openbrandexchange.com/install.sh | sudo sh -s -- --edition ts --uninstall
```

This removes the program and the service and keeps `/var/lib/obx-portal` and
`/etc/obx-portal`. Add `--purge` to delete those as well.

## Behind your own proxy

Already run nginx, Caddy, Traefik or a load balancer on the server? Install with `--behind-proxy`:
the installer does not install Caddy and the portal listens on `127.0.0.1:8080` only. Point your proxy
at it and make sure the settings file has `OBX_PUBLIC_URL=https://portal.yourbrand.com` and
`OBX_TRUST_PROXY=true`.

With nginx, pass `X-Forwarded-For` and `X-Forwarded-Proto`, allow large bodies
(`client_max_body_size 200m;`) and long requests (`proxy_read_timeout 3600s;` for big zips), and turn
off buffering for downloads (`proxy_buffering off;`). The portal sends `Strict-Transport-Security` as
soon as requests arrive over HTTPS.

## Appendix: manual install

For people who want to do every step themselves, or run the portal on macOS or Windows. Every release
has one archive per platform with a single executable that contains the runtime: no Bun, Node.js or
npm needed.

| File | Platform |
|---|---|
| `obx-portal-<version>-linux-x64.tar.gz` | Linux (Intel/AMD, glibc) |
| `obx-portal-<version>-linux-arm64.tar.gz` | Linux (ARM, e.g. Graviton, Ampere, Raspberry Pi 4/5 64-bit) |
| `obx-portal-<version>-darwin-arm64.tar.gz` / `-darwin-x64.tar.gz` | macOS |
| `obx-portal-<version>-windows-x64.zip` | Windows |

```sh
curl -LO https://github.com/openbrandexchange/node-ts/releases/download/v0.3.0/obx-portal-0.3.0-linux-x64.tar.gz
shasum -a 256 -c SHA256SUMS --ignore-missing      # after downloading SHA256SUMS from the same release
tar -xzf obx-portal-0.3.0-linux-x64.tar.gz && cd obx-portal-0.3.0-linux-x64
./obx-portal                                       # http://localhost:8080, setup code in the output
```

The archive holds `obx-portal`, `obx-portal-backup`, the web interface (`public/`), the licence and
an `.env.example`. Data goes to `./data` (change with `OBX_DATA_DIR`). The program reads settings from
environment variables only.

As a systemd service, with the same locations the installer uses:

```ini
# /etc/systemd/system/obx-portal.service
[Unit]
Description=Open Brand Exchange portal
After=network-online.target
Wants=network-online.target

[Service]
User=obx
WorkingDirectory=/opt/obx-portal
EnvironmentFile=/etc/obx-portal/obx-portal.env
Environment=OBX_DATA_DIR=/var/lib/obx-portal PORT=8080 HOST=127.0.0.1 OBX_TRUST_PROXY=true
ExecStart=/opt/obx-portal/obx-portal
Restart=on-failure
TimeoutStopSec=30
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/obx-portal
MemoryMax=1G

[Install]
WantedBy=multi-user.target
```

```sh
sudo useradd --system --home /var/lib/obx-portal --create-home obx
sudo mkdir -p /opt/obx-portal /etc/obx-portal && sudo cp -r obx-portal-0.3.0-linux-x64/. /opt/obx-portal/
echo "OBX_PUBLIC_URL=https://portal.yourbrand.com" | sudo tee /etc/obx-portal/obx-portal.env
sudo systemctl daemon-reload && sudo systemctl enable --now obx-portal
sudo journalctl -u obx-portal -f      # the first start prints the setup code
```

Then put a proxy with HTTPS in front, for example Caddy with
`caddy reverse-proxy --from portal.yourbrand.com --to 127.0.0.1:8080` (see "Behind your own proxy"
above). To update by hand: take a backup, stop the service, replace the contents of `/opt/obx-portal`
with the new release and start it again.
