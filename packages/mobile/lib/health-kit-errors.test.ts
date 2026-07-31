import { describe, expect, it } from "vitest";
import {
  isBackgroundHealthKitTransientNetworkError,
  isHealthKitSentrySource,
  isTransientNetworkErrorMessage,
} from "./health-kit-errors";

describe("health-kit-errors", () => {
  it("detects transient background fetch timeout messages", () => {
    expect(
      isTransientNetworkErrorMessage("fetch failed: UnexpectedException: The request timed out."),
    ).toBe(true);
    expect(
      isTransientNetworkErrorMessage(
        "Push workout routes: fetch failed: UnexpectedException: The request timed out.",
      ),
    ).toBe(true);
    expect(isTransientNetworkErrorMessage("network unreachable")).toBe(false);
    expect(isTransientNetworkErrorMessage("fetch failed: connection reset")).toBe(false);
    expect(isTransientNetworkErrorMessage("request timeout")).toBe(false);
  });

  it("detects transient network errors on Error instances and causes (DOFEK-MOBILE-19)", () => {
    const timeoutError = new Error("fetch failed: UnexpectedException: The request timed out.");
    const trpcError = new Error("TRPCClientError", { cause: timeoutError });

    expect(isBackgroundHealthKitTransientNetworkError(timeoutError)).toBe(true);
    expect(isBackgroundHealthKitTransientNetworkError(trpcError)).toBe(true);
    expect(isBackgroundHealthKitTransientNetworkError(new Error("server error"))).toBe(false);
  });

  it("identifies HealthKit Sentry sources used for scoped timeout filtering", () => {
    expect(isHealthKitSentrySource("bg-healthkit-sync")).toBe(true);
    expect(isHealthKitSentrySource("health-kit-workout-route-push")).toBe(true);
    expect(isHealthKitSentrySource("auto-sync-providers")).toBe(false);
    expect(isHealthKitSentrySource(undefined)).toBe(false);
  });
});
