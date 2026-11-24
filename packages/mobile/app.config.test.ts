import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeSentryOptions } from "@sentry/react-native/plugin/build/utils";
import type { ConfigContext, ExpoConfig } from "expo/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createConfig from "./app.config";
import appJson from "./app.json";
import sentryPodspec from "./plugins/Sentry.podspec.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function findSentryPluginOptions(config: ExpoConfig): Record<string, unknown> | undefined {
  const plugins = config.plugins ?? [];

  for (const plugin of plugins) {
    if (Array.isArray(plugin) && plugin[0] === "@sentry/react-native/expo") {
      const options = plugin[1];
      return isRecord(options) ? options : undefined;
    }
  }

  return undefined;
}

describe("mobile app config", () => {
  beforeEach(() => {
    vi.stubEnv("EXPO_APP_ID", "test-app-id");
    vi.stubEnv("EXPO_PUBLIC_SENTRY_DSN", "https://key@o123.ingest.us.sentry.io/456");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("includes the required OTA app identity while preserving configured headers", () => {
    const config = createConfig({
      config: {
        name: "Dofek",
        slug: "dofek",
        updates: { requestHeaders: { custom: "preserved" } },
      },
    } satisfies ConfigContext);
    expect(config.updates?.requestHeaders).toEqual({
      custom: "preserved",
      "expo-app-id": "test-app-id",
    });
  });

  it("fails when the OTA application identity is missing", () => {
    vi.stubEnv("EXPO_APP_ID", " ");
    expect(() =>
      createConfig({ config: { name: "Dofek", slug: "dofek" } } satisfies ConfigContext),
    ).toThrow("EXPO_APP_ID is required");
  });

  it("retains OTA application identity when selecting a preview channel", async () => {
    vi.stubEnv("PREVIEW_CHANNEL", "pr-123");
    vi.resetModules();
    const { default: previewConfig } = await import("./app.config");
    const config = previewConfig({
      config: { name: "Dofek", slug: "dofek" },
    } satisfies ConfigContext);
    expect(config.updates?.requestHeaders).toEqual({
      "expo-app-id": "test-app-id",
      "expo-channel-name": "pr-123",
    });
  });
  it("does not block cold start on network OTA delivery", () => {
    vi.stubEnv("EXPO_PUBLIC_SENTRY_DSN", "https://key@o123.ingest.us.sentry.io/456");

    const config = createConfig({
      config: {
        name: "Dofek",
        slug: "dofek",
        updates: {
          fallbackToCacheTimeout: appJson.expo.updates.fallbackToCacheTimeout,
        },
      } satisfies ExpoConfig,
    } satisfies ConfigContext);

    expect(config.updates?.fallbackToCacheTimeout).toBe(0);
  });

  it("uses EXPO_PUBLIC_SENTRY_DSN for native Sentry initialization", () => {
    vi.stubEnv("EXPO_PUBLIC_SENTRY_DSN", "https://key@o123.ingest.us.sentry.io/456");

    const config = createConfig({
      config: {
        name: "Dofek",
        slug: "dofek",
        plugins: [
          [
            "@sentry/react-native/expo",
            {
              organization: "east-bay-software",
              project: "dofek-mobile",
              useNativeInit: true,
              options: {
                dsn: "https://key@legacy.example/3",
                enableMetricKit: true,
              },
            },
          ],
        ],
      },
    } satisfies ConfigContext);

    const sentryOptions = findSentryPluginOptions(config);

    expect(sentryOptions?.options).toEqual({
      dsn: "https://key@o123.ingest.us.sentry.io/456",
      enableMetricKit: true,
    });
  });

  it("writes the watchdog experiment into native Sentry options", async () => {
    const config = createConfig({
      config: appJson.expo satisfies ExpoConfig,
    } satisfies ConfigContext);
    const sentryOptions = findSentryPluginOptions(config)?.options;
    const options = isRecord(sentryOptions) ? sentryOptions : undefined;
    expect(options).toBeDefined();

    const projectRoot = await mkdtemp(path.join(tmpdir(), "dofek-sentry-options-"));
    try {
      writeSentryOptions(projectRoot, options ?? {});
      const generated: unknown = JSON.parse(
        await readFile(path.join(projectRoot, "sentry.options.json"), "utf8"),
      );
      expect(generated).toMatchObject({
        _experiments: { enableWatchdogTerminationsV2: true },
        enableMetricKit: true,
        enableMetricKitRawPayload: true,
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("publishes the Sleep widget App Group from the host bundle identifier", () => {
    const config = createConfig({
      config: {
        name: "Dofek",
        slug: "dofek",
        ios: { bundleIdentifier: "com.dofek.app" },
      },
    } satisfies ConfigContext);
    expect(config.ios?.entitlements?.["com.apple.security.application-groups"]).toEqual([
      "group.com.dofek.app.sleep-widget",
    ]);
  });

  it("preserves existing host App Groups when adding the Sleep widget group", () => {
    const config = createConfig({
      config: {
        name: "Dofek",
        slug: "dofek",
        ios: {
          bundleIdentifier: "com.dofek.app",
          entitlements: {
            "com.apple.security.application-groups": ["group.com.dofek.app.existing"],
          },
        },
      },
    } satisfies ConfigContext);
    expect(config.ios?.entitlements?.["com.apple.security.application-groups"]).toEqual([
      "group.com.dofek.app.existing",
      "group.com.dofek.app.sleep-widget",
    ]);
  });

  it("isolates the Sleep widget App Group for preview bundle identifiers", async () => {
    vi.stubEnv("PREVIEW_CHANNEL", "pr-123");
    vi.stubEnv("PREVIEW_BUNDLE_IDENTIFIER", "com.dofek.app.preview");
    vi.resetModules();
    const { default: previewConfig } = await import("./app.config");
    const config = previewConfig({
      config: { name: "Dofek", slug: "dofek", ios: { bundleIdentifier: "com.dofek.app" } },
    } satisfies ConfigContext);
    expect(config.ios?.bundleIdentifier).toBe("com.dofek.app.preview");
    expect(config.ios?.entitlements?.["com.apple.security.application-groups"]).toEqual([
      "group.com.dofek.app.preview.sleep-widget",
    ]);
  });

  it("keeps the binary CocoaPod and watch SPM on the RNSentry Cocoa version", async () => {
    const require = createRequire(import.meta.url);
    const sentryPackagePath = require.resolve("@sentry/react-native/package.json");
    const nativePodspec = await readFile(
      path.join(path.dirname(sentryPackagePath), "RNSentry.podspec"),
      "utf8",
    );
    const watchPlugin = await readFile(
      path.resolve("packages/mobile/plugins/with-watch-sentry-spm.js"),
      "utf8",
    );
    const nativeVersion = nativePodspec.match(/sentry_cocoa_version = '([^']+)'/)?.[1];
    const watchVersion = watchPlugin.match(/const PACKAGE_VERSION = "([^"]+)"/)?.[1];

    expect(nativeVersion).toBeDefined();
    expect(sentryPodspec.version).toBe(nativeVersion);
    expect(sentryPodspec.source.http).toContain(`/${nativeVersion}/`);
    expect(watchVersion).toBe(nativeVersion);
  });
});
