const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");
const { VERSION } = require("./config");
const { baseDir } = require("./paths");

const BIN_DIR = path.join(baseDir(), "bin");

function platformSuffix() {
  if (process.platform === "win32") return "win-x64.exe";
  return "linux-x64";
}

function isNewer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

async function checkForUpdate(repo) {
  const { data: release } = await axios.get(
    `https://api.github.com/repos/${repo}/releases/latest`,
    {
      headers: { Accept: "application/vnd.github+json" },
      timeout: 10000,
    },
  );

  const latestVersion = release.tag_name.replace(/^v/, "");
  if (!isNewer(latestVersion, VERSION)) return null;

  const suffix = platformSuffix();
  const binaryAsset = release.assets.find((a) => a.name.endsWith(suffix));
  const checksumAsset = release.assets.find(
    (a) => a.name === `${binaryAsset?.name}.sha256`,
  );

  if (!binaryAsset || !checksumAsset) {
    logger.warn(
      `[Bridge] Release ${latestVersion} is missing a binary or checksum for this platform, skipping`,
    );
    return null;
  }

  logger.info(
    `[Bridge] Downloading Bridge ${latestVersion} (${binaryAsset.name})...`,
  );

  const [binaryRes, checksumRes] = await Promise.all([
    axios.get(binaryAsset.browser_download_url, {
      responseType: "arraybuffer",
      timeout: 60000,
    }),
    axios.get(checksumAsset.browser_download_url, {
      responseType: "text",
      timeout: 10000,
    }),
  ]);

  const binaryBuffer = Buffer.from(binaryRes.data);
  const expectedHash = checksumRes.data.trim().split(/\s+/)[0];
  const actualHash = crypto
    .createHash("sha256")
    .update(binaryBuffer)
    .digest("hex");

  if (actualHash !== expectedHash) {
    logger.error(
      `[Bridge] Checksum mismatch for ${binaryAsset.name}, discarding download`,
    );
    return null;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const outPath = path.join(
    BIN_DIR,
    `bridge-${latestVersion}${suffix.endsWith(".exe") ? ".exe" : ""}`,
  );
  fs.writeFileSync(outPath, binaryBuffer);
  if (process.platform !== "win32") fs.chmodSync(outPath, 0o755);

  logger.ready(
    `[Bridge] Verified and staged Bridge ${latestVersion} at ${outPath}`,
  );
  return { version: latestVersion, path: outPath };
}

module.exports = { checkForUpdate, isNewer };
