import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyOtaUpdate } from "./verify-ota-update.ts";

vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
vi.mock("./verify-ota-update.ts", () => ({ verifyOtaUpdate: vi.fn() }));

const originalArguments = process.argv;
let receipt: unknown;
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("EXPO_APP_ID", "release-app-id");
  vi.mocked(verifyOtaUpdate).mockReset().mockResolvedValue("published-id");
  receipt = [
    { id: "published-id", platform: "ios", runtimeVersion: "published-runtime", branch: "main" },
  ];
  process.argv = [
    "node",
    "verify-published-ota.ts",
    "dist/xprem-update-metadata.json",
    "production",
  ];
  vi.mocked(readFileSync)
    .mockReset()
    .mockImplementation((path) =>
      path instanceof URL ? "installed-device-certificate" : JSON.stringify(receipt),
    );
});
afterEach(() => {
  process.argv = originalArguments;
  vi.unstubAllEnvs();
});

describe("published OTA receipt audit", () => {
  it("audits the published identity/runtime against the installed certificate", async () => {
    await import("./verify-published-ota.ts");
    expect(verifyOtaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://ota.dofek.asherlc.com/manifest",
        channel: "production",
        appId: "release-app-id",
        expectedId: "published-id",
        runtimeVersion: "published-runtime",
        certificate: "installed-device-certificate",
      }),
    );
  });

  it("audits the same preview branch and channel", async () => {
    receipt = [
      { id: "preview-id", platform: "ios", runtimeVersion: "preview-runtime", branch: "pr-123" },
    ];
    process.argv[3] = "pr-123";
    await import("./verify-published-ota.ts");
    expect(verifyOtaUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "pr-123",
        expectedId: "preview-id",
        runtimeVersion: "preview-runtime",
      }),
    );
  });

  it.each([
    [],
    [{ id: "wrong-branch", platform: "ios", runtimeVersion: "runtime", branch: "other" }],
    [{ id: "wrong-platform", platform: "android", runtimeVersion: "runtime", branch: "main" }],
    [{ id: "", platform: "ios", runtimeVersion: "runtime", branch: "main" }],
  ])("rejects a receipt that cannot identify this published iOS update: %j", async (value) => {
    receipt = value;
    await expect(import("./verify-published-ota.ts")).rejects.toThrow();
    expect(verifyOtaUpdate).not.toHaveBeenCalled();
  });

  it("refuses ambiguous multiple iOS publication receipts", async () => {
    const update = {
      id: "published-id",
      platform: "ios",
      runtimeVersion: "runtime",
      branch: "main",
    };
    receipt = [update, { ...update, id: "other-id" }];
    await expect(import("./verify-published-ota.ts")).rejects.toThrow();
    expect(verifyOtaUpdate).not.toHaveBeenCalled();
  });

  it("propagates signature, identity and asset delivery failures", async () => {
    vi.mocked(verifyOtaUpdate).mockRejectedValue(new Error("OTA asset returned HTTP 500"));
    await expect(import("./verify-published-ota.ts")).rejects.toThrow(
      "OTA asset returned HTTP 500",
    );
  });

  it("fails missing application identity before auditing", async () => {
    vi.stubEnv("EXPO_APP_ID", undefined);
    await expect(import("./verify-published-ota.ts")).rejects.toThrow("EXPO_APP_ID is required");
    expect(verifyOtaUpdate).not.toHaveBeenCalled();
  });

  it("fails missing arguments before reading files", async () => {
    process.argv = process.argv.slice(0, 2);
    await expect(import("./verify-published-ota.ts")).rejects.toThrow("Usage:");
    expect(readFileSync).not.toHaveBeenCalled();
  });
});
