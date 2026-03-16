import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fitRecordsToMetricStream,
  parseWorkoutList,
  parseWorkoutSummary,
  WahooClient,
  WahooProvider,
  type WahooWorkout,
} from "./wahoo.ts";

// ============================================================
// Tests targeting uncovered sync paths in wahoo.ts
// ============================================================

describe("WahooClient.getWorkout", () => {
  it("fetches a single workout by ID", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json({
        workout: {
          id: 42,
          workout_type_id: 0,
          starts: "2026-03-01T10:00:00Z",
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        },
      }),
    );

    const client = new WahooClient("test-token", mockFetch);
    const result = await client.getWorkout(42);
    expect(result.workout.id).toBe(42);
    expect(mockFetch).toHaveBeenCalledOnce();
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/workouts/42");
  });
});

describe("WahooClient.downloadFitFile", () => {
  it("downloads and returns a Buffer", async () => {
    const testData = new Uint8Array([0x2e, 0x46, 0x49, 0x54]);
    const mockFetch = vi.fn().mockResolvedValue(new Response(testData, { status: 200 }));

    const client = new WahooClient("test-token", mockFetch);
    const result = await client.downloadFitFile("https://example.com/test.fit");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(4);
  });
});

describe("fitRecordsToMetricStream", () => {
  it("maps FIT records to metric_stream rows", () => {
    const records = [
      {
        recordedAt: new Date("2026-03-01T10:00:00Z"),
        heartRate: 140,
        power: 200,
        cadence: 85,
        speed: 8.5,
        lat: 40.7,
        lng: -74.0,
        altitude: 50,
        temperature: 22,
        distance: 1000,
        grade: 1.5,
        calories: 100,
        verticalSpeed: 0.5,
        gpsAccuracy: 3,
        accumulatedPower: 5000,
        leftRightBalance: 50,
        verticalOscillation: 8.2,
        stanceTime: 250,
        stanceTimePercent: 35,
        stepLength: 1.2,
        verticalRatio: 7.5,
        stanceTimeBalance: 50.5,
        leftTorqueEffectiveness: 75,
        rightTorqueEffectiveness: 72,
        leftPedalSmoothness: 20,
        rightPedalSmoothness: 19,
        combinedPedalSmoothness: 19.5,
        raw: { extra: "data" },
      },
    ];

    const rows = fitRecordsToMetricStream(records, "wahoo", "act-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerId).toBe("wahoo");
    expect(rows[0]?.activityId).toBe("act-1");
    expect(rows[0]?.heartRate).toBe(140);
    expect(rows[0]?.power).toBe(200);
    expect(rows[0]?.cadence).toBe(85);
    expect(rows[0]?.speed).toBe(8.5);
    expect(rows[0]?.lat).toBe(40.7);
    expect(rows[0]?.lng).toBe(-74.0);
    expect(rows[0]?.altitude).toBe(50);
    expect(rows[0]?.temperature).toBe(22);
    expect(rows[0]?.distance).toBe(1000);
    expect(rows[0]?.grade).toBe(1.5);
    expect(rows[0]?.calories).toBe(100);
    expect(rows[0]?.verticalSpeed).toBe(0.5);
    expect(rows[0]?.leftTorqueEffectiveness).toBe(75);
    expect(rows[0]?.combinedPedalSmoothness).toBe(19.5);
  });

  it("handles records with undefined optional fields", () => {
    const records = [
      {
        recordedAt: new Date("2026-03-01T10:00:00Z"),
        heartRate: undefined,
        power: undefined,
        cadence: undefined,
        speed: undefined,
        lat: undefined,
        lng: undefined,
        altitude: undefined,
        temperature: undefined,
        distance: undefined,
        grade: undefined,
        calories: undefined,
        verticalSpeed: undefined,
        gpsAccuracy: undefined,
        accumulatedPower: undefined,
        leftRightBalance: undefined,
        verticalOscillation: undefined,
        stanceTime: undefined,
        stanceTimePercent: undefined,
        stepLength: undefined,
        verticalRatio: undefined,
        stanceTimeBalance: undefined,
        leftTorqueEffectiveness: undefined,
        rightTorqueEffectiveness: undefined,
        leftPedalSmoothness: undefined,
        rightPedalSmoothness: undefined,
        combinedPedalSmoothness: undefined,
        raw: {},
      },
    ];

    const rows = fitRecordsToMetricStream(records, "wahoo", "act-2");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.heartRate).toBeUndefined();
    expect(rows[0]?.power).toBeUndefined();
  });
});

describe("parseWorkoutList", () => {
  it("calculates hasMore correctly when page * per_page < total", () => {
    const response = {
      workouts: [
        {
          id: 1,
          workout_type_id: 0,
          starts: "2026-03-01T10:00:00Z",
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        },
      ],
      total: 100,
      page: 1,
      per_page: 30,
      order: "desc",
      sort: "starts",
    };

    const result = parseWorkoutList(response);
    expect(result.hasMore).toBe(true);
    expect(result.total).toBe(100);
    expect(result.page).toBe(1);
  });

  it("calculates hasMore when all fetched", () => {
    const response = {
      workouts: [
        {
          id: 1,
          workout_type_id: 1,
          starts: "2026-03-01T10:00:00Z",
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        },
      ],
      total: 30,
      page: 1,
      per_page: 30,
      order: "desc",
      sort: "starts",
    };

    const result = parseWorkoutList(response);
    expect(result.hasMore).toBe(false);
  });
});

describe("WahooProvider.sync — token error path", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when no tokens found", async () => {
    process.env.WAHOO_CLIENT_ID = "id";
    process.env.WAHOO_CLIENT_SECRET = "secret";

    const provider = new WahooProvider(vi.fn());
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };

    // @ts-expect-error mock DB
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.provider).toBe("wahoo");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
  });
});

describe("parseWorkoutSummary — unknown type", () => {
  it("returns other for unknown workout_type_id", () => {
    const workout: WahooWorkout = {
      id: 999,
      workout_type_id: 99,
      starts: "2026-03-01T10:00:00Z",
      created_at: "2026-03-01T10:00:00Z",
      updated_at: "2026-03-01T10:00:00Z",
    };
    const result = parseWorkoutSummary(workout);
    expect(result.activityType).toBe("other");
  });

  it("maps walking type (8)", () => {
    const workout: WahooWorkout = {
      id: 888,
      workout_type_id: 8,
      starts: "2026-03-01T10:00:00Z",
      created_at: "2026-03-01T10:00:00Z",
      updated_at: "2026-03-01T10:00:00Z",
    };
    expect(parseWorkoutSummary(workout).activityType).toBe("walking");
  });

  it("maps treadmill running type (2)", () => {
    const workout: WahooWorkout = {
      id: 222,
      workout_type_id: 2,
      starts: "2026-03-01T10:00:00Z",
      created_at: "2026-03-01T10:00:00Z",
      updated_at: "2026-03-01T10:00:00Z",
    };
    expect(parseWorkoutSummary(workout).activityType).toBe("running");
  });

  it("sets endedAt to undefined when no duration", () => {
    const workout: WahooWorkout = {
      id: 111,
      workout_type_id: 0,
      starts: "2026-03-01T10:00:00Z",
      created_at: "2026-03-01T10:00:00Z",
      updated_at: "2026-03-01T10:00:00Z",
    };
    const result = parseWorkoutSummary(workout);
    expect(result.endedAt).toBeUndefined();
    expect(result.fitFileUrl).toBeUndefined();
  });
});
