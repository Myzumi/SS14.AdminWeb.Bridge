const path = require("path");

function baseDir() {
  return process.pkg ? path.dirname(process.execPath) : process.cwd();
}

module.exports = { baseDir };
