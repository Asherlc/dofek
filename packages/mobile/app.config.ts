import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExpoConfig } from "expo/config";
import { z } from "zod";

const PREVIEW_CHANNEL = process.env.PREVIEW_CHANNEL;

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectoryPath = dirname(currentFilePath);
const appJsonPath = join(currentDirectoryPath, "app.json");
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
