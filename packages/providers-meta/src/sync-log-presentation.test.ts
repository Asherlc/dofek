import { describe, expect, it } from "vitest";
import { providerSyncLogPresentation } from "./sync-log-presentation.ts";

describe("providerSyncLogPresentation", () => {
  it.each(["access_token_expired", "refresh_token_revoked", "session_expired"])(
    "explains that %s requires reconnecting before data can resume",
    (authFailureReason) => {
      expect(
        providerSyncLogPresentation({
          authFailureReason,
          dataType: "strength",
          providerName: "WHOOP",
          status: "error",
        }),
      ).toEqual({
        dataTypeLabel: "Strength",
        heading: "Authorization expired",
        message: "Reconnect WHOOP to resume Strength data.",
        tone: "danger",
      });
    },
  );

  it("distinguishes a failed authorization attempt from an expired authorization", () => {
    expect(
      providerSyncLogPresentation({
        authFailureReason: "authorization_failed",
        dataType: "developer_workouts",
        providerName: "WHOOP",
        status: "error",
      }),
    ).toEqual({
      dataTypeLabel: "Developer workouts",
      heading: "Authorization failed",
      message: "Reconnect WHOOP to resume Developer workouts data.",
      tone: "danger",
    });
  });

  it("gives a retry action for an ordinary sync error", () => {
    expect(
      providerSyncLogPresentation({
        authFailureReason: null,
        dataType: "daily_metrics",
        providerName: "Oura",
        status: "error",
      }),
    ).toEqual({
      dataTypeLabel: "Daily metrics",
      heading: "Daily metrics data sync failed",
      message: "Try syncing Oura again. Open Diagnostics if the problem continues.",
      tone: "danger",
    });
  });

  it("summarizes a successful sync without an action", () => {
    expect(
      providerSyncLogPresentation({
        authFailureReason: null,
        dataType: "activities",
        providerName: "Strava",
        status: "success",
      }),
    ).toEqual({
      dataTypeLabel: "Activities",
      heading: "Activities data synced",
      message: null,
      tone: "success",
    });
  });

  it("warns when a sync completed with missing data", () => {
    expect(
      providerSyncLogPresentation({
        authFailureReason: null,
        dataType: "daily_metrics",
        providerName: "Oura",
        status: "degraded",
      }),
    ).toEqual({
      dataTypeLabel: "Daily metrics",
      heading: "Daily metrics data synced with issues",
      message: "Some daily metrics data may be missing. Open Diagnostics for details.",
      tone: "warning",
    });
  });

  it("does not present an unexpected raw status as a successful sync", () => {
    expect(
      providerSyncLogPresentation({
        authFailureReason: null,
        dataType: "strength",
        providerName: "WHOOP",
        status: "unknown",
      }),
    ).toEqual({
      dataTypeLabel: "Strength",
      heading: "Strength data status unavailable",
      message: "Open Diagnostics for the raw sync status.",
      tone: "warning",
    });
  });
});
