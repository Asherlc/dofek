import type { ClimbingFilters } from "@dofek/training/climbing-filters";
import type { ClimbingGradePreference } from "@dofek/training/climbing-grades";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  ClimbingGradeProgression,
  ClimbingRepository,
  ClimbingSessionSummary,
  ClimbingVolumeByGrade,
} from "./climbing-repository.ts";
import { queryText } from "./climbing-test-helpers.ts";

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

  it.each(["getGradeProgression", "getVolumeByGrade", "getSessionSummaries"] as const)(
    "%s sends each selected filter to PostgreSQL as a bound query condition",
    async (method) => {
      const cases: Array<{ filters: ClimbingFilters; condition: string; values: string[] }> = [
        { filters: {}, condition: "true", values: [] },
        { filters: { style: "boulder" }, condition: "ce.climb_type =", values: ["boulder"] },
        { filters: { style: "route" }, condition: "ce.climb_type =", values: ["route"] },
        {
          filters: { style: "unknown" },
          condition: "ce.climb_type = 'route' AND ce.climb_style IS NULL",
          values: [],
        },
        { filters: { style: "lead" }, condition: "ce.climb_style =", values: ["lead"] },
        {
          filters: { protection: "unknown" },
          condition: "ce.route_protection IS NULL",
          values: [],
        },
        {
          filters: { protection: "sport" },
          condition: "= ANY(ce.route_protection)",
          values: ["sport"],
        },
        {
          filters: { protection: "trad" },
          condition: "= ANY(ce.route_protection)",
          values: ["trad"],
        },
        {
          filters: { setting: "indoor" },
          condition: "CASE WHEN ce.provider_id",
          values: ["indoor"],
        },
        {
          filters: { setting: "outdoor" },
          condition: "CASE WHEN ce.provider_id",
          values: ["outdoor"],
        },
        {
          filters: { setting: "unknown" },
          condition: "CASE WHEN ce.provider_id",
          values: ["unknown"],
        },
      ];
      for (const { filters, condition, values } of cases) {
        const { repo, execute } = makeRepository();
        await repo[method](30, filters);
        const query = execute.mock.calls[0]?.[0];
        if (!(query instanceof SQL)) throw new Error("Expected a parameterized SQL query");
        const statement = new PgDialect().sqlToQuery(query);
        const text = statement.sql.replace(/\s+/g, " ");
        expect(text).toContain(condition);
        expect(statement.params).toEqual(expect.arrayContaining(values));
        expect(statement.params).not.toContain(undefined);
        if (Object.keys(filters).length === 0) {
          expect(text).toContain("AND true AND ce.provider_absent_at IS NULL");
        }
        if (filters.style !== "boulder" && filters.style !== "route")
          expect(text).not.toMatch(/ce\.climb_type = \$/);
        if (
          !filters.style ||
          filters.style === "unknown" ||
          filters.style === "boulder" ||
          filters.style === "route"
        )
          expect(text).not.toContain("ce.climb_style =");
        if (filters.style !== "unknown") expect(text).not.toContain("ce.climb_style IS NULL");
        if (filters.protection !== "unknown")
          expect(text).not.toContain("ce.route_protection IS NULL");
        if (!filters.protection || filters.protection === "unknown")
          expect(text).not.toContain("= ANY(ce.route_protection)");
      }
    },
  );

  describe("getGradeProgression", () => {
    it("returns empty array when no climbing entries exist", async () => {
      const { repo } = makeRepository([]);

      await expect(repo.getGradeProgression(90)).resolves.toEqual([]);
    });

    it("shows increasingly consistent sends at the same maximum grade and preserves missing periods", async () => {
      const entry = (date: string, grade: string, sent: boolean | null = true) => ({
        session_date: date,
        climb_type: "boulder",
        climb_style: null,
        grade_system: "v_scale",
        grade,
        setting: "indoor",
        sent,
      });
      const { repo } = makeRepository([
        entry("2026-01-02", "V4"),
        entry("2026-01-02", "V2"),
        entry("2026-01-05", "V1"),
        entry("2026-01-10", "V3", false),
        entry("2026-03-02", "V4"),
        entry("2026-03-02", "V4"),
        entry("2026-03-05", "V4"),
        entry("2026-03-05", "V3", false),
      ]);

      const [result] = await repo.getGradeProgression(365);
      expect(result).toBeInstanceOf(ClimbingGradeProgression);
      expect(result?.toDetail()).toMatchObject({
        style: "boulder",
        gradeSystem: "v_scale",
        settings: ["indoor"],
        grades: [{ grade: "V1" }, { grade: "V2" }, { grade: "V3" }, { grade: "V4" }],
        periods: [
          {
            startDate: "2026-01-01",
            endDate: "2026-01-31",
            settings: [
              {
                climbingDays: 3,
                sends: 3,
                sendsPerDay: 1,
                segments: [
                  { grade: "V1", sendsPerDay: 1 / 3, stackStart: 0, stackEnd: 1 / 3 },
                  { grade: "V2", sendsPerDay: 1 / 3 },
                  { grade: "V3", sendsPerDay: 0 },
                  { grade: "V4", sendsPerDay: 1 / 3, stackEnd: 1 },
                ],
              },
            ],
          },
          {
            startDate: "2026-02-01",
            endDate: "2026-02-28",
            settings: [
              {
                climbingDays: 0,
                sends: 0,
                sendsPerDay: null,
                segments: [
                  { sendsPerDay: null },
                  { sendsPerDay: null },
                  { sendsPerDay: null },
                  { sendsPerDay: null },
                ],
              },
            ],
          },
          {
            startDate: "2026-03-01",
            settings: [
              {
                climbingDays: 2,
                sends: 3,
                sendsPerDay: 1.5,
                segments: [
                  { sendsPerDay: 0 },
                  { sendsPerDay: 0 },
                  { sendsPerDay: 0 },
                  { grade: "V4", sendsPerDay: 1.5 },
                ],
              },
            ],
          },
        ],
      });
    });

    it("converts boulder and route progression grades to the selected systems", async () => {
      const { repo } = makeRepository(
        [
          {
            session_date: "2026-07-06",
            climb_type: "boulder",
            climb_style: null,
            setting: "indoor",
            sent: true,
            grade_system: "v_scale",
            grade: "V4",
          },
          {
            session_date: "2026-07-09",
            climb_type: "route",
            climb_style: "lead",
            setting: "outdoor",
            sent: true,
            grade_system: "yds",
            grade: "5.10c",
          },
        ],
        { boulder: "font", route: "french" },
      );

      const progression = await repo.getGradeProgression(90);

      expect(progression.map((row) => row.toDetail())).toMatchObject([
        {
          style: "boulder",
          climbType: "boulder",
          gradeSystem: "font",
          grades: [{ grade: "6a+/6b+", gradeSortValue: 65 }],
          periods: [{ settings: [{ sends: 1, sendsPerDay: 1 }] }],
        },
        {
          style: "lead",
          climbType: "route",
          gradeSystem: "french",
          grades: [{ grade: "6b", gradeSortValue: 64.5 }],
          periods: [{ settings: [{ sends: 1, sendsPerDay: 1 }] }],
        },
      ]);
    });

    it("keeps styles and settings separate, counts each day once, and retains failed-only days", async () => {
      const entry = (
        style: string | null,
        setting: string,
        grade: string,
        sent: boolean | null = true,
      ) => ({
        session_date: "2026-07-06",
        climb_type: "route",
        climb_style: style,
        grade_system: "yds",
        grade,
        setting,
        sent,
      });
      const { repo } = makeRepository([
        entry("lead", "indoor", "5.10a"),
        entry("lead", "indoor", "5.10a"),
        entry("lead", "outdoor", "5.10b", false),
        entry("top-rope", "indoor", "5.10c"),
        entry(null, "unknown", "5.11a", null),
      ]);
      const lanes = (await repo.getGradeProgression(90)).map((row) => row.toDetail());
      expect(lanes).toMatchObject([
        {
          style: "top-rope",
          settings: ["indoor"],
          periods: [{ settings: [{ climbingDays: 1, sends: 1 }] }],
        },
        {
          style: "lead",
          settings: ["indoor", "outdoor"],
          periods: [
            {
              settings: [
                { setting: "indoor", climbingDays: 1, sends: 2, sendsPerDay: 2 },
                { setting: "outdoor", climbingDays: 1, sends: 0, sendsPerDay: 0 },
              ],
            },
          ],
        },
        {
          style: "unknown",
          settings: ["unknown"],
          periods: [
            {
              settings: [
                {
                  climbingDays: 1,
                  sends: 0,
                  unknownOutcomes: 1,
                  sendsPerDay: 0,
                },
              ],
            },
          ],
        },
      ]);
    });

    it("queries climbing outcomes through deduped activity members", async () => {
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

    it("merges equivalent display grades without dropping repeated sends and rejects invalid grades", async () => {
      const entry = (grade: string, gradeSystem = "v_scale") => ({
        session_date: "2026-07-06",
        climb_type: "boulder",
        climb_style: null,
        grade_system: gradeSystem,
        grade,
        setting: "indoor",
        sent: true,
      });
      const { repo } = makeRepository([
        entry("V5"),
        entry("6C", "font"),
        entry("not-a-grade"),
        entry("5.10a", "yds"),
      ]);
      expect((await repo.getGradeProgression(90))[0]?.toDetail()).toMatchObject({
        grades: [{ grade: "V5", gradeSortValue: 69 }],
        periods: [
          {
            settings: [
              {
                climbingDays: 1,
                sends: 2,
                segments: [
                  {
                    grade: "V5",
                    sends: 2,
                    sendsPerDay: 2,
                    stackStart: 0,
                    stackEnd: 2,
                  },
                ],
              },
            ],
          },
        ],
      });
    });

    it("uses at most six calendar periods and a common scale across all lanes, including year boundaries", async () => {
      const entry = (date: string, climbType = "boulder", grade = "V4") => ({
        session_date: date,
        climb_type: climbType,
        climb_style: climbType === "route" ? "lead" : null,
        grade_system: climbType === "route" ? "yds" : "v_scale",
        grade,
        setting: "outdoor",
        sent: true,
      });
      const { repo } = makeRepository([
        entry("2025-12-06"),
        entry("2026-11-06"),
        entry("2026-01-06", "route", "5.10a"),
        entry("2026-01-06", "route", "5.10a"),
        entry("2026-01-06", "route", "5.10a"),
        entry("2026-01-06", "route", "5.10a"),
      ]);
      const lanes = (await repo.getGradeProgression(365)).map((row) => row.toDetail());
      for (const lane of lanes) {
        expect(lane.periods).toHaveLength(6);
        expect(lane.periods[0]).toMatchObject({ startDate: "2025-12-01", endDate: "2026-01-31" });
        expect(lane.periods[5]).toMatchObject({ startDate: "2026-10-01", endDate: "2026-11-30" });
        expect(lane.axisMax).toBe(6);
        expect(lane.axisInterval).toBe(2);
        expect(lane.axisTicks).toEqual([0, 2, 4, 6]);
      }
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
      expect(text).toContain("WHERE ce.canonical_activity_id IS NOT NULL");
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
