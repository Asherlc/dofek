import { describe, expect, it } from "vitest";
import { syncCardSummary } from "./sync-card-summary.ts";

describe("syncCardSummary", () => {
  const successfulAt = "2026-05-12T10:00:00.000Z";
  const attemptedAt = "2026-05-13T10:00:00.000Z";

  it("shows one timestamp when the latest attempt is the successful update", () => {
    expect(
      syncCardSummary({
        lastSyncAt: successfulAt,
        lastSuccessfulSyncAt: successfulAt,
        recentLogs: [{ status: "success", syncedAt: successfulAt }],
      }),
    ).toEqual({
      lastAttemptAt: null,
      lastSuccessfulSyncAt: successfulAt,
      latestIssue: null,
      hasHistory: true,
    });
  });

  it("preserves differing attempt and successful-update times", () => {
    expect(
      syncCardSummary({
        lastSyncAt: attemptedAt,
        lastSuccessfulSyncAt: successfulAt,
        recentLogs: [],
      }),
    ).toMatchObject({
      lastAttemptAt: attemptedAt,
      lastSuccessfulSyncAt: successfulAt,
      hasHistory: true,
    });
  });

  it("preserves a failed attempt even when the provided timestamps match", () => {
    expect(
      syncCardSummary({
        lastSyncAt: successfulAt,
        lastSuccessfulSyncAt: successfulAt,
        recentLogs: [{ status: "error", syncedAt: successfulAt }],
      }),
    ).toMatchObject({
      lastAttemptAt: successfulAt,
      latestIssue: {
        status: "error",
        label: "Latest sync failed",
        accessibilityLabel: "Sync needs attention",
      },
    });
  });

  it("summarizes the newest issue independently of log order", () => {
    expect(
      syncCardSummary({
        lastSyncAt: attemptedAt,
        lastSuccessfulSyncAt: successfulAt,
        recentLogs: [
          { status: "success", syncedAt: successfulAt },
          { status: "degraded", syncedAt: attemptedAt },
        ],
      }),
    ).toMatchObject({
      latestIssue: {
        status: "degraded",
        label: "Latest sync completed with issues",
        accessibilityLabel: "Sync completed with issues",
      },
    });
  });

  it("recognizes historical success when the recent log window is empty", () => {
    expect(
      syncCardSummary({ lastSyncAt: null, lastSuccessfulSyncAt: successfulAt, recentLogs: [] }),
    ).toEqual({
      lastAttemptAt: null,
      lastSuccessfulSyncAt: successfulAt,
      latestIssue: null,
      hasHistory: true,
    });
  });

  it("keeps a failure visible when data types share the newest attempt time", () => {
    expect(
      syncCardSummary({
        lastSyncAt: attemptedAt,
        lastSuccessfulSyncAt: successfulAt,
        recentLogs: [
          { status: "success", syncedAt: attemptedAt },
          { status: "degraded", syncedAt: attemptedAt },
          { status: "error", syncedAt: attemptedAt },
        ],
      }),
    ).toMatchObject({
      lastAttemptAt: attemptedAt,
      latestIssue: { status: "error", label: "Latest sync failed" },
    });
  });

  it("uses the failed log's recorded time when the provider summary still has the last success", () => {
    expect(
      syncCardSummary({
        lastSyncAt: successfulAt,
        lastSuccessfulSyncAt: successfulAt,
        recentLogs: [{ status: "error", syncedAt: attemptedAt }],
      }),
    ).toMatchObject({ lastAttemptAt: attemptedAt, lastSuccessfulSyncAt: successfulAt });
  });

  it("reports genuinely empty history without inventing an update", () => {
    expect(
      syncCardSummary({ lastSyncAt: null, lastSuccessfulSyncAt: null, recentLogs: [] }),
    ).toEqual({
      lastAttemptAt: null,
      lastSuccessfulSyncAt: null,
      latestIssue: null,
      hasHistory: false,
    });
  });
});
