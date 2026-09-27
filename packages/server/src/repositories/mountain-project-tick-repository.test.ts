import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityRow } from "../models/activity.ts";
import { ActivityRepository } from "./activity-repository.ts";
import { MountainProjectTickRepository } from "./mountain-project-tick-repository.ts";

function activity(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    canonical_type: "climbing",
    modality: null,
    started_at: "2026-01-02T00:30:00.000Z",
    ended_at: null,
    name: "Climbing",
    notes: null,
    perceived_exertion: null,
    provider_id: "strava",
    timezone: null,
    start_utc_offset_minutes: null,
    end_utc_offset_minutes: null,
    local_time_source: "unknown",
    subsource: null,
    source_providers: ["strava"],
    source_external_ids: null,
    avg_hr: null,
    max_hr: null,
    avg_power: null,
    max_power: null,
    avg_speed: null,
    max_speed: null,
    avg_cadence: null,
    total_distance: null,
    elevation_gain_m: null,
    elevation_loss_m: null,
    sample_count: null,
    provider_absent_at: null,
    ...overrides,
  };
}

describe("MountainProjectTickRepository", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("queries only active same-owner, unattached Mountain Project ticks for the activity's displayed day", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    vi.spyOn(ActivityRepository.prototype, "findById").mockResolvedValue(activity());
    const repository = new MountainProjectTickRepository(
      { execute },
      "user-1",
      "America/Los_Angeles",
    );

    await repository.getSuggestions("canonical-group-id");

    const statement = execute.mock.calls[0]?.[0];
    if (!(statement instanceof SQL)) throw new Error("Expected suggestion SQL");
    const compiled = new PgDialect().sqlToQuery(statement);
    expect(compiled.sql).toContain("WHERE user_id =");
    expect(compiled.sql).toContain("provider_id = 'mountain-project'");
    expect(compiled.sql).toContain("provider_absent_at IS NULL");
    expect(compiled.sql).toContain("activity_id IS NULL");
    expect(compiled.sql).toContain("unattached_date =");
    expect(compiled.params).toContain("2026-01-01");
  });

  it("uses the activity's Los Angeles displayed date across UTC midnight", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    vi.spyOn(ActivityRepository.prototype, "findById").mockResolvedValue(activity());
    const repository = new MountainProjectTickRepository(
      { execute },
      "user-1",
      "America/Los_Angeles",
    );

    await repository.getSuggestions("canonical-group-id");

    const statement = execute.mock.calls[0]?.[0];
    if (!(statement instanceof SQL)) throw new Error("Expected suggestion SQL");
    const query = new PgDialect().sqlToQuery(statement);
    expect(query.params).toContain("2026-01-01");
  });

  it("updates one eligible tick conditionally and reports a concurrent attachment conflict", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    vi.spyOn(ActivityRepository.prototype, "findById").mockResolvedValue(activity());
    const repository = new MountainProjectTickRepository(
      { execute },
      "user-1",
      "America/Los_Angeles",
    );

    await expect(
      repository.attachTick({
        tickId: "20000000-0000-4000-8000-000000000001",
        activityId: "canonical-group-id",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const statement = execute.mock.calls[0]?.[0];
    if (!(statement instanceof SQL)) throw new Error("Expected attachment SQL");
    const sql = new PgDialect().sqlToQuery(statement).sql;
    expect(sql).toContain("UPDATE fitness.climbing_entry");
    expect(sql).toContain("RETURNING");
    expect(sql).toContain("AND activity_id IS NULL");
    expect(sql).toContain("AND provider_absent_at IS NULL");
  });
});
