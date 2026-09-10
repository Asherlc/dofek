import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { HangboardingRepository } from "./hangboarding-repository.ts";

function makeDb(responses: Record<string, unknown>[][]) {
  const execute = vi.fn();
  for (const response of responses) execute.mockResolvedValueOnce(response);
  execute.mockResolvedValue([]);
  return { execute };
}

function makeDetailRow(overrides: Record<string, unknown> = {}) {
  return {
    activity_id: "activity-1",
    canonical_type: "hangboard",
    plan_name: "7/3 Repeaters",
    session_id: "session-1",
    board_id: "board-1",
    board_name: "Tension Board",
    segments_error: null,
    activity_duration_seconds: 300,
    interval_id: "interval-1",
    interval_index: 0,
    label: "Step 1: 19 mm edge",
    interval_type: "work",
    interval_started_at: "2026-08-07T14:00:00.000Z",
    interval_ended_at: "2026-08-07T14:00:07.000Z",
    duration_seconds: 7,
    ...overrides,
  };
}

function queryText(db: ReturnType<typeof makeDb>, callIndex = 0) {
  const query = db.execute.mock.calls[callIndex]?.[0];
  return new PgDialect().sqlToQuery(query);
}

describe("HangboardingRepository", () => {
  it("returns a user-facing Hang Ten session summary", async () => {
    const db = makeDb([
      [
        {
          activity_id: "activity-1",
          canonical_type: "hangboard",
          plan_name: "7/3 Repeaters",
          session_id: "session-1",
          board_id: "board-1",
          board_name: "Tension Board",
          segments_error: null,
          activity_duration_seconds: 300,
          interval_id: "interval-2",
          interval_index: 1,
          label: "Step 1: Rest",
          interval_type: "rest",
          interval_started_at: "2026-08-07T14:00:07.000Z",
          interval_ended_at: "2026-08-07T14:01:00.000Z",
          duration_seconds: 53,
        },
        {
          activity_id: "activity-1",
          canonical_type: "hangboard",
          plan_name: "7/3 Repeaters",
          session_id: "session-1",
          board_id: "board-1",
          board_name: "Tension Board",
          segments_error: null,
          activity_duration_seconds: 300,
          interval_id: "interval-1",
          interval_index: 0,
          label: "Step 1: 19 mm edge",
          interval_type: "work",
          interval_started_at: "2026-08-07T14:00:00.000Z",
          interval_ended_at: "2026-08-07T14:00:07.000Z",
          duration_seconds: 7,
        },
      ],
    ]);

    await expect(
      new HangboardingRepository(db, "user-1", "UTC").getDetail("activity-1"),
    ).resolves.toEqual({
      planName: "7/3 Repeaters",
      boardName: "Tension Board",
      segmentsError: null,
      summary: {
        durationSeconds: 300,
        workIntervalCount: 1,
        totalWorkDurationSeconds: 7,
        totalRestDurationSeconds: 53,
        exercises: [{ label: "19 mm edge", workIntervalCount: 1, workDurationSeconds: 7 }],
      },
    });
  });

  it("returns null for an activity that is not owned or not Hangboarding", async () => {
    const db = makeDb([]);
    const repository = new HangboardingRepository(db, "user-1", "UTC");

    await expect(repository.getDetail("not-visible")).resolves.toBeNull();
  });

  it("applies the limited access window to detail queries", async () => {
    const db = makeDb([]);
    const accessWindow = {
      kind: "limited",
      paid: false,
      reason: "free_signup_week",
      startDate: "2026-08-01",
      endDateExclusive: "2026-08-08",
    } as const;

    await expect(
      new HangboardingRepository(db, "user-1", "America/Los_Angeles", accessWindow).getDetail(
        "activity-1",
      ),
    ).resolves.toBeNull();

    const query = queryText(db);
    expect(query.sql).toContain("CAST($3::date AS timestamp without time zone)");
    expect(query.params).toContain("2026-08-01");
    expect(query.params).toContain("2026-08-08");
  });

  it("returns null when the query returns a non-Hangboarding activity", async () => {
    const db = makeDb([[makeDetailRow({ canonical_type: "climbing" })]]);

    await expect(
      new HangboardingRepository(db, "user-1", "UTC").getDetail("activity-1"),
    ).resolves.toBeNull();
  });

  it("ignores incomplete intervals when calculating a session summary", async () => {
    const db = makeDb([
      [
        makeDetailRow({ interval_id: null }),
        makeDetailRow({ interval_index: null }),
        makeDetailRow({ interval_started_at: null }),
        makeDetailRow({ interval_id: "interval-valid", interval_index: 3 }),
        makeDetailRow({
          interval_id: "interval-incomplete",
          interval_index: 4,
          interval_ended_at: null,
          duration_seconds: null,
        }),
      ],
    ]);

    await expect(
      new HangboardingRepository(db, "user-1", "UTC").getDetail("activity-1"),
    ).resolves.toMatchObject({
      summary: { workIntervalCount: 1, totalWorkDurationSeconds: 7 },
    });
  });

  it("returns server-computed summary totals and daily rows", async () => {
    const db = makeDb([
      [
        {
          session_count: 2,
          total_duration_seconds: 1500,
          average_duration_seconds: 750,
          total_work_duration_seconds: 17,
          total_rest_duration_seconds: 103,
          work_interval_count: 2,
          average_heart_rate: 125,
          peak_heart_rate: 150,
          latest_activity_id: "activity-2",
          latest_started_at: "2026-08-08T14:00:00.000Z",
          latest_plan_name: "Repeaters",
          latest_board_name: "Tension Board",
          latest_duration_seconds: 900,
        },
      ],
      [
        {
          date: "2026-08-07",
          session_count: 1,
          duration_seconds: 600,
          work_duration_seconds: 7,
          rest_duration_seconds: 53,
        },
        {
          date: "2026-08-08",
          session_count: 1,
          duration_seconds: 900,
          work_duration_seconds: 10,
          rest_duration_seconds: 50,
        },
      ],
    ]);

    await expect(new HangboardingRepository(db, "user-1", "UTC").getSummary(30)).resolves.toEqual({
      sessionCount: 2,
      totalDurationSeconds: 1500,
      averageDurationSeconds: 750,
      totalWorkDurationSeconds: 17,
      totalRestDurationSeconds: 103,
      workIntervalCount: 2,
      averageHeartRate: 125,
      peakHeartRate: 150,
      latestSession: {
        activityId: "activity-2",
        startedAt: "2026-08-08T14:00:00.000Z",
        planName: "Repeaters",
        boardName: "Tension Board",
        durationSeconds: 900,
      },
      daily: [
        {
          date: "2026-08-07",
          sessionCount: 1,
          durationSeconds: 600,
          workDurationSeconds: 7,
          restDurationSeconds: 53,
        },
        {
          date: "2026-08-08",
          sessionCount: 1,
          durationSeconds: 900,
          workDurationSeconds: 10,
          restDurationSeconds: 50,
        },
      ],
    });
  });

  it("preserves null aggregates when interval durations or heart rates are unavailable", async () => {
    const db = makeDb([
      [
        {
          session_count: 1,
          total_duration_seconds: 600,
          average_duration_seconds: 600,
          total_work_duration_seconds: null,
          total_rest_duration_seconds: null,
          work_interval_count: null,
          average_heart_rate: null,
          peak_heart_rate: null,
          latest_activity_id: "activity-1",
          latest_started_at: "2026-08-07T14:00:00.000Z",
          latest_plan_name: null,
          latest_board_name: null,
          latest_duration_seconds: 600,
        },
      ],
      [
        {
          date: "2026-08-07",
          session_count: 1,
          duration_seconds: 600,
          work_duration_seconds: null,
          rest_duration_seconds: null,
        },
      ],
    ]);

    const result = await new HangboardingRepository(db, "user-1", "UTC").getSummary(30);
    expect(result.totalWorkDurationSeconds).toBeNull();
    expect(result.totalRestDurationSeconds).toBeNull();
    expect(result.workIntervalCount).toBeNull();
    expect(result.averageHeartRate).toBeNull();
    expect(result.peakHeartRate).toBeNull();
    expect(result.daily[0]).toMatchObject({
      workDurationSeconds: null,
      restDurationSeconds: null,
    });
  });

  it("maps daily rows when no sessions are available", async () => {
    const db = makeDb([
      [],
      [
        {
          date: "2026-08-07",
          session_count: 0,
          duration_seconds: 0,
          work_duration_seconds: null,
          rest_duration_seconds: null,
        },
      ],
    ]);

    await expect(new HangboardingRepository(db, "user-1", "UTC").getSummary(30)).resolves.toEqual({
      sessionCount: 0,
      totalDurationSeconds: 0,
      averageDurationSeconds: null,
      totalWorkDurationSeconds: null,
      totalRestDurationSeconds: null,
      workIntervalCount: null,
      averageHeartRate: null,
      peakHeartRate: null,
      latestSession: null,
      daily: [
        {
          date: "2026-08-07",
          sessionCount: 0,
          durationSeconds: 0,
          workDurationSeconds: null,
          restDurationSeconds: null,
        },
      ],
    });
  });

  it("returns no latest session when latest activity metadata is incomplete", async () => {
    const db = makeDb([
      [
        {
          session_count: 1,
          total_duration_seconds: 600,
          average_duration_seconds: 600,
          total_work_duration_seconds: null,
          total_rest_duration_seconds: null,
          work_interval_count: null,
          average_heart_rate: null,
          peak_heart_rate: null,
          latest_activity_id: null,
          latest_started_at: null,
          latest_plan_name: null,
          latest_board_name: null,
          latest_duration_seconds: null,
        },
      ],
      [],
    ]);

    await expect(
      new HangboardingRepository(db, "user-1", "UTC").getSummary(30),
    ).resolves.toMatchObject({ latestSession: null });
  });
});
