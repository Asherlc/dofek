import { describe, expect, it } from "vitest";
import {
  parseHeartRateValues,
  parseRecovery,
  parseSleep,
  parseWorkout,
  WhoopClient,
  type WhoopRecoveryRecord,
  type WhoopSleepRecord,
  type WhoopWorkoutRecord,
} from "../whoop.ts";

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
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("auth-service/v3/whoop")) {
        return Promise.resolve(
          Response.json({
            ChallengeName: "SMS_MFA",
            Session: "mfa-session",
          }),
        );
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as typeof globalThis.fetch;

    await expect(WhoopClient.authenticate("user@test.com", "pass", mockFetch)).rejects.toThrow(
      /MFA/,
    );
  });

  it("returns token when no MFA required", async () => {
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
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
    }) as typeof globalThis.fetch;

    const token = await WhoopClient.authenticate("user@test.com", "pass", mockFetch);
    expect(token.accessToken).toBe("my-tok");
    expect(token.refreshToken).toBe("my-ref");
    expect(token.userId).toBe(42);
  });

  it("throws when signIn gets token but no userId from bootstrap", async () => {
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
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
    }) as typeof globalThis.fetch;

    await expect(WhoopClient.authenticate("user@test.com", "pass", mockFetch)).rejects.toThrow(
      /user ID/i,
    );
  });
});

describe("WhoopClient._fetchUserId — various response shapes", () => {
  it("extracts user_id from top level", async () => {
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ user_id: 123 }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as typeof globalThis.fetch;

    const userId = await WhoopClient._fetchUserId("token", mockFetch);
    expect(userId).toBe(123);
  });

  it("extracts id from nested user object", async () => {
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ user: { id: 456 } }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as typeof globalThis.fetch;

    const userId = await WhoopClient._fetchUserId("token", mockFetch);
    expect(userId).toBe(456);
  });

  it("extracts user_id from nested user object", async () => {
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ user: { user_id: 789 } }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as typeof globalThis.fetch;

    const userId = await WhoopClient._fetchUserId("token", mockFetch);
    expect(userId).toBe(789);
  });

  it("returns null when no user ID can be extracted", async () => {
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("users-service/v2/bootstrap")) {
        return Promise.resolve(Response.json({ something: "else" }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    }) as typeof globalThis.fetch;

    const userId = await WhoopClient._fetchUserId("token", mockFetch);
    expect(userId).toBeNull();
  });
});

describe("WhoopClient.refreshAccessToken — success path", () => {
  it("returns new access token and reuses old refresh token", async () => {
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
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
    }) as typeof globalThis.fetch;

    const result = await WhoopClient.refreshAccessToken("old-refresh", mockFetch);
    expect(result.accessToken).toBe("new-access");
    // Should reuse old refresh token since Cognito doesn't return a new one
    expect(result.refreshToken).toBe("old-refresh");
    expect(result.userId).toBe(99);
  });

  it("returns new refresh token when Cognito provides one", async () => {
    const mockFetch = ((input: RequestInfo | URL) => {
      const url = input.toString();
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
    }) as typeof globalThis.fetch;

    const result = await WhoopClient.refreshAccessToken("old-refresh", mockFetch);
    expect(result.refreshToken).toBe("new-refresh");
  });
});
