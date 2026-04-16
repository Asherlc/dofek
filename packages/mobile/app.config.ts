import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExpoConfig } from "expo/config";
import { z } from "zod";

const PREVIEW_CHANNEL = process.env.PREVIEW_CHANNEL;
const PREVIEW_BUNDLE_IDENTIFIER = process.env.PREVIEW_BUNDLE_IDENTIFIER;
const HEALTH_KIT_PLUGIN_PATH = "./plugins/with-healthkit-entitlements";
const REQUIRED_HEALTH_KIT_ENTITLEMENTS = [
  "com.apple.developer.healthkit",
  "com.apple.developer.healthkit.background-delivery",
  "com.apple.developer.healthkit.access",
] as const;
const REQUIRED_HEALTH_KIT_USAGE_KEYS = [
  "NSHealthShareUsageDescription",
  "NSHealthUpdateUsageDescription",
] as const;

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

function hasHealthKitPlugin(plugins: ExpoConfig["plugins"]): boolean {
  if (!plugins) {
    return false;
  }
  return plugins.some((plugin) => {
    if (typeof plugin === "string") {
      return plugin === HEALTH_KIT_PLUGIN_PATH;
    }
    if (Array.isArray(plugin)) {
      const [pluginName] = plugin;
      return pluginName === HEALTH_KIT_PLUGIN_PATH;
    }
    return false;
  });
}

function getRequiredString(
  infoPlist: Record<string, unknown>,
  key: (typeof REQUIRED_HEALTH_KIT_USAGE_KEYS)[number],
): string {
  const value = infoPlist[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required iOS Info.plist value "${key}" for Apple Health permissions.`);
  }
  return value;
}

function assertHealthKitBuildPrerequisites(configToValidate: ExpoConfig): void {
  if (!hasHealthKitPlugin(configToValidate.plugins)) {
    throw new Error(
      `Missing required Expo plugin "${HEALTH_KIT_PLUGIN_PATH}". This must be configured so Apple Health entitlements are always written during prebuild.`,
    );
  }

  const iosConfig = configToValidate.ios;
  if (!iosConfig) {
    throw new Error("Missing iOS config. Apple Health integration requires an iOS configuration.");
  }

  const entitlements =
    typeof iosConfig.entitlements === "object" &&
    iosConfig.entitlements !== null &&
    !Array.isArray(iosConfig.entitlements)
      ? iosConfig.entitlements
      : {};
  for (const entitlementKey of REQUIRED_HEALTH_KIT_ENTITLEMENTS) {
    const val = entitlements[entitlementKey];
    if (val !== true && !(Array.isArray(val) && val.length > 0)) {
      throw new Error(
        `Missing required iOS entitlement "${entitlementKey}" in app config. Apple Health must be enabled at build time.`,
      );
    }
  }

  const infoPlist =
    typeof iosConfig.infoPlist === "object" &&
    iosConfig.infoPlist !== null &&
    !Array.isArray(iosConfig.infoPlist)
      ? iosConfig.infoPlist
      : {};
  for (const requiredUsageKey of REQUIRED_HEALTH_KIT_USAGE_KEYS) {
    getRequiredString(infoPlist, requiredUsageKey);
  }
}

const config: ExpoConfig = {
  ...baseConfig.expo,
  extra: {
    ...baseConfig.expo.extra,
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
          ...(typeof PREVIEW_BUNDLE_IDENTIFIER === "string" &&
          PREVIEW_BUNDLE_IDENTIFIER.trim().length > 0
            ? { bundleIdentifier: PREVIEW_BUNDLE_IDENTIFIER.trim() }
            : {}),
        },
      }
    : {}),
};

assertHealthKitBuildPrerequisites(config);

export default config;
