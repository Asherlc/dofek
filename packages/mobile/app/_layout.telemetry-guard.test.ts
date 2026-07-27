import { describe, expect, it, vi } from "vitest";

describe("app bootstrap telemetry guard", () => {
  it("does not crash layout import when telemetry initialization throws", async () => {
    vi.resetModules();

    vi.doMock("@sentry/react-native", () => ({
      init: vi.fn(),
      captureException: vi.fn(),
      wrap: vi.fn((component: unknown) => component),
    }));

    vi.doMock("expo-splash-screen", () => ({
      preventAutoHideAsync: vi.fn(() => Promise.resolve()),
      hideAsync: vi.fn(() => Promise.resolve()),
    }));

    vi.doMock("expo-crypto", () => ({
      randomUUID: vi.fn(() => "11111111-1111-4111-8111-111111111111"),
    }));

    vi.doMock("../components/AccountDeletionStatusScreen", () => ({
      AccountDeletionStatusScreen: () => null,
    }));

    vi.doMock("../lib/account-erasure-storage", () => ({
      loadAnyMobileAccountErasurePreparation: vi.fn(() => Promise.resolve(null)),
      loadMobileAccountErasureStatusCapability: vi.fn(() => Promise.resolve(null)),
    }));

    const captureExceptionMock = vi.fn();

    vi.doMock("../lib/telemetry", () => ({
      initTelemetry: vi.fn(() => {
        throw new Error("telemetry-init-failed");
      }),
      captureException: captureExceptionMock,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    await expect(import("./_layout")).resolves.toBeDefined();
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), {
      source: "bootstrap-telemetry-init",
    });
  });
});
