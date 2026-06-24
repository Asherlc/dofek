import { describe, expect, it } from "vitest";
import { buildSyncRequestJobId } from "../lib/sync-request-query.ts";
import { resolveWhoopSyncRequestQuery } from "../providers/whoop/sync-request-query.ts";

describe("resolveWhoopSyncRequestQuery", () => {
  it("maps a fresh sync job to the first bootstrap cycles request", () => {
    expect(
      resolveWhoopSyncRequestQuery({
        userId: "user-1",
        providerId: "whoop",
        sinceDays: 30,
      }),
    ).toEqual({
      path: "core-details-bff/v0/cycles/details",
      filters: expect.objectContaining({
        cursorMs: expect.any(Number),
      }),
    });
  });

  it("maps an API checkpoint to the next step request", () => {
    expect(
      resolveWhoopSyncRequestQuery({
        userId: "user-1",
        providerId: "whoop",
        sinceIso: "2026-05-01T00:00:00.000Z",
        untilIso: "2026-05-03T00:00:00.000Z",
        checkpoint: {
          runId: "run-1",
          recordsSynced: 0,
          phase: "api",
          cycleFetchCursorMs: null,
          cycles: [],
          apiSteps: [
            {
              type: "heart_rate",
              start: "2026-05-01T00:00:00.000Z",
              end: "2026-05-08T00:00:00.000Z",
            },
          ],
          apiStepIndex: 0,
          presentExternalIds: [],
        },
      }),
    ).toEqual({
      path: "metrics-service/v1/metrics",
      filters: {
        name: "heart_rate",
        start: "2026-05-01T00:00:00.000Z",
        end: "2026-05-08T00:00:00.000Z",
        step: 6,
      },
    });
  });
});

describe("buildSyncRequestJobId", () => {
  it("is stable for the same provider request", () => {
    const query = {
      path: "metrics-service/v1/metrics",
      filters: {
        name: "heart_rate",
        start: "2026-05-01T00:00:00.000Z",
        end: "2026-05-08T00:00:00.000Z",
        step: 6,
      },
    };
    expect(buildSyncRequestJobId("whoop", "user-1", query)).toBe(
      buildSyncRequestJobId("whoop", "user-1", query),
    );
  });
});
