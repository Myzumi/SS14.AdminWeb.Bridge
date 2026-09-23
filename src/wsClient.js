const WebSocket = require("ws");
const axios = require("axios");
const crypto = require("crypto");
const logger = require("./logger");
const { VERSION } = require("./config");
const { deriveSessionKeys } = require("./crypto/handshake");
const { createEnvelope } = require("./crypto/envelope");
const { createGuardedPool, testConnection } = require("./postgres");

const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 60000;
const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 90000;
const STATS_INTERVAL_MS = 5 * 60 * 1000;

async function runQuery(pool, request, stats) {
  const { id, sql, params = [] } = request;
  const startedAt = Date.now();

  try {
    const result = await pool.query(sql, params);
    const ms = Date.now() - startedAt;
    stats.queries += 1;
    stats.latencyMs += ms;
    logger.debug(
      `[Bridge] Query ok ${ms}ms (${result.rowCount ?? result.rows.length} rows)`,
    );
    return {
      id,
      type: "rpc:response",
      result: { rows: result.rows, rowCount: result.rowCount },
    };
  } catch (error) {
    const ms = Date.now() - startedAt;
    stats.queries += 1;
    stats.failed += 1;
    stats.latencyMs += ms;
    logger.warn(`[Bridge] Query failed after ${ms}ms: ${error.message}`);
    return { id, type: "rpc:error", error: error.message };
  }
}

async function fetchRemoteConfig(webserverUrl, bridgeToken) {
  const res = await axios.post(
    `${webserverUrl}/api/bridge/config`,
    {},
    { headers: { "x-bridge-token": bridgeToken }, timeout: 10000 },
  );

  logger.info(
    `[Bridge] Registered with AdminWeb as server "${res.data.serverName}"`,
  );
  return res.data;
}

function notifySupervisor(message) {
  if (typeof process.send === "function") process.send(message);
}

function startWsClient(config, identity) {
  let ws = null;
  let envelope = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let statsTimer = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let lastHeartbeatAck = 0;
  let shuttingDown = false;

  // Rolling counters for the periodic summary line - reset each time we report.
  const stats = { queries: 0, failed: 0, latencyMs: 0 };

  const pool = createGuardedPool(config.pg, config.blockWriteCommands);

  function reportStats() {
    if (stats.queries === 0) return; // stay quiet when nothing happened this window
    const avg = Math.round(stats.latencyMs / stats.queries);
    logger.info(
      `[Bridge] Last ${STATS_INTERVAL_MS / 60000}m: ${stats.queries} queries (${stats.failed} failed), avg ${avg}ms`,
    );
    stats.queries = 0;
    stats.failed = 0;
    stats.latencyMs = 0;
  }

  function send(message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(envelope ? envelope.seal(message) : message));
  }

  function scheduleReconnect() {
    if (shuttingDown) return;
    clearInterval(heartbeatTimer);
    logger.warn(
      `[Bridge] Reconnecting in ${Math.round(reconnectDelay / 1000)}s...`,
    );
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  async function connect() {
    if (shuttingDown) return;

    let remoteConfig;
    try {
      remoteConfig = await fetchRemoteConfig(
        config.webserverUrl,
        config.bridgeToken,
      );
    } catch (error) {
      logger.error(
        `[Bridge] Failed to fetch config from webserver: ${error.message}`,
      );
      scheduleReconnect();
      return;
    }

    const pgOk = await testConnection(pool);
    if (!pgOk)
      logger.warn(
        "[Bridge] Postgres connection test failed, tunnel will still connect but queries will fail",
      );

    const useEncryption = remoteConfig.encryptTunnel ?? config.encryptTunnel;

    const wsUrl = `${config.webserverUrl.replace(/^http/, "ws")}${remoteConfig.wsPath}`;
    ws = new WebSocket(wsUrl, {
      headers: { "x-bridge-token": config.bridgeToken },
    });

    ws.on("open", () => {
      logger.info(
        `[Bridge] Tunnel socket open, handshaking as "${remoteConfig.serverName}"...`,
      );
      const localNonce = crypto.randomBytes(16);
      ws.__localNonce = localNonce;
      ws.send(
        JSON.stringify({
          type: "hello",
          publicKey: identity.publicKeyBase64,
          nonce: localNonce.toString("base64"),
          version: VERSION,
        }),
      );
    });

    ws.on("message", async (raw) => {
      let message;
      try {
        const parsed = JSON.parse(raw.toString());
        message =
          envelope && parsed.n && parsed.ct ? envelope.open(parsed) : parsed;
      } catch (error) {
        logger.warn(
          `[Bridge] Received malformed tunnel message: ${error.message}`,
        );
        return;
      }

      if (message.type === "hello-ack") {
        const remoteNonce = Buffer.from(message.nonce, "base64");
        const sessionKeys = deriveSessionKeys(
          identity.privateKeyObject,
          message.publicKey,
          ws.__localNonce,
          remoteNonce,
          true, // we always send "hello" first
        );
        envelope = useEncryption ? createEnvelope(sessionKeys) : null;
        reconnectDelay = RECONNECT_MIN_MS;
        lastHeartbeatAck = 0;
        heartbeatTimer = setInterval(() => {
          if (
            lastHeartbeatAck &&
            Date.now() - lastHeartbeatAck > HEARTBEAT_TIMEOUT_MS
          ) {
            clearInterval(heartbeatTimer);
            logger.warn(
              `[Bridge] No heartbeat response for ${Math.round(HEARTBEAT_TIMEOUT_MS / 1000)}s, dropping the tunnel`,
            );
            ws.terminate();
            return;
          }
          send({ type: "heartbeat" });
        }, HEARTBEAT_INTERVAL_MS);
        logger.ready(
          `[Bridge] Tunnel established for server "${remoteConfig.serverName}" (${useEncryption ? "encrypted" : "plaintext"})`,
        );
        send({ type: "ready" });
        notifySupervisor({ type: "ready" });
        return;
      }

      if (message.type === "heartbeat-ack") {
        lastHeartbeatAck = Date.now();
        return;
      }

      if (message.type === "restart-notice-ack") {
        notifySupervisor({ type: "handover-window-open" });
        return;
      }

      if (message.type === "rpc") {
        send(await runQuery(pool, message, stats));
      }
    });

    ws.on("close", (code, reason) => {
      clearInterval(heartbeatTimer);
      envelope = null;
      logger.warn(`[Bridge] Tunnel closed (${code} ${reason || ""})`);
      scheduleReconnect();
    });

    ws.on("error", (error) => {
      logger.error(`[Bridge] Tunnel socket error: ${error.message}`);
    });
  }

  function requestHandover() {
    send({ type: "restart-notice" });
  }

  function shutdown() {
    shuttingDown = true;
    clearInterval(heartbeatTimer);
    clearInterval(statsTimer);
    clearTimeout(reconnectTimer);
    reportStats();
    pool.end().catch(() => {});

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.once("close", () => process.exit(0));
      ws.close(1000, "shutdown");
      setTimeout(() => process.exit(0), 2000);
    } else {
      process.exit(0);
    }
  }

  statsTimer = setInterval(reportStats, STATS_INTERVAL_MS);
  connect();

  return { requestHandover, shutdown };
}

module.exports = { startWsClient };
