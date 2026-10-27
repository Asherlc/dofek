import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

const withIosPodSettings = await import("./with-ios-pod-settings.js");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

test("configures RNSentry to import its XCFramework while applying the ExpoModulesCore workaround", async () => {
  const platformProjectRoot = await mkdtemp(path.join(tmpdir(), "dofek-podfile-"));
  temporaryDirectories.push(platformProjectRoot);
  const podfilePath = path.join(platformProjectRoot, "Podfile");
  await writeFile(
    podfilePath,
    "# [with-ios-pod-settings] Use one source-built Sentry Cocoa pod\nENV['SENTRY_USE_XCFRAMEWORK'] = '0'\npost_install do |installer|\nend\n",
  );

  const config = withIosPodSettings.default({ mods: { ios: {} } });
  await config.mods.ios.dangerous({
    modRequest: { platformProjectRoot },
  });

  const podfile = await readFile(podfilePath, "utf-8");
  expect(podfile).not.toContain("SENTRY_USE_XCFRAMEWORK");
  expect(podfile).toContain("if target.name == 'RNSentry'");
  expect(podfile).toContain(
    "config.build_settings['CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES'] = 'YES'",
  );
  expect(podfile).toContain("[with-ios-pod-settings] ExpoModulesCore return-type workaround");
});
