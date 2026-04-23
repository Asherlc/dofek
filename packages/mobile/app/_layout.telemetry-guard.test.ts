import { describe, expect, it, vi } from "vitest";

describe("app bootstrap telemetry guard", () => {
  it("does not crash layout import when telemetry initialization throws", async () => {
    vi.resetModules();

    vi.doMock("@sentry/react-native", () => ({
      init: vi.fn(),
      captureException: vi.fn(),
      wrap: vi.fn((component: unknown) => component),
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
