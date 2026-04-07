import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectoryPath = dirname(currentFilePath);
const appConfigPath = resolve(currentDirectoryPath, "app.config.ts");

describe("app.config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("loads with Node TypeScript stripping enabled", () => {
    const executionResult = spawnSync(
      process.execPath,
      ["--experimental-strip-types", appConfigPath],
      {
        encoding: "utf8",
      },
    );

    expect(executionResult.status).toBe(0);
    expect(executionResult.stderr).not.toContain("ERR_IMPORT_ATTRIBUTE_MISSING");
  });

  it("uses production config when PREVIEW_CHANNEL is not set", async () => {
    vi.stubEnv("PREVIEW_CHANNEL", "");

    const config = (await import("./app.config")).default;

    expect(config.name).toBe("Dofek");
    expect(config.ios?.bundleIdentifier).toBe("com.dofek.app");
    expect(config.updates?.requestHeaders?.["expo-channel-name"]).toBe("production");
  });

  it("overrides channel and bundle ID for preview", async () => {
    vi.stubEnv("PREVIEW_CHANNEL", "pr-42");

    const config = (await import("./app.config")).default;

    expect(config.name).toBe("Dofek Preview");
    expect(config.ios?.bundleIdentifier).toBe("com.dofek.preview");
    expect(config.updates?.requestHeaders?.["expo-channel-name"]).toBe("pr-42");
  });

  it("preserves OTA server URL in preview mode", async () => {
    vi.stubEnv("PREVIEW_CHANNEL", "pr-99");

    const config = (await import("./app.config")).default;

    expect(config.updates?.url).toBe("https://ota.dofek.asherlc.com/manifest");
    expect(config.updates?.enabled).toBe(true);
  });

  it("preserves iOS entitlements in preview mode", async () => {
    vi.stubEnv("PREVIEW_CHANNEL", "pr-1");

    const config = (await import("./app.config")).default;

    expect(config.ios?.entitlements?.["com.apple.developer.healthkit"]).toBe(true);
    expect(config.ios?.deploymentTarget).toBe("16.0");
  });
});
