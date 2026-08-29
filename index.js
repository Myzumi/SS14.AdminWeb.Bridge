const path = require("path");
const { baseDir } = require("./src/paths");

if (!process.env.BRIDGE_HOME) process.env.BRIDGE_HOME = baseDir();

require("dotenv").config({ path: path.join(baseDir(), ".env") });

require("./src/sentry").setupGlobalHandlers();

if (process.env.BRIDGE_WORKER) {
  require("./src/index").main();
} else {
  const logger = require("./src/logger");
  const { VERSION } = require("./src/config");
  logger.info(`[Bridge] SS14.AdminWeb.Bridge v${VERSION} (supervisor)`);
  require("./src/supervisor").runSupervisor();
}
