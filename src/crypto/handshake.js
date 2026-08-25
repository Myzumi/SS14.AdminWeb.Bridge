const crypto = require("crypto");

function publicKeyFromBase64(publicKeyBase64) {
  return crypto.createPublicKey({
    key: {
      kty: "OKP",
      crv: "X25519",
      x: Buffer.from(publicKeyBase64, "base64").toString("base64url"),
    },
    format: "jwk",
  });
}

function deriveSessionKeys(
  privateKeyObject,
  remotePublicKeyBase64,
  localNonce,
  remoteNonce,
  isInitiator,
) {
  const remotePublicKey = publicKeyFromBase64(remotePublicKeyBase64);
  const sharedSecret = crypto.diffieHellman({
    privateKey: privateKeyObject,
    publicKey: remotePublicKey,
  });

  const salt = Buffer.concat([localNonce, remoteNonce].sort(Buffer.compare));

  const initiatorToResponderKey = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      sharedSecret,
      salt,
      "ss14-adminweb-bridge-tunnel:i2r",
      32,
    ),
  );
  const responderToInitiatorKey = Buffer.from(
    crypto.hkdfSync(
      "sha256",
      sharedSecret,
      salt,
      "ss14-adminweb-bridge-tunnel:r2i",
      32,
    ),
  );

  return isInitiator
    ? { sendKey: initiatorToResponderKey, recvKey: responderToInitiatorKey }
    : { sendKey: responderToInitiatorKey, recvKey: initiatorToResponderKey };
}

module.exports = { publicKeyFromBase64, deriveSessionKeys };
