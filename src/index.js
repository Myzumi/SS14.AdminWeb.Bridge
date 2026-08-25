const { loadConfig, loadOrCreateIdentity, VERSION } = require("./config");
const { startWsClient } = require("./wsClient");
const logger = require("./logger");

function main() {
  logger.info(`[Bridge] SS14.AdminWeb.Bridge v${VERSION} starting...`);

  const config = loadConfig();
  const identity = loadOrCreateIdentity();
  const client = startWsClient(config, identity);

  process.on("message", (message) => {
    if (message.type === "prepare-handover") client.requestHandover();
    if (message.type === "shutdown") client.shutdown();
  });

  process.on("SIGINT", () => client.shutdown());
  process.on("SIGTERM", () => client.shutdown());
}

module.exports = { main };
