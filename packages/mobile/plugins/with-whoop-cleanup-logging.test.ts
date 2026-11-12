import { dirname } from "node:path";
import { withPlugins } from "expo/config-plugins";
import { expect, test } from "vitest";
import withWhoopCleanupLogging from "./with-whoop-cleanup-logging";

async function transform(
  contents: string,
  language: "swift" | "objc" = "swift",
  nativeInit = false,
) {
  const testPath = expect.getState().testPath;
  if (!testPath) throw new Error("The running test path is required");
  const base = {
    name: "Test",
    slug: "test",
    _internal: { projectRoot: dirname(dirname(testPath)) },
  };
  const config = nativeInit
    ? withPlugins(base, [
        withWhoopCleanupLogging,
        [
          "@sentry/react-native/expo",
          { organization: "test", project: "test", useNativeInit: true },
        ],
      ])
    : withWhoopCleanupLogging(base);
  const mod = config.mods?.ios?.appDelegate;
  if (!mod) throw new Error("The AppDelegate mod was not registered");
  const result = await mod({
    ...config,
    modResults: { path: "/test/ios/Test/AppDelegate.swift", contents, language },
    modRequest: {
      projectRoot: "/test",
      platformProjectRoot: "/test/ios",
      modName: "appDelegate",
      platform: "ios",
      introspect: false,
    },
    modRawConfig: { name: "Test", slug: "test" },
  });
  return result.modResults.contents;
}

const delegate = "import RNSentry\nfunc start() {\n  RNSentrySDK.start()\n}\n";

test("configures cleanup attribution in the existing native Sentry startup", async () => {
  const result = await transform(delegate);
  expect(result).toMatch(/^internal import ExpoWhoopBle$/m);
  expect(result).toContain("RNSentrySDK.start { options in");
  expect(result).toContain("WhoopBleModule.configureCleanupLogAttribution(options)");
});

test("composes with Sentry's native initialization mod", async () => {
  const result = await transform(
    "import Expo\nclass AppDelegate {\n  func application() -> Bool {\n    return true\n  }\n}\n",
    "swift",
    true,
  );
  expect(result).toContain("WhoopBleModule.configureCleanupLogAttribution(options)");
  expect(result).toMatch(/^internal import ExpoWhoopBle$/m);
  expect(result.match(/RNSentrySDK\.start/g)).toHaveLength(1);
});

test("keeps one native initialization after Sentry reinserts its stock startup", async () => {
  const first = await transform(delegate);
  const second = await transform(
    first.replace("func start() {", "func start() {\n  RNSentrySDK.start()"),
  );
  expect(second.match(/RNSentrySDK\.start/g)).toHaveLength(1);
  expect(second).toBe(first);
});

test("fails when the required native startup or Swift delegate is missing", async () => {
  await expect(transform("import RNSentry")).rejects.toThrow("RNSentrySDK.start");
  await expect(transform(delegate, "objc")).rejects.toThrow("Swift");
});
