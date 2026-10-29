import { readFileSync } from "node:fs";
import { z } from "zod";
import mobileApp from "../packages/mobile/app.json";
import { verifyOtaUpdate } from "./verify-ota-update.ts";

const [metadataPath, channel, ...extra] = process.argv.slice(2);
if (!metadataPath || !channel || !/^(production|pr-\d+)$/.test(channel) || extra.length)
  throw new Error(
    "Usage: verify-published-ota.ts <xprem-update-metadata.json> <production|pr-number>",
  );
const branch = channel === "production" ? "main" : channel;
const [update] = z
  .tuple([
    z.object({
      id: z.string().min(1),
      platform: z.literal("ios"),
      runtimeVersion: z.string().min(1),
      branch: z.literal(branch),
    }),
  ])
  .parse(JSON.parse(readFileSync(metadataPath, "utf8")));
const certificatePath = new URL(
  `../packages/mobile/${mobileApp.expo.updates.codeSigningCertificate}`,
  import.meta.url,
);
const id = await verifyOtaUpdate({
  url: mobileApp.expo.updates.url,
  channel,
  expectedId: update.id,
  runtimeVersion: update.runtimeVersion,
  certificate: readFileSync(certificatePath, "utf8"),
  fetchImplementation: fetch,
});
console.log(
  `Verified published OTA update ${id}, runtime ${update.runtimeVersion}, device signature and asset bytes`,
);
