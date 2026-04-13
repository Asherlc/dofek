import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExpoConfig } from "expo/config";
import { z } from "zod";

const PREVIEW_CHANNEL = process.env.PREVIEW_CHANNEL;

const appJsonCandidatePaths = [
  join(process.cwd(), "app.json"),
  join(process.cwd(), "packages/mobile", "app.json"),
];
const appJsonPath = appJsonCandidatePaths.find((candidatePath) => existsSync(candidatePath));

if (!appJsonPath) {
  throw new Error("Unable to locate packages/mobile/app.json from current working directory");
}

const appJsonRaw = readFileSync(appJsonPath, "utf8");
const parsedAppJson: unknown = JSON.parse(appJsonRaw);

const AppJsonSchema = z.object({
  expo: z.custom<ExpoConfig>(
    (value) => typeof value === "object" && value !== null,
    "packages/mobile/app.json must include an expo configuration",
  ),
});

const baseConfig = AppJsonSchema.parse(parsedAppJson);

const config: ExpoConfig = {
  ...baseConfig.expo,
  extra: {
    ...baseConfig.expo.extra,
    router: {
      ignore: [/\.stories\.[tj]sx?$/],
    },
  },
  ...(PREVIEW_CHANNEL
    ? {
        name: "Dofek Preview",
        slug: baseConfig.expo.slug,
        updates: {
          ...baseConfig.expo.updates,
          requestHeaders: {
            "expo-channel-name": PREVIEW_CHANNEL,
          },
        },
        ios: {
          ...baseConfig.expo.ios,
          bundleIdentifier: "com.dofek.preview",
        },
      }
    : {}),
};

export default config;
