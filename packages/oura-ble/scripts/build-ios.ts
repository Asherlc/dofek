import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const native = fileURLToPath(new URL("../native/", import.meta.url));
const generated = fileURLToPath(new URL("../ios/generated/", import.meta.url));
const targetDirectory = join(native, "target");
const library = "oura_ble_core";
const device = "aarch64-apple-ios";
const simulatorTargets = ["aarch64-apple-ios-sim", "x86_64-apple-ios"];
const archive = (target: string) => join(targetDirectory, target, "release", `lib${library}.a`);
const buildOptions = {
  cwd: native,
  env: {
    ...process.env,
    CARGO_TARGET_DIR: targetDirectory,
    IPHONEOS_DEPLOYMENT_TARGET: "16.4",
  },
  stdio: "inherit" as const,
};

const staging = mkdtempSync(join(tmpdir(), "oura-ble-ios-"));
try {
  execFileSync("cargo", ["+1.100.0", "build", "--locked", "--lib"], buildOptions);
  execFileSync(
    "cargo",
    [
      "+1.100.0",
      "run",
      "--locked",
      "--features",
      "bindgen",
      "--bin",
      "uniffi-bindgen",
      "--",
      "generate",
      "--library",
      join(targetDirectory, "debug", `lib${library}.dylib`),
      "--language",
      "swift",
      "--out-dir",
      staging,
    ],
    buildOptions,
  );

  const headers = join(staging, "Headers");
  mkdirSync(headers);
  copyFileSync(join(staging, `${library}FFI.h`), join(headers, `${library}FFI.h`));
  copyFileSync(join(staging, `${library}FFI.modulemap`), join(headers, "module.modulemap"));

  for (const target of [device, ...simulatorTargets]) {
    execFileSync(
      "cargo",
      ["+1.100.0", "build", "--locked", "--lib", "--release", "--target", target],
      buildOptions,
    );
  }
  const simulator = join(staging, `lib${library}.a`);
  execFileSync(
    "xcrun",
    ["lipo", "-create", ...simulatorTargets.map(archive), "-output", simulator],
    buildOptions,
  );

  rmSync(generated, { recursive: true, force: true });
  mkdirSync(generated, { recursive: true });
  execFileSync(
    "xcodebuild",
    [
      "-create-xcframework",
      "-library",
      archive(device),
      "-headers",
      headers,
      "-library",
      simulator,
      "-headers",
      headers,
      "-output",
      join(generated, "OuraBleCore.xcframework"),
    ],
    buildOptions,
  );
  copyFileSync(join(staging, `${library}.swift`), join(generated, `${library}.swift`));
  execFileSync(
    "cargo",
    [
      "+1.100.0",
      "about",
      "generate",
      "about.hbs",
      "-o",
      join(generated, "THIRD-PARTY-LICENSES.txt"),
    ],
    buildOptions,
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
}
