import { describe, expect, it } from "vitest";
import {
  providerSyncAccessIssue,
  providerSyncLogPresentation,
  theCragLogbookAccessErrorMessage,
} from "./sync-log-presentation.ts";

describe("providerSyncLogPresentation", () => {
  it("collapses repeated separators in a recorded data type", () => {
    expect(
      providerSyncLogPresentation({
        providerName: "Oura",
        dataType: "daily__metrics--summary",
        status: "success",
        authFailureReason: null,
      }).dataTypeLabel,
    ).toBe("Daily metrics summary");
  });

  it("distinguishes a failed sign-in from a failed authorization", () => {
    expect(
      providerSyncLogPresentation({
        providerName: "Garmin",
        dataType: "update",
        status: "error",
        pushOnly: true,
        authFailureReason: "authentication_failed",
        errorMessage: "Try syncing Garmin again.",
      }),
    ).toMatchObject({
      heading: "Sign-in failed",
      message: "Reconnect Garmin to resume incoming updates.",
      tone: "danger",
    });
  });

  it.each(["error", "degraded"])("selects the actionable cause for a push %s", (status) => {
    expect(
      providerSyncLogPresentation({
        providerName: "Garmin",
        dataType: "update",
        status,
        pushOnly: true,
        authFailureReason: null,
        errorMessage: "An activity file could not be read.",
      }).message,
    ).toBe("An activity file could not be read.");
  });

  it("keeps reconnect guidance ahead of a stored authorization error", () => {
    expect(
      providerSyncLogPresentation({
        providerName: "Garmin",
        dataType: "update",
        status: "error",
        pushOnly: true,
        authFailureReason: "authorization_failed",
        errorMessage: "Try syncing Garmin again.",
      }).message,
    ).toBe("Reconnect Garmin to resume incoming updates.");
  });

  it.each([
    ["error", "Earlier updates remain available. Open Diagnostics for details."],
    ["degraded", "Some update data may be missing. Open Diagnostics for details."],
  ])(
    "uses %s outcome guidance when its stored cause contains runtime details",
    (status, message) => {
      expect(
        providerSyncLogPresentation({
          providerName: "Garmin",
          dataType: "update",
          status,
          pushOnly: true,
          authFailureReason: null,
          errorMessage: "TypeError: Cannot read properties of undefined",
        }).message,
      ).toBe(message);
    },
  );

  it.each([
    ["error", "Try syncing Oura again. Open Diagnostics if the problem continues."],
    ["degraded", "Some sleep data may be missing. Open Diagnostics for details."],
  ])("retains polling %s guidance when a stored cause is available", (status, message) => {
    expect(
      providerSyncLogPresentation({
        providerName: "Oura",
        dataType: "sleep",
        status,
        pushOnly: false,
        authFailureReason: null,
        errorMessage: "The provider is unavailable.",
      }).message,
    ).toBe(message);
  });

  it("describes missing generic data once for a degraded outcome", () => {
    expect(
      providerSyncLogPresentation({
        providerName: "Garmin",
        dataType: "data",
        status: "degraded",
        pushOnly: true,
        authFailureReason: null,
      }).message,
    ).toBe("Some data may be missing. Open Diagnostics for details.");
  });

  it("keeps successful push outcomes free of stale error guidance", () => {
    expect(
      providerSyncLogPresentation({
        providerName: "Garmin",
        dataType: "update",
        status: "success",
        pushOnly: true,
        authFailureReason: null,
        errorMessage: "An earlier update could not be read.",
      }).message,
    ).toBeNull();
  });

  it.each([
    ["error", "Activities update not processed", "danger"],
    ["success", "Activities update processed", "success"],
    ["degraded", "Activities update processed with issues", "warning"],
  ])("describes a push %s outcome as an update", (status, heading, tone) => {
    expect(
      providerSyncLogPresentation({
        providerName: "Garmin",
        dataType: "activities",
        status,
        authFailureReason: null,
        pushOnly: true,
      }),
    ).toMatchObject({ heading, tone });
  });

  it("gives diagnostics guidance for failed incoming data", () => {
    expect(
      providerSyncLogPresentation({
        providerName: "Garmin",
        dataType: "update",
        status: "error",
        authFailureReason: null,
        pushOnly: true,
      }),
    ).toMatchObject({
      dataTypeLabel: "Update",
      heading: "Update not processed",
      message: "Earlier updates remain available. Open Diagnostics for details.",
    });
  });

  it("keeps authorization recovery specific to push authorization errors", () => {
    expect(
      providerSyncLogPresentation({
        providerName: "Garmin",
        dataType: "update",
        status: "error",
        authFailureReason: "authorization_failed",
        pushOnly: true,
      }),
    ).toMatchObject({
      heading: "Authorization failed",
      message: "Reconnect Garmin to resume incoming updates.",
    });
  });

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

const theCragAction = {
  label: "theCrag API Keys",
  url: "https://www.thecrag.com/settings/apikey/",
};

function theCragMessage(status: number): string {
  return `theCrag denied logbook access (${status}). Check your weekly token budget, supporter status, and API key.`;
}

function requiresAccessMessage(status: number): string {
  return `theCrag requires logbook access for this key (${status}). Check the key's access in theCrag Settings > API Keys.`;
}

function deniedAccessMessage(status: number): string {
  return `theCrag denied logbook access (${status}). Check your API key, active supporter status and weekly usage budget in theCrag Settings > API Keys.`;
}

describe("providerSyncAccessIssue", () => {
  it("returns null for unrecognized or unsafe look-alike messages", () => {
    expect(providerSyncAccessIssue(null)).toBeNull();
    expect(providerSyncAccessIssue(undefined)).toBeNull();
    expect(providerSyncAccessIssue("some other provider error")).toBeNull();
    expect(providerSyncAccessIssue(theCragLogbookAccessErrorMessage(401))).toBeNull();
    expect(
      providerSyncAccessIssue(
        `${theCragMessage(400)} https://www.thecrag.com.evil.example/settings/apikey/`,
      ),
    ).toBeNull();
  });
});

describe("providerSyncLogPresentation theCrag logbook access", () => {
  const formats: Array<[string, (status: number) => string]> = [
    ["current", theCragLogbookAccessErrorMessage],
    ["legacy requires-access", requiresAccessMessage],
    ["legacy denied-access", deniedAccessMessage],
  ];

  it.each(formats)(
    "presents the %s denial for HTTP 400 and 403 even with a stored authorization reason",
    (_format, build) => {
      for (const status of [400, 403]) {
        expect(
          providerSyncLogPresentation({
            providerName: "theCrag",
            dataType: "logbook",
            status: "error",
            authFailureReason: "access_token_expired",
            errorMessage: build(status),
          }),
        ).toEqual({
          dataTypeLabel: "Logbook",
          heading: "Logbook access denied",
          message: theCragMessage(status),
          tone: "danger",
          action: theCragAction,
        });
      }
    },
  );

  it.each(["degraded", "success", "unknown"])(
    "does not present a recognized access message as a denial for a %s status",
    (status) => {
      expect(
        providerSyncLogPresentation({
          providerName: "theCrag",
          dataType: "logbook",
          status,
          authFailureReason: null,
          errorMessage: theCragLogbookAccessErrorMessage(403),
        }).heading,
      ).not.toBe("Logbook access denied");
    },
  );
});
