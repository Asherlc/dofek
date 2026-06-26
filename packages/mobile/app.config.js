// This file is intentionally CommonJS JavaScript, not TypeScript. `eoas publish`
// runs `expo export` inside an isolated `pnpx`/`dlx` sandbox that has no local
// `typescript` install, so Expo falls back to Node's built-in
// `stripTypeScriptTypes` with `mode: 'transform'` — which Node 26 rejects
// (only `'strip'` is allowed), failing to read a `.ts` config. JSDoc below keeps
// `tsc`/editor type-checking without TypeScript syntax.

/** @typedef {import("expo/config").ExpoConfig} ExpoConfig */
/** @typedef {NonNullable<ExpoConfig["plugins"]>[number]} ExpoPlugin */

const PREVIEW_CHANNEL = process.env.PREVIEW_CHANNEL;
const PREVIEW_BUNDLE_IDENTIFIER = process.env.PREVIEW_BUNDLE_IDENTIFIER;

/**
 * @param {ExpoPlugin} plugin
 * @returns {ExpoPlugin}
 */
function withSentryDsn(plugin) {
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

/** @type {(context: import("expo/config").ConfigContext) => ExpoConfig} */
module.exports = ({ config }) => ({
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
