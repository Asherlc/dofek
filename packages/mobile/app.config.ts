import type { ConfigContext, ExpoConfig } from "expo/config";

const PREVIEW_CHANNEL = process.env.PREVIEW_CHANNEL;
const PREVIEW_BUNDLE_IDENTIFIER = process.env.PREVIEW_BUNDLE_IDENTIFIER;

type ExpoPlugin = NonNullable<ExpoConfig["plugins"]>[number];

function withSentryDsn(plugin: ExpoPlugin): ExpoPlugin {
  const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

  if (!Array.isArray(plugin) || plugin[0] !== "@sentry/react-native/expo" || !sentryDsn) {
    return plugin;
  }

  const pluginOptions = plugin[1];
  if (typeof pluginOptions !== "object" || pluginOptions === null) {
    return plugin;
  }

  return [
    plugin[0],
    {
      ...pluginOptions,
      options: {
        ...("options" in pluginOptions &&
        typeof pluginOptions.options === "object" &&
        pluginOptions.options !== null
          ? pluginOptions.options
          : {}),
        dsn: sentryDsn,
      },
    },
  ];
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name || "Dofek",
  slug: config.slug || "dofek",
  plugins: config.plugins?.map(withSentryDsn),
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
