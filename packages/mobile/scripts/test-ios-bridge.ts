import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iosDirectory = resolve(mobileDirectory, "ios");
const podfile = resolve(iosDirectory, "Podfile");
const marker = "  # WHOOP Expo bridge XCTest dependencies";
if (!existsSync(podfile))
  throw new Error("Generate ios with pnpm prebuild before running bridge tests");
const contents = readFileSync(podfile, "utf8");
if (!contents.includes(marker)) {
  const target = "target 'Dofek' do";
  if (!contents.includes(target)) throw new Error("Generate ios with pnpm prebuild first");
  const require = createRequire(import.meta.url);
  const testCorePackage = require.resolve("expo-modules-test-core/package.json");
  const testCorePodPath = resolve(dirname(testCorePackage), "ios")
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'");
  writeFileSync(
    podfile,
    contents.replace(
      target,
      `${target}\n${marker}\n  pod 'ExpoWhoopBle', :path => '../modules/whoop-ble/ios', :testspecs => ['BridgeTests']\n  pod 'ExpoModulesTestCore', :path => '${testCorePodPath}'`,
    ),
  );
}

// Expo's official TestAppContext imports the source module with @testable.
execFileSync("pod", ["install"], {
  cwd: iosDirectory,
  stdio: "inherit",
  env: { ...process.env, EXPO_USE_PRECOMPILED_MODULES: "0" },
});

interface Simulator {
  name: string;
  udid: string;
  state: string;
}
const inventory: { devices: Record<string, Simulator[]> } = JSON.parse(
  execFileSync("xcrun", ["simctl", "list", "devices", "available", "--json"], {
    encoding: "utf8",
  }),
);
const phones = Object.values(inventory.devices)
  .flat()
  .filter((device) => device.name.startsWith("iPhone"));
const simulator = phones.find((device) => device.state === "Booted") ?? phones[0];
if (!simulator) throw new Error("Install an iPhone Simulator runtime before running bridge tests");

execFileSync(
  "xcodebuild",
  [
    "test",
    "-quiet",
    "-project",
    "Pods/Pods.xcodeproj",
    "-scheme",
    "ExpoWhoopBle-Unit-BridgeTests",
    "-configuration",
    "Debug",
    "-destination",
    `platform=iOS Simulator,id=${simulator.udid}`,
    "-derivedDataPath",
    "build/bridge-tests",
  ],
  { cwd: iosDirectory, stdio: "inherit" },
);
