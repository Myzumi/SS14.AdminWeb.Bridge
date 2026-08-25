const chalk = require("chalk");

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function line(color, msg) {
  return `${chalk.gray(ts())} ${chalk[color](msg)}`;
}

function info(msg) {
  console.log(line("cyan", msg));
}

function ready(msg) {
  console.log(line("green", msg));
}

function warn(msg) {
  console.warn(line("yellow", msg));
}

function error(msg) {
  console.error(line("red", msg));
}

function debug(msg) {
  const v = String(process.env.DEBUG || "")
    .trim()
    .toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "no") return;
  console.log(line("gray", msg));
}

module.exports = { info, ready, warn, error, debug };
