import type { ExpoConfig } from "expo/config";
import baseConfig from "./app.json";

const PREVIEW_SLOT = process.env.PREVIEW_SLOT;

const config: ExpoConfig = {
  ...baseConfig.expo,
  ...(PREVIEW_SLOT
    ? {
        name: `Dofek Preview ${PREVIEW_SLOT}`,
        slug: baseConfig.expo.slug,
        updates: {
          ...baseConfig.expo.updates,
          requestHeaders: {
            "expo-channel-name": `preview-${PREVIEW_SLOT}`,
          },
        },
        ios: {
          ...baseConfig.expo.ios,
          bundleIdentifier: `com.dofek.preview-${PREVIEW_SLOT}`,
        },
      }
    : {}),
};

export default config;
