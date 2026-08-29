const axios = require("axios");
const crypto = require("crypto");
const logger = require("./logger");

const VERSION = require("../package.json").version;

const SECRET_PATTERNS = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@\S+/gi,
  /\w*(pass(word)?|secret|token|api_?key|authorization|credential|dsn)\w*\s*[=:]\s*\S+/gi,
];

const IGNORED = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /getaddrinfo/i,
];

let enabled = false;
let endpoint = null;
let publicKey = null;
let environment = "production";
let serverId = null;

function isOptedIn() {
  const v = String(process.env.BRIDGE_ENABLE_TELEMETRY || "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function parseDsn(dsn) {
  const url = new URL(dsn);
  const projectId = url.pathname.replace(/^\//, "");
  if (!url.username || !projectId)
    throw new Error("DSN is missing a key or project id");

  return {
    endpoint: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
    publicKey: url.username,
  };
}

/** Strip anything secret-looking out of a string. */
function redact(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const pattern of SECRET_PATTERNS)
    out = out.replace(pattern, "[redacted]");
  return out;
}

function parseStack(stack) {
  if (typeof stack !== "string") return [];

  const frames = [];
  for (const line of stack.split("\n")) {
    // "    at fn (/path/file.js:12:34)" or "    at /path/file.js:12:34"
    const match = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!match) continue;

    frames.push({
      function: match[1] ? redact(match[1]) : "<anonymous>",
      filename: redact(match[2]),
      lineno: Number(match[3]),
      colno: Number(match[4]),
      // Anything outside node_modules is ours, which is what Sentry groups on.
      in_app: !match[2].includes("node_modules"),
    });
  }
  return frames.reverse();
}

function init(options = {}) {
  if (enabled) return true;

  if (!isOptedIn()) {
    logger.debug(
      "[Bridge] Crash reporting is off. Set BRIDGE_ENABLE_TELEMETRY=1 to send crash reports.",
    );
    return false;
  }

  if (!options.dsn) {
    logger.debug(
      "[Bridge] No telemetry DSN provided by the server, crash reporting is off",
    );
    return false;
  }

  try {
    const parsed = parseDsn(options.dsn);
    endpoint = parsed.endpoint;
    publicKey = parsed.publicKey;
    environment = options.environment || "production";
    serverId = options.serverId || null;
    enabled = true;

    logger.info(
      "[Bridge] Crash reporting enabled (no queries or credentials are sent)",
    );
    return true;
  } catch (error) {
    // A bad DSN must never stop the tunnel working.
    logger.warn(`[Bridge] Could not enable crash reporting: ${error.message}`);
    return false;
  }
}

function captureException(error, options = {}) {
  if (!enabled) return;

  const err = error instanceof Error ? error : new Error(String(error));
  const message = redact(err.message || "Unknown error");

  if (IGNORED.some((pattern) => pattern.test(message))) return;

  const event = {
    event_id: crypto.randomBytes(16).toString("hex"),
    timestamp: Date.now() / 1000,
    platform: "node",
    level: "error",
    logger: "bridge",
    release: `ss14-adminweb-bridge@${VERSION}`,
    environment,
    tags: {
      service: "bridge",
      ...(serverId ? { "server.id": serverId } : {}),
      ...(options.tags || {}),
    },
    contexts: {
      runtime: { name: "node", version: process.version },
      os: { name: process.platform },
    },
    ...(options.context ? { transaction: options.context } : {}),
    exception: {
      values: [
        {
          type: err.name || "Error",
          value: message,
          stacktrace: { frames: parseStack(err.stack) },
        },
      ],
    },
  };

  send(event);
}

function send(event) {
  const envelope =
    JSON.stringify({
      event_id: event.event_id,
      sent_at: new Date().toISOString(),
    }) +
    "\n" +
    JSON.stringify({ type: "event" }) +
    "\n" +
    JSON.stringify(event) +
    "\n";

  axios
    .post(endpoint, envelope, {
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${publicKey}, sentry_client=ss14-bridge/${VERSION}`,
      },
      timeout: 5000,
    })
    .catch((error) => {
      logger.debug(`[Bridge] Could not send crash report: ${error.message}`);
    });
}

function setupGlobalHandlers() {
  process.on("uncaughtException", (error) => {
    logger.error(`[Bridge] Uncaught exception: ${error.message}`);
    if (error.stack) logger.debug(error.stack);
    captureException(error, { tags: { handler: "uncaughtException" } });

    // Give the request a moment, then exit as Node would have.
    setTimeout(() => process.exit(1), 1000).unref();
  });

  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error(`[Bridge] Unhandled rejection: ${error.message}`);
    captureException(error, { tags: { handler: "unhandledRejection" } });
  });
}

module.exports = {
  init,
  captureException,
  setupGlobalHandlers,
  isEnabled: () => enabled,
  // Exported for tests.
  parseDsn,
  redact,
  parseStack,
};
