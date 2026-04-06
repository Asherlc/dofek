import type { ExpoConfig } from "expo/config";
import baseConfig from "./app.json";

const PREVIEW_CHANNEL = process.env.PREVIEW_CHANNEL;

const config: ExpoConfig = {
  ...baseConfig.expo,
  ...(PREVIEW_CHANNEL
    ? {
        name: `Dofek Preview`,
        slug: baseConfig.expo.slug,
        updates: {
          ...baseConfig.expo.updates,
          requestHeaders: {
            "expo-channel-name": PREVIEW_CHANNEL,
          },
        },
        ios: {
          ...baseConfig.expo.ios,
          bundleIdentifier: `com.dofek.preview`,
        },
      }
    : {}),
};

export default config;
