import { afterEach, describe, expect, it, vi } from "vitest";

describe("app.config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses production config when PREVIEW_SLOT is not set", async () => {
    vi.stubEnv("PREVIEW_SLOT", "");

    const config = (await import("./app.config")).default;

    expect(config.name).toBe("Dofek");
    expect(config.ios?.bundleIdentifier).toBe("com.dofek.app");
    expect(config.updates?.requestHeaders?.["expo-channel-name"]).toBe("production");
  });

  it("overrides channel and bundle ID for preview slot 1", async () => {
    vi.stubEnv("PREVIEW_SLOT", "1");

    const config = (await import("./app.config")).default;

    expect(config.name).toBe("Dofek Preview 1");
    expect(config.ios?.bundleIdentifier).toBe("com.dofek.preview-1");
    expect(config.updates?.requestHeaders?.["expo-channel-name"]).toBe("preview-1");
  });

  it("overrides channel and bundle ID for preview slot 3", async () => {
    vi.stubEnv("PREVIEW_SLOT", "3");

    const config = (await import("./app.config")).default;

    expect(config.name).toBe("Dofek Preview 3");
    expect(config.ios?.bundleIdentifier).toBe("com.dofek.preview-3");
    expect(config.updates?.requestHeaders?.["expo-channel-name"]).toBe("preview-3");
  });

  it("preserves OTA server URL in preview mode", async () => {
    vi.stubEnv("PREVIEW_SLOT", "2");

    const config = (await import("./app.config")).default;

    expect(config.updates?.url).toBe("https://ota.dofek.asherlc.com/manifest");
    expect(config.updates?.enabled).toBe(true);
  });

  it("preserves iOS entitlements in preview mode", async () => {
    vi.stubEnv("PREVIEW_SLOT", "1");

    const config = (await import("./app.config")).default;

    expect(config.ios?.entitlements?.["com.apple.developer.healthkit"]).toBe(true);
    expect(config.ios?.deploymentTarget).toBe("16.0");
  });
});
