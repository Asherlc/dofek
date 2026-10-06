import assert from "node:assert/strict";
import { constants, createHash, generateKeyPairSync, privateEncrypt } from "node:crypto";
import { createRequire } from "node:module";

// Exercise the same dependency used by Expo's signing tooling.
const mobileRequire = createRequire(new URL("../packages/mobile/package.json", import.meta.url));
const expoRequire = createRequire(mobileRequire.resolve("expo/package.json"));
const cliRequire = createRequire(expoRequire.resolve("@expo/cli/package.json"));
const forge: {
  pki: { publicKeyFromPem(pem: string): { verify(digest: string, signature: string): boolean } };
} = cliRequire("node-forge");

const modulusLength = 2048;
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength,
  publicExponent: 3,
});
const verifier = forge.pki.publicKeyFromPem(
  publicKey.export({ type: "spki", format: "pem" }).toString(),
);
const digest = createHash("sha256").update("dependency security regression").digest();

function verifyDigestInfo(prefix: string) {
  const digestInfo = Buffer.concat([Buffer.from(prefix, "hex"), digest]);
  const encoded = Buffer.concat([
    Buffer.from([0, 1]),
    Buffer.alloc(modulusLength / 8 - digestInfo.length - 3, 0xff),
    Buffer.from([0]),
    digestInfo,
  ]);
  const signature = privateEncrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, encoded);
  return verifier.verify(digest.toString("binary"), signature.toString("binary"));
}

// Valid SHA-256 DigestInfo with and without optional NULL parameters.
assert.equal(verifyDigestInfo("3031300d060960864801650304020105000420"), true);
assert.equal(verifyDigestInfo("302f300b06096086480165030402010420"), true);

// An extra OCTET STRING inside DigestAlgorithm must never be accepted.
// https://github.com/digitalbazaar/forge/pull/1152
for (const prefix of [
  "30343010060960864801650304020105000401780420",
  "3032300e06096086480165030402010401780420",
]) {
  assert.throws(() => verifyDigestInfo(prefix), /does not contain a valid.*DigestInfo/);
}
console.log("node-forge signature security regressions passed.");
