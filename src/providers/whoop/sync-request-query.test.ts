import { describe, expect, it } from "vitest";
import { resolveWhoopSyncRequestQuery } from "./sync-request-query.ts";

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

  it("returns bootstrap cycle details query with checkpoint cursor", () => {
    expect(
      resolveWhoopSyncRequestQuery({
        userId: "user-1",
        providerId: "whoop",
        sinceIso: "2026-05-01T00:00:00.000Z",
        untilIso: "2026-05-03T00:00:00.000Z",
        checkpoint: {
          runId: "run-1",
          recordsSynced: 0,
          phase: "bootstrap",
          cycleFetchCursorMs: 1234567890,
          cycles: [],
          apiSteps: [],
          apiStepIndex: 0,
          presentExternalIds: [],
        },
      }),
    ).toEqual({
      path: "core-details-bff/v0/cycles/details",
      filters: {
        start: "2026-05-01T00:00:00.000Z",
        end: "2026-05-03T00:00:00.000Z",
        cursorMs: 1234567890,
      },
    });
  });

  it("returns null for bootstrap checkpoint with null cursor", () => {
    expect(
      resolveWhoopSyncRequestQuery({
        userId: "user-1",
        providerId: "whoop",
        sinceIso: "2026-05-01T00:00:00.000Z",
        untilIso: "2026-05-03T00:00:00.000Z",
        checkpoint: {
          runId: "run-1",
          recordsSynced: 0,
          phase: "bootstrap",
          cycleFetchCursorMs: null,
          cycles: [],
          apiSteps: [],
          apiStepIndex: 0,
          presentExternalIds: [],
        },
      }),
    ).toBeNull();
  });

  it("returns null when API phase step index is out of bounds", () => {
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
          apiSteps: [],
          apiStepIndex: 0,
          presentExternalIds: [],
        },
      }),
    ).toBeNull();
  });

  it("returns null for a done checkpoint even when api steps exist", () => {
    expect(
      resolveWhoopSyncRequestQuery({
        userId: "user-1",
        providerId: "whoop",
        sinceIso: "2026-05-01T00:00:00.000Z",
        untilIso: "2026-05-03T00:00:00.000Z",
        checkpoint: {
          runId: "run-1",
          recordsSynced: 0,
          phase: "done",
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
    ).toBeNull();
  });
});
