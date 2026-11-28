import { describe, expect, it } from "vitest";
import {
  isBackgroundHealthKitTransientNetworkError,
  isHealthKitAuthorizationNotDetermined,
  isTransientNetworkErrorMessage,
  shouldSuppressBackgroundTransientNetworkError,
} from "./health-kit-errors";

describe("health-kit-errors", () => {
  it("matches only the typed HealthKit authorization-not-determined code", () => {
    expect(
      isHealthKitAuthorizationNotDetermined({
        code: "HEALTHKIT_AUTHORIZATION_NOT_DETERMINED",
      }),
    ).toBe(true);
    expect(
      isHealthKitAuthorizationNotDetermined(
        Object.assign(new Error("localized system message"), {
          code: "HEALTHKIT_AUTHORIZATION_NOT_DETERMINED",
        }),
      ),
    ).toBe(true);
    expect(isHealthKitAuthorizationNotDetermined({ code: "HEALTHKIT_DATABASE_INACCESSIBLE" })).toBe(
      false,
    );
    expect(isHealthKitAuthorizationNotDetermined(new Error("Authorization not determined"))).toBe(
      false,
    );
    expect(isHealthKitAuthorizationNotDetermined(null)).toBe(false);
  });

  it("keeps an underlying storage failure reportable under a cancellation wrapper", () => {
    const error = new Error("fetch failed: cancelled", {
      cause: new Error("Failed to write value."),
    });
    expect(shouldSuppressBackgroundTransientNetworkError(error, "bg-healthkit-sync")).toBe(false);
  });
  it("retains a wrapped parse failure even when its message was copied by tRPC", () => {
    const cause = new SyntaxError("fetch failed: cancelled");
    expect(
      shouldSuppressBackgroundTransientNetworkError(
        new Error(cause.message, { cause }),
        "bg-healthkit-sync",
      ),
    ).toBe(false);
  });
  it("retains mixed sync failures and cyclic causes as unexpected", () => {
    const mixed = new Error(
      "HealthKit observer sync completed with 2 error(s): Invalid schema; Push workout routes: fetch failed: cancelled",
    );
    expect(shouldSuppressBackgroundTransientNetworkError(mixed, "bg-healthkit-sync")).toBe(false);
    const cyclic = new Error("unknown");
    cyclic.cause = cyclic;
    expect(shouldSuppressBackgroundTransientNetworkError(cyclic, "bg-healthkit-sync")).toBe(false);
  });
  it.each([
    "bg-healthkit-sync",
    "whoop-ble-imu-upload",
    "whoop-ble-realtime-upload",
    "apple-health-sync-log",
  ])("classifies handled cancellation and offline delivery from %s", (source) => {
    for (const message of [
      "HealthKit observer sync completed with 1 error(s): Push workout routes: fetch failed: cancelled",
      "fetch failed: The Internet connection appears to be offline.",
      "fetch failed: The network connection was lost.",
    ]) {
      expect(shouldSuppressBackgroundTransientNetworkError(new Error(message), source)).toBe(true);
    }
    expect(
      shouldSuppressBackgroundTransientNetworkError(new SyntaxError("Invalid response"), source),
    ).toBe(false);
  });

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

  it.each([
    // Status with and without a reason phrase, plus a response preview (DOFEK-MOBILE-37).
    [
      "Non-JSON tRPC response from healthKitSync.pushQuantitySamples: 408 request timed out, content-type absent, ",
      true,
    ],
    [
      "Non-JSON tRPC response from healthKitSync.pushQuantitySamples: 408, content-type absent, ",
      true,
    ],
    [
      "Non-JSON tRPC response from healthKitSync.pushQuantitySamples: 408 Request Timeout, content-type text/plain, upstream timeout body",
      true,
    ],
    // Other statuses, a status with a 408 prefix, the wrong procedure, and mixed results stay reportable.
    [
      "Non-JSON tRPC response from healthKitSync.pushQuantitySamples: 413 Payload Too Large, content-type text/plain, payload too large",
      false,
    ],
    [
      "Non-JSON tRPC response from healthKitSync.pushQuantitySamples: 4080 request timed out, content-type absent, ",
      false,
    ],
    [
      "Non-JSON tRPC response from healthKitSync.pushWorkouts: 408 request timed out, content-type absent, ",
      false,
    ],
    [
      "Non-JSON tRPC response from healthKitSync.pushQuantitySamples: 408 request timed out, content-type absent, ; other failure",
      false,
    ],
  ])("classifies the non-JSON pushQuantitySamples diagnostic: %s", (message, expected) => {
    expect(isTransientNetworkErrorMessage(message)).toBe(expected);
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
