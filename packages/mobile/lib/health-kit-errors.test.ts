import { describe, expect, it } from "vitest";
import {
  isBackgroundHealthKitTransientNetworkError,
  isTransientNetworkErrorMessage,
  shouldSuppressBackgroundTransientNetworkError,
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

  it("detects transient dropped-connection messages (NSURLErrorNetworkConnectionLost)", () => {
    expect(
      isTransientNetworkErrorMessage(
        "fetch failed: UnexpectedException: The network connection was lost.",
      ),
    ).toBe(true);
    expect(
      isTransientNetworkErrorMessage(
        "Push workout routes: fetch failed: The network connection was lost.",
      ),
    ).toBe(true);
    expect(isTransientNetworkErrorMessage("the network connection was lost")).toBe(false);
  });

  it("detects transient network errors on Error instances and causes (DOFEK-MOBILE-19)", () => {
    const timeoutError = new Error("fetch failed: UnexpectedException: The request timed out.");
    const connectionLostError = new Error(
      "fetch failed: UnexpectedException: The network connection was lost.",
    );
    const trpcError = new Error("TRPCClientError", { cause: timeoutError });

    expect(isBackgroundHealthKitTransientNetworkError(timeoutError)).toBe(true);
    expect(isBackgroundHealthKitTransientNetworkError(connectionLostError)).toBe(true);
    expect(isBackgroundHealthKitTransientNetworkError(trpcError)).toBe(true);
    expect(isBackgroundHealthKitTransientNetworkError(new Error("server error"))).toBe(false);
  });

  it("suppresses transient network errors only for declared background sync sources", () => {
    const connectionLostError = new Error(
      "fetch failed: UnexpectedException: The network connection was lost.",
    );

    // Transient network error from a HealthKit source: suppressed from error tracking.
    expect(
      shouldSuppressBackgroundTransientNetworkError(connectionLostError, "bg-healthkit-sync"),
    ).toBe(true);
    expect(
      shouldSuppressBackgroundTransientNetworkError(
        connectionLostError,
        "health-kit-workout-route-push",
      ),
    ).toBe(true);
    expect(
      shouldSuppressBackgroundTransientNetworkError(connectionLostError, "bg-accel-sync"),
    ).toBe(true);

    // Transient network error from a non-HealthKit source: still reported.
    expect(shouldSuppressBackgroundTransientNetworkError(connectionLostError, "react-query")).toBe(
      false,
    );
    expect(shouldSuppressBackgroundTransientNetworkError(connectionLostError, undefined)).toBe(
      false,
    );

    // Non-transient error from a HealthKit source: still reported.
    expect(
      shouldSuppressBackgroundTransientNetworkError(new Error("server error"), "bg-healthkit-sync"),
    ).toBe(false);
  });
});
