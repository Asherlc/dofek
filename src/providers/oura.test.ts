import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mapOuraActivityType,
  OuraClient,
  type OuraDailyActivity,
  type OuraDailyCardiovascularAge,
  type OuraDailyReadiness,
  type OuraDailyResilience,
  type OuraDailySpO2,
  type OuraDailyStress,
  type OuraEnhancedTag,
  type OuraHeartRate,
  OuraProvider,
  type OuraRestModePeriod,
  type OuraSession,
  type OuraSleepDocument,
  type OuraSleepTime,
  type OuraTag,
  type OuraVO2Max,
  type OuraWorkout,
  ouraOAuthConfig,
  parseOuraDailyMetrics,
  parseOuraSleep,
} from "./oura.ts";

// ============================================================
// Mock external dependencies (for sync tests)
// ============================================================

vi.mock("../db/sync-log.ts", () => ({
  withSyncLog: vi.fn(
    async (
      _db: unknown,
      _providerId: string,
      _dataType: string,
      fn: () => Promise<{ recordCount: number; result: unknown }>,
    ) => {
      const { result } = await fn();
      return result;
    },
  ),
}));

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: vi.fn(async () => "oura"),
  loadTokens: vi.fn(async () => ({
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "daily heartrate personal session spo2 workout tag",
  })),
  saveTokens: vi.fn(async () => {}),
}));

vi.mock("../auth/oauth.ts", () => ({
  exchangeCodeForTokens: vi.fn(async () => ({
    accessToken: "exchanged-token",
    refreshToken: "exchanged-refresh",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "daily",
  })),
  getOAuthRedirectUri: vi.fn(
    () => process.env.OAUTH_REDIRECT_URI_unencrypted ?? "https://dofek.example.com/callback",
  ),
  refreshAccessToken: vi.fn(async () => ({
    accessToken: "refreshed-token",
    refreshToken: "refreshed-refresh",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "daily",
  })),
}));

// ============================================================
// Mock DB (chainable insert pattern)
// ============================================================

function _createMockDb() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate, onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values });
  return { insert, values, onConflictDoUpdate, onConflictDoNothing };
}

// ============================================================
// Sample data factories (for sync tests)
// ============================================================

function _fakeSleepDoc(overrides: Partial<OuraSleepDocument> = {}): OuraSleepDocument {
  return {
    id: "sleep-001",
    day: "2026-03-01",
    bedtime_start: "2026-02-28T22:30:00+00:00",
    bedtime_end: "2026-03-01T06:45:00+00:00",
    total_sleep_duration: 28800,
    deep_sleep_duration: 5400,
    rem_sleep_duration: 5700,
    light_sleep_duration: 14400,
    awake_time: 3300,
    efficiency: 87,
    type: "long_sleep",
    average_heart_rate: 52,
    lowest_heart_rate: 45,
    average_hrv: 48,
    time_in_bed: 29700,
    readiness_score_delta: 2.5,
    latency: 900,
    ...overrides,
  };
}

function _fakeWorkout(overrides: Partial<OuraWorkout> = {}): OuraWorkout {
  return {
    id: "workout-001",
    activity: "running",
    calories: 350,
    day: "2026-03-01",
    distance: 5000,
    end_datetime: "2026-03-01T08:30:00+00:00",
    intensity: "moderate",
    label: "Morning Run",
    source: "confirmed",
    start_datetime: "2026-03-01T08:00:00+00:00",
    ...overrides,
  };
}

function _fakeSession(overrides: Partial<OuraSession> = {}): OuraSession {
  return {
    id: "session-001",
    day: "2026-03-01",
    start_datetime: "2026-03-01T07:00:00+00:00",
    end_datetime: "2026-03-01T07:15:00+00:00",
    type: "meditation",
    mood: "good",
    ...overrides,
  };
}

function _fakeHeartRate(overrides: Partial<OuraHeartRate> = {}): OuraHeartRate {
  return {
    bpm: 72,
    source: "awake",
    timestamp: "2026-03-01T10:00:00+00:00",
    ...overrides,
  };
}

function _fakeReadiness(overrides: Partial<OuraDailyReadiness> = {}): OuraDailyReadiness {
  return {
    id: "readiness-001",
    day: "2026-03-01",
    score: 82,
    temperature_deviation: -0.15,
    temperature_trend_deviation: 0.05,
    contributors: {
      resting_heart_rate: 85,
      hrv_balance: 78,
      body_temperature: 90,
      recovery_index: 72,
      sleep_balance: 80,
      previous_night: 88,
      previous_day_activity: 75,
      activity_balance: 82,
    },
    ...overrides,
  };
}

function _fakeActivity(overrides: Partial<OuraDailyActivity> = {}): OuraDailyActivity {
  return {
    id: "activity-001",
    day: "2026-03-01",
    steps: 9500,
    active_calories: 450,
    equivalent_walking_distance: 8200,
    high_activity_time: 2700,
    medium_activity_time: 1800,
    low_activity_time: 7200,
    resting_time: 50400,
    sedentary_time: 28800,
    total_calories: 2300,
    ...overrides,
  };
}

function _fakeSpO2(overrides: Partial<OuraDailySpO2> = {}): OuraDailySpO2 {
  return {
    id: "spo2-001",
    day: "2026-03-01",
    spo2_percentage: { average: 97.5 },
    breathing_disturbance_index: 12,
    ...overrides,
  };
}

function _fakeVO2Max(overrides: Partial<OuraVO2Max> = {}): OuraVO2Max {
  return {
    id: "vo2max-001",
    day: "2026-03-01",
    timestamp: "2026-03-01T08:00:00",
    vo2_max: 42.5,
    ...overrides,
  };
}

function _fakeStress(overrides: Partial<OuraDailyStress> = {}): OuraDailyStress {
  return {
    id: "stress-001",
    day: "2026-03-01",
    stress_high: 5400,
    recovery_high: 10800,
    day_summary: "restored",
    ...overrides,
  };
}

function _fakeResilience(overrides: Partial<OuraDailyResilience> = {}): OuraDailyResilience {
  return {
    id: "resilience-001",
    day: "2026-03-01",
    level: "solid",
    contributors: {
      sleep_recovery: 85,
      daytime_recovery: 72,
      stress: 68,
    },
    ...overrides,
  };
}

function _fakeCvAge(
  overrides: Partial<OuraDailyCardiovascularAge> = {},
): OuraDailyCardiovascularAge {
  return {
    day: "2026-03-01",
    vascular_age: 35,
    ...overrides,
  };
}

function _fakeTag(overrides: Partial<OuraTag> = {}): OuraTag {
  return {
    id: "tag-001",
    day: "2026-03-01",
    text: "caffeine",
    timestamp: "2026-03-01T09:00:00+00:00",
    tags: ["caffeine", "morning"],
    ...overrides,
  };
}

function _fakeEnhancedTag(overrides: Partial<OuraEnhancedTag> = {}): OuraEnhancedTag {
  return {
    id: "etag-001",
    tag_type_code: "caffeine",
    start_time: "2026-03-01T09:00:00+00:00",
    end_time: "2026-03-01T10:00:00+00:00",
    start_day: "2026-03-01",
    end_day: "2026-03-01",
    comment: null,
    custom_name: null,
    ...overrides,
  };
}

function _fakeRestMode(overrides: Partial<OuraRestModePeriod> = {}): OuraRestModePeriod {
  return {
    id: "rm-001",
    start_day: "2026-03-01",
    start_time: "2026-03-01T08:00:00+00:00",
    end_day: "2026-03-02",
    end_time: "2026-03-02T08:00:00+00:00",
    ...overrides,
  };
}

function _fakeSleepTime(overrides: Partial<OuraSleepTime> = {}): OuraSleepTime {
  return {
    id: "st-001",
    day: "2026-03-01",
    optimal_bedtime: {
      day_tz: -18000,
      end_offset: 3600,
      start_offset: 0,
    },
    recommendation: "follow_optimal_bedtime",
    status: "optimal_found",
    ...overrides,
  };
}

// ============================================================
// Helper: create a mock fetch that routes Oura API calls
// ============================================================

interface MockApiData {
  sleep?: OuraSleepDocument[];
  workouts?: OuraWorkout[];
  sessions?: OuraSession[];
  heartRate?: OuraHeartRate[];
  readiness?: OuraDailyReadiness[];
  dailyActivity?: OuraDailyActivity[];
  spo2?: OuraDailySpO2[];
  vo2max?: OuraVO2Max[];
  stress?: OuraDailyStress[];
  resilience?: OuraDailyResilience[];
  cvAge?: OuraDailyCardiovascularAge[];
  tags?: OuraTag[];
  enhancedTags?: OuraEnhancedTag[];
  restMode?: OuraRestModePeriod[];
  sleepTime?: OuraSleepTime[];
}

function _createMockApiFetch(data: MockApiData = {}): typeof globalThis.fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const urlStr = input.toString();

    // Sleep time must come before sleep check
    if (urlStr.includes("/v2/usercollection/sleep_time")) {
      return Response.json({ data: data.sleepTime ?? [], next_token: null });
    }
    if (urlStr.includes("/v2/usercollection/sleep")) {
      return Response.json({ data: data.sleep ?? [], next_token: null });
    }
    if (urlStr.includes("/v2/usercollection/workout")) {
      return Response.json({ data: data.workouts ?? [], next_token: null });
    }
    if (urlStr.includes("/v2/usercollection/session")) {
      return Response.json({ data: data.sessions ?? [], next_token: null });
    }
    if (urlStr.includes("/v2/usercollection/heartrate")) {
      return Response.json({ data: data.heartRate ?? [], next_token: null });
    }
    if (urlStr.includes("/v2/usercollection/daily_readiness")) {
      return Response.json({ data: data.readiness ?? [], next_token: null });
    }
    if (urlStr.includes("/v2/usercollection/daily_activity")) {
      return Response.json({ data: data.dailyActivity ?? [], next_token: null });
    }
    if (urlStr.includes("/v2/usercollection/daily_spo2")) {
      return Response.json({ data: data.spo2 ?? [], next_token: null });
    }
    if (urlStr.includes("/v2/usercollection/daily_stress")) {
      return Response.json({ data: data.stress ?? [], next_token: null });
    }
    if (urlStr.includes("/v2/usercollection/daily_resilience")) {
      return Response.json({ data: data.resilience ?? [], next_token: null });
    }
    if (urlStr.includes("/v2/usercollection/daily_cardiovascular_age")) {
      return Response.json({ data: data.cvAge ?? [], next_token: null });
    }
    if (urlStr.includes("/v2/usercollection/vO2_max")) {
      return Response.json({ data: data.vo2max ?? [], next_token: null });
    }
    // Enhanced tags must come before tags
    if (urlStr.includes("/v2/usercollection/enhanced_tag")) {
      return Response.json({ data: data.enhancedTags ?? [], next_token: null });
    }
    if (urlStr.includes("/v2/usercollection/tag")) {
      return Response.json({ data: data.tags ?? [], next_token: null });
    }
    if (urlStr.includes("/v2/usercollection/rest_mode_period")) {
      return Response.json({ data: data.restMode ?? [], next_token: null });
    }

    return new Response("Not found", { status: 404 });
  };
}

// ============================================================
// Sample API responses (Oura API v2 format)
// ============================================================

const sampleSleep: OuraSleepDocument = {
  id: "sleep-abc123",
  day: "2026-03-01",
  bedtime_start: "2026-02-28T22:30:00+00:00",
  bedtime_end: "2026-03-01T06:45:00+00:00",
  total_sleep_duration: 28800, // 480 min = 8h
  deep_sleep_duration: 5400, // 90 min
  rem_sleep_duration: 5700, // 95 min
  light_sleep_duration: 14400, // 240 min
  awake_time: 3300, // 55 min
  efficiency: 87,
  type: "long_sleep",
  average_heart_rate: 52,
  lowest_heart_rate: 45,
  average_hrv: 48,
  time_in_bed: 29700, // seconds
  readiness_score_delta: 2.5,
  latency: 900, // seconds
};

const sampleNap: OuraSleepDocument = {
  id: "sleep-nap456",
  day: "2026-03-01",
  bedtime_start: "2026-03-01T14:00:00+00:00",
  bedtime_end: "2026-03-01T14:30:00+00:00",
  total_sleep_duration: 1500,
  deep_sleep_duration: 0,
  rem_sleep_duration: 300,
  light_sleep_duration: 1200,
  awake_time: 300,
  efficiency: 80,
  type: "rest",
  average_heart_rate: 58,
  lowest_heart_rate: 52,
  average_hrv: 42,
  time_in_bed: 1800,
  readiness_score_delta: null,
  latency: 120,
};

const sampleSpO2: OuraDailySpO2 = {
  id: "spo2-abc123",
  day: "2026-03-01",
  spo2_percentage: { average: 97.5 },
  breathing_disturbance_index: 12,
};

const sampleVO2Max: OuraVO2Max = {
  id: "vo2max-abc123",
  day: "2026-03-01",
  timestamp: "2026-03-01T08:00:00",
  vo2_max: 42.5,
};

const sampleReadiness: OuraDailyReadiness = {
  id: "readiness-abc123",
  day: "2026-03-01",
  score: 82,
  temperature_deviation: -0.15,
  temperature_trend_deviation: 0.05,
  contributors: {
    resting_heart_rate: 85,
    hrv_balance: 78,
    body_temperature: 90,
    recovery_index: 72,
    sleep_balance: 80,
    previous_night: 88,
    previous_day_activity: 75,
    activity_balance: 82,
  },
};

const sampleActivity: OuraDailyActivity = {
  id: "activity-abc123",
  day: "2026-03-01",
  steps: 9500,
  active_calories: 450,
  equivalent_walking_distance: 8200,
  high_activity_time: 2700,
  medium_activity_time: 1800,
  low_activity_time: 7200,
  resting_time: 50400,
  sedentary_time: 28800,
  total_calories: 2300,
};

const sampleStress: OuraDailyStress = {
  id: "stress-abc123",
  day: "2026-03-01",
  stress_high: 5400, // 90 min in seconds
  recovery_high: 10800, // 180 min in seconds
  day_summary: "restored",
};

const sampleResilience: OuraDailyResilience = {
  id: "resilience-abc123",
  day: "2026-03-01",
  level: "solid",
  contributors: {
    sleep_recovery: 85,
    daytime_recovery: 72,
    stress: 68,
  },
};

// ============================================================
// Parsing tests
// ============================================================

describe("Oura Provider", () => {
  describe("parseOuraSleep", () => {
    it("maps sleep fields correctly", () => {
      const result = parseOuraSleep(sampleSleep);

      expect(result.externalId).toBe("sleep-abc123");
      expect(result.startedAt).toEqual(new Date("2026-02-28T22:30:00+00:00"));
      expect(result.endedAt).toEqual(new Date("2026-03-01T06:45:00+00:00"));
      expect(result.durationMinutes).toBe(480);
      expect(result.deepMinutes).toBe(90);
      expect(result.remMinutes).toBe(95);
      expect(result.lightMinutes).toBe(240);
      expect(result.awakeMinutes).toBe(55);
      expect(result.efficiencyPct).toBe(87);
      expect(result.isNap).toBe(false);
    });

    it("identifies naps from rest type", () => {
      const result = parseOuraSleep(sampleNap);

      expect(result.isNap).toBe(true);
      expect(result.durationMinutes).toBe(25);
      expect(result.lightMinutes).toBe(20);
    });

    it("identifies late_nap as nap", () => {
      const lateNap: OuraSleepDocument = { ...sampleSleep, type: "late_nap" };
      const result = parseOuraSleep(lateNap);
      expect(result.isNap).toBe(true);
    });

    it("identifies sleep type as non-nap", () => {
      const sleepType: OuraSleepDocument = { ...sampleSleep, type: "sleep" };
      const result = parseOuraSleep(sleepType);
      expect(result.isNap).toBe(false);
    });

    it("handles missing optional duration fields", () => {
      const minimal: OuraSleepDocument = {
        ...sampleSleep,
        total_sleep_duration: null,
        deep_sleep_duration: null,
        rem_sleep_duration: null,
        light_sleep_duration: null,
        awake_time: null,
      };

      const result = parseOuraSleep(minimal);

      expect(result.deepMinutes).toBeUndefined();
      expect(result.remMinutes).toBeUndefined();
      expect(result.lightMinutes).toBeUndefined();
      expect(result.awakeMinutes).toBeUndefined();
      expect(result.durationMinutes).toBeUndefined();
    });

    it("rounds seconds to nearest minute", () => {
      const oddDurations: OuraSleepDocument = {
        ...sampleSleep,
        total_sleep_duration: 1850, // 30.83 min → 31
        deep_sleep_duration: 95, // 1.58 min → 2
      };
      const result = parseOuraSleep(oddDurations);
      expect(result.durationMinutes).toBe(31);
      expect(result.deepMinutes).toBe(2);
    });
  });

  describe("parseOuraDailyMetrics", () => {
    it("maps daily readiness and activity fields", () => {
      const result = parseOuraDailyMetrics(sampleReadiness, sampleActivity, null, null, null, null);

      expect(result.date).toBe("2026-03-01");
      expect(result.steps).toBe(9500);
      expect(result.activeEnergyKcal).toBe(450);
      expect(result.hrv).toBe(78);
      expect(result.restingHr).toBe(85);
      expect(result.exerciseMinutes).toBe(75);
      expect(result.skinTempC).toBe(-0.15);
    });

    it("includes SpO2 when provided", () => {
      const result = parseOuraDailyMetrics(
        sampleReadiness,
        sampleActivity,
        sampleSpO2,
        null,
        null,
        null,
      );

      expect(result.spo2Avg).toBe(97.5);
    });

    it("includes VO2 max when provided", () => {
      const result = parseOuraDailyMetrics(
        sampleReadiness,
        sampleActivity,
        null,
        sampleVO2Max,
        null,
        null,
      );

      expect(result.vo2max).toBe(42.5);
    });

    it("includes both SpO2 and VO2 max", () => {
      const result = parseOuraDailyMetrics(
        sampleReadiness,
        sampleActivity,
        sampleSpO2,
        sampleVO2Max,
        null,
        null,
      );

      expect(result.spo2Avg).toBe(97.5);
      expect(result.vo2max).toBe(42.5);
    });

    it("handles null spo2_percentage", () => {
      const noPercentage: OuraDailySpO2 = { ...sampleSpO2, spo2_percentage: null };
      const result = parseOuraDailyMetrics(null, null, noPercentage, null, null, null);
      expect(result.spo2Avg).toBeUndefined();
    });

    it("handles null vo2_max value", () => {
      const noValue: OuraVO2Max = { ...sampleVO2Max, vo2_max: null };
      const result = parseOuraDailyMetrics(null, null, null, noValue, null, null);
      expect(result.vo2max).toBeUndefined();
    });

    it("handles null readiness", () => {
      const result = parseOuraDailyMetrics(null, sampleActivity, null, null, null, null);

      expect(result.steps).toBe(9500);
      expect(result.activeEnergyKcal).toBe(450);
      expect(result.hrv).toBeUndefined();
      expect(result.restingHr).toBeUndefined();
      expect(result.skinTempC).toBeUndefined();
    });

    it("handles null activity", () => {
      const result = parseOuraDailyMetrics(sampleReadiness, null, null, null, null, null);

      expect(result.steps).toBeUndefined();
      expect(result.activeEnergyKcal).toBeUndefined();
      expect(result.exerciseMinutes).toBeUndefined();
      expect(result.hrv).toBe(78);
      expect(result.restingHr).toBe(85);
    });

    it("handles null contributors in readiness", () => {
      const noContributors: OuraDailyReadiness = {
        ...sampleReadiness,
        contributors: {
          resting_heart_rate: null,
          hrv_balance: null,
          body_temperature: null,
          recovery_index: null,
          sleep_balance: null,
          previous_night: null,
          previous_day_activity: null,
          activity_balance: null,
        },
      };

      const result = parseOuraDailyMetrics(noContributors, sampleActivity, null, null, null, null);
      expect(result.hrv).toBeUndefined();
      expect(result.restingHr).toBeUndefined();
    });

    it("uses activity day when readiness is null", () => {
      const result = parseOuraDailyMetrics(null, sampleActivity, null, null, null, null);
      expect(result.date).toBe("2026-03-01");
    });

    it("returns empty date when all are null", () => {
      const result = parseOuraDailyMetrics(null, null, null, null, null, null);
      expect(result.date).toBe("");
    });

    it("uses spo2 day when readiness and activity are null", () => {
      const result = parseOuraDailyMetrics(null, null, sampleSpO2, null, null, null);
      expect(result.date).toBe("2026-03-01");
    });

    it("uses vo2max day when others are null", () => {
      const result = parseOuraDailyMetrics(null, null, null, sampleVO2Max, null, null);
      expect(result.date).toBe("2026-03-01");
    });

    it("rounds exercise minutes from seconds", () => {
      const activity: OuraDailyActivity = {
        ...sampleActivity,
        high_activity_time: 100, // 1.67 min
        medium_activity_time: 100, // 1.67 min
      };
      const result = parseOuraDailyMetrics(null, activity, null, null, null, null);
      expect(result.exerciseMinutes).toBe(3); // Math.round(200/60)
    });

    it("includes stress data when provided", () => {
      const result = parseOuraDailyMetrics(
        sampleReadiness,
        sampleActivity,
        null,
        null,
        sampleStress,
        null,
      );
      expect(result.stressHighMinutes).toBe(90);
      expect(result.recoveryHighMinutes).toBe(180);
    });

    it("includes resilience level when provided", () => {
      const result = parseOuraDailyMetrics(
        sampleReadiness,
        sampleActivity,
        null,
        null,
        null,
        sampleResilience,
      );
      expect(result.resilienceLevel).toBe("solid");
    });

    it("handles null stress fields", () => {
      const nullStress: OuraDailyStress = {
        ...sampleStress,
        stress_high: null,
        recovery_high: null,
      };
      const result = parseOuraDailyMetrics(null, null, null, null, nullStress, null);
      expect(result.stressHighMinutes).toBeUndefined();
      expect(result.recoveryHighMinutes).toBeUndefined();
    });

    it("handles null stress and resilience", () => {
      const result = parseOuraDailyMetrics(sampleReadiness, sampleActivity, null, null, null, null);
      expect(result.stressHighMinutes).toBeUndefined();
      expect(result.recoveryHighMinutes).toBeUndefined();
      expect(result.resilienceLevel).toBeUndefined();
    });

    it("uses stress day when others are null", () => {
      const result = parseOuraDailyMetrics(null, null, null, null, sampleStress, null);
      expect(result.date).toBe("2026-03-01");
    });

    it("uses resilience day when others are null", () => {
      const result = parseOuraDailyMetrics(null, null, null, null, null, sampleResilience);
      expect(result.date).toBe("2026-03-01");
    });
  });
});

// ============================================================
// OAuth config tests
// ============================================================

describe("ouraOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when OURA_CLIENT_ID is not set", () => {
    delete process.env.OURA_CLIENT_ID;
    delete process.env.OURA_CLIENT_SECRET;
    expect(ouraOAuthConfig()).toBeNull();
  });

  it("returns null when OURA_CLIENT_SECRET is not set", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    delete process.env.OURA_CLIENT_SECRET;
    expect(ouraOAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
    const config = ouraOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toContain("daily");
    expect(config?.authorizeUrl).toContain("cloud.ouraring.com");
    expect(config?.tokenUrl).toContain("api.ouraring.com");
  });

  it("uses custom OAUTH_REDIRECT_URI_unencrypted when set", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI_unencrypted = "https://example.com/callback";
    const config = ouraOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when not set", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI_unencrypted;
    const config = ouraOAuthConfig();
    expect(config?.redirectUri).toContain("dofek");
  });
});

// ============================================================
// Provider validate/authSetup tests
// ============================================================

describe("OuraProvider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when OURA_CLIENT_ID is missing", () => {
    delete process.env.OURA_CLIENT_ID;
    delete process.env.OURA_CLIENT_SECRET;
    const provider = new OuraProvider();
    expect(provider.validate()).toContain("OURA_CLIENT_ID");
  });

  it("returns error when OURA_CLIENT_SECRET is missing", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    delete process.env.OURA_CLIENT_SECRET;
    const provider = new OuraProvider();
    expect(provider.validate()).toContain("OURA_CLIENT_SECRET");
  });

  it("returns null when both OAuth vars are set", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
    const provider = new OuraProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("OuraProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
    const provider = new OuraProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("ouraring.com");
  });

  it("throws when env vars are missing", () => {
    delete process.env.OURA_CLIENT_ID;
    delete process.env.OURA_CLIENT_SECRET;
    const provider = new OuraProvider();
    expect(() => provider.authSetup()).toThrow("OURA_CLIENT_ID");
  });
});

describe("OuraProvider properties", () => {
  it("has correct id and name", () => {
    const provider = new OuraProvider();
    expect(provider.id).toBe("oura");
    expect(provider.name).toBe("Oura");
  });
});

// ============================================================
// OuraClient tests
// ============================================================

describe("OuraClient", () => {
  it("throws on non-OK response for sleep", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    };

    const client = new OuraClient("bad-token", mockFetch);
    await expect(client.getSleep("2026-03-01", "2026-03-02")).rejects.toThrow(
      "Oura API error (401)",
    );
  });

  it("fetches sleep data with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [sampleSleep], next_token: null });
    };

    const client = new OuraClient("test-token", mockFetch);
    const result = await client.getSleep("2026-03-01", "2026-03-02");

    expect(capturedUrl).toContain("/v2/usercollection/sleep");
    expect(capturedUrl).toContain("start_date=2026-03-01");
    expect(capturedUrl).toContain("end_date=2026-03-02");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe("sleep-abc123");
  });

  it("passes next_token for pagination", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    };

    const client = new OuraClient("test-token", mockFetch);
    await client.getSleep("2026-03-01", "2026-03-02", "page2token");

    expect(capturedUrl).toContain("next_token=page2token");
  });

  it("sends Authorization header with Bearer token", async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch: typeof globalThis.fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {}));
      return Response.json({ data: [], next_token: null });
    };

    const client = new OuraClient("my-secret-token", mockFetch);
    await client.getSleep("2026-03-01", "2026-03-02");

    expect(capturedHeaders.Authorization).toBe("Bearer my-secret-token");
  });

  it("includes error response body in error message", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Invalid API key provided", { status: 403 });
    };

    const client = new OuraClient("bad-token", mockFetch);
    await expect(client.getSleep("2026-03-01", "2026-03-02")).rejects.toThrow(
      "Invalid API key provided",
    );
  });

  it("fetches daily SpO2 data successfully", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [sampleSpO2], next_token: null });
    };

    const client = new OuraClient("test-token", mockFetch);
    const result = await client.getDailySpO2("2026-03-01", "2026-03-02");

    expect(capturedUrl).toContain("/v2/usercollection/daily_spo2");
    expect(capturedUrl).toContain("start_date=2026-03-01");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.spo2_percentage?.average).toBe(97.5);
  });

  it("passes next_token for SpO2 pagination", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    };

    const client = new OuraClient("test-token", mockFetch);
    await client.getDailySpO2("2026-03-01", "2026-03-02", "spo2page");

    expect(capturedUrl).toContain("next_token=spo2page");
  });

  it("throws on non-OK response for SpO2", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Forbidden", { status: 403 });
    };

    const client = new OuraClient("token", mockFetch);
    await expect(client.getDailySpO2("2026-03-01", "2026-03-02")).rejects.toThrow(
      "Oura API error (403)",
    );
  });

  it("fetches VO2 max data successfully", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [sampleVO2Max], next_token: null });
    };

    const client = new OuraClient("test-token", mockFetch);
    const result = await client.getVO2Max("2026-03-01", "2026-03-02");

    expect(capturedUrl).toContain("/v2/usercollection/vO2_max");
    expect(capturedUrl).toContain("start_date=2026-03-01");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.vo2_max).toBe(42.5);
  });

  it("passes next_token for VO2 max pagination", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    };

    const client = new OuraClient("test-token", mockFetch);
    await client.getVO2Max("2026-03-01", "2026-03-02", "vo2page");

    expect(capturedUrl).toContain("next_token=vo2page");
  });

  it("throws on non-OK response for VO2 max", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Server Error", { status: 500 });
    };

    const client = new OuraClient("token", mockFetch);
    await expect(client.getVO2Max("2026-03-01", "2026-03-02")).rejects.toThrow(
      "Oura API error (500)",
    );
  });

  it("fetches workouts with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    };

    const client = new OuraClient("test-token", mockFetch);
    await client.getWorkouts("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/workout");
    expect(capturedUrl).toContain("start_date=2026-03-01");
  });

  it("fetches heart rate with datetime params", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [] });
    };

    const client = new OuraClient("test-token", mockFetch);
    await client.getHeartRate("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/heartrate");
    expect(capturedUrl).toContain("start_datetime=2026-03-01T00:00:00");
    expect(capturedUrl).toContain("end_datetime=2026-03-02T23:59:59");
  });

  it("fetches sessions with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    };

    const client = new OuraClient("test-token", mockFetch);
    await client.getSessions("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/session");
  });

  it("fetches daily stress with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    };

    const client = new OuraClient("test-token", mockFetch);
    await client.getDailyStress("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/daily_stress");
  });

  it("fetches daily resilience with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    };

    const client = new OuraClient("test-token", mockFetch);
    await client.getDailyResilience("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/daily_resilience");
  });

  it("fetches cardiovascular age with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    };

    const client = new OuraClient("test-token", mockFetch);
    await client.getDailyCardiovascularAge("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/daily_cardiovascular_age");
  });

  it("fetches tags with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    };

    const client = new OuraClient("test-token", mockFetch);
    await client.getTags("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/tag");
  });

  it("fetches enhanced tags with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    };

    const client = new OuraClient("test-token", mockFetch);
    await client.getEnhancedTags("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/enhanced_tag");
  });

  it("fetches rest mode periods with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    };

    const client = new OuraClient("test-token", mockFetch);
    await client.getRestModePeriods("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/rest_mode_period");
  });

  it("fetches sleep time with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    };

    const client = new OuraClient("test-token", mockFetch);
    await client.getSleepTime("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/sleep_time");
  });
});

// ============================================================
// Activity type mapping tests
// ============================================================

describe("mapOuraActivityType", () => {
  it("maps known activity types", () => {
    expect(mapOuraActivityType("walking")).toBe("walking");
    expect(mapOuraActivityType("running")).toBe("running");
    expect(mapOuraActivityType("cycling")).toBe("cycling");
    expect(mapOuraActivityType("swimming")).toBe("swimming");
    expect(mapOuraActivityType("strength_training")).toBe("strength");
  });

  it("handles case-insensitive input", () => {
    expect(mapOuraActivityType("Walking")).toBe("walking");
    expect(mapOuraActivityType("RUNNING")).toBe("running");
  });

  it("passes through unknown types lowercase", () => {
    expect(mapOuraActivityType("kickboxing")).toBe("kickboxing");
    expect(mapOuraActivityType("CrossFit")).toBe("crossfit");
  });
});
