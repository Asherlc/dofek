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

    vi.doMock("expo-notifications", () => ({
      SchedulableTriggerInputTypes: { DAILY: "daily" },
      addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
      cancelScheduledNotificationAsync: vi.fn(async () => undefined),
      getAllScheduledNotificationsAsync: vi.fn(async () => []),
      getLastNotificationResponse: vi.fn(() => null),
      getPermissionsAsync: vi.fn(async () => ({ status: "undetermined" })),
      requestPermissionsAsync: vi.fn(async () => ({ status: "granted" })),
      scheduleNotificationAsync: vi.fn(async () => "notification-id"),
      setNotificationHandler: vi.fn(),
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
      route: "/bootstrap",
    });
  });
});
