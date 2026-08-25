const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");
const { loadConfig } = require("./config");
const { checkForUpdate } = require("./updater");
const { baseDir } = require("./paths");

const CURRENT_POINTER = path.join(baseDir(), "bin", "current.json");
const CRASH_BACKOFF_MIN_MS = 2000;
const CRASH_BACKOFF_MAX_MS = 30000;
const HANDOVER_WINDOW_TIMEOUT_MS = 60000;

function currentBinaryPath() {
  if (fs.existsSync(CURRENT_POINTER)) {
    return JSON.parse(fs.readFileSync(CURRENT_POINTER, "utf8")).path;
  }
  return process.execPath;
}

function persistCurrentBinary(binaryPath) {
  fs.mkdirSync(path.dirname(CURRENT_POINTER), { recursive: true });
  fs.writeFileSync(
    CURRENT_POINTER,
    JSON.stringify({ path: binaryPath }, null, 2),
  );
}

function spawnWorker(binaryPath, onMessage) {
  const isSelf = binaryPath === process.execPath;
  const child = isSelf
    ? spawn(
        process.execPath,
        [__filename.replace("supervisor.js", "../index.js")],
        {
          env: { ...process.env, BRIDGE_WORKER: "1" },
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        },
      )
    : spawn(binaryPath, [], {
        env: { ...process.env, BRIDGE_WORKER: "1" },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });

  child.on("message", onMessage);
  return child;
}

function runSupervisor() {
  const config = loadConfig();
  let activeWorker = null;
  let candidateWorker = null;
  let expectingActiveExit = false;
  let crashBackoff = CRASH_BACKOFF_MIN_MS;

  function startActiveWorker() {
    const binaryPath = currentBinaryPath();
    activeWorker = spawnWorker(binaryPath, handleActiveMessage);

    activeWorker.on("exit", (code) => {
      if (expectingActiveExit) {
        expectingActiveExit = false;
        return;
      }
      logger.warn(
        `[Bridge] Worker exited unexpectedly (code ${code}), restarting in ${Math.round(crashBackoff / 1000)}s`,
      );
      setTimeout(startActiveWorker, crashBackoff);
      crashBackoff = Math.min(crashBackoff * 2, CRASH_BACKOFF_MAX_MS);
    });
  }

  function handleActiveMessage(message) {
    if (message.type === "ready") crashBackoff = CRASH_BACKOFF_MIN_MS;
    if (message.type === "handover-window-open") beginCandidateHandover();
  }

  function beginCandidateHandover() {
    if (!candidateWorker || !candidateWorker.__binaryPath) return;

    const binaryPath = candidateWorker.__binaryPath;
    candidateWorker = spawnWorker(binaryPath, (message) => {
      if (message.type !== "ready") return;

      logger.ready(
        "[Bridge] Candidate worker reported ready, retiring old worker",
      );
      expectingActiveExit = true;
      activeWorker.send({ type: "shutdown" });
      activeWorker = candidateWorker;
      candidateWorker = null;
      persistCurrentBinary(binaryPath);
    });
    candidateWorker.__binaryPath = binaryPath;
  }

  async function pollForUpdates() {
    if (!config.autoUpdate) return;

    try {
      const update = await checkForUpdate(config.updateRepo);
      if (update && activeWorker && !candidateWorker) {
        candidateWorker = { __binaryPath: update.path };
        activeWorker.send({ type: "prepare-handover" });

        setTimeout(() => {
          if (
            candidateWorker &&
            candidateWorker.__binaryPath === update.path &&
            !candidateWorker.pid
          ) {
            logger.warn(
              `[Bridge] Handover window for ${update.version} timed out, aborting update`,
            );
            candidateWorker = null;
          }
        }, HANDOVER_WINDOW_TIMEOUT_MS);
      }
    } catch (error) {
      logger.warn(`[Bridge] Update check failed: ${error.message}`);
    }

    setTimeout(pollForUpdates, config.updateCheckIntervalMs);
  }

  function shutdownSupervisor() {
    logger.warn("[Bridge] Shutting down...");
    expectingActiveExit = true;

    const workers = [activeWorker, candidateWorker].filter((w) => w && w.pid);
    if (workers.length === 0) {
      process.exit(0);
      return;
    }

    let pending = workers.length;
    const fallback = setTimeout(() => process.exit(0), 3000);

    for (const worker of workers) {
      worker.once("exit", () => {
        pending -= 1;
        if (pending <= 0) {
          clearTimeout(fallback);
          process.exit(0);
        }
      });
      worker.send({ type: "shutdown" });
    }
  }

  process.on("SIGINT", shutdownSupervisor);
  process.on("SIGTERM", shutdownSupervisor);

  startActiveWorker();
  setTimeout(pollForUpdates, config.updateCheckIntervalMs);
}

module.exports = { runSupervisor };
