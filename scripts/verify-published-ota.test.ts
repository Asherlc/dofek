import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyOtaUpdate } from "./verify-ota-update.ts";

vi.mock("node:fs", () => ({ existsSync: vi.fn(), readFileSync: vi.fn(), writeFileSync: vi.fn() }));
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
    "published-runtime",
  ];
  vi.mocked(existsSync).mockReset().mockReturnValue(true);
  vi.mocked(writeFileSync).mockReset();
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
    process.argv[4] = "preview-runtime";
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

  it.each(["production", "pr-123"])(
    "audits exact local content and writes the verified identity without a publisher receipt on %s",
    async (channel) => {
      process.argv[3] = channel;
      vi.mocked(existsSync).mockReturnValue(false);
      const bundle = Buffer.from("exported bundle");
      const image = Buffer.from("exported image");
      vi.mocked(readFileSync).mockImplementation((path) => {
        if (path instanceof URL) return "installed-device-certificate";
        if (path === "dist/metadata.json")
          return JSON.stringify({
            fileMetadata: { ios: { bundle: "bundle.hbc", assets: [{ path: "assets/image.png" }] } },
          });
        if (path === "dist/bundle.hbc") return bundle;
        if (path === "dist/assets/image.png") return image;
        throw new Error(`Unexpected fixture file: ${String(path)}`);
      });
      await import("./verify-published-ota.ts");
      expect(verifyOtaUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeVersion: "published-runtime",
          expectedContent: {
            launchAssetHash: createHash("sha256").update(bundle).digest("base64url"),
            assetHashes: [createHash("sha256").update(image).digest("base64url")],
          },
        }),
      );
      expect(JSON.parse(String(vi.mocked(writeFileSync).mock.calls[0]?.[1]))).toEqual([
        {
          id: "published-id",
          platform: "ios",
          runtimeVersion: "published-runtime",
          branch: channel === "production" ? "main" : channel,
        },
      ]);
    },
  );

  it("fails a missing local export before auditing or creating a receipt", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("Export metadata missing");
    });
    await expect(import("./verify-published-ota.ts")).rejects.toThrow("Export metadata missing");
    expect(verifyOtaUpdate).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("does not create a receipt when verification of an unchanged update fails", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockImplementation((path) =>
      path instanceof URL
        ? "installed-device-certificate"
        : path === "dist/metadata.json"
          ? JSON.stringify({ fileMetadata: { ios: { bundle: "bundle.hbc", assets: [] } } })
          : Buffer.from("bundle"),
    );
    vi.mocked(verifyOtaUpdate).mockRejectedValue(
      new Error("OTA content does not match the local export"),
    );
    await expect(import("./verify-published-ota.ts")).rejects.toThrow(
      "OTA content does not match the local export",
    );
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("rejects a receipt for a different export runtime", async () => {
    process.argv[4] = "different-runtime";
    await expect(import("./verify-published-ota.ts")).rejects.toThrow();
    expect(verifyOtaUpdate).not.toHaveBeenCalled();
  });
});
