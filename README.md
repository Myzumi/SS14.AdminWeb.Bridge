# SS14.AdminWeb.Bridge

The AdminWeb.Bridge is a Bridging Service that Connects a Protected Postgres Database to the SS14.AdminWeb Ecosystem.
This is used if the Space Station 14 Postgres Database is behind either a Protected Firewall or has no access to the outside.
This Bridge connects to https://ss14adminweb.myzumi.dev (Default Environment Variable), gets its Configuration from the Webservice and initiates a Websocket Connection afterwards.
This Websocket will then function as a "Database Connection", Relaying Commands between the Webserver and the Postgres Database.

## Sentry

Version 0.1.2 Now comes with a Sentry Setup;
This is currently Defaulted to on, which can be disabled via the environment Variable `BRIDGE_DISABLE_TELEMETRY`.
Due to Complications with PGK (The Packaging that creates the Binaries), I've Shipped a custom written Sentry Client that is based on Axios.

Out of Security Reasons, It will Redact any Environment Variables set and will only supply the Error as well as the Connected Server ID (SS14.AdminWeb Specific)

The DSN URL Will be Supplied by the SS14.AdminWeb Environment when the Bridge gets its Configuration.

## Setup

Clone the Repository or Download the Release Binaries and put them on your Local Postgres Host.
Either Copy the Repositories `.env.example` or run the bridge for the first time and it creates it next to the Binary.
Note: Any Files the bridge needs or creates are put next to the Binary or its local .bridge folder next to it.

To Setup the Bridge, Go to your SS14.AdminWeb's Server, Select `Game Server` under the Settings and changing the Source to `Bridge`
Then Create a new Token and fill it inside the Bridge's .env `BRIDGE_TOKEN`
After that fill out your `PG_*` for your Local Postgres Database and Optionally edit the other Environment Variables to your Liking.

First run generates an identity keypair under `.bridge/identity.json` and prints a fingerprint, This one can be cross-checked in the Game Server's Source Settings.

## Environment Variables

- `BRIDGE_TOKEN`
  Required to run the Bridge Software, Authenticates with the Supplied `WEBSERVER_URL` Server.
- `WEBSERVER_URL`
  Where the Service is located at, defaults to "https://ss14adminweb.myzumi.dev"
- `PG_HOST` / `PG_PORT` / `PG_DATABASE` / `PG_USER` / `PG_PASSWORD`
  Is your Local Postgres Access Data.
- `BLOCK_WRITE_COMMANDS`
  Blocks all SQL Commands that contains DELETE/UPDATE/INSERT/DROP/ALTER/TRUNCATE, This is enabled by Default for Security Reasons.
- `ENCRYPT_TUNNEL` -
  Encrypts the Tunnel with X25519 and AES-256-GCM on top of TLS, on by default
- `AUTO_UPDATE`
  Checks the Github Repository for any new Releases and Updates the Bridge Software Automatically without a downtime. Off by Default.
- `UPDATE_CHECK_INTERVAL_MS` / `UPDATE_REPO`
  The Interval to check the supplied Repository at.

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
