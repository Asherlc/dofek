import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import {
  dailyMetrics as dailyMetricsTable,
  sleepSession as sleepSessionTable,
} from "../db/schema/activity.ts";
import { OuraClient } from "./oura/client.ts";
import { ouraOAuthConfig } from "./oura/oauth.ts";
import {
  mapOuraActivityType,
  ouraProviderOffsetColumns,
  parseOuraDailyMetrics,
  parseOuraSleep,
} from "./oura/parsing.ts";
import { OuraProvider } from "./oura/provider.ts";
import {
  type OuraDailyActivity,
  type OuraDailySpO2,
  type OuraEnhancedTag,
  type OuraHeartRate,
  type OuraRestModePeriod,
  type OuraSession,
  type OuraSleepDocument,
  type OuraTag,
  type OuraWorkout,
  ouraDailyActivitySchema,
  ouraDailySpO2Schema,
  ouraEnhancedTagSchema,
  ouraHeartRateSchema,
  ouraRestModePeriodSchema,
  ouraSessionSchema,
  ouraSleepDocumentSchema,
  ouraTagSchema,
  ouraWorkoutSchema,
} from "./oura/schemas.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { makeTransactionalTestDatabase } from "./test-helpers.ts";

vi.mock("../db/provider-data-deletion.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

const { publishedMetricStreamBatches } = vi.hoisted<{
  publishedMetricStreamBatches: Record<string, unknown>[][];
}>(() => ({
  publishedMetricStreamBatches: [],
}));

const { syncLogEntries } = vi.hoisted<{
  syncLogEntries: Record<string, unknown>[];
}>(() => ({
  syncLogEntries: [],
}));

const providerActivityAbsenceMocks = vi.hoisted(() => ({
  finishProviderActivityListSync: vi.fn().mockResolvedValue(undefined),
  upsertProviderActivity: vi.fn().mockResolvedValue({ id: "activity-id" }),
}));

vi.mock("../db/provider-activity-sync.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../db/provider-activity-sync.ts")>();
  return {
    ...original,
    finishProviderActivityListSync: providerActivityAbsenceMocks.finishProviderActivityListSync,
    upsertProviderActivity: providerActivityAbsenceMocks.upsertProviderActivity,
  };
});

vi.mock("../metric-stream/redpanda-producer.ts", () => ({
  getDefaultMetricStreamEventPublisher: async () => ({
    publishRows: async (rows: readonly Record<string, unknown>[]) => {
      publishedMetricStreamBatches.push([...rows]);
      return rows.map((row, index) => ({
        version: 1,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        recordedAt: row.recordedAt instanceof Date ? row.recordedAt.toISOString() : row.recordedAt,
      }));
    },
  }),
}));

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "00000000-0000-0000-0000-000000000001",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

afterEach(() => {
  publishedMetricStreamBatches.length = 0;
  syncLogEntries.length = 0;
  providerActivityAbsenceMocks.finishProviderActivityListSync.mockReset();
  providerActivityAbsenceMocks.finishProviderActivityListSync.mockResolvedValue(undefined);
  providerActivityAbsenceMocks.upsertProviderActivity.mockReset();
  providerActivityAbsenceMocks.upsertProviderActivity.mockResolvedValue({ id: "activity-id" });
});

// ============================================================
// Mock external dependencies (for sync tests)
// ============================================================

vi.mock("../db/sync-log.ts", () => ({
  withSyncLog: vi.fn(
    async (
      _db: unknown,
      providerId: string,
      dataType: string,
      fn: () => Promise<{
        recordCount: number;
        result: unknown;
        degradations?: Record<string, unknown>[];
      }>,
    ) => {
      try {
        const { recordCount, result, degradations = [] } = await fn();
        const firstDegradation = degradations[0];
        syncLogEntries.push({
          providerId,
          dataType,
          status: firstDegradation ? "degraded" : "success",
          recordCount,
          errorMessage: firstDegradation?.message,
          degradationKind: firstDegradation?.kind,
        });
        return result;
      } catch (err) {
        syncLogEntries.push({
          providerId,
          dataType,
          status: "error",
          recordCount: undefined,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
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
    () => process.env.OAUTH_REDIRECT_URI ?? "https://dofek.example.com/callback",
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
    execute: vi.fn().mockResolvedValue([]),
  };

  return makeTransactionalTestDatabase(Object.assign(db, chain));
}

function expectConflictTarget(
  db: ReturnType<typeof createMockDb>,
  expectedTarget: ReadonlyArray<unknown>,
): void {
  const targetMatched = db.onConflictDoUpdate.mock.calls.some((callArgs) => {
    const [arg] = callArgs;
    if (typeof arg !== "object" || arg === null || !("target" in arg)) {
      return false;
    }
    const target = Reflect.get(arg, "target");
    if (!Array.isArray(target) || target.length !== expectedTarget.length) {
      return false;
    }
    return target.every((column, index) => column === expectedTarget[index]);
  });
  expect(targetMatched).toBe(true);
}

function expectConflictSetContainsKey(
  db: ReturnType<typeof createMockDb>,
  expectedTarget: ReadonlyArray<unknown>,
  key: string,
): void {
  const setMatched = db.onConflictDoUpdate.mock.calls.some((callArgs) => {
    const [arg] = callArgs;
    if (typeof arg !== "object" || arg === null || !("target" in arg) || !("set" in arg)) {
      return false;
    }
    const target = Reflect.get(arg, "target");
    const set = Reflect.get(arg, "set");
    if (!Array.isArray(target) || target.length !== expectedTarget.length) {
      return false;
    }
    const targetMatches = target.every((column, index) => column === expectedTarget[index]);
    if (!targetMatches || typeof set !== "object" || set === null) {
      return false;
    }
    return key in set;
  });
  expect(setMatched).toBe(true);
}

function expectReasonableDuration(durationMilliseconds: number): void {
  expect(durationMilliseconds).toBeGreaterThanOrEqual(0);
  expect(durationMilliseconds).toBeLessThan(60_000);
}

function expectSchemaParseAndKeys<T extends Record<string, unknown>>(
  schema: z.ZodSchema<T>,
  input: T,
  requiredKeys: string[],
): void {
  const parsed: Record<string, unknown> = schema.parse(input);
  for (const key of requiredKeys) {
    expect(key in parsed).toBe(true);
    expect(parsed[key]).not.toBeUndefined();
  }
}

const recordSchema = z.record(z.string(), z.unknown());

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

function findUpsertValues(
  predicate: (values: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  for (const call of providerActivityAbsenceMocks.upsertProviderActivity.mock.calls) {
    const values = call[1];
    const parsed = recordSchema.safeParse(values);
    if (parsed.success && predicate(parsed.data)) return parsed.data;
  }
  throw new Error("No matching upsert values call found");
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

// ============================================================
// Helper: create a mock fetch that routes Oura API calls
// ============================================================

interface MockApiData {
  sleep?: OuraSleepDocument[];
  workouts?: OuraWorkout[];
  sessions?: OuraSession[];
  heartRate?: OuraHeartRate[];
  dailyActivity?: OuraDailyActivity[];
  spo2?: OuraDailySpO2[];
  tags?: OuraTag[];
  enhancedTags?: OuraEnhancedTag[];
  restMode?: OuraRestModePeriod[];
}

function createMockApiFetch(data: MockApiData = {}): typeof globalThis.fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const urlStr = input.toString();

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
    if (urlStr.includes("/v2/usercollection/daily_activity")) {
      return Response.json({ data: data.dailyActivity ?? [], next_token: null });
    }
    if (urlStr.includes("/v2/usercollection/daily_spo2")) {
      return Response.json({ data: data.spo2 ?? [], next_token: null });
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

// ============================================================
// Parsing tests
// ============================================================

describe("Oura Provider", () => {
  describe("ouraProviderOffsetColumns", () => {
    it("maps independent timestamp offsets to provider-local persistence columns", () => {
      expect(
        ouraProviderOffsetColumns("2026-03-08T01:30:00-08:00", "2026-03-08T03:30:00-07:00"),
      ).toEqual({
        timezone: null,
        startUtcOffsetMinutes: -480,
        endUtcOffsetMinutes: -420,
        localTimeSource: "provider_offset",
      });
    });
  });

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
      expect(result.stagingAvailable).toBe(true);
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
      expect(result.stagingAvailable).toBe(false);
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
    it("maps measured sleep, activity, and SpO2 observations", () => {
      const result = parseOuraDailyMetrics(sampleActivity, sampleSpO2, sampleSleep);

      expect(result).toEqual({
        date: "2026-03-01",
        steps: 9500,
        hrv: 48,
        restingHr: 45,
        spo2Avg: 97.5,
      });
    });

    it("includes SpO2 when provided", () => {
      const result = parseOuraDailyMetrics(sampleActivity, sampleSpO2, null);

      expect(result.spo2Avg).toBe(97.5);
    });

    it("handles null spo2_percentage", () => {
      const noPercentage: OuraDailySpO2 = { ...sampleSpO2, spo2_percentage: null };
      const result = parseOuraDailyMetrics(null, noPercentage, null);
      expect(result.spo2Avg).toBeUndefined();
    });

    it("returns undefined hrv and restingHr when no sleep data", () => {
      const result = parseOuraDailyMetrics(sampleActivity, null, null);

      expect(result.hrv).toBeUndefined();
      expect(result.restingHr).toBeUndefined();
    });

    it("handles null activity", () => {
      const result = parseOuraDailyMetrics(null, null, sampleSleep);

      expect(result.steps).toBeUndefined();
      expect(result.hrv).toBe(48);
      expect(result.restingHr).toBe(45);
    });

    it("handles null hrv in sleep", () => {
      const noHrv: OuraSleepDocument = {
        ...sampleSleep,
        average_hrv: null,
        lowest_heart_rate: null,
      };
      const result = parseOuraDailyMetrics(sampleActivity, null, noHrv);
      expect(result.hrv).toBeUndefined();
      expect(result.restingHr).toBeUndefined();
    });

    it("uses activity day when no other source is present", () => {
      const result = parseOuraDailyMetrics(sampleActivity, null, null);
      expect(result.date).toBe("2026-03-01");
    });

    it("returns empty date when all are null", () => {
      const result = parseOuraDailyMetrics(null, null, null);
      expect(result.date).toBe("");
    });

    it("uses spo2 day when activity is null", () => {
      const result = parseOuraDailyMetrics(null, sampleSpO2, null);
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

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = ouraOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when not set", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;
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
    expect(setup.oauthConfig?.clientId).toBe("test-id");
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
    expect(identity.emailVerified).toBe(false);
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
    expect(setup.oauthConfig?.scopes).toContain("email");
  });
});

describe("Oura API schemas", () => {
  it("accepts valid objects for all exported Oura schemas", () => {
    expectSchemaParseAndKeys(ouraSleepDocumentSchema, fakeSleepDoc(), [
      "id",
      "day",
      "type",
      "efficiency",
    ]);
    expectSchemaParseAndKeys(ouraDailyActivitySchema, fakeActivity(), ["id", "day", "steps"]);
    expectSchemaParseAndKeys(ouraDailySpO2Schema, fakeSpO2(), ["id", "day", "spo2_percentage"]);
    expectSchemaParseAndKeys(ouraWorkoutSchema, fakeWorkout(), ["id", "activity", "intensity"]);
    expectSchemaParseAndKeys(ouraHeartRateSchema, fakeHeartRate(), ["bpm", "source", "timestamp"]);
    expectSchemaParseAndKeys(ouraSessionSchema, fakeSession(), ["id", "type", "mood"]);
    expectSchemaParseAndKeys(ouraTagSchema, fakeTag(), ["id", "day", "tags"]);
    expectSchemaParseAndKeys(ouraEnhancedTagSchema, fakeEnhancedTag(), [
      "id",
      "start_time",
      "start_day",
    ]);
    expectSchemaParseAndKeys(ouraRestModePeriodSchema, fakeRestMode(), ["id", "start_day"]);
  });

  it("rejects malformed objects and invalid enum values", () => {
    expect(ouraSleepDocumentSchema.safeParse({}).success).toBe(false);
    expect(ouraSleepDocumentSchema.safeParse({ ...fakeSleepDoc(), type: "bad_type" }).success).toBe(
      false,
    );

    expect(
      ouraDailySpO2Schema.safeParse({
        ...fakeSpO2(),
        spo2_percentage: { average: "97" },
      }).success,
    ).toBe(false);

    expect(ouraWorkoutSchema.safeParse({ ...fakeWorkout(), intensity: "all_out" }).success).toBe(
      false,
    );

    expect(ouraSessionSchema.safeParse({ ...fakeSession(), type: "sauna" }).success).toBe(false);
    expect(ouraSessionSchema.safeParse({ ...fakeSession(), mood: "excellent" }).success).toBe(
      false,
    );

    expect(ouraTagSchema.safeParse({ ...fakeTag(), tags: "caffeine" }).success).toBe(false);
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
    await expect(client.getSleep("2026-03-01", "2026-03-02")).rejects.not.toThrow(
      "Invalid API key provided…",
    );
  });

  it("throws OuraApiError with structured status on API failures", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    };

    const client = new OuraClient("bad-token", mockFetch);
    await expect(client.getSleep("2026-03-01", "2026-03-02")).rejects.toMatchObject({
      name: "OuraApiError",
      status: 401,
    });
  });

  it("includes error bodies up to 200 characters without truncation", async () => {
    const body = "a".repeat(200);
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(body, { status: 500 });
    };

    const client = new OuraClient("bad-token", mockFetch);
    await expect(client.getSleep("2026-03-01", "2026-03-02")).rejects.toThrow(body);
    await expect(client.getSleep("2026-03-01", "2026-03-02")).rejects.not.toThrow(`${body}…`);
  });

  it("truncates error bodies longer than 200 characters", async () => {
    const body = "x".repeat(250);
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(body, { status: 500 });
    };

    const client = new OuraClient("bad-token", mockFetch);
    await expect(client.getSleep("2026-03-01", "2026-03-02")).rejects.toThrow(
      `${"x".repeat(200)}…`,
    );
    await expect(client.getSleep("2026-03-01", "2026-03-02")).rejects.not.toThrow(body);
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

  it("truncates long error response bodies at 200 characters", async () => {
    const longBody = "x".repeat(201);
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(longBody, { status: 500 });
    };

    const client = new OuraClient("token", mockFetch);
    await expect(client.getSleep("2026-03-01", "2026-03-02")).rejects.toMatchObject({
      message: expect.stringContaining("…"),
    });
  });

  it("does not truncate error responses exactly at 200 characters", async () => {
    const body200 = "x".repeat(200);
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(body200, { status: 500 });
    };

    const client = new OuraClient("token", mockFetch);
    await expect(client.getSleep("2026-03-01", "2026-03-02")).rejects.toMatchObject({
      message: expect.not.stringContaining("…"),
    });
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
});

// ============================================================
// Activity type mapping tests
// ============================================================

describe("mapOuraActivityType", () => {
  it("maps known activity types", () => {
    expect(mapOuraActivityType("walking").canonicalType).toBe("walking");
    expect(mapOuraActivityType("running").canonicalType).toBe("running");
    expect(mapOuraActivityType("cycling").canonicalType).toBe("cycling");
    expect(mapOuraActivityType("swimming").canonicalType).toBe("swimming");
    expect(mapOuraActivityType("strength_training").canonicalType).toBe("strength");
  });

  it("handles case-insensitive input", () => {
    expect(mapOuraActivityType("Walking").canonicalType).toBe("walking");
    expect(mapOuraActivityType("RUNNING").canonicalType).toBe("running");
  });

  it("returns other for unknown types", () => {
    expect(mapOuraActivityType("kickboxing").canonicalType).toBe("other");
    expect(mapOuraActivityType("CrossFit").canonicalType).toBe("other");
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

    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-03-01") }) }),
    );

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expectReasonableDuration(result.duration);
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
    expect(sleepValues.stagingAvailable).toBe(true);
    expect(sleepValues.efficiencyPct).toBe(87);
    expect(sleepValues.sleepType).toBe("long_sleep");
    expect(sleepValues.startedAt).toEqual(new Date("2026-02-28T22:30:00+00:00"));
    expect(sleepValues.endedAt).toEqual(new Date("2026-03-01T06:45:00+00:00"));
    expectConflictTarget(db, [
      sleepSessionTable.userId,
      sleepSessionTable.providerId,
      sleepSessionTable.externalId,
    ]);
  });

  it("follows Oura pagination tokens when syncing sleep sessions", async () => {
    setupEnv();
    const firstSleep = fakeSleepDoc({ id: "sleep-page-1" });
    const secondSleep = fakeSleepDoc({ id: "sleep-page-2", day: "2026-03-02" });
    const requestedUrls: string[] = [];
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = input.toString();
      requestedUrls.push(urlStr);
      if (urlStr.includes("/v2/usercollection/sleep") && urlStr.includes("next_token=page-2")) {
        return Response.json({ data: [secondSleep], next_token: null });
      }
      if (urlStr.includes("/v2/usercollection/sleep")) {
        return Response.json({ data: [firstSleep], next_token: "page-2" });
      }
      return Response.json({ data: [], next_token: null });
    };
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-03-01") }) }),
    );

    expect(result.errors).toHaveLength(0);
    const sleepExternalIds = filterValuesCalls(
      db,
      (values) => values.providerId === "oura" && typeof values.externalId === "string",
    ).map((values) => values.externalId);
    expect(sleepExternalIds).toContain("sleep-page-1");
    expect(sleepExternalIds).toContain("sleep-page-2");
    expect(
      requestedUrls.some(
        (requestedUrl) =>
          requestedUrl.includes("/v2/usercollection/sleep") &&
          requestedUrl.includes("next_token=page-2"),
      ),
    ).toBe(true);
  });

  it("persists Oura sleep pages fetched before a later page failure", async () => {
    setupEnv();
    const firstSleep = fakeSleepDoc({ id: "sleep-before-error" });
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = input.toString();
      if (urlStr.includes("/v2/usercollection/sleep") && urlStr.includes("next_token=page-2")) {
        return new Response("temporary failure", { status: 502 });
      }
      if (urlStr.includes("/v2/usercollection/sleep")) {
        return Response.json({ data: [firstSleep], next_token: "page-2" });
      }
      return Response.json({ data: [], next_token: null });
    };
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-03-01") }) }),
    );

    expect(result.errors.some((error) => error.message.includes("sleep"))).toBe(true);
    const persistedSleep = findValuesCall(
      db,
      (values) => values.externalId === "sleep-before-error" && values.providerId === "oura",
    );
    expect(persistedSleep.durationMinutes).toBe(480);
    expect(syncLogEntries).toContainEqual(
      expect.objectContaining({
        providerId: "oura",
        dataType: "sleep",
        status: "error",
      }),
    );
  });

  it("syncs workouts to activity table", async () => {
    setupEnv();
    const workout = fakeWorkout();
    const mockFetch = createMockApiFetch({ workouts: [workout] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-03-01") }) }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    const val = findUpsertValues(
      (v) =>
        v.externalId === "workout-001" &&
        typeof v.activityType === "object" &&
        v.activityType !== null &&
        Reflect.get(v.activityType, "canonicalType") === "running",
    );
    expect(val.providerId).toBe("oura");
    expect(val.activityType).toMatchObject({ providerType: "running" });
    expect(val.name).toBe("Morning Run");
    expect(val.startedAt).toEqual(new Date("2026-03-01T08:00:00+00:00"));
    expect(val.endedAt).toEqual(new Date("2026-03-01T08:30:00+00:00"));
    expect(val.raw).toEqual(workout);
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        providerId: "oura",
        windowStart: new Date("2026-03-01"),
        presentExternalIds: new Set(["workout-001"]),
      }),
    );
  });

  it("reports activity absence reconciliation errors without rejecting sync", async () => {
    setupEnv();
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockRejectedValueOnce(
      new Error("write failed"),
    );
    const workout = fakeWorkout();
    const mockFetch = createMockApiFetch({ workouts: [workout] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-03-01") }) }),
    );

    expect(result.provider).toBe("oura");
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("activity absence reconciliation: write failed");
    expect(result.errors[0]?.cause).toBeInstanceOf(Error);
  });

  it("syncs sessions to activity table", async () => {
    setupEnv();
    const session = fakeSession();
    const mockFetch = createMockApiFetch({ sessions: [session] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-03-01") }) }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    const val = findUpsertValues(
      (v) =>
        v.externalId === "session-001" &&
        typeof v.activityType === "object" &&
        v.activityType !== null &&
        Reflect.get(v.activityType, "canonicalType") === "meditation",
    );
    expect(val.providerId).toBe("oura");
    expect(val.activityType).toMatchObject({ providerType: "meditation" });
    expect(val.name).toBe("meditation");
    expect(val.startedAt).toEqual(new Date("2026-03-01T07:00:00+00:00"));
    expect(val.endedAt).toEqual(new Date("2026-03-01T07:15:00+00:00"));
    expect(val.raw).toEqual(session);
  });

  it("maps breathing sessions to breathwork activity type", async () => {
    setupEnv();
    const session = fakeSession({ id: "session-breathing", type: "breathing" });
    const mockFetch = createMockApiFetch({ sessions: [session] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-03-01") }) }),
    );

    expect(result.errors).toHaveLength(0);
    const value = findUpsertValues((record) => record.externalId === "session-breathing");
    expect(value.activityType).toMatchObject({ canonicalType: "breathwork" });
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

    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-03-01") }) }),
    );
    vi.useRealTimers();

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(2);

    const hrRows = publishedMetricStreamBatches.flat();
    const first = hrRows.find((r) => r.channel === "heart_rate" && r.scalar === 72);
    const second = hrRows.find((r) => r.channel === "heart_rate" && r.scalar === 85);
    expect(first?.scalar).toBe(72);
    expect(first?.providerId).toBe("oura");
    expect(first?.recordedAt).toBe("2026-03-01T10:00:00.000Z");
    expect(second?.scalar).toBe(85);
    expect(second?.recordedAt).toBe("2026-03-01T10:05:00.000Z");
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
    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

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

  it("syncs tags", async () => {
    setupEnv();
    const tag = fakeTag();
    const mockFetch = createMockApiFetch({ tags: [tag] });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-03-01") }) }),
    );

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

    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-03-01") }) }),
    );

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

    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-03-01") }) }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    const val = findValuesCall(db, (v) => v.type === "oura_rest_mode" && v.externalId === "rm-001");
    expect(val.providerId).toBe("oura");
    expect(val.startDate).toEqual(new Date("2026-03-01T08:00:00+00:00"));
    expect(val.endDate).toEqual(new Date("2026-03-02T08:00:00+00:00"));
  });

  it("syncs daily metrics from multiple sources", async () => {
    setupEnv();
    const dailyActivity = fakeActivity();
    const spo2 = fakeSpO2();
    const sleep = fakeSleepDoc();
    const mockFetch = createMockApiFetch({
      dailyActivity: [dailyActivity],
      spo2: [spo2],
      sleep: [sleep],
    });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-03-01") }) }),
    );

    expect(result.errors).toHaveLength(0);
    // daily_metrics phase should produce 1 record (all sources merge by day)
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    // Find the daily metrics values call
    const val = findValuesCall(
      db,
      (v) => v.date === "2026-03-01" && v.providerId === "oura" && v.steps === 9500,
    );
    expect(val.steps).toBe(9500);
    // HRV and resting HR come from sleep measurements, not provider score fields.
    expect(val.hrv).toBe(48);
    expect("restingHr" in val).toBe(false);
    expect(val.spo2Avg).toBe(97.5);
    expectConflictTarget(db, [
      dailyMetricsTable.userId,
      dailyMetricsTable.date,
      dailyMetricsTable.providerId,
      dailyMetricsTable.sourceName,
    ]);
  });

  it("returns error when token resolution fails", async () => {
    setupEnv();
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValueOnce(null);

    const mockFetch = createMockApiFetch();
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-03-01") }) }),
    );

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

    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-03-01") }) }),
    );

    // Should have errors from the workout phase
    expect(result.errors.length).toBeGreaterThan(0);
    const workoutError = result.errors.find((e) => e.message.includes("workouts"));
    expect(workoutError).toBeDefined();

    // But sleep and tags should still have succeeded
    expect(result.recordsSynced).toBeGreaterThanOrEqual(2);

    // Verify tags endpoint was actually called (phases after workout still ran)
    expect(callCount).toBe(1);
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("handles empty API responses gracefully", async () => {
    setupEnv();
    // All endpoints return empty arrays (default behavior of createMockApiFetch)
    const mockFetch = createMockApiFetch();
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const result = await provider.sync(
      new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-03-01") }) }),
    );

    expect(result.provider).toBe("oura");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
    // No data inserts should happen when all responses are empty
    // values() should never have been called with actual data
    expect(db.values).not.toHaveBeenCalled();
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
    const requestHeaders: Array<Record<string, unknown>> = [];

    const mockFetch: typeof globalThis.fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const headers = init?.headers;
      if (headers && typeof headers === "object" && !Array.isArray(headers)) {
        requestHeaders.push(z.record(z.string(), z.unknown()).parse(headers));
      }
      if (init?.body) {
        const bodyParsed = z.record(z.string(), z.unknown()).parse(JSON.parse(String(init.body)));
        requestBodies.push(bodyParsed);
      }
      return Response.json({ id: "sub-first-type" });
    };

    const provider = new OuraProvider(mockFetch);
    const result = await provider.registerWebhook("https://example.com/wh", "verify-me");

    expect(result.subscriptionId).toBe("sub-first-type");
    expect(result.expiresAt).toBeInstanceOf(Date);

    // Should make one POST request per supported raw data type.
    expect(requestBodies).toHaveLength(5);

    const dataTypes = requestBodies.map((b) => b.data_type);
    expect(dataTypes).toContain("daily_activity");
    expect(dataTypes).toContain("daily_sleep");
    expect(dataTypes).toContain("workout");
    expect(dataTypes).toContain("session");
    expect(dataTypes).toContain("daily_spo2");

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
    // All supported types should have been attempted
    expect(callCount).toBe(5);
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
    let capturedHeaders: Record<string, unknown> = {};

    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      capturedMethod = init?.method ?? "GET";
      if (init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)) {
        capturedHeaders = z.record(z.string(), z.unknown()).parse(init.headers);
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
    const dataTypes = ["daily_activity", "daily_sleep", "workout", "session", "daily_spo2"];

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
    expectReasonableDuration(result.duration);

    const val = findUpsertValues((v) => v.externalId === "workout-001" && v.providerId === "oura");
    expect(val.activityType).toMatchObject({ canonicalType: "running" });
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
    expectReasonableDuration(result.duration);

    const val = findUpsertValues((v) => v.externalId === "session-001" && v.providerId === "oura");
    expect(val.activityType).toMatchObject({ canonicalType: "meditation" });
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
    expectReasonableDuration(result.duration);

    const val = findValuesCall(db, (v) => v.externalId === "sleep-001" && v.providerId === "oura");
    expect(val.durationMinutes).toBe(480);
    expect(val.efficiencyPct).toBe(87);
    expect(val.sleepType).toBe("long_sleep");
    expectConflictTarget(db, [
      sleepSessionTable.userId,
      sleepSessionTable.providerId,
      sleepSessionTable.externalId,
    ]);
    expectConflictSetContainsKey(
      db,
      [sleepSessionTable.userId, sleepSessionTable.providerId, sleepSessionTable.externalId],
      "durationMinutes",
    );
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
    expectReasonableDuration(result.duration);
    expectConflictTarget(db, [
      sleepSessionTable.userId,
      sleepSessionTable.providerId,
      sleepSessionTable.externalId,
    ]);
  });

  it("syncs only daily metrics for daily_activity", async () => {
    setupEnv();
    const dailyActivity = fakeActivity();
    const mockFetch = createMockApiFetch({ dailyActivity: [dailyActivity] });
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
    expectConflictTarget(db, [
      dailyMetricsTable.userId,
      dailyMetricsTable.date,
      dailyMetricsTable.providerId,
      dailyMetricsTable.sourceName,
    ]);
    expectConflictSetContainsKey(
      db,
      [
        dailyMetricsTable.userId,
        dailyMetricsTable.date,
        dailyMetricsTable.providerId,
        dailyMetricsTable.sourceName,
      ],
      "steps",
    );
  });

  it("merges all daily metric sources and prefers long_sleep when both sleep types exist", async () => {
    setupEnv();
    const mockFetch = createMockApiFetch({
      dailyActivity: [fakeActivity()],
      spo2: [fakeSpO2()],
      sleep: [
        fakeSleepDoc({
          id: "sleep-short",
          type: "sleep",
          average_hrv: 22,
          lowest_heart_rate: 61,
        }),
        fakeSleepDoc({
          id: "sleep-long",
          type: "long_sleep",
          average_hrv: 66,
          lowest_heart_rate: 40,
        }),
      ],
    });
    const provider = new OuraProvider(mockFetch);
    const db = createMockDb();

    const event: import("./types.ts").WebhookEvent = {
      ownerExternalId: "user-1",
      eventType: "create",
      objectType: "daily_activity",
    };
    const result = await provider.syncWebhookEvent(db, event);

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    const metricsRow = findValuesCall(
      db,
      (value) => value.providerId === "oura" && value.date === "2026-03-01",
    );
    expect(metricsRow.steps).toBe(9500);
    expect(metricsRow.spo2Avg).toBe(97.5);
    expect(metricsRow.hrv).toBe(66);
    expect("restingHr" in metricsRow).toBe(false);
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
    expectConflictTarget(db, [
      dailyMetricsTable.userId,
      dailyMetricsTable.date,
      dailyMetricsTable.providerId,
      dailyMetricsTable.sourceName,
    ]);
    expectConflictSetContainsKey(
      db,
      [
        dailyMetricsTable.userId,
        dailyMetricsTable.date,
        dailyMetricsTable.providerId,
        dailyMetricsTable.sourceName,
      ],
      "spo2Avg",
    );
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
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("uses yesterday as start_date and today as end_date for webhook pulls", async () => {
    setupEnv();
    vi.useFakeTimers({ now: new Date("2026-04-01T12:00:00Z") });
    try {
      const calledUrls: string[] = [];
      const mockFetch: typeof globalThis.fetch = async (
        input: RequestInfo | URL,
      ): Promise<Response> => {
        const url = input.toString();
        calledUrls.push(url);
        if (url.includes("/v2/usercollection/workout")) {
          return Response.json({ data: [], next_token: null });
        }
        return new Response("Not found", { status: 404 });
      };
      const provider = new OuraProvider(mockFetch);
      const db = createMockDb();
      const event: import("./types.ts").WebhookEvent = {
        ownerExternalId: "user-1",
        eventType: "create",
        objectType: "workout",
      };

      const result = await provider.syncWebhookEvent(db, event);

      expect(result.errors).toHaveLength(0);
      const workoutUrl = calledUrls.find((url) => url.includes("/v2/usercollection/workout"));
      expect(workoutUrl).toBeDefined();
      expect(workoutUrl).toContain("start_date=2026-03-31");
      expect(workoutUrl).toContain("end_date=2026-04-01");
    } finally {
      vi.useRealTimers();
    }
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
    expectReasonableDuration(result.duration);
  });
});

describe("OuraProvider — rate-limit aware fetch wiring", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("surfaces a 429 as a ProviderRateLimitError tagged 'oura'", async () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";

    const rateLimited429: typeof globalThis.fetch = async () =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });

    const provider = new OuraProvider(rateLimited429);
    const err = await provider
      .registerWebhook("https://example.com/cb", "verify-token")
      .catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("oura");
      expect(err.statusCode).toBe(429);
    }
  });
});
