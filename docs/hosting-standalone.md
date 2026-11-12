# Standalone binary

Every release has one archive per platform with a single executable that contains the runtime:
no Docker, Bun, Node.js or npm needed.

| File | Platform |
|---|---|
| `obx-portal-<version>-linux-x64.tar.gz` | Linux (Intel/AMD, glibc) |
| `obx-portal-<version>-linux-arm64.tar.gz` | Linux (ARM, e.g. Graviton, Ampere, Raspberry Pi 4/5 64-bit) |
| `obx-portal-<version>-darwin-arm64.tar.gz` / `-darwin-x64.tar.gz` | macOS |
| `obx-portal-<version>-windows-x64.zip` | Windows |

```sh
curl -LO https://github.com/openbrandexchange/node-ts/releases/download/v0.2.1/obx-portal-0.2.1-linux-x64.tar.gz
shasum -a 256 -c SHA256SUMS --ignore-missing      # after downloading SHA256SUMS from the same release
tar -xzf obx-portal-0.2.1-linux-x64.tar.gz && cd obx-portal-0.2.1-linux-x64
./obx-portal                                       # http://localhost:8080, setup code in the output
```

The archive holds `obx-portal`, `obx-portal-backup`, the web interface (`public/`), the licence and
an `.env.example`. Data goes to `./data` (change with `OBX_DATA_DIR`). The binary reads settings from
environment variables only.

## As a service (systemd)

```ini
# /etc/systemd/system/brand-portal.service
[Unit]
Description=Open Brand Exchange portal
After=network-online.target
Wants=network-online.target

[Service]
User=portal
WorkingDirectory=/opt/brand-portal
EnvironmentFile=/etc/brand-portal.env
Environment=OBX_DATA_DIR=/var/lib/brand-portal PORT=8080 HOST=127.0.0.1 OBX_TRUST_PROXY=true
ExecStart=/opt/brand-portal/obx-portal
Restart=on-failure
TimeoutStopSec=30
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/brand-portal
MemoryMax=1G

[Install]
WantedBy=multi-user.target
```

```sh
sudo useradd --system --home /var/lib/brand-portal --create-home portal
sudo systemctl daemon-reload && sudo systemctl enable --now brand-portal
journalctl -u brand-portal -f        # JSON logs; the first start prints the setup code
```

Put Caddy or nginx in front for HTTPS (see [hosting-docker.md](hosting-docker.md#https-with-caddy)).

Backups: `OBX_DATA_DIR=/var/lib/brand-portal ./obx-portal-backup backup /var/backups/portal/$(date +%F)`
(see [operations.md](operations.md#backup-and-restore)). Updates: stop the service, replace the folder
with the new release, start it (see [upgrading.md](upgrading.md)).
