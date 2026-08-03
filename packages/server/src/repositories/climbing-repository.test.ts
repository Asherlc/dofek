import { describe, expect, it, vi } from "vitest";
import {
  ClimbingActivityEntry,
  ClimbingGradeProgression,
  ClimbingRepository,
  ClimbingSessionSummary,
  ClimbingVolumeByGrade,
} from "./climbing-repository.ts";

function queryText(query: unknown): string {
  if (typeof query !== "object" || query === null || !("queryChunks" in query)) {
    throw new Error("Expected Drizzle SQL query object");
  }

  const queryChunks = Reflect.get(query, "queryChunks");
  return JSON.stringify(queryChunks);
}

describe("ClimbingGradeProgression", () => {
  it("serializes to API shape", () => {
    const row = new ClimbingGradeProgression({
      date: "2026-07-09",
      climbType: "boulder",
      gradeSystem: "v_scale",
      grade: "V5",
      gradeSortValue: 5,
    });

    expect(row.toDetail()).toEqual({
      date: "2026-07-09",
      climbType: "boulder",
      gradeSystem: "v_scale",
      grade: "V5",
      gradeSortValue: 5,
    });
  });
});

describe("ClimbingVolumeByGrade", () => {
  it("serializes to API shape", () => {
    const row = new ClimbingVolumeByGrade({
      climbType: "route",
      gradeSystem: "yds",
      grade: "5.10c",
      gradeSortValue: 5103,
      attempts: 4,
      sends: 2,
    });

    expect(row.toDetail()).toEqual({
      climbType: "route",
      gradeSystem: "yds",
      grade: "5.10c",
      gradeSortValue: 5103,
      attempts: 4,
      sends: 2,
    });
  });
});

describe("ClimbingSessionSummary", () => {
  it("serializes to API shape", () => {
    const row = new ClimbingSessionSummary({
      activityId: "activity-1",
      date: "2026-07-09",
      name: "Kaya climbing at Touchstone Pacific Pipe",
      locationName: "Touchstone Pacific Pipe",
      attempts: 12,
      sends: 8,
      hardestBoulderGrade: "V4",
      hardestBoulderGradeSortValue: 4,
      hardestRouteGrade: "5.10c",
      hardestRouteGradeSortValue: 5103,
    });

    expect(row.toDetail()).toEqual({
      activityId: "activity-1",
      date: "2026-07-09",
      name: "Kaya climbing at Touchstone Pacific Pipe",
      locationName: "Touchstone Pacific Pipe",
      attempts: 12,
      sends: 8,
      hardestBoulderGrade: "V4",
      hardestBoulderGradeSortValue: 4,
      hardestRouteGrade: "5.10c",
      hardestRouteGradeSortValue: 5103,
    });
  });
});

describe("ClimbingActivityEntry", () => {
  it("serializes to API shape", () => {
    const row = new ClimbingActivityEntry({
      id: "entry-1",
      climbType: "boulder",
      gradeSystem: "v_scale",
      grade: "V4",
      sent: true,
      attemptCount: 7,
      attempts: [],
      ascentType: "Redpoint",
      holdType: null,
      routeName: "Blue Arete",
      locationName: "Pacific Pipe",
      sourceName: "Kaya",
      wallAngleDegrees: null,
    });

    expect(row.toDetail()).toEqual({
      id: "entry-1",
      climbType: "boulder",
      gradeSystem: "v_scale",
      grade: "V4",
      sent: true,
      attemptCount: 7,
      attempts: [],
      ascentType: "Redpoint",
      holdType: null,
      routeName: "Blue Arete",
      locationName: "Pacific Pipe",
      sourceName: "Kaya",
      wallAngleDegrees: null,
    });
  });
});

describe("ClimbingRepository", () => {
  function executeDb(execute: ReturnType<typeof vi.fn>) {
    return { execute };
  }

  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new ClimbingRepository(executeDb(execute), "user-1", "America/Los_Angeles");
    return { repo, execute };
  }

  describe("getGradeProgression", () => {
    it("returns empty array when no climbing entries exist", async () => {
      const { repo } = makeRepository([]);

      await expect(repo.getGradeProgression(90)).resolves.toEqual([]);
    });

    it("returns normalized best sent grade rows with server-computed sort values", async () => {
      const { repo } = makeRepository([
        {
          session_date: "2026-07-06",
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "V3",
          grade_sort_value: 3,
        },
        {
          session_date: "2026-07-09",
          climb_type: "route",
          grade_system: "yds",
          grade: "5.10c",
          grade_sort_value: 5103,
        },
      ]);

      const result = await repo.getGradeProgression(90);

      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(ClimbingGradeProgression);
      expect(result.map((row) => row.toDetail())).toEqual([
        {
          date: "2026-07-06",
          climbType: "boulder",
          gradeSystem: "v_scale",
          grade: "V3",
          gradeSortValue: 3,
        },
        {
          date: "2026-07-09",
          climbType: "route",
          gradeSystem: "yds",
          grade: "5.10c",
          gradeSortValue: 5103,
        },
      ]);
    });

    it("queries best sent grades through deduped activity members and excludes unsent entries", async () => {
      const { repo, execute } = makeRepository([]);

      await repo.getGradeProgression(30);

      const text = queryText(execute.mock.calls[0]?.[0]);
      expect(text).toContain("fitness.v_activity");
      expect(text).toContain("ce.activity_id = ANY(a.member_activity_ids)");
      expect(text).toContain("a.user_id = ");
      expect(text).toContain("AT TIME ZONE");
      expect(text).toContain("detail.attempt_count > 0");
      expect(text).toContain("BOOL_OR(attempt.outcome = 'sent')");
      expect(text).toContain("ELSE ce.sent");
      expect(text).toContain("IS NOT NULL");
      expect(text).toContain("NOW() - ");
    });

    it("applies limited entitlement access windows to activity timestamps", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const repo = new ClimbingRepository(executeDb(execute), "user-1", "UTC", {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-07-01",
        endDateExclusive: "2026-07-08",
      });

      await repo.getGradeProgression(30);

      const text = queryText(execute.mock.calls[0]?.[0]);
      expect(text).toContain("a.started_at");
      expect(text).toContain("2026-07-01");
      expect(text).toContain("2026-07-08");
    });
  });

  describe("getVolumeByGrade", () => {
    it("returns empty array when no climbing entries exist", async () => {
      const { repo } = makeRepository([]);

      await expect(repo.getVolumeByGrade(90)).resolves.toEqual([]);
    });

    it("returns attempts and sends grouped by climb type and grade", async () => {
      const { repo } = makeRepository([
        {
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "V2",
          grade_sort_value: 2,
          attempts: 6,
          sends: 4,
        },
        {
          climb_type: "route",
          grade_system: "yds",
          grade: "5.12-",
          grade_sort_value: 5117,
          attempts: 2,
          sends: 1,
        },
      ]);

      const result = await repo.getVolumeByGrade(90);

      expect(result.map((row) => row.toDetail())).toEqual([
        {
          climbType: "boulder",
          gradeSystem: "v_scale",
          grade: "V2",
          gradeSortValue: 2,
          attempts: 6,
          sends: 4,
        },
        {
          climbType: "route",
          gradeSystem: "yds",
          grade: "5.12-",
          gradeSortValue: 5117,
          attempts: 2,
          sends: 1,
        },
      ]);
    });

    it("queries canonical attempt totals and sent counts", async () => {
      const { repo, execute } = makeRepository([]);

      await repo.getVolumeByGrade(30);

      const text = queryText(execute.mock.calls[0]?.[0]);
      expect(text).toContain("WHEN detail.attempt_count > 0 THEN detail.attempt_count");
      expect(text).toContain("ELSE ce.attempt_count");
      expect(text).toContain("WHEN detail.attempt_count > 0 THEN detail.sent");
      expect(text).toContain("ELSE ce.sent");
      expect(text).toContain("GROUP BY ce.climb_type, ce.grade_system, ce.grade, grade_sort_value");
      expect(text).toContain("ORDER BY grade_sort_value");
    });
  });

  describe("getSessionSummaries", () => {
    it("returns empty array when no climbing entries exist", async () => {
      const { repo } = makeRepository([]);

      await expect(repo.getSessionSummaries(90)).resolves.toEqual([]);
    });

    it("returns session summaries with hardest sent boulder and route grades", async () => {
      const { repo } = makeRepository([
        {
          activity_id: "activity-1",
          session_date: "2026-07-09",
          name: "Kaya climbing at Touchstone Pacific Pipe",
          location_name: "Touchstone Pacific Pipe",
          attempts: 12,
          sends: 8,
          hardest_boulder_grade: "V4",
          hardest_boulder_grade_sort_value: 4,
          hardest_route_grade: null,
          hardest_route_grade_sort_value: null,
        },
        {
          activity_id: "activity-2",
          session_date: "2026-07-10",
          name: "Evening routes",
          location_name: "Mission Cliffs",
          attempts: 5,
          sends: 2,
          hardest_boulder_grade: null,
          hardest_boulder_grade_sort_value: null,
          hardest_route_grade: "5.10c",
          hardest_route_grade_sort_value: 5103,
        },
      ]);

      const result = await repo.getSessionSummaries(90);

      expect(result[0]).toBeInstanceOf(ClimbingSessionSummary);
      expect(result.map((row) => row.toDetail())).toEqual([
        {
          activityId: "activity-1",
          date: "2026-07-09",
          name: "Kaya climbing at Touchstone Pacific Pipe",
          locationName: "Touchstone Pacific Pipe",
          attempts: 12,
          sends: 8,
          hardestBoulderGrade: "V4",
          hardestBoulderGradeSortValue: 4,
          hardestRouteGrade: null,
          hardestRouteGradeSortValue: null,
        },
        {
          activityId: "activity-2",
          date: "2026-07-10",
          name: "Evening routes",
          locationName: "Mission Cliffs",
          attempts: 5,
          sends: 2,
          hardestBoulderGrade: null,
          hardestBoulderGradeSortValue: null,
          hardestRouteGrade: "5.10c",
          hardestRouteGradeSortValue: 5103,
        },
      ]);
    });

    it("queries climbing sessions through deduped activity members", async () => {
      const { repo, execute } = makeRepository([]);

      await repo.getSessionSummaries(30);

      const text = queryText(execute.mock.calls[0]?.[0]);
      expect(text).toContain("fitness.v_activity");
      expect(text).toContain("ce.activity_id = ANY(a.member_activity_ids)");
      expect(text).toContain("a.activity_type IN ('climbing', 'rock_climbing')");
      expect(text).toContain("IS NOT NULL");
      expect(text).toContain("SUM(attempt_count) AS attempts");
      expect(text).not.toContain("SUM(attempt_count)::int AS attempts");
      expect(text).toContain("COUNT(*) FILTER (WHERE sent)::int AS sends");
    });
  });

  describe("getActivityEntries", () => {
    it("returns normalized entries for an activity member", async () => {
      const { repo } = makeRepository([
        {
          id: "entry-1",
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "v4",
          sent: true,
          attempt_count: 7,
          attempts: [],
          ascent_type: "Redpoint",
          hold_type: null,
          route_name: "Blue Arete",
          location_name: "Pacific Pipe",
          source_name: "Kaya",
          wall_angle_degrees: null,
        },
      ]);

      const result = await repo.getActivityEntries("activity-1");

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(ClimbingActivityEntry);
      expect(result[0]?.toDetail()).toEqual({
        id: "entry-1",
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V4",
        sent: true,
        attemptCount: 7,
        attempts: [],
        ascentType: "Redpoint",
        holdType: null,
        routeName: "Blue Arete",
        locationName: "Pacific Pipe",
        sourceName: "Kaya",
        wallAngleDegrees: null,
      });
    });

    it("queries entries through deduped activity members", async () => {
      const { repo, execute } = makeRepository([]);

      await repo.getActivityEntries("activity-1");

      const text = queryText(execute.mock.calls[0]?.[0]);
      expect(text).toContain("fitness.v_activity");
      expect(text).toContain("ce.activity_id = ANY(a.member_activity_ids)");
      expect(text).toContain("ce.attempt_count");
      expect(text).toContain("jsonb_agg");
      expect(text).toContain("ce.raw->>'ascentType'");
      expect(text).toContain("ANY(a.member_activity_ids)");
      expect(text).toContain("a.user_id = ");
      expect(text).toContain("ORDER BY");
    });
  });
});
