import { describe, expect, it } from "vitest";
import {
  PROCESSING_ALERT_ACTIONS,
  processingAlertsFailurePresentation,
} from "./processing-alerts.ts";

describe("processing alert contract", () => {
  it("exposes every supported customer action", () => {
    expect(PROCESSING_ALERT_ACTIONS).toEqual([
      "retry_sync",
      "reconnect",
      "retry_import",
      "contact_support",
    ]);
  });

  it("explains that only alert status is unavailable when no snapshot loaded", () => {
    expect(
      processingAlertsFailurePresentation({
        errorMessage: "Status service timed out.",
        lastCheckedLabel: null,
      }),
    ).toEqual({
      title: "Alert status is unavailable",
      message:
        "We could not check for new alerts. Your synced health data is still available, and this status check did not pause syncs or imports. Details: Status service timed out.",
      retryLabel: "Retry alert status",
    });
  });

  it("identifies retained alerts as stale after a failed refresh", () => {
    expect(
      processingAlertsFailurePresentation({
        errorMessage: "Status service timed out.",
        lastCheckedLabel: "5 minutes ago",
      }),
    ).toEqual({
      title: "Alert status may be out of date",
      message:
        "Showing alerts last checked 5 minutes ago. Your synced health data is still available, and this status check did not pause syncs or imports. Details: Status service timed out.",
      retryLabel: "Retry alert status",
    });
  });
});
