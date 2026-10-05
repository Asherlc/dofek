import type { ClimbingGradePreference } from "@dofek/training/climbing-grades";
import { describe, expect, it, vi } from "vitest";
import {
  ClimbingGradeProgression,
  ClimbingRepository,
  ClimbingSessionSummary,
  ClimbingVolumeByGrade,
} from "./climbing-repository.ts";
import { queryText } from "./climbing-test-helpers.ts";

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
      recordedAttempts: 4,
      sends: 2,
    });

    expect(row.toDetail()).toEqual({
      climbType: "route",
      gradeSystem: "yds",
      grade: "5.10c",
      gradeSortValue: 5103,
      attempts: 4,
      recordedAttempts: 4,
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

describe("ClimbingRepository", () => {
  function executeDb(execute: CallableVitestMock) {
    return { execute };
  }

  function makeRepository(
    rows: Record<string, unknown>[] = [],
    gradePreference?: ClimbingGradePreference,
  ) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new ClimbingRepository(
      executeDb(execute),
      "user-1",
      "America/Los_Angeles",
      undefined,
      gradePreference,
    );
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
          gradeSortValue: 60,
        },
        {
          date: "2026-07-09",
          climbType: "route",
          gradeSystem: "yds",
          grade: "5.10c",
          gradeSortValue: 64.5,
        },
      ]);
    });

    it("converts boulder and route progression grades to the selected systems", async () => {
      const { repo } = makeRepository(
        [
          {
            session_date: "2026-07-06",
            climb_type: "boulder",
            grade_system: "v_scale",
            grade: "V4",
          },
          {
            session_date: "2026-07-09",
            climb_type: "route",
            grade_system: "yds",
            grade: "5.10c",
          },
        ],
        { boulder: "font", route: "french" },
      );

      const progression = await repo.getGradeProgression(90);

      expect(progression.map((row) => row.toDetail())).toEqual([
        {
          date: "2026-07-06",
          climbType: "boulder",
          gradeSystem: "font",
          grade: "6a+/6b+",
          gradeSortValue: 65,
        },
        {
          date: "2026-07-09",
          climbType: "route",
          gradeSystem: "french",
          grade: "6b",
          gradeSortValue: 64.5,
        },
      ]);
    });

    it("keeps the first equal grade, replaces it with a harder grade, skips invalid grades, and orders session types", async () => {
      const { repo } = makeRepository([
        {
          session_date: "2026-07-06",
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "V3",
        },
        {
          session_date: "2026-07-06",
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "V3",
        },
        {
          session_date: "2026-07-06",
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "V4",
        },
        {
          session_date: "2026-07-06",
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "not-a-grade",
        },
        {
          session_date: "2026-07-06",
          climb_type: "route",
          grade_system: "yds",
          grade: "5.10c",
        },
      ]);

      const progression = await repo.getGradeProgression(90);

      expect(progression.map((row) => row.toDetail())).toEqual([
        expect.objectContaining({ climbType: "boulder", grade: "V4", gradeSortValue: 65 }),
        expect.objectContaining({ climbType: "route", grade: "5.10c", gradeSortValue: 64.5 }),
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
      expect(text).toContain("NOW() AT TIME ZONE");
      expect(text).toContain("::date - ");
    });

    it("includes active standalone ticks by the user's calendar date", async () => {
      const { repo, execute } = makeRepository([]);

      await repo.getGradeProgression(30);

      const text = queryText(execute.mock.calls[0]?.[0]);
      expect(text).toContain("ce.activity_id IS NULL");
      expect(text).toContain("ce.unattached_date");
      expect(text).toContain("ce.provider_absent_at IS NULL");
      expect(text).toContain("AT TIME ZONE");
    });

    it("applies limited entitlement access windows to activity calendar dates", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const repo = new ClimbingRepository(executeDb(execute), "user-1", "UTC", {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-07-01",
        endDateExclusive: "2026-07-08",
      });

      await repo.getGradeProgression(30);

      const text = queryText(execute.mock.calls[0]?.[0]);
      expect(text).toContain("local_time_source");
      expect(text).toContain("AT TIME ZONE");
      expect(text).toContain("2026-07-01");
      expect(text).toContain("2026-07-08");
    });
  });

  describe("getVolumeByGrade", () => {
    it.each<[number | null, number | null]>([
      [3, null],
      [null, 3],
      [null, null],
    ])(
      "preserves unknown totals when merging counts %s then %s across grade systems",
      async (first, second) => {
        const { repo } = makeRepository([
          {
            climb_type: "boulder",
            grade_system: "v_scale",
            grade: "V5",
            attempts: first,
            recorded_attempts: first,
            sends: 1,
          },
          {
            climb_type: "boulder",
            grade_system: "font",
            grade: "6C",
            attempts: second,
            recorded_attempts: second,
            sends: 2,
          },
        ]);

        expect((await repo.getVolumeByGrade(90)).map((row) => row.toDetail())).toEqual([
          expect.objectContaining({
            climbType: "boulder",
            grade: "V5",
            attempts: null,
            recordedAttempts:
              first === null && second === null ? null : (first ?? 0) + (second ?? 0),
            sends: 3,
          }),
        ]);
      },
    );

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
          recorded_attempts: 6,
          sends: 4,
        },
        {
          climb_type: "route",
          grade_system: "yds",
          grade: "5.12-",
          grade_sort_value: 5117,
          attempts: 2,
          recorded_attempts: 2,
          sends: 1,
        },
      ]);

      const result = await repo.getVolumeByGrade(90);

      expect(result.map((row) => row.toDetail())).toEqual([
        {
          climbType: "boulder",
          gradeSystem: "v_scale",
          grade: "V2",
          gradeSortValue: 55,
          attempts: 6,
          recordedAttempts: 6,
          sends: 4,
        },
        {
          climbType: "route",
          gradeSystem: "yds",
          grade: "5.12-",
          gradeSortValue: 75.5,
          attempts: 2,
          recordedAttempts: 2,
          sends: 1,
        },
      ]);
    });

    it("converts volume buckets to the selected grade systems", async () => {
      const { repo } = makeRepository(
        [
          {
            climb_type: "boulder",
            grade_system: "v_scale",
            grade: "V4",
            attempts: 6,
            recorded_attempts: 6,
            sends: 4,
          },
          {
            climb_type: "route",
            grade_system: "yds",
            grade: "5.10c",
            attempts: 2,
            recorded_attempts: 2,
            sends: 1,
          },
        ],
        { boulder: "font", route: "french" },
      );

      const volume = await repo.getVolumeByGrade(90);

      expect(volume.map((row) => row.toDetail())).toEqual([
        {
          climbType: "route",
          gradeSystem: "french",
          grade: "6b",
          gradeSortValue: 64.5,
          attempts: 2,
          recordedAttempts: 2,
          sends: 1,
        },
        {
          climbType: "boulder",
          gradeSystem: "font",
          grade: "6a+/6b+",
          gradeSortValue: 65,
          attempts: 6,
          recordedAttempts: 6,
          sends: 4,
        },
      ]);
    });

    it("merges source grades that convert to the same display bucket and skips invalid grades", async () => {
      const { repo } = makeRepository(
        [
          {
            climb_type: "boulder",
            grade_system: "v_scale",
            grade: "V4",
            attempts: 3,
            recorded_attempts: 3,
            sends: 1,
          },
          {
            climb_type: "boulder",
            grade_system: "v_scale",
            grade: "V4",
            attempts: 2,
            recorded_attempts: 2,
            sends: 2,
          },
          {
            climb_type: "boulder",
            grade_system: "v_scale",
            grade: "not-a-grade",
            attempts: 9,
            recorded_attempts: 9,
            sends: 9,
          },
        ],
        { boulder: "font", route: "french" },
      );

      const volume = await repo.getVolumeByGrade(90);

      expect(volume.map((row) => row.toDetail())).toEqual([
        {
          climbType: "boulder",
          gradeSystem: "font",
          grade: "6a+/6b+",
          gradeSortValue: 65,
          attempts: 5,
          recordedAttempts: 5,
          sends: 3,
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
      expect(text).toContain("GROUP BY ce.climb_type, ce.grade_system, ce.grade");
    });

    it("includes active standalone ticks by the user's calendar date", async () => {
      const { repo, execute } = makeRepository([]);

      await repo.getVolumeByGrade(30);

      const text = queryText(execute.mock.calls[0]?.[0]);
      expect(text).toContain("ce.activity_id IS NULL");
      expect(text).toContain("ce.unattached_date");
      expect(text).toContain("ce.provider_absent_at IS NULL");
      expect(text).toContain("AT TIME ZONE");
    });
  });

  describe("getSessionSummaries", () => {
    it.each<[number | null, number | null]>([
      [3, null],
      [null, 3],
      [null, null],
    ])(
      "preserves unknown session totals for counts %s then %s while retaining known sends",
      async (first, second) => {
        const { repo } = makeRepository(
          [first, second].map((attemptCount, index) => ({
            activity_id: "activity-1",
            session_date: "2026-09-29",
            name: "Kaya climbing",
            location_name: "Pacific Pipe",
            attempt_count: attemptCount,
            sent: index === 0,
            climb_type: "boulder",
            grade_system: "v_scale",
            grade: "V4",
          })),
        );

        expect((await repo.getSessionSummaries(90)).map((row) => row.toDetail())).toEqual([
          expect.objectContaining({
            activityId: "activity-1",
            attempts: null,
            sends: 1,
            hardestBoulderGrade: "V4",
          }),
        ]);
      },
    );

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
          attempt_count: 12,
          sent: true,
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "V4",
        },
        {
          activity_id: "activity-2",
          session_date: "2026-07-10",
          name: "Evening routes",
          location_name: "Mission Cliffs",
          attempt_count: 5,
          sent: true,
          climb_type: "route",
          grade_system: "yds",
          grade: "5.10c",
        },
      ]);

      const result = await repo.getSessionSummaries(90);

      expect(result[0]).toBeInstanceOf(ClimbingSessionSummary);
      expect(result.map((row) => row.toDetail())).toEqual([
        {
          activityId: "activity-2",
          date: "2026-07-10",
          name: "Evening routes",
          locationName: "Mission Cliffs",
          attempts: 5,
          sends: 1,
          hardestBoulderGrade: null,
          hardestBoulderGradeSortValue: null,
          hardestRouteGrade: "5.10c",
          hardestRouteGradeSortValue: 64.5,
        },
        {
          activityId: "activity-1",
          date: "2026-07-09",
          name: "Kaya climbing at Touchstone Pacific Pipe",
          locationName: "Touchstone Pacific Pipe",
          attempts: 12,
          sends: 1,
          hardestBoulderGrade: "V4",
          hardestBoulderGradeSortValue: 65,
          hardestRouteGrade: null,
          hardestRouteGradeSortValue: null,
        },
      ]);
    });

    it("queries climbing sessions through deduped activity members", async () => {
      const { repo, execute } = makeRepository([]);

      await repo.getSessionSummaries(30);

      const text = queryText(execute.mock.calls[0]?.[0]);
      expect(text).toContain("fitness.v_activity");
      expect(text).toContain("ce.activity_id = ANY(a.member_activity_ids)");
      expect(text).toContain("a.canonical_type = 'climbing'");
      expect(text).toContain("attempt_count");
      expect(text).toContain("ce.grade_system");
      expect(text).not.toContain("unattached_date");
    });

    it("keeps a non-null location from a later entry in the same activity", async () => {
      const { repo } = makeRepository([
        {
          activity_id: "activity-1",
          session_date: "2026-07-09",
          name: "Climbing session",
          location_name: null,
          attempt_count: 1,
          sent: false,
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "V3",
        },
        {
          activity_id: "activity-1",
          session_date: "2026-07-09",
          name: "Climbing session",
          location_name: "Pacific Pipe",
          attempt_count: 1,
          sent: true,
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "V4",
        },
      ]);

      const [summary] = await repo.getSessionSummaries(90);

      expect(summary?.toDetail().locationName).toBe("Pacific Pipe");
    });

    it("preserves the first location, counts only sent entries, and selects each climb type's hardest sent grade", async () => {
      const { repo } = makeRepository([
        {
          activity_id: "activity-1",
          session_date: "2026-07-09",
          name: "Climbing session",
          location_name: "First gym",
          attempt_count: 2,
          sent: true,
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "V3",
        },
        {
          activity_id: "activity-1",
          session_date: "2026-07-09",
          name: "Climbing session",
          location_name: "Second gym",
          attempt_count: 3,
          sent: false,
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "V8",
        },
        {
          activity_id: "activity-1",
          session_date: "2026-07-09",
          name: "Climbing session",
          location_name: null,
          attempt_count: 4,
          sent: true,
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "V4",
        },
        {
          activity_id: "activity-1",
          session_date: "2026-07-09",
          name: "Climbing session",
          location_name: null,
          attempt_count: 5,
          sent: true,
          climb_type: "route",
          grade_system: "yds",
          grade: "5.10c",
        },
        {
          activity_id: "activity-1",
          session_date: "2026-07-09",
          name: "Climbing session",
          location_name: null,
          attempt_count: 6,
          sent: true,
          climb_type: "route",
          grade_system: "yds",
          grade: "5.11a",
        },
      ]);

      const [summary] = await repo.getSessionSummaries(90);

      expect(summary?.toDetail()).toMatchObject({
        locationName: "First gym",
        attempts: 20,
        sends: 4,
        hardestBoulderGrade: "V4",
        hardestBoulderGradeSortValue: 65,
        hardestRouteGrade: "5.11a",
        hardestRouteGradeSortValue: 67.5,
      });
    });
  });
});
