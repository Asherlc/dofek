import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { SchemaExecutionDatabase } from "../lib/typed-sql.ts";
import { readFingerLoadingRange } from "./climbing-training-log-repository.ts";
import { collectSqlText } from "./test-helpers.ts";

describe("readFingerLoadingRange", () => {
  it("scopes the query and derives effective load from canonical raw values", async () => {
    const execute = vi.fn(
      async (_query: SQL): Promise<Record<string, unknown>[]> => [
        {
          activity_id: "activity-1",
          bodyweight_kg: 72.5,
          edge_size_mm: 20,
          exercise: "max_hang",
          external_load_kg: 17.5,
          grip_position: "half_crimp",
          hold_duration_seconds: 10,
          laterality: "both",
          notes: "Controlled",
          rest_interval_seconds: 180,
          rpe: 8,
          set_count: 5,
          started_at: "2026-07-28T17:00:00.000Z",
        },
      ],
    );
    const database = { execute } satisfies SchemaExecutionDatabase;

    const result = await readFingerLoadingRange({
      database,
      endDate: "2026-07-29",
      startDate: "2026-07-01",
      timezone: "America/Los_Angeles",
      userId: "user-1",
    });

    expect(result).toEqual([
      {
        activityId: "activity-1",
        bodyweightKg: 72.5,
        edgeSizeMm: 20,
        effectiveLoadKg: 90,
        exercise: "max_hang",
        externalLoadKg: 17.5,
        gripPosition: "half_crimp",
        holdDurationSeconds: 10,
        laterality: "both",
        notes: "Controlled",
        restIntervalSeconds: 180,
        rpe: 8,
        setCount: 5,
        startedAt: "2026-07-28T17:00:00.000Z",
      },
    ]);
    expect(execute).toHaveBeenCalledOnce();
    const query = execute.mock.calls[0]?.[0];
    expect(collectSqlText(query)).toContain("WHERE a.user_id =");
    expect(JSON.stringify(query)).toContain("user-1");
    expect(JSON.stringify(query)).toContain("America/Los_Angeles");
    expect(JSON.stringify(query)).toContain("2026-07-01");
    expect(JSON.stringify(query)).toContain("2026-07-29");
  });
});
