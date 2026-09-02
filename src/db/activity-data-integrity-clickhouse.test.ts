import { describe, expect, it, vi } from "vitest";
import { snapshotDerivedRows } from "./activity-data-integrity-clickhouse.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const activityA = "00000000-0000-4000-8000-00000000000a";
const activityB = "00000000-0000-4000-8000-00000000000b";
const activityC = "00000000-0000-4000-8000-00000000000c";

const matchAB = {
  activity_id: activityA,
  duplicate_activity_id: activityB,
  overlap_ratio: 0.9,
  refresh_version: "11",
  is_deleted: 0,
  refreshed_at: "2026-09-02 18:00:00.000000000",
};
const matchBC = {
  ...matchAB,
  activity_id: activityB,
  duplicate_activity_id: activityC,
};

const groupRows = [activityA, activityB, activityC].map((activityId) => ({
  activity_id: activityId,
  group_id: activityA,
  refresh_version: "12",
  is_deleted: 0,
  refreshed_at: "2026-09-02 18:00:00.000000000",
}));

const sourceRows = [activityA, activityB, activityC].map((activityId) => ({
  activity_id: activityId,
  provider_id: "wahoo",
  user_id: userId,
  canonical_type: "cycling",
  refresh_version: "10",
  is_deleted: 0,
}));

describe("snapshotDerivedRows", () => {
  it("captures an edge reached through a duplicate when groups do not expand the scope", async () => {
    const client = {
      query: vi.fn(
        async ({
          query,
          query_params,
        }: {
          query: string;
          query_params?: Record<string, unknown>;
        }) => {
          const activityIds = Array.isArray(query_params?.activityIds)
            ? query_params.activityIds.filter(
                (activityId): activityId is string => typeof activityId === "string",
              )
            : [];
          if (query.includes("activity_duplicate_matches")) {
            return {
              json: async () => (activityIds.includes(activityB) ? [matchAB, matchBC] : [matchAB]),
            };
          }
          if (query.includes("activity_duplicate_groups")) {
            return {
              json: async () => groupRows.filter((row) => activityIds.includes(row.activity_id)),
            };
          }
          if (query.includes("activity_source_records")) {
            return { json: async () => sourceRows };
          }
          return { json: async () => [] };
        },
      ),
    };

    const snapshot = await snapshotDerivedRows(client, userId, [activityA]);

    expect(snapshot.activityIds).toEqual([activityA, activityB, activityC]);
    expect(snapshot.matchRows).toEqual([matchAB, matchBC]);
  });

  it("captures duplicate edges to a fixpoint after group membership expands the scope", async () => {
    const client = {
      query: vi.fn(
        async ({
          query,
          query_params,
        }: {
          query: string;
          query_params?: Record<string, unknown>;
        }) => {
          const activityIds = Array.isArray(query_params?.activityIds)
            ? query_params.activityIds.filter(
                (activityId): activityId is string => typeof activityId === "string",
              )
            : undefined;
          if (query.includes("activity_duplicate_matches")) {
            const matches = activityIds?.includes(activityC) ? [matchAB, matchBC] : [matchAB];
            return { json: async () => matches };
          }
          if (query.includes("activity_duplicate_groups")) {
            return { json: async () => groupRows };
          }
          if (query.includes("activity_source_records")) {
            return { json: async () => sourceRows };
          }
          return { json: async () => [] };
        },
      ),
    };

    const snapshot = await snapshotDerivedRows(client, userId, [activityA]);

    expect(snapshot.activityIds).toEqual([activityA, activityB, activityC]);
    expect(snapshot.matchRows).toEqual([matchAB, matchBC]);
  });
});
