import { describe, expect, it, vi } from "vitest";
import {
  type DerivedSnapshot,
  incompatibleMemberCount,
  snapshotDerivedRows,
  snapshotDerivedRowsOrFallback,
  sourceRowsMatchPostgres,
  uint64StringSchema,
  waitForPostgresMirror,
} from "./activity-data-integrity-clickhouse.ts";

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

function sourceRow(activityId: string): DerivedSnapshot["sourceRows"][number] {
  return {
    activity_id: activityId,
    provider_id: "wahoo",
    user_id: userId,
    canonical_type: "cycling",
    refresh_version: "10",
    is_deleted: 0,
  };
}

const sourceRowA = sourceRow(activityA);
const sourceRowB = sourceRow(activityB);
const sourceRows = [sourceRowA, sourceRowB, sourceRow(activityC)];

function compatibilitySnapshot(
  sources: DerivedSnapshot["sourceRows"],
  deduped: DerivedSnapshot["dedupedRows"],
): DerivedSnapshot {
  return {
    sourceRows: sources,
    matchRows: [],
    groupRows: [],
    dedupedRows: deduped,
    memberRows: [],
    sensorSummaryRows: [],
    summaryRows: [],
    components: [],
    highestVersion: "0",
    activityIds: [],
  };
}

describe("snapshotDerivedRows", () => {
  it("returns the complete empty snapshot without querying ClickHouse", async () => {
    const client = { query: vi.fn() };

    await expect(snapshotDerivedRows(client, userId, [])).resolves.toEqual({
      sourceRows: [],
      matchRows: [],
      groupRows: [],
      dedupedRows: [],
      memberRows: [],
      sensorSummaryRows: [],
      summaryRows: [],
      components: [],
      highestVersion: "0",
      activityIds: [],
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("preserves the captured pre-state when a failure snapshot is unavailable", async () => {
    const fallback = compatibilitySnapshot([sourceRowA], []);
    const client = {
      query: vi.fn(async () => Promise.reject(new Error("ClickHouse unavailable"))),
    };

    await expect(
      snapshotDerivedRowsOrFallback(client, userId, [activityA], fallback),
    ).resolves.toBe(fallback);
  });

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
    expect(snapshot.components).toEqual([
      { groupId: activityA, memberActivityIds: [activityA, activityB, activityC] },
    ]);
    expect(snapshot.highestVersion).toBe("12");
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

  it("fetches source rows for every member returned by the deduped projection", async () => {
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
            ? query_params.activityIds
            : [];
          if (query.includes("deduped_activities")) {
            return {
              json: async () => [
                {
                  activity_id: activityA,
                  user_id: userId,
                  provider_id: "wahoo",
                  canonical_type: "cycling",
                  member_activity_ids: [activityA, activityC],
                  refresh_version: "12",
                  is_deleted: 0,
                },
              ],
            };
          }
          if (query.includes("activity_source_records")) {
            return {
              json: async () => sourceRows.filter((row) => activityIds.includes(row.activity_id)),
            };
          }
          return { json: async () => [] };
        },
      ),
    };

    const snapshot = await snapshotDerivedRows(client, userId, [activityA]);

    expect(snapshot.activityIds).toEqual([activityA, activityC]);
    expect(snapshot.sourceRows).toEqual([sourceRowA, sourceRows[2]]);
  });
});

describe("UInt64 parsing", () => {
  it("accepts exact safe inputs and rejects negative, fractional, unsafe, and overflowing values", () => {
    expect(uint64StringSchema.parse(0)).toBe("0");
    expect(uint64StringSchema.parse("18446744073709551615")).toBe("18446744073709551615");
    for (const invalid of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      "-1",
      "1.5",
      "18446744073709551616",
    ]) {
      expect(() => uint64StringSchema.parse(invalid)).toThrow();
    }
  });
});

describe("incompatibleMemberCount", () => {
  const dedupedRow = {
    activity_id: activityA,
    user_id: userId,
    provider_id: "wahoo",
    canonical_type: "cycling",
    member_activity_ids: [activityA, activityB, activityC],
    refresh_version: "12",
    is_deleted: 0,
  };

  it("counts type mismatches while ignoring absent source rows", () => {
    expect(
      incompatibleMemberCount(
        compatibilitySnapshot(
          [sourceRowA, { ...sourceRowB, canonical_type: "running" }],
          [dedupedRow],
        ),
      ),
    ).toBe(1);
  });

  it("requires provider consistency only for other activities", () => {
    expect(
      incompatibleMemberCount(
        compatibilitySnapshot(
          sourceRows.map((row, index) => ({
            ...row,
            provider_id: index === 1 ? "peloton" : "wahoo",
            canonical_type: "other",
          })),
          [{ ...dedupedRow, canonical_type: "other" }],
        ),
      ),
    ).toBe(1);
    expect(
      incompatibleMemberCount(
        compatibilitySnapshot(
          sourceRows.map((row, index) => ({
            ...row,
            provider_id: index === 1 ? "peloton" : "wahoo",
          })),
          [dedupedRow],
        ),
      ),
    ).toBe(0);
  });
});

describe("sourceRowsMatchPostgres", () => {
  const repaired = {
    id: activityA,
    repaired: {
      timezone: "America/New_York",
      startUtcOffsetMinutes: -240,
      endUtcOffsetMinutes: -240,
      localTimeSource: "provider_timezone",
    },
  };
  const mirrored = {
    ...sourceRowA,
    timezone: repaired.repaired.timezone,
    start_utc_offset_minutes: repaired.repaired.startUtcOffsetMinutes,
    end_utc_offset_minutes: repaired.repaired.endUtcOffsetMinutes,
    local_time_source: repaired.repaired.localTimeSource,
  };

  it("requires a live source row with every repaired local-time field", () => {
    expect(sourceRowsMatchPostgres([mirrored], [repaired])).toBe(true);
    expect(sourceRowsMatchPostgres([], [repaired])).toBe(false);
    for (const mismatch of [
      { is_deleted: 1 },
      { timezone: null },
      { start_utc_offset_minutes: -300 },
      { end_utc_offset_minutes: -300 },
      { local_time_source: "provider_offset" },
    ]) {
      expect(sourceRowsMatchPostgres([{ ...mirrored, ...mismatch }], [repaired])).toBe(false);
    }
  });
});

describe("waitForPostgresMirror", () => {
  const repaired = {
    id: activityA,
    repaired: {
      timezone: null,
      startUtcOffsetMinutes: -240,
      endUtcOffsetMinutes: -240,
      localTimeSource: "provider_offset",
    },
  };
  const mirrored = {
    ...sourceRowA,
    timezone: null,
    start_utc_offset_minutes: -240,
    end_utc_offset_minutes: -240,
    local_time_source: "provider_offset",
  };

  it("polls until every changed activity is mirrored", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => [] })
      .mockResolvedValueOnce({ json: async () => [mirrored] });
    const sleep = vi.fn(async () => undefined);
    const monotonicNow = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1);

    await waitForPostgresMirror({ query }, userId, [repaired], {
      cdcReadinessTimeoutMs: 10,
      cdcReadinessPollIntervalMs: 3,
      monotonicNow,
      sleep,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0].query_params).toEqual({ userId, activityIds: [activityA] });
    expect(sleep).toHaveBeenCalledWith(3);
  });

  it("fails at the configured deadline without sleeping again", async () => {
    const query = vi.fn().mockResolvedValue({ json: async () => [] });
    const sleep = vi.fn(async () => undefined);
    const monotonicNow = vi.fn().mockReturnValueOnce(5).mockReturnValueOnce(15);

    await expect(
      waitForPostgresMirror({ query }, userId, [repaired], {
        cdcReadinessTimeoutMs: 10,
        cdcReadinessPollIntervalMs: 3,
        monotonicNow,
        sleep,
      }),
    ).rejects.toThrow("did not publish 1 repaired activities within 10ms");
    expect(sleep).not.toHaveBeenCalled();
  });
});
