import { describe, expect, it, vi } from "vitest";
import { listPreSleepActivities, listWorkoutWindows } from "./pre-sleep-activity-repository.ts";
import type { SleepEpisode } from "./sleep-episode-analysis.ts";

const filters = {
  providers: [],
  modalities: [],
  canonicalTypes: [],
};

function episode(overrides: {
  id: string;
  started_at: string;
  ended_at: string | null;
  local_start_date: string;
  local_wake_date: string | null;
  local_start_time?: string;
  local_wake_time?: string | null;
  source_providers?: string[];
}): SleepEpisode {
  return {
    date: overrides.local_wake_date ?? overrides.local_start_date,
    timing: {
      selected_session_id: overrides.id,
      source_session_ids: [overrides.id],
      source_providers: overrides.source_providers ?? ["oura"],
      source_provider: "oura",
      source_name: "Oura",
      started_at: overrides.started_at,
      ended_at: overrides.ended_at,
      local_start_date: overrides.local_start_date,
      local_start_time: overrides.local_start_time ?? "22:00:00",
      local_wake_date: overrides.local_wake_date,
      local_wake_time: overrides.local_wake_time ?? (overrides.local_wake_date ? "06:00:00" : null),
      display_timezone: "UTC",
      timezone_source: "profile",
      local_time_context: {
        timezone: null,
        startUtcOffsetMinutes: null,
        endUtcOffsetMinutes: null,
        source: "unknown",
      },
      is_nap: false,
      sleep_kind_recorded: true,
      elapsed_minutes:
        overrides.ended_at === null
          ? null
          : (Date.parse(overrides.ended_at) - Date.parse(overrides.started_at)) / 60_000,
    },
    duration_minutes:
      overrides.ended_at === null
        ? null
        : (Date.parse(overrides.ended_at) - Date.parse(overrides.started_at)) / 60_000,
    efficiency_pct: 90,
    staging_available: false,
    stages_minutes: { deep: null, rem: null, light: null, awake: null },
  };
}

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    sleep_id: "sleep-current",
    id: "activity-1",
    canonical_type: "run",
    started_at: "2026-03-10T10:00:00.000Z",
    ended_at: "2026-03-10T11:00:00.000Z",
    source_providers: ["strava"],
    matches_filter: true,
    ...overrides,
  };
}

function makeDb(rows: unknown[] = []) {
  return { execute: vi.fn().mockResolvedValue(rows) };
}

describe("listPreSleepActivities", () => {
  it("returns unavailable when no valid previous main wake exists", async () => {
    const db = makeDb();
    const only = episode({
      id: "sleep-1",
      started_at: "2026-03-10T06:00:00.000Z",
      ended_at: "2026-03-10T14:00:00.000Z",
      local_start_date: "2026-03-10",
      local_wake_date: "2026-03-10",
    });

    const result = await listPreSleepActivities(db, "user-1", [only], "UTC", filters);

    expect(db.execute).not.toHaveBeenCalled();
    expect(result.get("sleep-1")).toEqual({
      coverage_status: "unavailable",
      reason: "No valid preceding main wake in the two-calendar-day lookback.",
      previous_wake: null,
      activity_count: null,
      source_activity_ids: [],
      source_activity_ids_truncated: false,
      source_providers: [],
      duration: { value_minutes: null, supported_activities: 0 },
      last_activity: null,
      minutes_to_sleep: null,
    });
  });

  it("treats missing or non-preceding previous wake and gaps over two days as unavailable", async () => {
    const db = makeDb();
    const previousNoEnd = episode({
      id: "sleep-prev-open",
      started_at: "2026-03-09T06:00:00.000Z",
      ended_at: null,
      local_start_date: "2026-03-09",
      local_wake_date: null,
    });
    const previousOverlap = episode({
      id: "sleep-prev-overlap",
      started_at: "2026-03-09T06:00:00.000Z",
      ended_at: "2026-03-09T15:00:00.000Z",
      local_start_date: "2026-03-09",
      local_wake_date: "2026-03-09",
    });
    const previousFar = episode({
      id: "sleep-prev-far",
      started_at: "2026-03-06T06:00:00.000Z",
      ended_at: "2026-03-06T14:00:00.000Z",
      local_start_date: "2026-03-06",
      local_wake_date: "2026-03-06",
    });
    const current = episode({
      id: "sleep-current",
      started_at: "2026-03-09T14:00:00.000Z",
      ended_at: "2026-03-09T22:00:00.000Z",
      local_start_date: "2026-03-09",
      local_wake_date: "2026-03-09",
    });

    const noEnd = await listPreSleepActivities(
      db,
      "user-1",
      [previousNoEnd, current],
      "UTC",
      filters,
    );
    const overlap = await listPreSleepActivities(
      db,
      "user-1",
      [
        previousOverlap,
        { ...current, timing: { ...current.timing, started_at: "2026-03-09T14:30:00.000Z" } },
      ],
      "UTC",
      filters,
    );
    const gap = await listPreSleepActivities(
      db,
      "user-1",
      [
        previousFar,
        {
          ...current,
          timing: {
            ...current.timing,
            started_at: "2026-03-09T06:00:00.000Z",
            local_start_date: "2026-03-09",
          },
        },
      ],
      "UTC",
      filters,
    );

    expect(noEnd.get("sleep-current")?.coverage_status).toBe("unavailable");
    expect(overlap.get("sleep-current")?.coverage_status).toBe("unavailable");
    expect(gap.get("sleep-current")?.coverage_status).toBe("unavailable");
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("includes exactly two calendar-day gaps and reports no records", async () => {
    const db = makeDb([]);
    const previous = episode({
      id: "sleep-prev",
      started_at: "2026-03-07T06:00:00.000Z",
      ended_at: "2026-03-07T14:00:00.000Z",
      local_start_date: "2026-03-07",
      local_wake_date: "2026-03-07",
    });
    const current = episode({
      id: "sleep-current",
      started_at: "2026-03-09T06:00:00.000Z",
      ended_at: "2026-03-09T14:00:00.000Z",
      local_start_date: "2026-03-09",
      local_wake_date: "2026-03-09",
    });

    const result = await listPreSleepActivities(db, "user-1", [current, previous], "UTC", filters);

    expect(db.execute).toHaveBeenCalledOnce();
    expect(result.get("sleep-current")).toEqual({
      coverage_status: "no_records",
      reason: "No activity records cover this window. Recording completeness is unknown.",
      previous_wake: { session_id: "sleep-prev", ended_at: "2026-03-07T14:00:00.000Z" },
      activity_count: 0,
      source_activity_ids: [],
      source_activity_ids_truncated: false,
      source_providers: [],
      duration: { value_minutes: null, supported_activities: 0 },
      last_activity: null,
      minutes_to_sleep: null,
    });
  });

  it("distinguishes nonmatching recorded zero from partial missing/invalid ends", async () => {
    const previous = episode({
      id: "sleep-prev",
      started_at: "2026-03-09T06:00:00.000Z",
      ended_at: "2026-03-09T14:00:00.000Z",
      local_start_date: "2026-03-09",
      local_wake_date: "2026-03-09",
    });
    const current = episode({
      id: "sleep-current",
      started_at: "2026-03-10T06:00:00.000Z",
      ended_at: "2026-03-10T14:00:00.000Z",
      local_start_date: "2026-03-10",
      local_wake_date: "2026-03-10",
    });

    const nonmatching = await listPreSleepActivities(
      makeDb([
        activityRow({ id: "walk-1", source_providers: ["garmin"], matches_filter: false }),
        activityRow({ id: "walk-2", source_providers: ["apple"], matches_filter: false }),
      ]),
      "user-1",
      [previous, current],
      "UTC",
      filters,
    );
    expect(nonmatching.get("sleep-current")).toEqual({
      coverage_status: "no_matching_records",
      reason: null,
      previous_wake: { session_id: "sleep-prev", ended_at: "2026-03-09T14:00:00.000Z" },
      activity_count: 0,
      source_activity_ids: [],
      source_activity_ids_truncated: false,
      source_providers: [],
      duration: { value_minutes: 0, supported_activities: 0 },
      last_activity: null,
      minutes_to_sleep: null,
    });

    const partial = await listPreSleepActivities(
      makeDb([
        activityRow({
          id: "run-valid",
          started_at: "2026-03-09T20:00:00.000Z",
          ended_at: "2026-03-09T21:00:00.000Z",
          source_providers: ["strava", "zwift"],
        }),
        activityRow({
          id: "run-open",
          started_at: "2026-03-09T22:00:00.000Z",
          ended_at: null,
          source_providers: ["garmin"],
        }),
        activityRow({
          id: "run-invalid",
          started_at: "2026-03-09T23:00:00.000Z",
          ended_at: "2026-03-09T23:00:00.000Z",
          source_providers: ["apple"],
        }),
      ]),
      "user-1",
      [previous, current],
      "UTC",
      filters,
    );
    expect(partial.get("sleep-current")).toEqual({
      coverage_status: "partial",
      reason: "At least one matching activity has a missing or invalid end.",
      previous_wake: { session_id: "sleep-prev", ended_at: "2026-03-09T14:00:00.000Z" },
      activity_count: 3,
      source_activity_ids: ["run-valid", "run-open", "run-invalid"],
      source_activity_ids_truncated: false,
      source_providers: ["apple", "garmin", "strava", "zwift"],
      duration: { value_minutes: null, supported_activities: 1 },
      last_activity: null,
      minutes_to_sleep: null,
    });
  });

  it("computes clipped union duration, respects boundaries, and picks the last completed activity", async () => {
    const previous = episode({
      id: "sleep-prev",
      started_at: "2026-03-09T02:00:00.000Z",
      ended_at: "2026-03-09T10:00:00.000Z",
      local_start_date: "2026-03-09",
      local_wake_date: "2026-03-09",
    });
    const current = episode({
      id: "sleep-current",
      started_at: "2026-03-09T14:00:00.000Z",
      ended_at: "2026-03-09T22:00:00.000Z",
      local_start_date: "2026-03-09",
      local_wake_date: "2026-03-09",
    });
    const db = makeDb([
      activityRow({
        id: "early-overlap",
        canonical_type: "strength",
        started_at: "2026-03-09T09:30:00.000Z",
        ended_at: "2026-03-09T10:30:00.000Z",
        source_providers: ["apple"],
      }),
      activityRow({
        id: "middle",
        canonical_type: "walk",
        started_at: "2026-03-09T10:15:00.000Z",
        ended_at: "2026-03-09T11:00:00.000Z",
        source_providers: ["garmin"],
      }),
      activityRow({
        id: "late-tie-a",
        canonical_type: "ride",
        started_at: "2026-03-09T12:30:00.000Z",
        ended_at: "2026-03-09T13:30:00.000Z",
        source_providers: ["wahoo"],
      }),
      activityRow({
        id: "late-tie-b",
        canonical_type: "yoga",
        started_at: "2026-03-09T13:00:00.000Z",
        ended_at: "2026-03-09T13:30:00.000Z",
        source_providers: ["peloton"],
      }),
      activityRow({
        id: "after-sleep-start",
        canonical_type: "run",
        started_at: "2026-03-09T13:45:00.000Z",
        ended_at: "2026-03-09T14:15:00.000Z",
        source_providers: ["strava"],
      }),
      activityRow({
        id: "excluded",
        canonical_type: "swim",
        started_at: "2026-03-09T11:30:00.000Z",
        ended_at: "2026-03-09T12:00:00.000Z",
        source_providers: ["polar"],
        matches_filter: false,
      }),
    ]);

    const result = await listPreSleepActivities(
      db,
      "user-1",
      [previous, current],
      "America/New_York",
      {
        providers: ["apple", "strava"],
        modalities: ["outdoor"],
        canonicalTypes: ["run"],
      },
    );

    expect(db.execute).toHaveBeenCalledOnce();
    const summary = result.get("sleep-current");
    expect(summary).toMatchObject({
      coverage_status: "observed",
      reason: null,
      previous_wake: { session_id: "sleep-prev", ended_at: "2026-03-09T10:00:00.000Z" },
      activity_count: 5,
      source_activity_ids: [
        "early-overlap",
        "middle",
        "late-tie-a",
        "late-tie-b",
        "after-sleep-start",
      ],
      source_activity_ids_truncated: false,
      source_providers: ["apple", "garmin", "peloton", "strava", "wahoo"],
      duration: { value_minutes: 135, supported_activities: 5 },
      last_activity: {
        id: "late-tie-a",
        canonical_type: "ride",
        source_providers: ["wahoo"],
        ended_at: "2026-03-09T13:30:00.000Z",
        local_end_date: "2026-03-09",
        local_end_time: "09:30:00",
      },
      minutes_to_sleep: 30,
    });
  });

  it("limits source evidence to 100 qualifying activities and preserves truncation", async () => {
    const previous = episode({
      id: "sleep-prev",
      started_at: "2026-03-09T00:00:00.000Z",
      ended_at: "2026-03-09T10:00:00.000Z",
      local_start_date: "2026-03-09",
      local_wake_date: "2026-03-09",
    });
    const current = episode({
      id: "sleep-current",
      started_at: "2026-03-09T14:00:00.000Z",
      ended_at: "2026-03-09T22:00:00.000Z",
      local_start_date: "2026-03-09",
      local_wake_date: "2026-03-09",
    });
    const rows = Array.from({ length: 101 }, (_, index) =>
      activityRow({
        id: `activity-${String(index).padStart(3, "0")}`,
        started_at: new Date(Date.parse("2026-03-09T10:00:00.000Z") + index * 60_000).toISOString(),
        ended_at: new Date(Date.parse("2026-03-09T10:01:00.000Z") + index * 60_000).toISOString(),
        source_providers: index === 100 ? ["zeta", "alpha"] : ["alpha"],
      }),
    );

    const result = await listPreSleepActivities(
      makeDb(rows),
      "user-1",
      [previous, current],
      "UTC",
      filters,
    );
    const summary = result.get("sleep-current");

    expect(summary?.activity_count).toBe(101);
    expect(summary?.source_activity_ids).toHaveLength(100);
    expect(summary?.source_activity_ids[0]).toBe("activity-000");
    expect(summary?.source_activity_ids[99]).toBe("activity-099");
    expect(summary?.source_activity_ids_truncated).toBe(true);
    expect(summary?.source_providers).toEqual(["alpha", "zeta"]);
  });
});

describe("listWorkoutWindows", () => {
  const access = { startDate: "2026-03-07", endDate: "2026-03-08", timezone: "UTC" };

  function pair(previousEnd: string, previousOverrides: Partial<SleepEpisode["timing"]> = {}) {
    const previous = episode({
      id: "sleep-prev",
      started_at: "2026-03-06T22:00:00.000Z",
      ended_at: previousEnd,
      local_start_date: "2026-03-06",
      local_wake_date: previousEnd.slice(0, 10),
    });
    previous.timing = { ...previous.timing, ...previousOverrides };
    const current = episode({
      id: "sleep-current",
      started_at: "2026-03-09T12:00:00.000Z",
      ended_at: "2026-03-09T07:00:00.000Z",
      local_start_date: "2026-03-09",
      local_wake_date: "2026-03-09",
    });
    return [current, previous];
  }

  function workoutRow() {
    const { matches_filter: _matches, ...row } = activityRow();
    return { ...row, matches_filter: false, provider_type: "strava", fit_members: [] };
  }

  it("returns previous wake and activities without internal columns", async () => {
    const db = makeDb([workoutRow()]);
    const result = await listWorkoutWindows(db, "user-1", pair("2026-03-07T06:00:00.000Z"), access);

    const { sleep_id: _sleepId, matches_filter: _matches, ...expected } = workoutRow();
    expect(result.get("sleep-current")).toEqual({
      previousWake: { sessionId: "sleep-prev", endedAt: "2026-03-07T06:00:00.000Z" },
      activities: [expected],
    });
  });

  it("returns an empty activity list when the window has no rows", async () => {
    const result = await listWorkoutWindows(
      makeDb([]),
      "user-1",
      pair("2026-03-07T06:00:00.000Z"),
      access,
    );
    expect(result.get("sleep-current")?.activities).toEqual([]);
  });

  it("includes wake dates on both inclusive range boundaries", async () => {
    for (const wake of ["2026-03-07T06:00:00.000Z", "2026-03-08T06:00:00.000Z"]) {
      const db = makeDb([]);
      const result = await listWorkoutWindows(db, "user-1", pair(wake), access);
      expect(result.has("sleep-current")).toBe(true);
      expect(db.execute).toHaveBeenCalledOnce();
    }
  });

  it("excludes wake dates before or after the access range", async () => {
    for (const wake of ["2026-03-06T23:00:00.000Z", "2026-03-09T00:30:00.000Z"]) {
      const db = makeDb([]);
      const result = await listWorkoutWindows(db, "user-1", pair(wake), access);
      expect(result.size).toBe(0);
      expect(db.execute).not.toHaveBeenCalled();
    }
  });

  it("evaluates the wake date in the access timezone", async () => {
    const db = makeDb([]);
    const result = await listWorkoutWindows(db, "user-1", pair("2026-03-09T02:00:00.000Z"), {
      ...access,
      timezone: "America/New_York",
    });
    expect(result.has("sleep-current")).toBe(true);
  });

  it("excludes windows whose previous sleep has no elapsed duration", async () => {
    const db = makeDb([]);
    const result = await listWorkoutWindows(
      db,
      "user-1",
      pair("2026-03-07T06:00:00.000Z", { elapsed_minutes: null }),
      access,
    );
    expect(result.size).toBe(0);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("ignores naps as the current sleep", async () => {
    const [current, previous] = pair("2026-03-07T06:00:00.000Z");
    if (!current) throw new Error("fixture");
    current.timing = { ...current.timing, is_nap: true };
    const db = makeDb([]);
    const result = await listWorkoutWindows(db, "user-1", [current, previous], access);
    expect(result.size).toBe(0);
  });
});
