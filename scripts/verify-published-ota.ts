import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import mobileApp from "../packages/mobile/app.json";
import { verifyOtaUpdate } from "./verify-ota-update.ts";

const [metadataPath, channel, runtimeVersion, ...extra] = process.argv.slice(2);
if (
  !metadataPath ||
  !channel ||
  !runtimeVersion ||
  !/^(production|pr-\d+)$/.test(channel) ||
  extra.length
)
  throw new Error(
    "Usage: verify-published-ota.ts <xprem-update-metadata.json> <production|pr-number> <runtime-version>",
  );
const appId = z
  .string({ error: "EXPO_APP_ID is required" })
  .trim()
  .min(1, "EXPO_APP_ID is required")
  .parse(process.env.EXPO_APP_ID);
const branch = channel === "production" ? "main" : channel;
const receiptSchema = z.tuple([
  z.object({
    id: z.string().min(1),
    platform: z.literal("ios"),
    runtimeVersion: z.literal(runtimeVersion),
    branch: z.literal(branch),
  }),
]);
const hasReceipt = existsSync(metadataPath);
const expectation = (() => {
  if (hasReceipt) {
    const [update] = receiptSchema.parse(JSON.parse(readFileSync(metadataPath, "utf8")));
    return { expectedId: update.id };
  }
  const exportDirectory = dirname(metadataPath);
  const {
    fileMetadata: { ios },
  } = z
    .object({
      fileMetadata: z.object({
        ios: z.object({
          bundle: z.string().min(1),
          assets: z.array(z.object({ path: z.string().min(1) })),
        }),
      }),
    })
    .parse(JSON.parse(readFileSync(join(exportDirectory, "metadata.json"), "utf8")));
  const hashFile = (path: string) =>
    createHash("sha256")
      .update(readFileSync(join(exportDirectory, path)))
      .digest("base64url");
  return {
    expectedContent: {
      launchAssetHash: hashFile(ios.bundle),
      assetHashes: ios.assets.map((asset) => hashFile(asset.path)),
    },
  };
})();
const certificatePath = new URL(
  `../packages/mobile/${mobileApp.expo.updates.codeSigningCertificate}`,
  import.meta.url,
);
const id = await verifyOtaUpdate({
  appId,
  url: mobileApp.expo.updates.url,
  channel,
  ...expectation,
  runtimeVersion,
  certificate: readFileSync(certificatePath, "utf8"),
  fetchImplementation: fetch,
});
if (!hasReceipt) {
  writeFileSync(
    metadataPath,
    JSON.stringify([{ id, platform: "ios", runtimeVersion, branch }], null, 2),
  );
}
console.log(
  `Verified OTA update ${id}, runtime ${runtimeVersion}, device signature and asset bytes`,
);
