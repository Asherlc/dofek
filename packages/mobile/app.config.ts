import type { ConfigContext, ExpoConfig } from "expo/config";

const PREVIEW_CHANNEL = process.env.PREVIEW_CHANNEL;
const PREVIEW_BUNDLE_IDENTIFIER = process.env.PREVIEW_BUNDLE_IDENTIFIER;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name || "Dofek",
  slug: config.slug || "dofek",
  ...(PREVIEW_CHANNEL
    ? {
        name: "Dofek Preview",
        updates: {
          ...config.updates,
          requestHeaders: {
            ...config.updates?.requestHeaders,
            "expo-channel-name": PREVIEW_CHANNEL,
          },
        },
        ios: {
          ...config.ios,
          bundleIdentifier:
            PREVIEW_BUNDLE_IDENTIFIER?.trim() || config.ios?.bundleIdentifier || "com.dofek.app",
        },
      }
    : {}),
});
