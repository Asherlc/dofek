import { describe, expect, it } from "vitest";
import { resolveWhoopSyncRequestQuery } from "../providers/whoop/sync-request-query.ts";
import { syncApiQueryKey } from "./sync-api-query.ts";
import {
  buildSyncRequestJobId,
  defaultSyncRequestQuery,
  planSyncStepIfRequestNotPending,
  registerSyncRequestQueryResolver,
  resolveSyncRequestQuery,
} from "./sync-request-query.ts";

registerSyncRequestQueryResolver("whoop", resolveWhoopSyncRequestQuery);

describe("defaultSyncRequestQuery", () => {
  it("deduplicates standard provider sync jobs by sync window", () => {
    expect(
      defaultSyncRequestQuery({
        userId: "user-1",
        providerId: "strava",
        sinceDays: 1,
      }),
    ).toEqual({
      path: "sync",
      filters: {
        sinceIso: expect.any(String),
        untilIso: expect.any(String),
      },
    });
  });
});

describe("resolveSyncRequestQuery", () => {
  it("uses the default resolver for providers without a custom mapping", () => {
    expect(
      resolveSyncRequestQuery("strava", {
        userId: "user-1",
        sinceIso: "2026-05-01T00:00:00.000Z",
        untilIso: "2026-05-03T00:00:00.000Z",
      }),
    ).toEqual({
      path: "sync",
      filters: {
        sinceIso: "2026-05-01T00:00:00.000Z",
        untilIso: "2026-05-03T00:00:00.000Z",
      },
    });
  });

  it("uses a registered step-chain resolver when present", () => {
    expect(
      resolveSyncRequestQuery("whoop", {
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
});

describe("buildSyncRequestJobId", () => {
  it("is stable for the same provider request", () => {
    const query = {
      path: "sync",
      filters: {
        sinceIso: "2026-05-01T00:00:00.000Z",
        untilIso: "2026-05-03T00:00:00.000Z",
      },
    };
    expect(buildSyncRequestJobId("strava", "user-1", query)).toBe(
      buildSyncRequestJobId("strava", "user-1", query),
    );
  });
});

describe("planSyncStepIfRequestNotPending", () => {
  it("skips steps whose API request is already pending", () => {
    const pendingKeys = new Set([
      syncApiQueryKey({
        path: "connectapi/stress",
        filters: { date: "2026-03-01" },
      }),
    ]);
    const steps: Array<{ type: string; date: string }> = [];

    planSyncStepIfRequestNotPending(
      steps,
      { type: "stress", date: "2026-03-01" },
      (step) => ({
        path: "connectapi/stress",
        filters: { date: step.date },
      }),
      pendingKeys,
    );
    planSyncStepIfRequestNotPending(
      steps,
      { type: "stress", date: "2026-03-02" },
      (step) => ({
        path: "connectapi/stress",
        filters: { date: step.date },
      }),
      pendingKeys,
    );

    expect(steps).toEqual([{ type: "stress", date: "2026-03-02" }]);
  });
});
