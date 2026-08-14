import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { SchemaExecutionDatabase } from "../lib/typed-sql.ts";
import {
  ClimbingTrainingLogRepository,
  readFingerLoadingRange,
} from "./climbing-training-log-repository.ts";
import { collectSqlText } from "./test-helpers.ts";

const fingerLoadingRow = {
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
};

describe("readFingerLoadingRange", () => {
  it("scopes history and derives effective load from canonical raw values", async () => {
    const execute = vi.fn(
      async (_query: SQL): Promise<Record<string, unknown>[]> => [fingerLoadingRow],
    );
    const database = { execute } satisfies SchemaExecutionDatabase;

    await expect(
      readFingerLoadingRange({
        database,
        endDate: "2026-07-29",
        startDate: "2026-07-01",
        timezone: "America/Los_Angeles",
        userId: "user-1",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ activityId: "activity-1", effectiveLoadKg: 90 }),
    ]);

    const queryText = collectSqlText(execute.mock.calls[0]?.[0]);
    expect(queryText).toContain("FROM fitness.v_activity AS a");
    expect(queryText).toContain("entry.activity_id = ANY(a.member_activity_ids)");
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain("user-1");
  });
});

describe("ClimbingTrainingLogRepository", () => {
  it("scopes finger-loading history to the user, time window, and entitlement window", async () => {
    const execute = vi.fn(
      async (_query: SQL): Promise<Record<string, unknown>[]> => [fingerLoadingRow],
    );
    const repository = new ClimbingTrainingLogRepository(
      { execute },
      "user-1",
      "America/Los_Angeles",
      {
        endDateExclusive: "2026-08-01",
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-07-01",
      },
    );

    await expect(repository.getFingerLoadingHistory(30)).resolves.toEqual([
      expect.objectContaining({ activityId: "activity-1", effectiveLoadKg: 90 }),
    ]);

    const query = execute.mock.calls[0]?.[0];
    const queryText = collectSqlText(query);
    expect(queryText).toContain("FROM fitness.v_activity AS a");
    expect(queryText).toContain("a.user_id =");
    expect(queryText).toContain("NOW() -");
    expect(queryText).toContain("INTERVAL '1 day'");
    expect(queryText).toContain("a.started_at >=");
    expect(queryText).toContain("a.started_at <");
    expect(JSON.stringify(query)).toContain("user-1");
    expect(JSON.stringify(query)).toContain("30");
    expect(JSON.stringify(query)).toContain("2026-07-01");
    expect(JSON.stringify(query)).toContain("2026-08-01");
    expect(JSON.stringify(query)).toContain("America/Los_Angeles");
  });
});
