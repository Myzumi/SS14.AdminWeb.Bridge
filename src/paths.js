const path = require("path");

function baseDir() {
  if (process.env.BRIDGE_HOME) return process.env.BRIDGE_HOME;
  return process.pkg ? path.dirname(process.execPath) : process.cwd();
}

function dataDir() {
  return path.join(baseDir(), ".bridge");
}

module.exports = { baseDir, dataDir };
