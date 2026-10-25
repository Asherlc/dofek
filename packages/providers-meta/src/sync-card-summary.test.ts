import { describe, expect, it } from "vitest";
import { providerSyncStatusPresentation, syncCardSummary } from "./sync-card-summary.ts";

describe("providerSyncStatusPresentation", () => {
  const old = "2026-10-23T10:00:00.000Z";
  const recent = "2026-10-24T10:00:00.000Z";
  const history = { lastSuccessfulSyncAt: null, recentLogs: [] };
  const processing = { status: "ready" as const, datasets: [], operations: [] };

  it("keeps missing recorded outcomes neutral", () => {
    expect(providerSyncStatusPresentation("Garmin", history, processing)).toMatchObject({
      heading: "No sync outcome recorded",
      tone: "neutral",
    });
  });

  it.each([
    ["error", "danger", "Latest Garmin sync failed"],
    ["degraded", "warning", "Garmin sync completed with issues"],
    ["success", "success", "Garmin sync complete"],
    ["unknown", "neutral", "Sync outcome unavailable"],
  ])(
    "presents the latest %s log without inferring success from record counts",
    (status, tone, heading) => {
      expect(
        providerSyncStatusPresentation(
          "Garmin",
          {
            lastSuccessfulSyncAt: old,
            recentLogs: [
              { status: "success", syncedAt: old },
              { status, syncedAt: recent },
            ],
          },
          processing,
        ),
      ).toMatchObject({ tone, heading, occurredAt: recent });
    },
  );

  it("recognizes recorded success outside the recent log window", () => {
    expect(
      providerSyncStatusPresentation(
        "Garmin",
        { ...history, lastSuccessfulSyncAt: recent },
        processing,
      ),
    ).toMatchObject({ tone: "success" });
  });

  it.each(["active", "failed", "ready"] as const)("preserves newer %s processing", (status) => {
    expect(
      providerSyncStatusPresentation(
        "Garmin",
        {
          ...history,
          recentLogs: [{ status: "error", syncedAt: old }],
        },
        {
          status,
          datasets: [],
          operations: [{ status, dismissed: false, createdAt: recent, timeline: [] }],
        },
      ),
    ).toBeNull();
  });

  it("keeps unfinished processing after ingestion records a successful sync", () => {
    expect(
      providerSyncStatusPresentation(
        "Garmin",
        { ...history, recentLogs: [{ status: "success", syncedAt: recent }] },
        {
          status: "active",
          datasets: [
            { status: "active", lastReadyAt: null, lastAdvancedAt: old, lastFailedAt: null },
          ],
          operations: [],
        },
      ),
    ).toBeNull();
  });

  it.each(["success", "error"])(
    "preserves a newer active dataset beside a failed dataset, latest sync=%s",
    (status) => {
      expect(
        providerSyncStatusPresentation(
          "Garmin",
          { ...history, recentLogs: [{ status, syncedAt: recent }] },
          {
            status: "failed",
            datasets: [
              { status: "failed", lastReadyAt: null, lastAdvancedAt: old, lastFailedAt: old },
              {
                status: "active",
                lastReadyAt: null,
                lastAdvancedAt: "2026-10-24T11:00:00.000Z",
                lastFailedAt: null,
              },
            ],
            operations: [],
          },
        ),
      ).toBeNull();
    },
  );

  it.each(["failed", "ready"] as const)(
    "ignores an old active operation superseded by the current %s dataset",
    (status) => {
      expect(
        providerSyncStatusPresentation(
          "Garmin",
          { ...history, recentLogs: [{ status: "success", syncedAt: recent }] },
          {
            status,
            datasets: [
              {
                status,
                lastAdvancedAt: "2026-10-24T09:00:00.000Z",
                lastReadyAt: status === "ready" ? "2026-10-24T09:00:00.000Z" : null,
                lastFailedAt: status === "failed" ? "2026-10-24T09:00:00.000Z" : null,
              },
            ],
            operations: [{ status: "active", dismissed: false, createdAt: old, timeline: [] }],
          },
        ),
      ).toMatchObject({ tone: "success", heading: "Garmin sync complete" });
    },
  );

  it("prefers failure at the same time as ready processing", () => {
    expect(
      providerSyncStatusPresentation(
        "Garmin",
        {
          ...history,
          recentLogs: [
            { status: "success", syncedAt: recent },
            { status: "error", syncedAt: recent },
          ],
        },
        {
          ...processing,
          datasets: [
            { status: "ready", lastReadyAt: recent, lastAdvancedAt: recent, lastFailedAt: null },
          ],
        },
      ),
    ).toMatchObject({ tone: "danger" });
  });

  it("replaces stale failed processing with a newer successful sync", () => {
    expect(
      providerSyncStatusPresentation(
        "Garmin",
        {
          ...history,
          recentLogs: [{ status: "success", syncedAt: recent }],
        },
        {
          status: "failed",
          datasets: [
            { status: "failed", lastReadyAt: null, lastAdvancedAt: old, lastFailedAt: old },
          ],
          operations: [],
        },
      ),
    ).toMatchObject({ tone: "success" });
  });
});

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

  it.each([
    [
      { status: "success", syncedAt: successfulAt },
      { status: "degraded", syncedAt: attemptedAt },
    ],
    [
      { status: "degraded", syncedAt: attemptedAt },
      { status: "success", syncedAt: successfulAt },
    ],
  ])("summarizes the newest issue independently of log order %#", (...recentLogs) => {
    expect(
      syncCardSummary({
        lastSyncAt: attemptedAt,
        lastSuccessfulSyncAt: successfulAt,
        recentLogs,
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

  it.each([
    [
      { status: "error", syncedAt: attemptedAt },
      { status: "success", syncedAt: attemptedAt },
      { status: "degraded", syncedAt: attemptedAt },
    ],
    [
      { status: "success", syncedAt: attemptedAt },
      { status: "error", syncedAt: attemptedAt },
      { status: "degraded", syncedAt: attemptedAt },
    ],
    [
      { status: "success", syncedAt: attemptedAt },
      { status: "degraded", syncedAt: attemptedAt },
      { status: "error", syncedAt: attemptedAt },
    ],
  ])("keeps a tied failure visible independently of log order %#", (...recentLogs) => {
    expect(
      syncCardSummary({
        lastSyncAt: attemptedAt,
        lastSuccessfulSyncAt: successfulAt,
        recentLogs,
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
