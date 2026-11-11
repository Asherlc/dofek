import type { ConfigContext, ExpoConfig } from "expo/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createConfig from "./app.config";
import appJson from "./app.json";

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
});
