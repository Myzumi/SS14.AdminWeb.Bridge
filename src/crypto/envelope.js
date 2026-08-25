const crypto = require("crypto");

const ALGO = "aes-256-gcm";

function createEnvelope({ sendKey, recvKey }) {
  let sendCounter = 0;

  function seal(message) {
    const nonce = Buffer.alloc(12);
    nonce.writeUIntBE(sendCounter++, 6, 6);

    const cipher = crypto.createCipheriv(ALGO, sendKey, nonce);
    const plaintext = Buffer.from(JSON.stringify(message), "utf8");
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);

    return { n: nonce.toString("base64"), ct: ciphertext.toString("base64") };
  }

  function open(envelope) {
    const nonce = Buffer.from(envelope.n, "base64");
    const data = Buffer.from(envelope.ct, "base64");
    const authTag = data.subarray(data.length - 16);
    const ciphertext = data.subarray(0, data.length - 16);

    const decipher = crypto.createDecipheriv(ALGO, recvKey, nonce);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return JSON.parse(plaintext.toString("utf8"));
  }

  return { seal, open };
}

module.exports = { createEnvelope };
