# SS14.AdminWeb.Bridge

The AdminWeb.Bridge is a Bridging Service that Connects a Protected Postgres Database to the SS14.AdminWeb Ecosystem.
This is used if the Space Station 14 Postgres Database is behind either a Protected Firewall or has no access to the outside.
This Bridge connects to https://ss14adminweb.myzumi.dev (Default Environment Var), gets its Configuration from the Webservice and initiates a Websocket Connection afterwards.
This Websocket will then function as a "Database Connection", Relaying Commands between the Webserver and the Postgres Database.

## Setup

Copy `.env.example` to `.env`, then in DataSourceSettings on your AdminWeb server set the Data Source to "Bridge" and generate a token. Paste that into `BRIDGE_TOKEN`, fill in `PG_*` for your local Postgres, then `npm install && npm start` (or just grab a packaged binary from Releases, no Node needed on the box).

First run generates an identity keypair under `.bridge/identity.json` and prints a fingerprint - cross-check it against DataSourceSettings once, that's your TOFU pin (same idea as an SSH host key).

Env vars, mostly self explanatory:

- `BRIDGE_TOKEN` - required, from DataSourceSettings
- `WEBSERVER_URL` - defaults to `https://ss14adminweb.myzumi.dev`
- `PG_HOST` / `PG_PORT` / `PG_DATABASE` / `PG_USER` / `PG_PASSWORD` - your local Postgres
- `BLOCK_WRITE_COMMANDS` - blocks DELETE/UPDATE/INSERT/DROP/ALTER/TRUNCATE through the tunnel, on by default
- `ENCRYPT_TUNNEL` - X25519 + AES-256-GCM on top of TLS, on by default
- `AUTO_UPDATE` - checks GitHub Releases and hot-swaps to a newer checksum-verified binary with zero downtime, off by default
- `UPDATE_CHECK_INTERVAL_MS` / `UPDATE_REPO` - only matter if `AUTO_UPDATE` is on

## Running as a service

Linux: systemd unit, something like

```ini
[Unit]
Description=SS14 AdminWeb Bridge
After=network.target

[Service]
WorkingDirectory=/opt/ss14-adminweb-bridge
ExecStart=/opt/ss14-adminweb-bridge/ss14-adminweb-bridge-linux-x64
Restart=on-failure
EnvironmentFile=/opt/ss14-adminweb-bridge/.env

[Install]
WantedBy=multi-user.target
```

Windows: run the `.exe` through NSSM or Task Scheduler on startup. The Bridge already handles its own crash-restart (and auto-update, if that's turned on) internally, so the service manager just has to keep it running.

## How it actually runs

There's a small supervisor process that spawns the real tunnel worker as a child and restarts it if it dies. If `AUTO_UPDATE` is on, the supervisor also does the update itself: downloads and checksum-verifies a new release, asks the current worker to open a handover window with the webserver, spawns the new worker, and only kills the old one once the new one confirms its tunnel is actually live.
