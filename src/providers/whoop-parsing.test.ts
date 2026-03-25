import { describe, expect, it } from "vitest";
import {
  parseHeartRateValues,
  parseJournalResponse,
  parseRecovery,
  parseSleep,
  parseWeightliftingWorkout,
  parseWorkout,
  WhoopClient,
  type WhoopRecoveryRecord,
  type WhoopSleepRecord,
  type WhoopWeightliftingWorkoutResponse,
  type WhoopWorkoutRecord,
} from "./whoop.ts";

// ============================================================
// Coverage tests for WHOOP pure parsing functions:
// - parseRecovery with non-SCORED state
// - parseSleep without score (no stage_summary)
// - parseWorkout without score (no distance, calories, etc.)
// - parseHeartRateValues with empty/large arrays
// - WhoopClient.authenticate MFA required path
// - WhoopClient._fetchUserId nested user object shapes
// - WhoopClient.refreshAccessToken success path
// ============================================================

describe("parseRecovery — edge cases", () => {
  it("returns undefined metrics when score_state is not SCORED", () => {
    const record: WhoopRecoveryRecord = {
      cycle_id: 100,
      sleep_id: 200,
      user_id: 10129,
      created_at: "2026-03-01T06:00:00Z",
      updated_at: "2026-03-01T06:30:00Z",
      score_state: "PENDING_MANUAL",
      score: {
        user_calibrating: false,
        recovery_score: 78,
        resting_heart_rate: 52,
        hrv_rmssd_milli: 65.5,
        spo2_percentage: 97.2,
        skin_temp_celsius: 33.7,
      },
    };

    const parsed = parseRecovery(record);
    expect(parsed.cycleId).toBe(100);
    expect(parsed.restingHr).toBeUndefined();
    expect(parsed.hrv).toBeUndefined();
    expect(parsed.spo2).toBeUndefined();
    expect(parsed.skinTemp).toBeUndefined();
  });

  it("returns undefined metrics when score is missing entirely", () => {
    const record: WhoopRecoveryRecord = {
      cycle_id: 101,
      sleep_id: 201,
      user_id: 10129,
      created_at: "2026-03-01T06:00:00Z",
      updated_at: "2026-03-01T06:30:00Z",
      score_state: "SCORED",
    };

    const parsed = parseRecovery(record);
    expect(parsed.restingHr).toBeUndefined();
    expect(parsed.hrv).toBeUndefined();
  });

  it("returns all metrics when SCORED with full score", () => {
    const record: WhoopRecoveryRecord = {
      cycle_id: 102,
      sleep_id: 202,
      user_id: 10129,
      created_at: "2026-03-01T06:00:00Z",
      updated_at: "2026-03-01T06:30:00Z",
      score_state: "SCORED",
      score: {
        user_calibrating: false,
        recovery_score: 85,
        resting_heart_rate: 48,
        hrv_rmssd_milli: 72.3,
        spo2_percentage: 98.1,
        skin_temp_celsius: 34.0,
      },
    };

    const parsed = parseRecovery(record);
    expect(parsed.restingHr).toBe(48);
    expect(parsed.hrv).toBe(72.3);
    expect(parsed.spo2).toBe(98.1);
    expect(parsed.skinTemp).toBe(34.0);
  });

  it("handles score without optional spo2 and skinTemp", () => {
    const record: WhoopRecoveryRecord = {
      cycle_id: 103,
      sleep_id: 203,
      user_id: 10129,
      created_at: "2026-03-01T06:00:00Z",
      updated_at: "2026-03-01T06:30:00Z",
      score_state: "SCORED",
      score: {
        user_calibrating: true,
        recovery_score: 60,
        resting_heart_rate: 55,
        hrv_rmssd_milli: 45.0,
      },
    };

    const parsed = parseRecovery(record);
    expect(parsed.restingHr).toBe(55);
    expect(parsed.hrv).toBe(45.0);
    expect(parsed.spo2).toBeUndefined();
    expect(parsed.skinTemp).toBeUndefined();
  });
});

describe("parseSleep — invalid timestamps", () => {
  function sleepRecord(overrides: Partial<WhoopSleepRecord> = {}): WhoopSleepRecord {
    return {
      id: 400,
      user_id: 10129,
      created_at: "2026-03-01T06:00:00Z",
      updated_at: "2026-03-01T06:30:00Z",
      start: "2026-02-28T23:00:00Z",
      end: "2026-03-01T07:00:00Z",
      timezone_offset: "-05:00",
      nap: false,
      score_state: "PENDING",
      ...overrides,
    };
  }

  it("throws with descriptive message for empty start timestamp", () => {
    expect(() => parseSleep(sleepRecord({ start: "" }))).toThrow("Invalid start timestamp");
  });

  it("throws with descriptive message for non-date start timestamp", () => {
    expect(() => parseSleep(sleepRecord({ start: "not-a-date" }))).toThrow(
      "Invalid start timestamp",
    );
  });

  it("throws with descriptive message for empty end timestamp", () => {
    expect(() => parseSleep(sleepRecord({ end: "" }))).toThrow("Invalid end timestamp");
  });

  it("includes the raw value in the error message", () => {
    expect(() => parseSleep(sleepRecord({ start: "garbage" }))).toThrow('"garbage"');
  });

  it("succeeds with valid timestamps", () => {
    const parsed = parseSleep(sleepRecord());
    expect(parsed.startedAt).toEqual(new Date("2026-02-28T23:00:00Z"));
    expect(parsed.endedAt).toEqual(new Date("2026-03-01T07:00:00Z"));
  });

  it("falls back to `during` field when start/end are missing", () => {
    const record: WhoopSleepRecord = {
      id: 500,
      user_id: 10129,
      created_at: "2026-03-01T06:00:00Z",
      updated_at: "2026-03-01T06:30:00Z",
      timezone_offset: "-05:00",
      nap: false,
      score_state: "SCORED",
      during: "['2026-03-24T05:30:00.000Z','2026-03-24T13:15:00.000Z')",
      score: {
        stage_summary: {
          total_in_bed_time_milli: 27900000,
          total_awake_time_milli: 1800000,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: 10800000,
          total_slow_wave_sleep_time_milli: 7200000,
          total_rem_sleep_time_milli: 8100000,
          sleep_cycle_count: 4,
          disturbance_count: 2,
        },
        sleep_needed: {
          baseline_milli: 27000000,
          need_from_sleep_debt_milli: 0,
          need_from_recent_strain_milli: 1800000,
          need_from_recent_nap_milli: 0,
        },
        respiratory_rate: 15.5,
        sleep_performance_percentage: 96,
        sleep_consistency_percentage: 85,
        sleep_efficiency_percentage: 93.5,
      },
    };

    const parsed = parseSleep(record);
    expect(parsed.startedAt).toEqual(new Date("2026-03-24T05:30:00.000Z"));
    expect(parsed.endedAt).toEqual(new Date("2026-03-24T13:15:00.000Z"));
    expect(parsed.deepMinutes).toBe(120);
    expect(parsed.remMinutes).toBe(135);
    expect(parsed.lightMinutes).toBe(180);
  });
});

describe("parseSleep — edge cases", () => {
  it("handles sleep record without score", () => {
    const record: WhoopSleepRecord = {
      id: 300,
      user_id: 10129,
      created_at: "2026-03-01T06:00:00Z",
      updated_at: "2026-03-01T06:30:00Z",
      start: "2026-02-28T23:00:00Z",
      end: "2026-03-01T07:00:00Z",
      timezone_offset: "-05:00",
      nap: false,
      score_state: "PENDING",
    };

    const parsed = parseSleep(record);
    expect(parsed.externalId).toBe("300");
    expect(parsed.deepMinutes).toBe(0);
    expect(parsed.remMinutes).toBe(0);
    expect(parsed.lightMinutes).toBe(0);
    expect(parsed.awakeMinutes).toBe(0);
    expect(parsed.durationMinutes).toBe(0);
    expect(parsed.efficiencyPct).toBeUndefined();
    expect(parsed.isNap).toBe(false);
  });

  it("parses nap correctly", () => {
    const record: WhoopSleepRecord = {
      id: 301,
      user_id: 10129,
      created_at: "2026-03-01T14:00:00Z",
      updated_at: "2026-03-01T14:30:00Z",
      start: "2026-03-01T13:00:00Z",
      end: "2026-03-01T13:30:00Z",
      timezone_offset: "-05:00",
      nap: true,
      score_state: "SCORED",
      score: {
        stage_summary: {
          total_in_bed_time_milli: 1800000,
          total_awake_time_milli: 300000,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: 900000,
          total_slow_wave_sleep_time_milli: 300000,
          total_rem_sleep_time_milli: 300000,
          sleep_cycle_count: 1,
          disturbance_count: 0,
        },
        sleep_needed: {
          baseline_milli: 28800000,
          need_from_sleep_debt_milli: 0,
          need_from_recent_strain_milli: 0,
          need_from_recent_nap_milli: 0,
        },
        respiratory_rate: 15.0,
        sleep_performance_percentage: 50,
        sleep_consistency_percentage: 70,
        sleep_efficiency_percentage: 83.3,
      },
    };

    const parsed = parseSleep(record);
    expect(parsed.isNap).toBe(true);
    expect(parsed.deepMinutes).toBe(5);
    expect(parsed.lightMinutes).toBe(15);
    expect(parsed.remMinutes).toBe(5);
    expect(parsed.awakeMinutes).toBe(5);
    expect(parsed.efficiencyPct).toBeCloseTo(83.3);
  });
});

describe("parseWorkout — edge cases", () => {
  it("handles workout without score", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-400",
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
      timezone_offset: "-05:00",
      sport_id: 0,
    };

    const parsed = parseWorkout(record);
    expect(parsed.externalId).toBe("uuid-400");
    expect(parsed.activityType).toBe("running");
    expect(parsed.durationSeconds).toBe(3600);
    expect(parsed.distanceMeters).toBeUndefined();
    expect(parsed.calories).toBeUndefined();
    expect(parsed.avgHeartRate).toBeUndefined();
    expect(parsed.maxHeartRate).toBeUndefined();
    expect(parsed.totalElevationGain).toBeUndefined();
  });

  it("maps unknown sport ID to other", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-401",
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
      timezone_offset: "-05:00",
      sport_id: 9999,
      score: 5,
      average_heart_rate: 120,
      max_heart_rate: 140,
      kilojoules: 500,
    };

    const parsed = parseWorkout(record);
    expect(parsed.activityType).toBe("other");
  });

  it("converts kilojoules to calories", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-402",
      during: "['2026-03-01T10:00:00Z','2026-03-01T10:30:00Z')",
      timezone_offset: "-05:00",
      sport_id: 44, // yoga
      score: 3,
      average_heart_rate: 100,
      max_heart_rate: 120,
      kilojoules: 418.4,
    };

    const parsed = parseWorkout(record);
    expect(parsed.calories).toBe(100); // 418.4 / 4.184 = ~100
    expect(parsed.activityType).toBe("yoga");
  });

  it("handles score with zero kilojoule", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-403",
      during: "['2026-03-01T10:00:00Z','2026-03-01T10:30:00Z')",
      timezone_offset: "-05:00",
      sport_id: 70, // meditation
      score: 0,
      average_heart_rate: 60,
      max_heart_rate: 70,
      kilojoules: 0,
    };

    const parsed = parseWorkout(record);
    expect(parsed.calories).toBeUndefined(); // 0 is falsy
    expect(parsed.activityType).toBe("meditation");
  });

  it("maps various sport IDs correctly", () => {
    const makeRecord = (sportId: number): WhoopWorkoutRecord => ({
      activity_id: `uuid-${sportId + 1000}`,
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
      timezone_offset: "-05:00",
      sport_id: sportId,
      score: 5,
      average_heart_rate: 130,
      max_heart_rate: 160,
      kilojoules: 1000,
    });

    expect(parseWorkout(makeRecord(1)).activityType).toBe("cycling");
    expect(parseWorkout(makeRecord(33)).activityType).toBe("swimming");
    expect(parseWorkout(makeRecord(52)).activityType).toBe("hiking");
    expect(parseWorkout(makeRecord(63)).activityType).toBe("walking");
    expect(parseWorkout(makeRecord(45)).activityType).toBe("weightlifting");
    expect(parseWorkout(makeRecord(18)).activityType).toBe("rowing");
    expect(parseWorkout(makeRecord(65)).activityType).toBe("elliptical");
    expect(parseWorkout(makeRecord(29)).activityType).toBe("skiing");
  });
});

describe("parseHeartRateValues — edge cases", () => {
  it("returns empty array for empty input", () => {
    expect(parseHeartRateValues([])).toHaveLength(0);
  });

  it("parses heart rate values with correct dates", () => {
    const values = [
      { time: 1709280000000, data: 72 },
      { time: 1709280006000, data: 75 },
    ];

    const parsed = parseHeartRateValues(values);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.recordedAt).toEqual(new Date(1709280000000));
    expect(parsed[0]?.heartRate).toBe(72);
    expect(parsed[1]?.recordedAt).toEqual(new Date(1709280006000));
    expect(parsed[1]?.heartRate).toBe(75);
  });
});

describe("WhoopClient.authenticate — MFA required path", () => {
  it("throws when MFA is required", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            ChallengeName: "SMS_MFA",
            Session: "mfa-session",
          }),
        );
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    await expect(WhoopClient.authenticate("user@test.com", "pass", mockFetch)).rejects.toThrow(
      /MFA/,
    );
  });

  it("returns token when no MFA required", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            AuthenticationResult: { AccessToken: "my-tok", RefreshToken: "my-ref" },
          }),
        );
      }
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ id: 42 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const token = await WhoopClient.authenticate("user@test.com", "pass", mockFetch);
    expect(token.accessToken).toBe("my-tok");
    expect(token.refreshToken).toBe("my-ref");
    expect(token.userId).toBe(42);
  });

  it("throws when signIn gets token but no userId from bootstrap", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            AuthenticationResult: { AccessToken: "tok", RefreshToken: "ref" },
          }),
        );
      }
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ profile: {} }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    await expect(WhoopClient.authenticate("user@test.com", "pass", mockFetch)).rejects.toThrow(
      /user ID/i,
    );
  });
});

describe("WhoopClient._fetchUserId — various response shapes", () => {
  it("extracts user_id from top level", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ user_id: 123 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const userId = await WhoopClient._fetchUserId("token", mockFetch);
    expect(userId).toBe(123);
  });

  it("extracts id from nested user object", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ user: { id: 456 } }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const userId = await WhoopClient._fetchUserId("token", mockFetch);
    expect(userId).toBe(456);
  });

  it("extracts user_id from nested user object", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ user: { user_id: 789 } }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const userId = await WhoopClient._fetchUserId("token", mockFetch);
    expect(userId).toBe(789);
  });

  it("returns null when no user ID can be extracted", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ something: "else" }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const userId = await WhoopClient._fetchUserId("token", mockFetch);
    expect(userId).toBeNull();
  });
});

describe("WhoopClient.refreshAccessToken — success path", () => {
  it("returns new access token and reuses old refresh token", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            AuthenticationResult: { AccessToken: "new-access" },
          }),
        );
      }
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ id: 99 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const result = await WhoopClient.refreshAccessToken("old-refresh", mockFetch);
    expect(result.accessToken).toBe("new-access");
    // Should reuse old refresh token since Cognito doesn't return a new one
    expect(result.refreshToken).toBe("old-refresh");
    expect(result.userId).toBe(99);
  });

  it("returns new refresh token when Cognito provides one", async () => {
    const mockFetch: typeof globalThis.fetch = (_input: RequestInfo | URL) => {
      const url = _input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            AuthenticationResult: { AccessToken: "new-access", RefreshToken: "new-refresh" },
          }),
        );
      }
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ id: 88 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const result = await WhoopClient.refreshAccessToken("old-refresh", mockFetch);
    expect(result.refreshToken).toBe("new-refresh");
  });
});

// ============================================================
// parseWorkout — legacy fallback (no `during` field)
// ============================================================

describe("parseWorkout — legacy fallback without during", () => {
  it("falls back to start/end when during is missing", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-legacy-1",
      timezone_offset: "-05:00",
      sport_id: 0,
      start: "2026-03-01T10:00:00Z",
      end: "2026-03-01T11:00:00Z",
    };

    const parsed = parseWorkout(record);
    expect(parsed.startedAt).toEqual(new Date("2026-03-01T10:00:00Z"));
    expect(parsed.endedAt).toEqual(new Date("2026-03-01T11:00:00Z"));
    expect(parsed.durationSeconds).toBe(3600);
  });

  it("falls back to created_at/updated_at when during and start/end are missing", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-legacy-2",
      timezone_offset: "-05:00",
      sport_id: 1,
      created_at: "2026-03-01T09:00:00Z",
      updated_at: "2026-03-01T10:30:00Z",
    };

    const parsed = parseWorkout(record);
    expect(parsed.startedAt).toEqual(new Date("2026-03-01T09:00:00Z"));
    expect(parsed.endedAt).toEqual(new Date("2026-03-01T10:30:00Z"));
    expect(parsed.durationSeconds).toBe(5400);
  });

  it("uses id as externalId when activity_id is missing", () => {
    const record: WhoopWorkoutRecord = {
      id: 12345,
      timezone_offset: "-05:00",
      sport_id: 0,
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
    };

    const parsed = parseWorkout(record);
    expect(parsed.externalId).toBe("12345");
  });
});

// ============================================================
// parseJournalResponse — all branches
// ============================================================

describe("parseJournalResponse", () => {
  it("returns empty array for null input", () => {
    expect(parseJournalResponse(null)).toEqual([]);
  });

  it("returns empty array for non-object input", () => {
    expect(parseJournalResponse("string")).toEqual([]);
    expect(parseJournalResponse(42)).toEqual([]);
    expect(parseJournalResponse(undefined)).toEqual([]);
  });

  it("handles plain array of entries with nested answers", () => {
    const raw = [
      {
        date: "2026-03-01T00:00:00Z",
        answers: [
          { name: "caffeine", value: 1, impact: 0.5 },
          { name: "alcohol", value: 0, impact: -0.2 },
        ],
      },
    ];

    const entries = parseJournalResponse(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.question).toBe("caffeine");
    expect(entries[0]?.answerNumeric).toBe(1);
    expect(entries[0]?.impactScore).toBe(0.5);
    expect(entries[1]?.question).toBe("alcohol");
  });

  it("unwraps entries from 'impacts' wrapper key", () => {
    const raw = {
      impacts: [{ date: "2026-03-01", answers: [{ name: "sleep_aid", value: 0 }] }],
    };

    const entries = parseJournalResponse(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.question).toBe("sleep_aid");
  });

  it("unwraps entries from 'entries' wrapper key", () => {
    const raw = {
      entries: [{ date: "2026-03-01", answers: [{ name: "melatonin", value: 1 }] }],
    };

    const entries = parseJournalResponse(raw);
    expect(entries).toHaveLength(1);
  });

  it("unwraps entries from 'data' wrapper key", () => {
    const raw = {
      data: [{ date: "2026-03-01", answers: [{ name: "stretch", value: 1 }] }],
    };

    const entries = parseJournalResponse(raw);
    expect(entries).toHaveLength(1);
  });

  it("unwraps entries from 'results' wrapper key", () => {
    const raw = {
      results: [{ date: "2026-03-01", answers: [{ name: "hydration", score: 3 }] }],
    };

    const entries = parseJournalResponse(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.answerNumeric).toBe(3);
  });

  it("unwraps entries from 'journal' wrapper key", () => {
    const raw = {
      journal: [{ date: "2026-03-01", answers: [{ name: "mood", value: 4 }] }],
    };

    const entries = parseJournalResponse(raw);
    expect(entries).toHaveLength(1);
  });

  it("unwraps entries from 'records' wrapper key", () => {
    const raw = {
      records: [{ date: "2026-03-01", answers: [{ name: "recovery", value: 2 }] }],
    };

    const entries = parseJournalResponse(raw);
    expect(entries).toHaveLength(1);
  });

  it("wraps single object when wrapped value is not an array", () => {
    const raw = {
      impacts: "not-an-array",
      date: "2026-03-01",
      name: "single_entry",
      value: 5,
    };

    const entries = parseJournalResponse(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.question).toBe("single_entry");
    expect(entries[0]?.answerNumeric).toBe(5);
  });

  it("skips null and non-object items in array", () => {
    const raw = [
      null,
      "string-item",
      42,
      { date: "2026-03-01", answers: [{ name: "valid", value: 1 }] },
    ];

    const entries = parseJournalResponse(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.question).toBe("valid");
  });

  it("extracts date from cycle_start field", () => {
    const raw = [{ cycle_start: "2026-03-01T00:00:00Z", answers: [{ name: "test", value: 1 }] }];

    const entries = parseJournalResponse(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.date).toEqual(new Date("2026-03-01T00:00:00Z"));
  });

  it("extracts date from start field", () => {
    const raw = [{ start: "2026-03-01T00:00:00Z", answers: [{ name: "test", value: 1 }] }];

    const entries = parseJournalResponse(raw);
    expect(entries).toHaveLength(1);
  });

  it("extracts date from day field", () => {
    const raw = [{ day: "2026-03-01", answers: [{ name: "test", value: 1 }] }];

    const entries = parseJournalResponse(raw);
    expect(entries).toHaveLength(1);
  });

  it("skips entries with invalid dates", () => {
    const raw = [
      { date: "not-a-date", answers: [{ name: "test", value: 1 }] },
      { answers: [{ name: "no_date", value: 1 }] },
    ];

    const entries = parseJournalResponse(raw);
    expect(entries).toHaveLength(0);
  });

  it("skips null/non-object answers in nested array", () => {
    const raw = [
      {
        date: "2026-03-01",
        answers: [null, "string", { name: "valid_answer", value: 3 }],
      },
    ];

    const entries = parseJournalResponse(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.question).toBe("valid_answer");
  });

  it("extracts answerText from answer field", () => {
    const raw = [
      {
        date: "2026-03-01",
        answers: [{ name: "note", answer: "felt great" }],
      },
    ];

    const entries = parseJournalResponse(raw);
    expect(entries[0]?.answerText).toBe("felt great");
  });

  it("extracts answerText from response field when answer is not a string", () => {
    const raw = [
      {
        date: "2026-03-01",
        answers: [{ name: "note", answer: 42, response: "pretty good" }],
      },
    ];

    const entries = parseJournalResponse(raw);
    expect(entries[0]?.answerText).toBe("pretty good");
  });

  it("extracts answerText from value field when answer and response are not strings", () => {
    const raw = [
      {
        date: "2026-03-01",
        answers: [{ name: "note", answer: 1, response: 2, value: "string value" }],
      },
    ];

    const entries = parseJournalResponse(raw);
    expect(entries[0]?.answerText).toBe("string value");
    // value is a string so answerNumeric should be null
    expect(entries[0]?.answerNumeric).toBeNull();
  });

  it("extracts impactScore from impact_score field", () => {
    const raw = [
      {
        date: "2026-03-01",
        answers: [{ name: "test", impact_score: 0.8 }],
      },
    ];

    const entries = parseJournalResponse(raw);
    expect(entries[0]?.impactScore).toBe(0.8);
  });

  it("uses behavior/question/type as question name fallbacks", () => {
    const raw = [{ date: "2026-03-01", answers: [{ behavior: "my_behavior", value: 1 }] }];
    expect(parseJournalResponse(raw)[0]?.question).toBe("my_behavior");

    const raw2 = [{ date: "2026-03-01", answers: [{ question: "my_question", value: 1 }] }];
    expect(parseJournalResponse(raw2)[0]?.question).toBe("my_question");

    const raw3 = [{ date: "2026-03-01", answers: [{ type: "my_type", value: 1 }] }];
    expect(parseJournalResponse(raw3)[0]?.question).toBe("my_type");
  });

  it("defaults to 'unknown' when no question name fields exist in answer", () => {
    const raw = [{ date: "2026-03-01", answers: [{ value: 1 }] }];

    const entries = parseJournalResponse(raw);
    expect(entries[0]?.question).toBe("unknown");
  });

  it("handles flat entries without nested answers", () => {
    const raw = [
      {
        date: "2026-03-01",
        name: "caffeine",
        value: 2,
        impact: 0.3,
      },
    ];

    const entries = parseJournalResponse(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.question).toBe("caffeine");
    expect(entries[0]?.answerNumeric).toBe(2);
    expect(entries[0]?.answerText).toBeNull();
    expect(entries[0]?.impactScore).toBe(0.3);
  });

  it("handles flat entries with behavior as question name", () => {
    const raw = [{ date: "2026-03-01", behavior: "meditation", score: 4 }];

    const entries = parseJournalResponse(raw);
    expect(entries[0]?.question).toBe("meditation");
    expect(entries[0]?.answerNumeric).toBe(4);
  });

  it("handles flat entries with type as question name", () => {
    const raw = [{ date: "2026-03-01", type: "sleep_quality", score: 3 }];

    const entries = parseJournalResponse(raw);
    expect(entries[0]?.question).toBe("sleep_quality");
  });

  it("handles flat entries with answer/response string fields", () => {
    const raw = [{ date: "2026-03-01", name: "note", answer: "good day" }];

    const entries = parseJournalResponse(raw);
    expect(entries[0]?.answerText).toBe("good day");

    const raw2 = [{ date: "2026-03-01", name: "note", response: "okay day" }];
    expect(parseJournalResponse(raw2)[0]?.answerText).toBe("okay day");
  });

  it("handles flat entries with impact_score", () => {
    const raw = [{ date: "2026-03-01", name: "test", impact_score: 0.7 }];

    const entries = parseJournalResponse(raw);
    expect(entries[0]?.impactScore).toBe(0.7);
  });

  it("defaults flat entry question to 'journal' when no name fields exist", () => {
    const raw = [{ date: "2026-03-01", value: 1 }];

    const entries = parseJournalResponse(raw);
    expect(entries[0]?.question).toBe("journal");
  });

  it("normalizes question names to lowercase with underscores", () => {
    const raw = [
      {
        date: "2026-03-01",
        answers: [{ name: "Morning  Stretch", value: 1 }],
      },
    ];

    const entries = parseJournalResponse(raw);
    expect(entries[0]?.question).toBe("morning_stretch");
  });

  it("extracts answerNumeric from score field in nested answers", () => {
    const raw = [
      {
        date: "2026-03-01",
        answers: [{ name: "energy", score: 7 }],
      },
    ];

    const entries = parseJournalResponse(raw);
    expect(entries[0]?.answerNumeric).toBe(7);
  });
});

// ============================================================
// parseSleep — sleep need breakdown
// ============================================================

describe("parseSleep — sleep need breakdown", () => {
  it("extracts sleep need components when scored", () => {
    const record: WhoopSleepRecord = {
      id: 400,
      user_id: 10129,
      created_at: "2026-03-01T06:00:00Z",
      updated_at: "2026-03-01T06:30:00Z",
      start: "2026-02-28T23:00:00Z",
      end: "2026-03-01T06:30:00Z",
      timezone_offset: "-05:00",
      nap: false,
      score_state: "SCORED",
      score: {
        stage_summary: {
          total_in_bed_time_milli: 27000000,
          total_awake_time_milli: 1800000,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: 10800000,
          total_slow_wave_sleep_time_milli: 7200000,
          total_rem_sleep_time_milli: 5400000,
          sleep_cycle_count: 4,
          disturbance_count: 2,
        },
        sleep_needed: {
          baseline_milli: 28800000, // 480 min
          need_from_sleep_debt_milli: 1800000, // 30 min
          need_from_recent_strain_milli: 900000, // 15 min
          need_from_recent_nap_milli: -600000, // -10 min
        },
        respiratory_rate: 16.1,
        sleep_performance_percentage: 92,
        sleep_consistency_percentage: 88,
        sleep_efficiency_percentage: 91.7,
      },
    };

    const parsed = parseSleep(record);
    expect(parsed.sleepNeedBaselineMinutes).toBe(480);
    expect(parsed.sleepNeedFromDebtMinutes).toBe(30);
    expect(parsed.sleepNeedFromStrainMinutes).toBe(15);
    expect(parsed.sleepNeedFromNapMinutes).toBe(-10);
  });

  it("returns undefined sleep need when score is missing", () => {
    const record: WhoopSleepRecord = {
      id: 401,
      user_id: 10129,
      created_at: "2026-03-01T06:00:00Z",
      updated_at: "2026-03-01T06:30:00Z",
      start: "2026-02-28T23:00:00Z",
      end: "2026-03-01T06:30:00Z",
      timezone_offset: "-05:00",
      nap: false,
      score_state: "PENDING",
    };

    const parsed = parseSleep(record);
    expect(parsed.sleepNeedBaselineMinutes).toBeUndefined();
    expect(parsed.sleepNeedFromDebtMinutes).toBeUndefined();
    expect(parsed.sleepNeedFromStrainMinutes).toBeUndefined();
    expect(parsed.sleepNeedFromNapMinutes).toBeUndefined();
  });
});

// ============================================================
// parseWorkout — percent recorded
// ============================================================

describe("parseWorkout — percent recorded", () => {
  it("extracts percent_recorded from workout record", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-pct-1",
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
      timezone_offset: "-05:00",
      sport_id: 0,
      percent_recorded: 95,
    };

    const parsed = parseWorkout(record);
    expect(parsed.percentRecorded).toBe(95);
  });

  it("returns undefined when percent_recorded is missing", () => {
    const record: WhoopWorkoutRecord = {
      activity_id: "uuid-pct-2",
      during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
      timezone_offset: "-05:00",
      sport_id: 0,
    };

    const parsed = parseWorkout(record);
    expect(parsed.percentRecorded).toBeUndefined();
  });
});

// ============================================================
// parseWeightliftingWorkout — MSK strain and strap location
// ============================================================

describe("parseWeightliftingWorkout — MSK strain breakdown", () => {
  it("extracts MSK strain scores from response", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "test-msk",
      user_id: 1,
      zone_durations: {},
      workout_groups: [],
      total_effective_volume_kg: 2047,
      raw_msk_strain_score: 0.0288,
      scaled_msk_strain_score: 2.856,
      cardio_strain_score: 1.549,
      cardio_strain_contribution_percent: 0.329,
      msk_strain_contribution_percent: 0.671,
    };

    const result = parseWeightliftingWorkout(response);
    expect(result.rawMskStrainScore).toBe(0.0288);
    expect(result.scaledMskStrainScore).toBe(2.856);
    expect(result.cardioStrainScore).toBe(1.549);
    expect(result.cardioStrainContributionPercent).toBe(0.329);
    expect(result.mskStrainContributionPercent).toBe(0.671);
  });
});

describe("parseWeightliftingWorkout — strap location", () => {
  it("extracts strap location from sets", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "test-strap",
      user_id: 1,
      zone_durations: {},
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 20,
                  number_of_reps: 10,
                  msk_total_volume_kg: 200,
                  time_in_seconds: 0,
                  during: "['2026-03-12T21:37:00.000Z','2026-03-12T21:37:00.001Z')",
                  complete: true,
                  strap_location: "BICEP",
                  strap_location_laterality: "LEFT",
                },
              ],
              exercise_details: {
                exercise_id: "CURL",
                name: "Bicep Curl",
                equipment: "DUMBBELL",
                exercise_type: "STRENGTH",
                muscle_groups: ["BICEPS"],
                volume_input_format: "REPS_AND_WEIGHT",
              },
            },
          ],
        },
      ],
      total_effective_volume_kg: 200,
      raw_msk_strain_score: 0.01,
      scaled_msk_strain_score: 1.0,
      cardio_strain_score: 0.5,
      cardio_strain_contribution_percent: 0.3,
      msk_strain_contribution_percent: 0.7,
    };

    const result = parseWeightliftingWorkout(response);
    expect(result.exercises[0]?.sets[0]?.strapLocation).toBe("BICEP");
    expect(result.exercises[0]?.sets[0]?.strapLocationLaterality).toBe("LEFT");
  });

  it("returns null strap location for manually-logged sets", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "test-no-strap",
      user_id: 1,
      zone_durations: {},
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 50,
                  number_of_reps: 8,
                  msk_total_volume_kg: 400,
                  time_in_seconds: 0,
                  during: "['2026-03-12T22:00:00.000Z','2026-03-12T22:00:00.001Z')",
                  complete: true,
                  strap_location: null,
                  strap_location_laterality: null,
                },
              ],
              exercise_details: {
                exercise_id: "BENCHPRESS",
                name: "Bench Press",
                equipment: "BARBELL",
                exercise_type: "STRENGTH",
                muscle_groups: ["CHEST"],
                volume_input_format: "REPS_AND_WEIGHT",
              },
            },
          ],
        },
      ],
      total_effective_volume_kg: 400,
      raw_msk_strain_score: 0,
      scaled_msk_strain_score: 0,
      cardio_strain_score: 0,
      cardio_strain_contribution_percent: 0,
      msk_strain_contribution_percent: 0,
    };

    const result = parseWeightliftingWorkout(response);
    expect(result.exercises[0]?.sets[0]?.strapLocation).toBeNull();
    expect(result.exercises[0]?.sets[0]?.strapLocationLaterality).toBeNull();
  });
});

// ============================================================
// parseWeightliftingWorkout — exercise metadata
// ============================================================

describe("parseWeightliftingWorkout — exercise metadata", () => {
  it("extracts muscle groups and exercise type", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "test-metadata",
      user_id: 1,
      zone_durations: {},
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 50,
                  number_of_reps: 8,
                  msk_total_volume_kg: 400,
                  time_in_seconds: 0,
                  during: "['2026-03-12T22:00:00.000Z','2026-03-12T22:00:00.001Z')",
                  complete: true,
                  strap_location: null,
                  strap_location_laterality: null,
                },
              ],
              exercise_details: {
                exercise_id: "BENCHPRESS",
                name: "Bench Press",
                equipment: "BARBELL",
                exercise_type: "STRENGTH",
                muscle_groups: ["CHEST", "TRICEPS"],
                volume_input_format: "REPS_AND_WEIGHT",
              },
            },
          ],
        },
      ],
      total_effective_volume_kg: 400,
      raw_msk_strain_score: 0,
      scaled_msk_strain_score: 0,
      cardio_strain_score: 0,
      cardio_strain_contribution_percent: 0,
      msk_strain_contribution_percent: 0,
    };

    const result = parseWeightliftingWorkout(response);
    expect(result.exercises[0]?.muscleGroups).toEqual(["CHEST", "TRICEPS"]);
    expect(result.exercises[0]?.exerciseType).toBe("STRENGTH");
  });
});

// ============================================================
// parseWeightliftingWorkout — additional edge cases
// ============================================================

describe("parseWeightliftingWorkout — additional edge cases", () => {
  it("returns null duration for TIME format with zero time_in_seconds", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "test-time-zero",
      user_id: 1,
      zone_durations: {
        zone0_to10_duration: 0,
        zone10_to20_duration: 0,
        zone20_to30_duration: 0,
        zone30_to40_duration: 0,
        zone40_to50_duration: 0,
        zone50_to60_duration: 0,
        zone60_to70_duration: 0,
        zone70_to80_duration: 0,
        zone80_to90_duration: 0,
        zone90_to100_duration: 0,
      },
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 0,
                  number_of_reps: 0,
                  msk_total_volume_kg: 0,
                  time_in_seconds: 0,
                  during: "['2026-03-12T21:37:00.000Z','2026-03-12T21:37:00.001Z')",
                  complete: true,
                  strap_location: null,
                  strap_location_laterality: null,
                },
              ],
              exercise_details: {
                exercise_id: "PLANK",
                name: "Plank",
                equipment: "BODY",
                exercise_type: "STRENGTH",
                muscle_groups: ["CORE"],
                volume_input_format: "TIME",
              },
            },
          ],
        },
      ],
      total_effective_volume_kg: 0,
      raw_msk_strain_score: 0,
      scaled_msk_strain_score: 0,
      cardio_strain_score: 0,
      cardio_strain_contribution_percent: 0,
      msk_strain_contribution_percent: 0,
    };

    const result = parseWeightliftingWorkout(response);
    expect(result.exercises[0]?.sets[0]?.durationSeconds).toBeNull();
  });

  it("sets equipment to null when empty string", () => {
    const response: WhoopWeightliftingWorkoutResponse = {
      activity_id: "test-no-equip",
      user_id: 1,
      zone_durations: {
        zone0_to10_duration: 0,
        zone10_to20_duration: 0,
        zone20_to30_duration: 0,
        zone30_to40_duration: 0,
        zone40_to50_duration: 0,
        zone50_to60_duration: 0,
        zone60_to70_duration: 0,
        zone70_to80_duration: 0,
        zone80_to90_duration: 0,
        zone90_to100_duration: 0,
      },
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 20,
                  number_of_reps: 10,
                  msk_total_volume_kg: 200,
                  time_in_seconds: 0,
                  during: "['2026-03-12T21:37:00.000Z','2026-03-12T21:37:00.001Z')",
                  complete: true,
                  strap_location: null,
                  strap_location_laterality: null,
                },
              ],
              exercise_details: {
                exercise_id: "PUSHUP",
                name: "Push Up",
                equipment: "",
                exercise_type: "STRENGTH",
                muscle_groups: ["CHEST"],
                volume_input_format: "REPS_AND_WEIGHT",
              },
            },
          ],
        },
      ],
      total_effective_volume_kg: 200,
      raw_msk_strain_score: 0,
      scaled_msk_strain_score: 0,
      cardio_strain_score: 0,
      cardio_strain_contribution_percent: 0,
      msk_strain_contribution_percent: 0,
    };

    const result = parseWeightliftingWorkout(response);
    expect(result.exercises[0]?.equipment).toBeNull();
  });
});
