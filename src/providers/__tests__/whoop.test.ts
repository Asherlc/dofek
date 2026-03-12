import { describe, expect, it } from "vitest";
import {
  parseHeartRateValues,
  parseRecovery,
  parseSleep,
  parseWorkout,
  type WhoopHrValue,
  WhoopInternalClient,
  type WhoopRecoveryRecord,
  type WhoopSleepRecord,
  type WhoopWorkoutRecord,
} from "../whoop.ts";

// ============================================================
// Pure parsing unit tests (no DB, no network)
// ============================================================

const sampleRecovery: WhoopRecoveryRecord = {
  cycle_id: 93845,
  sleep_id: 10235,
  user_id: 10129,
  created_at: "2026-03-01T11:25:44.774Z",
  updated_at: "2026-03-01T14:25:44.774Z",
  score_state: "SCORED",
  score: {
    user_calibrating: false,
    recovery_score: 78,
    resting_heart_rate: 52,
    hrv_rmssd_milli: 65.5,
    spo2_percentage: 97.2,
    skin_temp_celsius: 33.7,
  },
};

const sampleSleep: WhoopSleepRecord = {
  id: 10235,
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
      baseline_milli: 28800000,
      need_from_sleep_debt_milli: 1800000,
      need_from_recent_strain_milli: 900000,
      need_from_recent_nap_milli: 0,
    },
    respiratory_rate: 16.1,
    sleep_performance_percentage: 92,
    sleep_consistency_percentage: 88,
    sleep_efficiency_percentage: 91.7,
  },
};

const sampleWorkout: WhoopWorkoutRecord = {
  id: 1043,
  user_id: 9012,
  created_at: "2026-03-01T10:00:00Z",
  updated_at: "2026-03-01T11:00:00Z",
  start: "2026-03-01T10:00:00Z",
  end: "2026-03-01T11:00:00Z",
  timezone_offset: "-05:00",
  sport_id: 0,
  score_state: "SCORED",
  score: {
    strain: 12.5,
    average_heart_rate: 155,
    max_heart_rate: 185,
    kilojoule: 2500.5,
    percent_recorded: 100,
    distance_meter: 10000,
    altitude_gain_meter: 150.5,
    altitude_change_meter: -5.2,
    zone_duration: {
      zone_zero_milli: 60000,
      zone_one_milli: 300000,
      zone_two_milli: 900000,
      zone_three_milli: 1200000,
      zone_four_milli: 600000,
      zone_five_milli: 300000,
    },
  },
};

/** Helper: mock fetch that routes Cognito calls and user bootstrap */
function makeCognitoMockFetch(
  cognitoHandler: (body: Record<string, unknown>, headers: Record<string, string>) => unknown,
) {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.includes("auth-service/v3/whoop")) {
      const body = JSON.parse(init?.body as string);
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k] = v;
        }
      }
      const result = cognitoHandler(body, headers);
      return Promise.resolve(Response.json(result));
    }
    if (url.includes("users-service/v2/bootstrap")) {
      return Promise.resolve(Response.json({ id: 42 }));
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as typeof globalThis.fetch;
}

describe("WhoopInternalClient.signIn (Cognito v3)", () => {
  it("calls Cognito InitiateAuth with USER_PASSWORD_AUTH", async () => {
    let capturedBody: Record<string, unknown> = {};
    let capturedTarget = "";
    const mockFetch = makeCognitoMockFetch((body, headers) => {
      capturedBody = body;
      capturedTarget = headers["X-Amz-Target"] ?? "";
      return {
        AuthenticationResult: {
          AccessToken: "tok",
          RefreshToken: "ref",
        },
      };
    });

    await WhoopInternalClient.signIn("user@test.com", "pass", mockFetch);
    expect(capturedTarget).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    expect(capturedBody.AuthFlow).toBe("USER_PASSWORD_AUTH");
    expect((capturedBody.AuthParameters as Record<string, string>).USERNAME).toBe("user@test.com");
    expect((capturedBody.AuthParameters as Record<string, string>).PASSWORD).toBe("pass");
  });

  it("fetches user ID from users-service bootstrap after sign-in", async () => {
    const mockFetch = makeCognitoMockFetch(() => ({
      AuthenticationResult: { AccessToken: "tok", RefreshToken: "ref" },
    }));

    const result = await WhoopInternalClient.signIn("user@test.com", "pass", mockFetch);
    expect(result.type).toBe("success");
    if (result.type === "success") {
      expect(result.token.userId).toBe(42);
    }
  });

  it("returns verification_required when MFA challenge is returned", async () => {
    const mockFetch = makeCognitoMockFetch(() => ({
      ChallengeName: "SMS_MFA",
      Session: "session-abc",
    }));

    const result = await WhoopInternalClient.signIn("user@test.com", "pass", mockFetch);
    expect(result.type).toBe("verification_required");
    if (result.type === "verification_required") {
      expect(result.session).toBe("session-abc");
      expect(result.method).toBe("sms");
    }
  });

  it("authenticate() throws on MFA-required accounts", async () => {
    const mockFetch = makeCognitoMockFetch(() => ({
      ChallengeName: "SMS_MFA",
      Session: "session-abc",
    }));

    await expect(
      WhoopInternalClient.authenticate("user@test.com", "pass", mockFetch),
    ).rejects.toThrow("MFA");
  });
});

describe("WhoopInternalClient.refreshAccessToken (Cognito v3)", () => {
  it("calls Cognito InitiateAuth with REFRESH_TOKEN_AUTH", async () => {
    let capturedBody: Record<string, unknown> = {};
    const mockFetch = makeCognitoMockFetch((body) => {
      capturedBody = body;
      return {
        AuthenticationResult: { AccessToken: "new-tok" },
      };
    });

    const token = await WhoopInternalClient.refreshAccessToken("old-ref", mockFetch);
    expect(capturedBody.AuthFlow).toBe("REFRESH_TOKEN_AUTH");
    expect((capturedBody.AuthParameters as Record<string, string>).REFRESH_TOKEN).toBe("old-ref");
    expect(token.accessToken).toBe("new-tok");
    expect(token.refreshToken).toBe("old-ref"); // reuses old when not returned
    expect(token.userId).toBe(42);
  });
});

describe("WHOOP Provider — parsing", () => {
  describe("parseRecovery", () => {
    it("maps recovery fields to daily metrics", () => {
      const result = parseRecovery(sampleRecovery);
      expect(result.restingHr).toBe(52);
      expect(result.hrv).toBeCloseTo(65.5);
    });

    it("returns null fields for unscored recovery", () => {
      const unscored = { ...sampleRecovery, score_state: "PENDING_SCORE", score: undefined };
      const result = parseRecovery(unscored as WhoopRecoveryRecord);
      expect(result.restingHr).toBeUndefined();
      expect(result.hrv).toBeUndefined();
    });
  });

  describe("parseSleep", () => {
    it("maps sleep fields to sleep session", () => {
      const result = parseSleep(sampleSleep);
      expect(result.externalId).toBe("10235");
      expect(result.startedAt).toEqual(new Date("2026-02-28T23:00:00Z"));
      expect(result.endedAt).toEqual(new Date("2026-03-01T06:30:00Z"));
      expect(result.deepMinutes).toBe(120); // 7200000ms / 60000
      expect(result.remMinutes).toBe(90);
      expect(result.lightMinutes).toBe(180);
      expect(result.awakeMinutes).toBe(30);
      expect(result.efficiencyPct).toBeCloseTo(91.7);
      expect(result.isNap).toBe(false);
    });
  });

  describe("parseWorkout", () => {
    it("maps workout fields to cardio activity", () => {
      const result = parseWorkout(sampleWorkout);
      expect(result.externalId).toBe("1043");
      expect(result.activityType).toBe("running");
      expect(result.avgHeartRate).toBe(155);
      expect(result.maxHeartRate).toBe(185);
      expect(result.distanceMeters).toBe(10000);
      expect(result.totalElevationGain).toBeCloseTo(150.5);
      expect(result.calories).toBe(598); // 2500.5 kJ / 4.184
    });
  });

  describe("parseHeartRateValues", () => {
    it("converts WHOOP HR values to parsed records", () => {
      const values: WhoopHrValue[] = [
        { time: 1709251200000, data: 72 },
        { time: 1709251206000, data: 75 },
        { time: 1709251212000, data: 78 },
      ];
      const records = parseHeartRateValues(values);
      expect(records).toHaveLength(3);
      expect(records[0]!.heartRate).toBe(72);
      expect(records[0]!.recordedAt).toEqual(new Date(1709251200000));
      expect(records[2]!.heartRate).toBe(78);
    });
  });
});
