import { describe, expect, it } from "vitest";
import {
  PROCESSING_ALERT_ACTIONS,
  PROCESSING_ALERTS_EMPTY_PREVIEW,
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

  it("describes the exact structure of a future alert without inventing one", () => {
    expect(PROCESSING_ALERTS_EMPTY_PREVIEW).toEqual({
      title: "Nothing needs your attention",
      message: "New sync, connection, and import problems will appear here.",
      previewTitle: "When an alert appears, it will show",
      previewItems: ["What happened", "When it happened", "What to do next"],
      note: "Only real problems detected for your account are shown.",
    });
  });

  it("explains that only alert status is unavailable when no snapshot loaded", () => {
    expect(
      processingAlertsFailurePresentation({
        errorMessage: "Status service timed out.",
        hasSnapshot: false,
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
        hasSnapshot: true,
        lastCheckedLabel: "5 minutes ago",
      }),
    ).toEqual({
      title: "Alert status may be out of date",
      message:
        "Showing alerts last checked 5 minutes ago. Your synced health data is still available, and this status check did not pause syncs or imports. Details: Status service timed out.",
      retryLabel: "Retry alert status",
    });
  });

  it("identifies cached alerts as stale when their timestamp cannot be formatted", () => {
    expect(
      processingAlertsFailurePresentation({
        errorMessage: "Status service timed out.",
        hasSnapshot: true,
        lastCheckedLabel: null,
      }),
    ).toEqual({
      title: "Alert status may be out of date",
      message:
        "Showing cached alerts from a previous check. Your synced health data is still available, and this status check did not pause syncs or imports. Details: Status service timed out.",
      retryLabel: "Retry alert status",
    });
  });
});
