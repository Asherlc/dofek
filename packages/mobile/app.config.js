// Keep Expo configuration executable by Node without a TypeScript loader.
// JSDoc retains editor and compiler checks without TypeScript syntax.

/** @typedef {import("expo/config").ExpoConfig} ExpoConfig */
/** @typedef {NonNullable<ExpoConfig["plugins"]>[number]} ExpoPlugin */

const PREVIEW_CHANNEL = process.env.PREVIEW_CHANNEL;
const PREVIEW_BUNDLE_IDENTIFIER = process.env.PREVIEW_BUNDLE_IDENTIFIER;

function requireSentryDsn() {
  const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN?.trim();
  if (!sentryDsn) {
    throw new Error("EXPO_PUBLIC_SENTRY_DSN is required to configure native Sentry.");
  }
  return sentryDsn;
}

function requireExpoAppId() {
  const appId = process.env.EXPO_APP_ID?.trim();
  if (!appId) throw new Error("EXPO_APP_ID is required to configure OTA application identity.");
  return appId;
}

/**
 * @param {ExpoPlugin} plugin
 * @param {string} sentryDsn
 * @returns {ExpoPlugin}
 */
function withSentryDsn(plugin, sentryDsn) {
  if (!Array.isArray(plugin) || plugin[0] !== "@sentry/react-native/expo") {
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

/**
 * @param {ExpoConfig["plugins"]} plugins
 * @returns {ExpoConfig["plugins"]}
 */
function withRequiredSentryDsn(plugins) {
  const sentryDsn = requireSentryDsn();
  return plugins?.map((plugin) => withSentryDsn(plugin, sentryDsn));
}

/** @type {(context: import("expo/config").ConfigContext) => ExpoConfig} */
module.exports = ({ config }) => ({
  ...config,
  name: config.name || "Dofek",
  slug: config.slug || "dofek",
  plugins: withRequiredSentryDsn(config.plugins),
  updates: {
    ...config.updates,
    requestHeaders: {
      ...config.updates?.requestHeaders,
      "expo-app-id": requireExpoAppId(),
      ...(PREVIEW_CHANNEL ? { "expo-channel-name": PREVIEW_CHANNEL } : {}),
    },
  },
  ...(PREVIEW_CHANNEL
    ? {
        name: "Dofek Preview",
        ios: {
          ...config.ios,
          bundleIdentifier:
            PREVIEW_BUNDLE_IDENTIFIER?.trim() || config.ios?.bundleIdentifier || "com.dofek.app",
        },
      }
    : {}),
});
