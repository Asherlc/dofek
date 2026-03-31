import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import { logger } from "../logger.ts";
import {
  fetchAllPagesOptional,
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

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ============================================================
// Mock DB (chainable insert pattern)
// ============================================================

function createMockDb() {
  const chain = {
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
  };

  // Make each chain method return the chain for fluent chaining
  for (const fn of Object.values(chain)) {
    fn.mockReturnValue(chain);
  }

  const insertFn = vi.fn().mockReturnValue(chain);

  const db: SyncDatabase = {
    select: vi.fn(),
    insert: insertFn,
    delete: vi.fn(),
    execute: vi.fn(),
  };

  return Object.assign(db, chain);
}

const recordSchema = z.record(z.string(), z.unknown());
const recordArraySchema = z.array(recordSchema);

/**
 * Finds a mock call argument matching a predicate and returns it as a record.
 * Uses Zod parsing instead of `as` casts (per lint rules).
 */
function findValuesCall(
  db: ReturnType<typeof createMockDb>,
  predicate: (val: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  for (const c of db.values.mock.calls) {
    const parsed = recordSchema.safeParse(c[0]);
    if (parsed.success && predicate(parsed.data)) return parsed.data;
  }
  throw new Error("No matching values call found");
}

/**
 * Finds a mock call argument matching a predicate, where the argument is an array.
 * Returns the array of records.
 */
function findBatchValuesCall(
  db: ReturnType<typeof createMockDb>,
  predicate: (val: Array<Record<string, unknown>>) => boolean,
): Array<Record<string, unknown>> {
  for (const c of db.values.mock.calls) {
    const parsed = recordArraySchema.safeParse(c[0]);
    if (parsed.success && predicate(parsed.data)) return parsed.data;
  }
  throw new Error("No matching batch values call found");
}

/**
 * Filters mock call arguments matching a predicate and returns all matching records.
 */
function filterValuesCalls(
  db: ReturnType<typeof createMockDb>,
  predicate: (val: Record<string, unknown>) => boolean,
): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  for (const c of db.values.mock.calls) {
    const parsed = recordSchema.safeParse(c[0]);
    if (parsed.success && predicate(parsed.data)) results.push(parsed.data);
  }
  return results;
}

// ============================================================
// Sample data factories (for sync tests)
// ============================================================

function fakeSleepDoc(overrides: Partial<OuraSleepDocument> = {}): OuraSleepDocument {
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

function fakeWorkout(overrides: Partial<OuraWorkout> = {}): OuraWorkout {
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

function fakeSession(overrides: Partial<OuraSession> = {}): OuraSession {
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

function fakeHeartRate(overrides: Partial<OuraHeartRate> = {}): OuraHeartRate {
  return {
    bpm: 72,
    source: "awake",
    timestamp: "2026-03-01T10:00:00+00:00",
    ...overrides,
  };
}

function fakeReadiness(overrides: Partial<OuraDailyReadiness> = {}): OuraDailyReadiness {
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

function fakeActivity(overrides: Partial<OuraDailyActivity> = {}): OuraDailyActivity {
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

function fakeSpO2(overrides: Partial<OuraDailySpO2> = {}): OuraDailySpO2 {
  return {
    id: "spo2-001",
    day: "2026-03-01",
    spo2_percentage: { average: 97.5 },
    breathing_disturbance_index: 12,
    ...overrides,
  };
}

function fakeVO2Max(overrides: Partial<OuraVO2Max> = {}): OuraVO2Max {
  return {
    id: "vo2max-001",
    day: "2026-03-01",
    timestamp: "2026-03-01T08:00:00",
    vo2_max: 42.5,
    ...overrides,
  };
}

function fakeStress(overrides: Partial<OuraDailyStress> = {}): OuraDailyStress {
  return {
    id: "stress-001",
    day: "2026-03-01",
    stress_high: 5400,
    recovery_high: 10800,
    day_summary: "restored",
    ...overrides,
  };
}

function fakeResilience(overrides: Partial<OuraDailyResilience> = {}): OuraDailyResilience {
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

function fakeCvAge(
  overrides: Partial<OuraDailyCardiovascularAge> = {},
): OuraDailyCardiovascularAge {
  return {
    day: "2026-03-01",
    vascular_age: 35,
    ...overrides,
  };
}

function fakeTag(overrides: Partial<OuraTag> = {}): OuraTag {
  return {
    id: "tag-001",
    day: "2026-03-01",
    text: "caffeine",
    timestamp: "2026-03-01T09:00:00+00:00",
    tags: ["caffeine", "morning"],
    ...overrides,
  };
}

function fakeEnhancedTag(overrides: Partial<OuraEnhancedTag> = {}): OuraEnhancedTag {
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

function fakeRestMode(overrides: Partial<OuraRestModePeriod> = {}): OuraRestModePeriod {
  return {
    id: "rm-001",
    start_day: "2026-03-01",
    start_time: "2026-03-01T08:00:00+00:00",
    end_day: "2026-03-02",
    end_time: "2026-03-02T08:00:00+00:00",
    ...overrides,
  };
}

function fakeSleepTime(overrides: Partial<OuraSleepTime> = {}): OuraSleepTime {
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

function createMockApiFetch(data: MockApiData = {}): typeof globalThis.fetch {
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

    it("rounds 30 seconds up to 1 minute", () => {
      const s: OuraSleepDocument = { ...sampleSleep, total_sleep_duration: 30 };
      expect(parseOuraSleep(s).durationMinutes).toBe(1);
    });

    it("rounds 29 seconds down to 0 minutes", () => {
      const s: OuraSleepDocument = { ...sampleSleep, total_sleep_duration: 29 };
      expect(parseOuraSleep(s).durationMinutes).toBe(0);
    });
  });

  describe("parseOuraDailyMetrics", () => {
    it("uses sleep average_hrv and lowest_heart_rate instead of readiness contributor scores", () => {
      const result = parseOuraDailyMetrics(
        sampleReadiness,
        sampleActivity,
        null,
        null,
        null,
        null,
        sampleSleep,
      );

      // HRV should be the actual measurement from sleep (48 ms), NOT the
      // readiness contributor score (78 = "how much HRV contributes to readiness")
      expect(result.hrv).toBe(48);
      // Resting HR should be from sleep (45 bpm), NOT the contributor score (85)
      expect(result.restingHr).toBe(45);
    });

    it("maps daily readiness and activity fields", () => {
      const result = parseOuraDailyMetrics(
        sampleReadiness,
        sampleActivity,
        null,
        null,
        null,
        null,
        sampleSleep,
      );

      expect(result.date).toBe("2026-03-01");
      expect(result.steps).toBe(9500);
      expect(result.activeEnergyKcal).toBe(450);
      expect(result.hrv).toBe(48);
      expect(result.restingHr).toBe(45);
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
        null,
      );

      expect(result.spo2Avg).toBe(97.5);
      expect(result.vo2max).toBe(42.5);
    });

    it("handles null spo2_percentage", () => {
      const noPercentage: OuraDailySpO2 = { ...sampleSpO2, spo2_percentage: null };
      const result = parseOuraDailyMetrics(null, null, noPercentage, null, null, null, null);
      expect(result.spo2Avg).toBeUndefined();
    });

    it("handles null vo2_max value", () => {
      const noValue: OuraVO2Max = { ...sampleVO2Max, vo2_max: null };
      const result = parseOuraDailyMetrics(null, null, null, noValue, null, null, null);
      expect(result.vo2max).toBeUndefined();
    });

    it("returns undefined hrv and restingHr when no sleep data", () => {
      const result = parseOuraDailyMetrics(
        sampleReadiness,
        sampleActivity,
        null,
        null,
        null,
        null,
        null,
      );

      expect(result.hrv).toBeUndefined();
      expect(result.restingHr).toBeUndefined();
    });

    it("handles null activity", () => {
      const result = parseOuraDailyMetrics(
        sampleReadiness,
        null,
        null,
        null,
        null,
        null,
        sampleSleep,
      );

      expect(result.steps).toBeUndefined();
      expect(result.activeEnergyKcal).toBeUndefined();
      expect(result.exerciseMinutes).toBeUndefined();
      expect(result.hrv).toBe(48);
      expect(result.restingHr).toBe(45);
    });

    it("handles null hrv in sleep", () => {
      const noHrv: OuraSleepDocument = {
        ...sampleSleep,
        average_hrv: null,
        lowest_heart_rate: null,
      };
      const result = parseOuraDailyMetrics(
        sampleReadiness,
        sampleActivity,
        null,
        null,
        null,
        null,
        noHrv,
      );
      expect(result.hrv).toBeUndefined();
      expect(result.restingHr).toBeUndefined();
    });

    it("uses activity day when readiness is null", () => {
      const result = parseOuraDailyMetrics(null, sampleActivity, null, null, null, null, null);
      expect(result.date).toBe("2026-03-01");
    });

    it("returns empty date when all are null", () => {
      const result = parseOuraDailyMetrics(null, null, null, null, null, null, null);
      expect(result.date).toBe("");
    });

    it("uses spo2 day when readiness and activity are null", () => {
      const result = parseOuraDailyMetrics(null, null, sampleSpO2, null, null, null, null);
      expect(result.date).toBe("2026-03-01");
    });

    it("uses vo2max day when others are null", () => {
      const result = parseOuraDailyMetrics(null, null, null, sampleVO2Max, null, null, null);
      expect(result.date).toBe("2026-03-01");
    });

    it("rounds exercise minutes from seconds", () => {
      const activity: OuraDailyActivity = {
        ...sampleActivity,
        high_activity_time: 100, // 1.67 min
        medium_activity_time: 100, // 1.67 min
      };
      const result = parseOuraDailyMetrics(null, activity, null, null, null, null, null);
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
        null,
      );
      expect(result.resilienceLevel).toBe("solid");
    });

    it("handles null stress fields", () => {
      const nullStress: OuraDailyStress = {
        ...sampleStress,
        stress_high: null,
        recovery_high: null,
      };
      const result = parseOuraDailyMetrics(null, null, null, null, nullStress, null, null);
      expect(result.stressHighMinutes).toBeUndefined();
      expect(result.recoveryHighMinutes).toBeUndefined();
    });

    it("handles null stress and resilience", () => {
      const result = parseOuraDailyMetrics(
        sampleReadiness,
        sampleActivity,
        null,
        null,
        null,
        null,
        null,
      );
      expect(result.stressHighMinutes).toBeUndefined();
      expect(result.recoveryHighMinutes).toBeUndefined();
      expect(result.resilienceLevel).toBeUndefined();
    });

    it("uses stress day when others are null", () => {
      const result = parseOuraDailyMetrics(null, null, null, null, sampleStress, null, null);
      expect(result.date).toBe("2026-03-01");
    });

    it("uses resilience day when others are null", () => {
      const result = parseOuraDailyMetrics(null, null, null, null, null, sampleResilience, null);
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

describe("OuraProvider.getUserIdentity()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns identity from personal_info API", async () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({
        id: "abc-123",
        email: "ring@test.com",
        age: 30,
      });
    };

    const provider = new OuraProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");
    const identity = await setup.getUserIdentity("test-token");
    expect(identity.providerAccountId).toBe("abc-123");
    expect(identity.email).toBe("ring@test.com");
    expect(identity.name).toBeNull();
  });

  it("handles missing email", async () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({ id: "xyz-456" });
    };

    const provider = new OuraProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");
    const identity = await setup.getUserIdentity("test-token");
    expect(identity.providerAccountId).toBe("xyz-456");
    expect(identity.email).toBeNull();
    expect(identity.name).toBeNull();
  });

  it("throws on API error", async () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Forbidden", { status: 403 });
    };

    const provider = new OuraProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");
    await expect(setup.getUserIdentity("bad-token")).rejects.toThrow(
      "Oura personal info API error (403)",
    );
  });

  it("includes email scope in OAuth config", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";

    const provider = new OuraProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.scopes).toContain("email");
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
    await expect(client.getSleep("2026-03-01", "2026-03-02")).rejects.toThrow("API error 401");
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
    await expect(client.getDailySpO2("2026-03-01", "2026-03-02")).rejects.toThrow("API error 403");
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
    await expect(client.getVO2Max("2026-03-01", "2026-03-02")).rejects.toThrow("API error 500");
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

  it("returns other for unknown types", () => {
    expect(mapOuraActivityType("kickboxing")).toBe("other");
    expect(mapOuraActivityType("CrossFit")).toBe("other");
  });
});

// ============================================================
// Sync tests
// ============================================================

describe("OuraProvider.sync()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function setupEnv() {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
  }

  it("syncs sleep sessions", async () => {
    setupEnv();
    const sleep = fakeSleepDoc();
    const mockFetch = createMockApiFetch({ sleep: [sleep] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    // Sleep phase produces 1 record + daily_metrics phase produces 0 (no readiness/activity/etc.)
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    // Verify values were passed with correct sleep data
    const sleepValues = findValuesCall(
      db,
      (v) => v.externalId === "sleep-001" && v.providerId === "oura",
    );
    expect(sleepValues.durationMinutes).toBe(480);
    expect(sleepValues.deepMinutes).toBe(90);
    expect(sleepValues.remMinutes).toBe(95);
    expect(sleepValues.lightMinutes).toBe(240);
    expect(sleepValues.awakeMinutes).toBe(55);
    expect(sleepValues.efficiencyPct).toBe(87);
    expect(sleepValues.sleepType).toBe("long_sleep");
    expect(sleepValues.startedAt).toEqual(new Date("2026-02-28T22:30:00+00:00"));
    expect(sleepValues.endedAt).toEqual(new Date("2026-03-01T06:45:00+00:00"));
  });

  it("syncs workouts to activity table", async () => {
    setupEnv();
    const workout = fakeWorkout();
    const mockFetch = createMockApiFetch({ workouts: [workout] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    // Verify workout values
    const val = findValuesCall(
      db,
      (v) => v.externalId === "workout-001" && v.activityType === "running",
    );
    expect(val.providerId).toBe("oura");
    expect(val.name).toBe("Morning Run");
    expect(val.startedAt).toEqual(new Date("2026-03-01T08:00:00+00:00"));
    expect(val.endedAt).toEqual(new Date("2026-03-01T08:30:00+00:00"));
    expect(val.raw).toEqual(workout);
  });

  it("syncs sessions to activity table", async () => {
    setupEnv();
    const session = fakeSession();
    const mockFetch = createMockApiFetch({ sessions: [session] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    const val = findValuesCall(
      db,
      (v) => v.externalId === "session-001" && v.activityType === "meditation",
    );
    expect(val.providerId).toBe("oura");
    expect(val.name).toBe("meditation");
    expect(val.startedAt).toEqual(new Date("2026-03-01T07:00:00+00:00"));
    expect(val.endedAt).toEqual(new Date("2026-03-01T07:15:00+00:00"));
    expect(val.raw).toEqual(session);
  });

  it("syncs heart rate data", async () => {
    setupEnv();
    // Pin Date.now() within a single 30-day window of the since date
    // to avoid the mock returning duplicate HR data across multiple windows.
    vi.useFakeTimers({ now: new Date("2026-03-15T12:00:00Z") });
    const hr1 = fakeHeartRate({ bpm: 72, timestamp: "2026-03-01T10:00:00+00:00" });
    const hr2 = fakeHeartRate({ bpm: 85, timestamp: "2026-03-01T10:05:00+00:00" });
    const mockFetch = createMockApiFetch({ heartRate: [hr1, hr2] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(db, new Date("2026-03-01"));
    vi.useRealTimers();

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(2);

    // Verify HR values are batched
    const hrRows = findBatchValuesCall(db, (arr) => arr.length === 2 && arr[0]?.heartRate === 72);
    expect(hrRows[0]?.heartRate).toBe(72);
    expect(hrRows[0]?.providerId).toBe("oura");
    expect(hrRows[0]?.recordedAt).toEqual(new Date("2026-03-01T10:00:00+00:00"));
    expect(hrRows[1]?.heartRate).toBe(85);
    expect(hrRows[1]?.recordedAt).toEqual(new Date("2026-03-01T10:05:00+00:00"));

    // HR uses onConflictDoNothing, not onConflictDoUpdate
    expect(db.onConflictDoNothing).toHaveBeenCalled();
  });

  it("chunks heart rate fetches into 30-day windows", async () => {
    setupEnv();
    const hr1 = fakeHeartRate({ bpm: 72, timestamp: "2026-01-15T10:00:00+00:00" });
    const hr2 = fakeHeartRate({ bpm: 85, timestamp: "2026-02-15T10:00:00+00:00" });
    const hr3 = fakeHeartRate({ bpm: 78, timestamp: "2026-03-15T10:00:00+00:00" });

    // Track which date ranges are requested
    const requestedRanges: Array<{ start: string; end: string }> = [];
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = input.toString();
      if (urlStr.includes("/v2/usercollection/heartrate")) {
        const startMatch = urlStr.match(/start_datetime=([^&]+)/);
        const endMatch = urlStr.match(/end_datetime=([^&]+)/);
        if (startMatch?.[1] && endMatch?.[1]) {
          requestedRanges.push({ start: startMatch[1], end: endMatch[1] });
        }
        // Return HR data matching the requested period
        const data = [];
        if (startMatch?.[1]?.startsWith("2026-01")) data.push(hr1);
        if (startMatch?.[1]?.startsWith("2026-02")) data.push(hr2);
        if (startMatch?.[1]?.startsWith("2026-03")) data.push(hr3);
        return Response.json({ data, next_token: null });
      }
      return createMockApiFetch({ heartRate: [hr1, hr2, hr3] })(input);
    };

    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    // Sync from Jan 1 to Apr 30 (4 months, > 30 days)
    const result = await provider.sync(db, new Date("2026-01-01"));

    expect(result.errors).toHaveLength(0);
    // Should make multiple requests for HR due to 30-day window limit
    expect(requestedRanges.length).toBeGreaterThan(1);
    // Each window should be at most 30 days apart
    for (const range of requestedRanges) {
      const start = new Date(`${range.start}Z`).getTime();
      const end = new Date(`${range.end}Z`).getTime();
      const diff = (end - start) / (1000 * 60 * 60 * 24);
      expect(diff).toBeLessThanOrEqual(31); // Allow 1 day margin
    }
  });

  it("syncs daily stress", async () => {
    setupEnv();
    const stress = fakeStress();
    const mockFetch = createMockApiFetch({ stress: [stress] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    // Stress is batched as an array in the values call
    const stressRows = findBatchValuesCall(db, (arr) =>
      arr.some((v) => v.type === "oura_daily_stress"),
    );
    const stressRow = stressRows.find((r) => r.type === "oura_daily_stress");
    expect(stressRow).toBeDefined();
    expect(stressRow?.providerId).toBe("oura");
    expect(stressRow?.externalId).toBe("stress-001");
    expect(stressRow?.value).toBe(5400);
    expect(stressRow?.valueText).toBe("restored");
    expect(stressRow?.startDate).toEqual(new Date("2026-03-01T00:00:00"));
  });

  it("syncs daily resilience", async () => {
    setupEnv();
    const resilience = fakeResilience();
    const mockFetch = createMockApiFetch({ resilience: [resilience] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    const val = findValuesCall(
      db,
      (v) => v.type === "oura_daily_resilience" && v.externalId === "resilience-001",
    );
    expect(val.providerId).toBe("oura");
    expect(val.valueText).toBe("solid");
    expect(val.startDate).toEqual(new Date("2026-03-01T00:00:00"));
  });

  it("syncs cardiovascular age and skips null values", async () => {
    setupEnv();
    const cvAgeValid = fakeCvAge({ day: "2026-03-01", vascular_age: 35 });
    const cvAgeNull = fakeCvAge({ day: "2026-03-02", vascular_age: null });
    const mockFetch = createMockApiFetch({ cvAge: [cvAgeValid, cvAgeNull] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.errors).toHaveLength(0);

    // Should only have one CV age insert (the null one is skipped)
    const cvAgeValues = filterValuesCalls(db, (v) => v.type === "oura_cardiovascular_age");
    expect(cvAgeValues).toHaveLength(1);
    expect(cvAgeValues[0]?.externalId).toBe("oura_cv_age:2026-03-01");
    expect(cvAgeValues[0]?.value).toBe(35);
    expect(cvAgeValues[0]?.startDate).toEqual(new Date("2026-03-01T00:00:00"));
  });

  it("syncs tags", async () => {
    setupEnv();
    const tag = fakeTag();
    const mockFetch = createMockApiFetch({ tags: [tag] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    const val = findValuesCall(db, (v) => v.type === "oura_tag" && v.externalId === "tag-001");
    expect(val.providerId).toBe("oura");
    expect(val.valueText).toBe("caffeine, morning");
    expect(val.startDate).toEqual(new Date("2026-03-01T09:00:00+00:00"));
  });

  it("syncs enhanced tags with custom_name fallback", async () => {
    setupEnv();
    // One with custom_name, one without (falls back to tag_type_code)
    const tagWithCustom = fakeEnhancedTag({
      id: "etag-custom",
      custom_name: "My Custom Tag",
      tag_type_code: "generic",
    });
    const tagWithoutCustom = fakeEnhancedTag({
      id: "etag-code",
      custom_name: null,
      tag_type_code: "caffeine",
    });
    const mockFetch = createMockApiFetch({
      enhancedTags: [tagWithCustom, tagWithoutCustom],
    });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(2);

    // custom_name takes precedence
    const customVal = findValuesCall(
      db,
      (v) => v.externalId === "etag-custom" && v.type === "oura_enhanced_tag",
    );
    expect(customVal.valueText).toBe("My Custom Tag");

    // Falls back to tag_type_code when custom_name is null
    const codeVal = findValuesCall(
      db,
      (v) => v.externalId === "etag-code" && v.type === "oura_enhanced_tag",
    );
    expect(codeVal.valueText).toBe("caffeine");
  });

  it("syncs rest mode periods", async () => {
    setupEnv();
    const restMode = fakeRestMode();
    const mockFetch = createMockApiFetch({ restMode: [restMode] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    const val = findValuesCall(db, (v) => v.type === "oura_rest_mode" && v.externalId === "rm-001");
    expect(val.providerId).toBe("oura");
    expect(val.startDate).toEqual(new Date("2026-03-01T08:00:00+00:00"));
    expect(val.endDate).toEqual(new Date("2026-03-02T08:00:00+00:00"));
  });

  it("syncs sleep time recommendations", async () => {
    setupEnv();
    const sleepTime = fakeSleepTime();
    const mockFetch = createMockApiFetch({ sleepTime: [sleepTime] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    const val = findValuesCall(
      db,
      (v) => v.type === "oura_sleep_time" && v.externalId === "st-001",
    );
    expect(val.providerId).toBe("oura");
    expect(val.valueText).toBe("follow_optimal_bedtime");
    expect(val.startDate).toEqual(new Date("2026-03-01T00:00:00"));
  });

  it("syncs daily metrics from multiple sources", async () => {
    setupEnv();
    const readiness = fakeReadiness();
    const dailyActivity = fakeActivity();
    const spo2 = fakeSpO2();
    const vo2max = fakeVO2Max();
    const stress = fakeStress();
    const resilience = fakeResilience();
    const sleep = fakeSleepDoc();
    const mockFetch = createMockApiFetch({
      readiness: [readiness],
      dailyActivity: [dailyActivity],
      spo2: [spo2],
      vo2max: [vo2max],
      stress: [stress],
      resilience: [resilience],
      sleep: [sleep],
    });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.errors).toHaveLength(0);
    // daily_metrics phase should produce 1 record (all sources merge by day)
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    // Find the daily metrics values call
    const val = findValuesCall(
      db,
      (v) => v.date === "2026-03-01" && v.providerId === "oura" && v.steps === 9500,
    );
    expect(val.steps).toBe(9500);
    expect(val.activeEnergyKcal).toBe(450);
    // HRV and resting HR come from sleep data (actual measurements),
    // not readiness contributor scores
    expect(val.hrv).toBe(48);
    expect(val.restingHr).toBe(45);
    expect(val.exerciseMinutes).toBe(75);
    expect(val.skinTempC).toBe(-0.15);
    expect(val.spo2Avg).toBe(97.5);
    expect(val.vo2max).toBe(42.5);
    expect(val.stressHighMinutes).toBe(90);
    expect(val.recoveryHighMinutes).toBe(180);
    expect(val.resilienceLevel).toBe("solid");
  });

  it("returns error when token resolution fails", async () => {
    setupEnv();
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce(null);

    const mockFetch = createMockApiFetch();
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("oura");
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found for Oura");

    // No inserts should have been attempted
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("continues syncing when one phase fails", async () => {
    setupEnv();
    // Provide sleep data (will succeed) but make workout endpoint fail
    const sleep = fakeSleepDoc();
    const tag = fakeTag();

    let callCount = 0;
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      const urlStr = input.toString();

      // Sleep time must come before sleep check
      if (urlStr.includes("/v2/usercollection/sleep_time")) {
        return Response.json({ data: [], next_token: null });
      }
      if (urlStr.includes("/v2/usercollection/sleep")) {
        return Response.json({ data: [sleep], next_token: null });
      }
      if (urlStr.includes("/v2/usercollection/workout")) {
        // Simulate a server error for workouts
        return new Response("Internal Server Error", { status: 500 });
      }
      // Enhanced tags must come before tags
      if (urlStr.includes("/v2/usercollection/enhanced_tag")) {
        return Response.json({ data: [], next_token: null });
      }
      if (urlStr.includes("/v2/usercollection/tag")) {
        callCount++;
        return Response.json({ data: [tag], next_token: null });
      }
      // Return empty for all other endpoints
      if (urlStr.includes("/v2/usercollection/")) {
        return Response.json({ data: [], next_token: null });
      }
      return new Response("Not found", { status: 404 });
    };

    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(db, new Date("2026-03-01"));

    // Should have errors from the workout phase
    expect(result.errors.length).toBeGreaterThan(0);
    const workoutError = result.errors.find((e) => e.message.includes("workouts"));
    expect(workoutError).toBeDefined();

    // But sleep and tags should still have succeeded
    expect(result.recordsSynced).toBeGreaterThanOrEqual(2);

    // Verify tags endpoint was actually called (phases after workout still ran)
    expect(callCount).toBe(1);
  });

  it("handles empty API responses gracefully", async () => {
    setupEnv();
    // All endpoints return empty arrays (default behavior of createMockApiFetch)
    const mockFetch = createMockApiFetch();
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(db, new Date("2026-03-01"));

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
    // No data inserts should happen when all responses are empty
    // values() should never have been called with actual data
    expect(db.values).not.toHaveBeenCalled();
  });

  it("skips scope-gated endpoints on 401 and does not produce errors", async () => {
    setupEnv();
    const readiness = fakeReadiness();
    const dailyActivity = fakeActivity();

    // Return 401 for all scope-gated endpoints (stress, resilience, cv_age, vo2max)
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = input.toString();
      if (urlStr.includes("/v2/usercollection/sleep_time")) {
        return Response.json({ data: [], next_token: null });
      }
      if (urlStr.includes("/v2/usercollection/sleep")) {
        return Response.json({ data: [], next_token: null });
      }
      if (urlStr.includes("/v2/usercollection/daily_readiness")) {
        return Response.json({ data: [readiness], next_token: null });
      }
      if (urlStr.includes("/v2/usercollection/daily_activity")) {
        return Response.json({ data: [dailyActivity], next_token: null });
      }
      if (
        urlStr.includes("/v2/usercollection/daily_stress") ||
        urlStr.includes("/v2/usercollection/daily_resilience") ||
        urlStr.includes("/v2/usercollection/daily_cardiovascular_age") ||
        urlStr.includes("/v2/usercollection/vO2_max")
      ) {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json({ data: [], next_token: null });
    };

    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(db, new Date("2026-03-01"));

    // No errors — 401s on optional scopes are silently skipped
    expect(result.errors).toHaveLength(0);
    // Readiness + activity should still have synced
    const val = findValuesCall(
      db,
      (v) => v.date === "2026-03-01" && v.providerId === "oura" && v.steps === 9500,
    );
    expect(val.steps).toBe(9500);
    // Stress/resilience fields are absent when scope is missing
    expect(val.stressHighMinutes).toBeUndefined();
    expect(val.resilienceLevel).toBeUndefined();
  });
});

// ============================================================
// fetchAllPagesOptional tests
// ============================================================

describe("fetchAllPagesOptional", () => {
  it("returns data normally when the fetch succeeds", async () => {
    const fetchPage = async () => ({ data: [{ id: "x" }], next_token: null });
    const result = await fetchAllPagesOptional(fetchPage, "test_endpoint");
    expect(result).toEqual([{ id: "x" }]);
  });

  it("returns empty array on API error 401", async () => {
    const fetchPage = async (): Promise<{ data: never[]; next_token: null }> => {
      throw new Error("API error 401: Unauthorized");
    };
    const result = await fetchAllPagesOptional(fetchPage, "daily_stress");
    expect(result).toEqual([]);
  });

  it("logs a warning on 401 with the endpoint name", async () => {
    const warnSpy = vi.mocked(logger.warn);
    warnSpy.mockClear();

    const fetchPage = async (): Promise<{ data: never[]; next_token: null }> => {
      throw new Error("API error 401: Unauthorized");
    };
    await fetchAllPagesOptional(fetchPage, "daily_resilience");

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("daily_resilience"));
  });

  it("re-throws non-401 errors", async () => {
    const fetchPage = async (): Promise<{ data: never[]; next_token: null }> => {
      throw new Error("API error 500: Internal Server Error");
    };
    await expect(fetchAllPagesOptional(fetchPage, "daily_stress")).rejects.toThrow("API error 500");
  });

  it("re-throws 403 errors", async () => {
    const fetchPage = async (): Promise<{ data: never[]; next_token: null }> => {
      throw new Error("API error 403: Forbidden");
    };
    await expect(fetchAllPagesOptional(fetchPage, "daily_stress")).rejects.toThrow("API error 403");
  });

  it("paginates through multiple pages before returning", async () => {
    let page = 0;
    const fetchPage = async (_nextToken?: string) => {
      page++;
      if (page === 1) return { data: [{ id: "a" }], next_token: "tok2" };
      return { data: [{ id: "b" }], next_token: null };
    };
    const result = await fetchAllPagesOptional(fetchPage, "test_endpoint");
    expect(result).toEqual([{ id: "a" }, { id: "b" }]);
  });
});

// ============================================================
// Webhook method tests
// ============================================================

describe("OuraProvider.registerWebhook()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("registers all 8 data types with correct request parameters", async () => {
    process.env.OURA_CLIENT_ID = "test-client-id";
    process.env.OURA_CLIENT_SECRET = "test-client-secret";

    const requestBodies: Array<Record<string, unknown>> = [];
    const requestHeaders: Array<Record<string, string>> = [];

    const mockFetch: typeof globalThis.fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const headers = init?.headers;
      if (headers && typeof headers === "object" && !Array.isArray(headers)) {
        requestHeaders.push(z.record(z.string()).parse(headers));
      }
      if (init?.body) {
        const bodyParsed = z.record(z.unknown()).parse(JSON.parse(String(init.body)));
        requestBodies.push(bodyParsed);
      }
      return Response.json({ id: "sub-first-type" });
    };

    const provider = new OuraProvider(mockFetch);
    const result = await provider.registerWebhook("https://example.com/wh", "verify-me");

    expect(result.subscriptionId).toBe("sub-first-type");
    expect(result.expiresAt).toBeInstanceOf(Date);

    // Should have made 8 POST requests (one per data type)
    expect(requestBodies).toHaveLength(8);

    const dataTypes = requestBodies.map((b) => b.data_type);
    expect(dataTypes).toContain("daily_activity");
    expect(dataTypes).toContain("daily_readiness");
    expect(dataTypes).toContain("daily_sleep");
    expect(dataTypes).toContain("workout");
    expect(dataTypes).toContain("session");
    expect(dataTypes).toContain("daily_spo2");
    expect(dataTypes).toContain("daily_stress");
    expect(dataTypes).toContain("daily_resilience");

    // Verify each request has correct callback_url and verification_token
    for (const body of requestBodies) {
      expect(body.callback_url).toBe("https://example.com/wh");
      expect(body.verification_token).toBe("verify-me");
      expect(body.event_type).toBe(`create.${body.data_type}`);
    }

    // Verify client credentials are in headers
    for (const headers of requestHeaders) {
      expect(headers["x-client-id"]).toBe("test-client-id");
      expect(headers["x-client-secret"]).toBe("test-client-secret");
    }
  });

  it("handles 409 conflict (already registered) gracefully", async () => {
    process.env.OURA_CLIENT_ID = "test-client-id";
    process.env.OURA_CLIENT_SECRET = "test-client-secret";

    let callCount = 0;
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      callCount++;
      if (callCount === 1) {
        return Response.json({ id: "sub-001" });
      }
      // All subsequent return 409 (already registered)
      return new Response("Conflict", { status: 409 });
    };

    const provider = new OuraProvider(mockFetch);
    const result = await provider.registerWebhook("https://example.com/wh", "verify-me");

    // Should use the first successful ID
    expect(result.subscriptionId).toBe("sub-001");
    // All 8 types should have been attempted
    expect(callCount).toBe(8);
  });

  it("throws on non-409 error response", async () => {
    process.env.OURA_CLIENT_ID = "test-client-id";
    process.env.OURA_CLIENT_SECRET = "test-client-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Forbidden", { status: 403 });
    };

    const provider = new OuraProvider(mockFetch);
    await expect(provider.registerWebhook("https://example.com/wh", "verify-me")).rejects.toThrow(
      "Oura webhook registration for daily_activity failed (403)",
    );
  });

  it("throws when env vars are missing", async () => {
    delete process.env.OURA_CLIENT_ID;
    delete process.env.OURA_CLIENT_SECRET;

    const provider = new OuraProvider();
    await expect(provider.registerWebhook("https://example.com/wh", "verify-me")).rejects.toThrow(
      "OURA_CLIENT_ID and OURA_CLIENT_SECRET are required",
    );
  });

  it("falls back to default subscription ID when no successful response returns an id", async () => {
    process.env.OURA_CLIENT_ID = "test-client-id";
    process.env.OURA_CLIENT_SECRET = "test-client-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      // All return 409 (already registered)
      return new Response("Conflict", { status: 409 });
    };

    const provider = new OuraProvider(mockFetch);
    const result = await provider.registerWebhook("https://example.com/wh", "verify-me");

    expect(result.subscriptionId).toBe("oura-multi-subscription");
  });
});

describe("OuraProvider.unregisterWebhook()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("sends DELETE request with correct URL and credentials", async () => {
    process.env.OURA_CLIENT_ID = "test-client-id";
    process.env.OURA_CLIENT_SECRET = "test-client-secret";

    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Record<string, string> = {};

    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      capturedMethod = init?.method ?? "GET";
      if (init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)) {
        capturedHeaders = z.record(z.string()).parse(init.headers);
      }
      return new Response(null, { status: 204 });
    };

    const provider = new OuraProvider(mockFetch);
    await provider.unregisterWebhook("sub-123");

    expect(capturedUrl).toBe("https://api.ouraring.com/v2/webhook/subscription/sub-123");
    expect(capturedMethod).toBe("DELETE");
    expect(capturedHeaders["x-client-id"]).toBe("test-client-id");
    expect(capturedHeaders["x-client-secret"]).toBe("test-client-secret");
  });

  it("is a no-op when env vars are missing", async () => {
    delete process.env.OURA_CLIENT_ID;
    delete process.env.OURA_CLIENT_SECRET;

    let fetchCalled = false;
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response(null, { status: 204 });
    };

    const provider = new OuraProvider(mockFetch);
    await provider.unregisterWebhook("sub-123");

    expect(fetchCalled).toBe(false);
  });
});

describe("OuraProvider.verifyWebhookSignature()", () => {
  it("always returns true (verification done at registration time)", () => {
    const provider = new OuraProvider();
    const result = provider.verifyWebhookSignature(Buffer.from("test"), {}, "secret");
    expect(result).toBe(true);
  });
});

describe("OuraProvider.parseWebhookPayload()", () => {
  it("parses a single event with data_type and user_id", () => {
    const provider = new OuraProvider();
    const body = {
      event_type: "create.daily_activity",
      data_type: "daily_activity",
      user_id: "oura-user-123",
    };

    const events = provider.parseWebhookPayload(body);

    expect(events).toHaveLength(1);
    expect(events[0]?.ownerExternalId).toBe("oura-user-123");
    expect(events[0]?.eventType).toBe("create");
    expect(events[0]?.objectType).toBe("daily_activity");
  });

  it("returns empty array for verification challenge payload", () => {
    const provider = new OuraProvider();
    const body = { verification_token: "some-token" };

    const events = provider.parseWebhookPayload(body);

    expect(events).toHaveLength(0);
  });

  it("returns empty array for invalid payload", () => {
    const provider = new OuraProvider();

    expect(provider.parseWebhookPayload(null)).toHaveLength(0);
    expect(provider.parseWebhookPayload("string")).toHaveLength(0);
    expect(provider.parseWebhookPayload({ invalid: true })).toHaveLength(0);
  });

  it("parses events for each supported data type", () => {
    const provider = new OuraProvider();
    const dataTypes = [
      "daily_activity",
      "daily_readiness",
      "daily_sleep",
      "workout",
      "session",
      "daily_spo2",
      "daily_stress",
      "daily_resilience",
    ];

    for (const dataType of dataTypes) {
      const body = { data_type: dataType, user_id: "user-1" };
      const events = provider.parseWebhookPayload(body);
      expect(events).toHaveLength(1);
      expect(events[0]?.objectType).toBe(dataType);
    }
  });
});

describe("OuraProvider.handleValidationChallenge()", () => {
  it("always returns null (Oura uses POST for verification)", () => {
    const provider = new OuraProvider();
    expect(provider.handleValidationChallenge({}, "token")).toBeNull();
    expect(provider.handleValidationChallenge({ verify: "token" }, "token")).toBeNull();
  });
});

describe("OuraProvider.syncWebhookEvent()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function setupEnv() {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
  }

  it("syncs workouts when data_type is workout", async () => {
    setupEnv();
    const workout = fakeWorkout();
    const mockFetch = createMockApiFetch({ workouts: [workout] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "workout",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);

    const val = findValuesCall(
      db,
      (v) => v.externalId === "workout-001" && v.providerId === "oura",
    );
    expect(val.activityType).toBe("running");
    expect(val.name).toBe("Morning Run");
  });

  it("syncs sessions when data_type is session", async () => {
    setupEnv();
    const session = fakeSession();
    const mockFetch = createMockApiFetch({ sessions: [session] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "session",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);

    const val = findValuesCall(
      db,
      (v) => v.externalId === "session-001" && v.providerId === "oura",
    );
    expect(val.activityType).toBe("meditation");
    expect(val.name).toBe("meditation");
  });

  it("syncs sleep when data_type is daily_sleep", async () => {
    setupEnv();
    const sleep = fakeSleepDoc();
    const mockFetch = createMockApiFetch({ sleep: [sleep] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "daily_sleep",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);

    const val = findValuesCall(db, (v) => v.externalId === "sleep-001" && v.providerId === "oura");
    expect(val.durationMinutes).toBe(480);
    expect(val.efficiencyPct).toBe(87);
    expect(val.sleepType).toBe("long_sleep");
  });

  it("syncs sleep when data_type is sleep (alias)", async () => {
    setupEnv();
    const sleep = fakeSleepDoc();
    const mockFetch = createMockApiFetch({ sleep: [sleep] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "sleep",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);
  });

  it("syncs daily_stress healthEvents and daily metrics", async () => {
    setupEnv();
    const stress = fakeStress();
    const readiness = fakeReadiness();
    const dailyActivity = fakeActivity();
    const mockFetch = createMockApiFetch({
      stress: [stress],
      readiness: [readiness],
      dailyActivity: [dailyActivity],
    });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "daily_stress",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    // Should sync stress healthEvents + daily metrics composite
    expect(result.recordsSynced).toBeGreaterThanOrEqual(2);
  });

  it("syncs daily_resilience healthEvents and daily metrics", async () => {
    setupEnv();
    const resilience = fakeResilience();
    const readiness = fakeReadiness();
    const dailyActivity = fakeActivity();
    const mockFetch = createMockApiFetch({
      resilience: [resilience],
      readiness: [readiness],
      dailyActivity: [dailyActivity],
    });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "daily_resilience",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(2);
  });

  it("syncs only daily metrics for daily_activity", async () => {
    setupEnv();
    const dailyActivity = fakeActivity();
    const readiness = fakeReadiness();
    const mockFetch = createMockApiFetch({
      dailyActivity: [dailyActivity],
      readiness: [readiness],
    });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "daily_activity",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);
  });

  it("syncs only daily metrics for daily_readiness", async () => {
    setupEnv();
    const readiness = fakeReadiness();
    const mockFetch = createMockApiFetch({ readiness: [readiness] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "daily_readiness",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);
  });

  it("syncs only daily metrics for daily_spo2", async () => {
    setupEnv();
    const spo2 = fakeSpO2();
    const mockFetch = createMockApiFetch({ spo2: [spo2] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "daily_spo2",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);
  });

  it("returns empty result for unknown data_type", async () => {
    setupEnv();
    const mockFetch = createMockApiFetch();
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "unknown_data_type",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns error when token resolution fails", async () => {
    setupEnv();
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce(null);

    const mockFetch = createMockApiFetch();
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "workout",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found for Oura");
  });
});

// ============================================================
// Webhook method tests
// ============================================================

describe("OuraProvider.registerWebhook()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("registers all 8 data types with correct request parameters", async () => {
    process.env.OURA_CLIENT_ID = "test-client-id";
    process.env.OURA_CLIENT_SECRET = "test-client-secret";

    const requestBodies: Array<Record<string, unknown>> = [];
    const requestHeaders: Array<Record<string, string>> = [];

    const mockFetch: typeof globalThis.fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const headers = init?.headers;
      if (headers && typeof headers === "object" && !Array.isArray(headers)) {
        requestHeaders.push(z.record(z.string()).parse(headers));
      }
      if (init?.body) {
        const bodyParsed = z.record(z.unknown()).parse(JSON.parse(String(init.body)));
        requestBodies.push(bodyParsed);
      }
      return Response.json({ id: "sub-first-type" });
    };

    const provider = new OuraProvider(mockFetch);
    const result = await provider.registerWebhook("https://example.com/wh", "verify-me");

    expect(result.subscriptionId).toBe("sub-first-type");
    expect(result.expiresAt).toBeInstanceOf(Date);

    // Should have made 8 POST requests (one per data type)
    expect(requestBodies).toHaveLength(8);

    const dataTypes = requestBodies.map((b) => b.data_type);
    expect(dataTypes).toContain("daily_activity");
    expect(dataTypes).toContain("daily_readiness");
    expect(dataTypes).toContain("daily_sleep");
    expect(dataTypes).toContain("workout");
    expect(dataTypes).toContain("session");
    expect(dataTypes).toContain("daily_spo2");
    expect(dataTypes).toContain("daily_stress");
    expect(dataTypes).toContain("daily_resilience");

    // Verify each request has correct callback_url and verification_token
    for (const body of requestBodies) {
      expect(body.callback_url).toBe("https://example.com/wh");
      expect(body.verification_token).toBe("verify-me");
      expect(body.event_type).toBe(`create.${body.data_type}`);
    }

    // Verify client credentials are in headers
    for (const headers of requestHeaders) {
      expect(headers["x-client-id"]).toBe("test-client-id");
      expect(headers["x-client-secret"]).toBe("test-client-secret");
    }
  });

  it("handles 409 conflict (already registered) gracefully", async () => {
    process.env.OURA_CLIENT_ID = "test-client-id";
    process.env.OURA_CLIENT_SECRET = "test-client-secret";

    let callCount = 0;
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      callCount++;
      if (callCount === 1) {
        return Response.json({ id: "sub-001" });
      }
      // All subsequent return 409 (already registered)
      return new Response("Conflict", { status: 409 });
    };

    const provider = new OuraProvider(mockFetch);
    const result = await provider.registerWebhook("https://example.com/wh", "verify-me");

    // Should use the first successful ID
    expect(result.subscriptionId).toBe("sub-001");
    // All 8 types should have been attempted
    expect(callCount).toBe(8);
  });

  it("throws on non-409 error response", async () => {
    process.env.OURA_CLIENT_ID = "test-client-id";
    process.env.OURA_CLIENT_SECRET = "test-client-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Forbidden", { status: 403 });
    };

    const provider = new OuraProvider(mockFetch);
    await expect(provider.registerWebhook("https://example.com/wh", "verify-me")).rejects.toThrow(
      "Oura webhook registration for daily_activity failed (403)",
    );
  });

  it("throws when env vars are missing", async () => {
    delete process.env.OURA_CLIENT_ID;
    delete process.env.OURA_CLIENT_SECRET;

    const provider = new OuraProvider();
    await expect(provider.registerWebhook("https://example.com/wh", "verify-me")).rejects.toThrow(
      "OURA_CLIENT_ID and OURA_CLIENT_SECRET are required",
    );
  });

  it("falls back to default subscription ID when no successful response returns an id", async () => {
    process.env.OURA_CLIENT_ID = "test-client-id";
    process.env.OURA_CLIENT_SECRET = "test-client-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      // All return 409 (already registered)
      return new Response("Conflict", { status: 409 });
    };

    const provider = new OuraProvider(mockFetch);
    const result = await provider.registerWebhook("https://example.com/wh", "verify-me");

    expect(result.subscriptionId).toBe("oura-multi-subscription");
  });
});

describe("OuraProvider.unregisterWebhook()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("sends DELETE request with correct URL and credentials", async () => {
    process.env.OURA_CLIENT_ID = "test-client-id";
    process.env.OURA_CLIENT_SECRET = "test-client-secret";

    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Record<string, string> = {};

    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      capturedMethod = init?.method ?? "GET";
      if (init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)) {
        capturedHeaders = z.record(z.string()).parse(init.headers);
      }
      return new Response(null, { status: 204 });
    };

    const provider = new OuraProvider(mockFetch);
    await provider.unregisterWebhook("sub-123");

    expect(capturedUrl).toBe("https://api.ouraring.com/v2/webhook/subscription/sub-123");
    expect(capturedMethod).toBe("DELETE");
    expect(capturedHeaders["x-client-id"]).toBe("test-client-id");
    expect(capturedHeaders["x-client-secret"]).toBe("test-client-secret");
  });

  it("is a no-op when env vars are missing", async () => {
    delete process.env.OURA_CLIENT_ID;
    delete process.env.OURA_CLIENT_SECRET;

    let fetchCalled = false;
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response(null, { status: 204 });
    };

    const provider = new OuraProvider(mockFetch);
    await provider.unregisterWebhook("sub-123");

    expect(fetchCalled).toBe(false);
  });
});

describe("OuraProvider.verifyWebhookSignature()", () => {
  it("always returns true (verification done at registration time)", () => {
    const provider = new OuraProvider();
    const result = provider.verifyWebhookSignature(Buffer.from("test"), {}, "secret");
    expect(result).toBe(true);
  });
});

describe("OuraProvider.parseWebhookPayload()", () => {
  it("parses a single event with data_type and user_id", () => {
    const provider = new OuraProvider();
    const body = {
      event_type: "create.daily_activity",
      data_type: "daily_activity",
      user_id: "oura-user-123",
    };

    const events = provider.parseWebhookPayload(body);

    expect(events).toHaveLength(1);
    expect(events[0]?.ownerExternalId).toBe("oura-user-123");
    expect(events[0]?.eventType).toBe("create");
    expect(events[0]?.objectType).toBe("daily_activity");
  });

  it("returns empty array for verification challenge payload", () => {
    const provider = new OuraProvider();
    const body = { verification_token: "some-token" };

    const events = provider.parseWebhookPayload(body);

    expect(events).toHaveLength(0);
  });

  it("returns empty array for invalid payload", () => {
    const provider = new OuraProvider();

    expect(provider.parseWebhookPayload(null)).toHaveLength(0);
    expect(provider.parseWebhookPayload("string")).toHaveLength(0);
    expect(provider.parseWebhookPayload({ invalid: true })).toHaveLength(0);
  });

  it("parses events for each supported data type", () => {
    const provider = new OuraProvider();
    const dataTypes = [
      "daily_activity",
      "daily_readiness",
      "daily_sleep",
      "workout",
      "session",
      "daily_spo2",
      "daily_stress",
      "daily_resilience",
    ];

    for (const dataType of dataTypes) {
      const body = { data_type: dataType, user_id: "user-1" };
      const events = provider.parseWebhookPayload(body);
      expect(events).toHaveLength(1);
      expect(events[0]?.objectType).toBe(dataType);
    }
  });
});

describe("OuraProvider.handleValidationChallenge()", () => {
  it("always returns null (Oura uses POST for verification)", () => {
    const provider = new OuraProvider();
    expect(provider.handleValidationChallenge({}, "token")).toBeNull();
    expect(provider.handleValidationChallenge({ verify: "token" }, "token")).toBeNull();
  });
});

describe("OuraProvider.syncWebhookEvent()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function setupEnv() {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
  }

  it("syncs workouts when data_type is workout", async () => {
    setupEnv();
    const workout = fakeWorkout();
    const mockFetch = createMockApiFetch({ workouts: [workout] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "workout",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);

    const val = findValuesCall(
      db,
      (v) => v.externalId === "workout-001" && v.providerId === "oura",
    );
    expect(val.activityType).toBe("running");
    expect(val.name).toBe("Morning Run");
  });

  it("syncs sessions when data_type is session", async () => {
    setupEnv();
    const session = fakeSession();
    const mockFetch = createMockApiFetch({ sessions: [session] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "session",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);

    const val = findValuesCall(
      db,
      (v) => v.externalId === "session-001" && v.providerId === "oura",
    );
    expect(val.activityType).toBe("meditation");
    expect(val.name).toBe("meditation");
  });

  it("syncs sleep when data_type is daily_sleep", async () => {
    setupEnv();
    const sleep = fakeSleepDoc();
    const mockFetch = createMockApiFetch({ sleep: [sleep] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "daily_sleep",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);

    const val = findValuesCall(db, (v) => v.externalId === "sleep-001" && v.providerId === "oura");
    expect(val.durationMinutes).toBe(480);
    expect(val.efficiencyPct).toBe(87);
    expect(val.sleepType).toBe("long_sleep");
  });

  it("syncs sleep when data_type is sleep (alias)", async () => {
    setupEnv();
    const sleep = fakeSleepDoc();
    const mockFetch = createMockApiFetch({ sleep: [sleep] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "sleep",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);
  });

  it("syncs daily_stress healthEvents and daily metrics", async () => {
    setupEnv();
    const stress = fakeStress();
    const readiness = fakeReadiness();
    const dailyActivity = fakeActivity();
    const mockFetch = createMockApiFetch({
      stress: [stress],
      readiness: [readiness],
      dailyActivity: [dailyActivity],
    });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "daily_stress",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    // Should sync stress healthEvents + daily metrics composite
    expect(result.recordsSynced).toBeGreaterThanOrEqual(2);
  });

  it("syncs daily_resilience healthEvents and daily metrics", async () => {
    setupEnv();
    const resilience = fakeResilience();
    const readiness = fakeReadiness();
    const dailyActivity = fakeActivity();
    const mockFetch = createMockApiFetch({
      resilience: [resilience],
      readiness: [readiness],
      dailyActivity: [dailyActivity],
    });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "daily_resilience",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(2);
  });

  it("syncs only daily metrics for daily_activity", async () => {
    setupEnv();
    const dailyActivity = fakeActivity();
    const readiness = fakeReadiness();
    const mockFetch = createMockApiFetch({
      dailyActivity: [dailyActivity],
      readiness: [readiness],
    });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "daily_activity",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);
  });

  it("syncs only daily metrics for daily_readiness", async () => {
    setupEnv();
    const readiness = fakeReadiness();
    const mockFetch = createMockApiFetch({ readiness: [readiness] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "daily_readiness",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);
  });

  it("syncs only daily metrics for daily_spo2", async () => {
    setupEnv();
    const spo2 = fakeSpO2();
    const mockFetch = createMockApiFetch({ spo2: [spo2] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "daily_spo2",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);
  });

  it("returns empty result for unknown data_type", async () => {
    setupEnv();
    const mockFetch = createMockApiFetch();
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "unknown_data_type",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns error when token resolution fails", async () => {
    setupEnv();
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce(null);

    const mockFetch = createMockApiFetch();
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "workout",
    };

    const result = await provider.syncWebhookEvent(db, event);

    expect(result.provider).toBe("oura");
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found for Oura");
  });
});
