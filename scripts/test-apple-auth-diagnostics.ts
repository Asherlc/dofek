import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const temporaryDirectory = mkdtempSync(join(tmpdir(), "dofek-apple-auth-test-"));
try {
  const binary = join(temporaryDirectory, "apple-auth-diagnostics");
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-swift-version",
      "5",
      fileURLToPath(
        new URL(
          "packages/mobile/node_modules/expo-apple-authentication/ios/AppleAuthenticationErrorDiagnostics.swift",
          root,
        ),
      ),
      fileURLToPath(
        new URL(
          "packages/mobile/test-fixtures/AppleAuthenticationErrorDiagnostics.test.swift",
          root,
        ),
      ),
      "-o",
      binary,
    ],
    { stdio: "inherit" },
  );
  execFileSync(binary, [], { stdio: "inherit" });
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
