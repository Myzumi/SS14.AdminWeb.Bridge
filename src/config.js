const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");
const { baseDir, dataDir } = require("./paths");

const VERSION = require("../package.json").version;

const IDENTITY_DIR = dataDir();
const IDENTITY_FILE = path.join(IDENTITY_DIR, "identity.json");
const ENV_FILE = path.join(baseDir(), ".env");

const ENV_TEMPLATE = `# Token issued by DataSourceSettings.vue when you set a server's data source to "Bridge"
BRIDGE_TOKEN=

# Base URL of the SS14.AdminWeb webserver this Bridge reports to
WEBSERVER_URL=https://ss14adminweb.myzumi.dev

# Local Postgres connection for the SS14 game server database
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=ss14
PG_USER=postgres
PG_PASSWORD=

# Reject DELETE/UPDATE/INSERT/DROP/ALTER/TRUNCATE queries coming through the tunnel
BLOCK_WRITE_COMMANDS=true

# Encrypt tunnel traffic on top of TLS using an X25519/AES-256-GCM handshake
ENCRYPT_TUNNEL=true

# Optional: automatically download and hot-swap newer checksum-verified binaries (default off)
AUTO_UPDATE=false
UPDATE_CHECK_INTERVAL_MS=21600000
UPDATE_REPO=Myzumi/SS14.AdminWeb.Bridge

# Optional: set to 1/true to log every relayed query (method + duration). Off by default; a 5-minute
# summary line is always logged regardless.
DEBUG=
`;

function parseBool(value, def) {
  if (value === undefined) return def;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function loadConfig() {
  const bridgeToken = process.env.BRIDGE_TOKEN;
  if (!bridgeToken) {
    if (fs.existsSync(ENV_FILE)) {
      logger.error(
        "[Bridge] BRIDGE_TOKEN is not set in .env, get one from DataSourceSettings on your AdminWeb server",
      );
    } else {
      fs.writeFileSync(ENV_FILE, ENV_TEMPLATE);
      logger.warn(
        `[Bridge] No .env found, wrote one at ${ENV_FILE} - fill it out and restart`,
      );
    }
    process.exit(1);
  }

  return {
    bridgeToken,
    webserverUrl: (
      process.env.WEBSERVER_URL || "https://ss14adminweb.myzumi.dev"
    ).replace(/\/+$/, ""),
    pg: {
      host: process.env.PG_HOST || "localhost",
      port: parseInt(process.env.PG_PORT || "5432", 10),
      database: process.env.PG_DATABASE || "ss14",
      user: process.env.PG_USER || "postgres",
      password: process.env.PG_PASSWORD || "",
    },
    blockWriteCommands: parseBool(process.env.BLOCK_WRITE_COMMANDS, true),
    encryptTunnel: parseBool(process.env.ENCRYPT_TUNNEL, true),
    autoUpdate: parseBool(process.env.AUTO_UPDATE, false),
    updateCheckIntervalMs: parseInt(
      process.env.UPDATE_CHECK_INTERVAL_MS || "21600000",
      10,
    ),
    updateRepo: process.env.UPDATE_REPO || "Myzumi/SS14.AdminWeb.Bridge",
  };
}

function exportRawKey(keyObject, type) {
  const jwk = keyObject.export({ format: "jwk" });
  const field = type === "public" ? jwk.x : jwk.d;
  return Buffer.from(field, "base64url").toString("base64");
}

function fingerprint(publicKeyBase64) {
  return crypto
    .createHash("sha256")
    .update(Buffer.from(publicKeyBase64, "base64"))
    .digest("hex")
    .slice(0, 16);
}

function loadOrCreateIdentity() {
  if (fs.existsSync(IDENTITY_FILE)) {
    const raw = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf8"));
    const privateKeyObject = crypto.createPrivateKey({
      key: {
        kty: "OKP",
        crv: "X25519",
        x: Buffer.from(raw.publicKey, "base64").toString("base64url"),
        d: Buffer.from(raw.privateKey, "base64").toString("base64url"),
      },
      format: "jwk",
    });
    const publicKeyObject = crypto.createPublicKey({
      key: {
        kty: "OKP",
        crv: "X25519",
        x: Buffer.from(raw.publicKey, "base64").toString("base64url"),
      },
      format: "jwk",
    });

    logger.info(
      `[Bridge] Loaded existing identity (fingerprint ${fingerprint(raw.publicKey)})`,
    );
    return {
      publicKeyBase64: raw.publicKey,
      privateKeyObject,
      publicKeyObject,
    };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const publicKeyBase64 = exportRawKey(publicKey, "public");
  const privateKeyBase64 = exportRawKey(privateKey, "private");

  fs.mkdirSync(IDENTITY_DIR, { recursive: true });
  fs.writeFileSync(
    IDENTITY_FILE,
    JSON.stringify(
      { publicKey: publicKeyBase64, privateKey: privateKeyBase64 },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  try {
    fs.chmodSync(IDENTITY_FILE, 0o600); // Windows ignores this, that's fine
  } catch {
    // platform has no POSIX permission bits, nothing we can do about it
  }

  logger.ready(
    `[Bridge] Generated a new identity (fingerprint ${fingerprint(publicKeyBase64)})`,
  );
  logger.warn(
    "[Bridge] Cross-check that fingerprint against DataSourceSettings on first connect (TOFU pinning)",
  );

  return {
    publicKeyBase64,
    privateKeyObject: privateKey,
    publicKeyObject: publicKey,
  };
}

module.exports = { VERSION, loadConfig, loadOrCreateIdentity, parseBool };
