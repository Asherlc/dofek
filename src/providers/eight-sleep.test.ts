import {
  parseEightSleepDailyMetrics,
  parseEightSleepHeartRateSamples,
  parseEightSleepTrendDay,
} from "@dofek/eight-sleep/parsing";
import type { EightSleepTrendDay } from "@dofek/eight-sleep/types";
import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetricStreamEventPublisher } from "../metric-stream/redpanda-producer.ts";
import { EightSleepProvider } from "./eight-sleep.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createCapturingMetricStreamPublisher, createMockDatabase } from "./test-helpers.ts";

vi.mock("../db/provider-data-deletion.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "00000000-0000-0000-0000-000000000001",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

// ============================================================
// Sample API responses
// ============================================================

const sampleTrendDay = {
  day: "2026-03-01",
  score: 85,
  tnt: 12,
  processing: false,
  presenceDuration: 28800, // 8 hours in seconds
  sleepDuration: 25200, // 7 hours
  lightDuration: 10800, // 3 hours
  deepDuration: 7200, // 2 hours
  remDuration: 5400, // 1.5 hours
  latencyAsleepSeconds: 600,
  latencyOutSeconds: 300,
  presenceStart: "2026-02-28T23:00:00.000Z",
  presenceEnd: "2026-03-01T07:00:00.000Z",
  sleepQualityScore: {
    total: 82,
    hrv: { score: 75, current: 45.2, average: 42.0 },
    respiratoryRate: { score: 90, current: 15.3, average: 15.0 },
    heartRate: { score: 85, current: 52, average: 55 },
    tempBedC: { average: 28.5 },
    tempRoomC: { average: 20.1 },
    sleepDurationSeconds: { score: 88 },
  },
  sleepRoutineScore: {
    total: 78,
    latencyAsleepSeconds: { score: 70 },
    latencyOutSeconds: { score: 80 },
    wakeupConsistency: { score: 85 },
  },
  sleepFitnessScore: { total: 80 },
  sessions: [
    {
      stages: [
        { stage: "light", duration: 1200 },
        { stage: "deep", duration: 3600 },
        { stage: "rem", duration: 2700 },
        { stage: "awake", duration: 300 },
      ],
      timeseries: {
        heartRate: [
          ["2026-02-28T23:05:00.000Z", 58],
          ["2026-02-28T23:10:00.000Z", 55],
          ["2026-02-28T23:15:00.000Z", 52],
          ["2026-03-01T02:00:00.000Z", 48],
        ] satisfies Array<[string, number]>,
        tempBedC: [
          ["2026-02-28T23:05:00.000Z", 27.5],
          ["2026-03-01T02:00:00.000Z", 28.0],
        ] satisfies Array<[string, number]>,
      },
    },
  ],
} satisfies EightSleepTrendDay;

function makeTrendDay(overrides: Partial<EightSleepTrendDay> = {}): EightSleepTrendDay {
  return { ...sampleTrendDay, ...overrides };
}

function validEightSleepTokenRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: "eight-sleep",
    accessToken: "valid-token",
    refreshToken: null,
    expiresAt: new Date("2099-01-01T00:00:00Z"),
    scopes: "userId:user-123",
    ...overrides,
  };
}

function createEightSleepTrendsFetch(days: EightSleepTrendDay[]): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    if (!url.includes("/trends")) {
      return new Response("Not found", { status: 404 });
    }

    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer valid-token");
    expect(url).toContain("/users/user-123/trends");
    expect(url).toContain("from=2026-02-01");
    expect(url).toContain("include-all-sessions=true");
    expect(url).toContain("model-version=v2");
    return Response.json({ days });
  };
}

function createSyncRun(
  db: ReturnType<typeof createMockDatabase>["db"],
  metricStreamPublisher = createCapturingMetricStreamPublisher().publisher,
) {
  return new SyncRun({
    db,
    window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
    metricStreamPublisher,
  });
}

function createRejectingMetricStreamPublisher(message: string): MetricStreamEventPublisher {
  return {
    publishRows: vi.fn(async () => {
      throw new Error(message);
    }),
  };
}

// ============================================================
// Tests
// ============================================================

describe("Eight Sleep Provider", () => {
  describe("parseEightSleepTrendDay", () => {
    it("maps sleep session fields correctly", () => {
      const result = parseEightSleepTrendDay(sampleTrendDay);

      expect(result.externalId).toBe("eightsleep-2026-03-01");
      expect(result.startedAt).toEqual(new Date("2026-02-28T23:00:00.000Z"));
      expect(result.endedAt).toEqual(new Date("2026-03-01T07:00:00.000Z"));
      expect(result.isNap).toBe(false);
    });

    it("converts durations from seconds to minutes", () => {
      const result = parseEightSleepTrendDay(sampleTrendDay);

      expect(result.durationMinutes).toBe(420); // 25200 / 60 = 420
      expect(result.deepMinutes).toBe(120); // 7200 / 60
      expect(result.remMinutes).toBe(90); // 5400 / 60
      expect(result.lightMinutes).toBe(180); // 10800 / 60
    });

    it("calculates awake minutes from presence minus sleep duration", () => {
      const result = parseEightSleepTrendDay(sampleTrendDay);
      // awake = presenceDuration - sleepDuration = 28800 - 25200 = 3600s = 60 min
      expect(result.awakeMinutes).toBe(60);
    });

    it("does not include efficiencyPct (derived in v_sleep view)", () => {
      const result = parseEightSleepTrendDay(sampleTrendDay);
      expect(result).not.toHaveProperty("efficiencyPct");
    });
  });

  describe("parseEightSleepDailyMetrics", () => {
    it("extracts daily health metrics from quality scores", () => {
      const result = parseEightSleepDailyMetrics(sampleTrendDay);

      expect(result.date).toBe("2026-03-01");
      expect(result.restingHr).toBe(52);
      expect(result.hrv).toBe(45.2);
      expect(result.respiratoryRateAvg).toBe(15.3);
      expect(result.skinTempC).toBe(28.5);
    });

    it("handles missing quality scores", () => {
      const noQuality = {
        ...sampleTrendDay,
        sleepQualityScore: undefined,
      };
      const result = parseEightSleepDailyMetrics(noQuality);

      expect(result.date).toBe("2026-03-01");
      expect(result.restingHr).toBeUndefined();
      expect(result.hrv).toBeUndefined();
      expect(result.respiratoryRateAvg).toBeUndefined();
      expect(result.skinTempC).toBeUndefined();
    });

    it("handles partial quality scores", () => {
      const partialQuality = {
        ...sampleTrendDay,
        sleepQualityScore: {
          total: 50,
          hrv: { score: 75, current: 40, average: 38 },
        },
      };
      const result = parseEightSleepDailyMetrics(partialQuality);

      expect(result.hrv).toBe(40);
      expect(result.restingHr).toBeUndefined();
      expect(result.respiratoryRateAvg).toBeUndefined();
    });
  });

  describe("parseEightSleepHeartRateSamples", () => {
    it("extracts HR samples from session timeseries", () => {
      const result = parseEightSleepHeartRateSamples(sampleTrendDay.sessions ?? []);

      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({
        recordedAt: new Date("2026-02-28T23:05:00.000Z"),
        heartRate: 58,
      });
      expect(result[3]).toEqual({
        recordedAt: new Date("2026-03-01T02:00:00.000Z"),
        heartRate: 48,
      });
    });

    it("filters out zero bpm values", () => {
      const sessionsWithZero = [
        {
          stages: [],
          timeseries: {
            heartRate: [
              ["2026-03-01T00:00:00Z", 55],
              ["2026-03-01T00:05:00Z", 0],
              ["2026-03-01T00:10:00Z", 52],
            ] satisfies Array<[string, number]>,
          },
        },
      ];
      const result = parseEightSleepHeartRateSamples(sessionsWithZero);

      expect(result).toHaveLength(2);
      expect(result[0]?.heartRate).toBe(55);
      expect(result[1]?.heartRate).toBe(52);
    });

    it("handles sessions without HR timeseries", () => {
      const noHr = [{ stages: [], timeseries: {} }];
      const result = parseEightSleepHeartRateSamples(noHr);
      expect(result).toHaveLength(0);
    });

    it("handles empty sessions array", () => {
      const result = parseEightSleepHeartRateSamples([]);
      expect(result).toHaveLength(0);
    });

    it("combines HR samples from multiple sessions", () => {
      const multiSession = [
        {
          stages: [],
          timeseries: {
            heartRate: [["2026-03-01T00:00:00Z", 55]] satisfies Array<[string, number]>,
          },
        },
        {
          stages: [],
          timeseries: {
            heartRate: [["2026-03-01T01:00:00Z", 50]] satisfies Array<[string, number]>,
          },
        },
      ];
      const result = parseEightSleepHeartRateSamples(multiSession);
      expect(result).toHaveLength(2);
    });
  });
});

describe("EightSleepProvider — rate-limit aware fetch wiring", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("surfaces a 429 as a ProviderRateLimitError tagged with providerId 'eight-sleep'", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });

    const provider = new EightSleepProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.automatedLogin) throw new Error("automatedLogin not defined");

    const err = await setup
      .automatedLogin("user@example.com", "password")
      .catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("eight-sleep");
      expect(err.statusCode).toBe(429);
    }
  });
});

describe("EightSleepProvider.sync()", () => {
  it("is enabled and exposes credential login auth", async () => {
    const provider = new EightSleepProvider(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input.toString()).toBe("https://auth-api.8slp.net/v1/tokens");
        expect(String(init?.body)).toContain("user@example.com");
        return Response.json({
          access_token: "access-token",
          expires_in: 3600,
          userId: "user-123",
        });
      },
    );

    expect(provider.validate()).toBeNull();

    const setup = provider.authSetup();
    if (!setup.automatedLogin) throw new Error("automatedLogin not defined");

    const tokenSet = await setup.automatedLogin("user@example.com", "password");

    expect(tokenSet.accessToken).toBe("access-token");
    expect(tokenSet.refreshToken).toBeNull();
    expect(tokenSet.scopes).toBe("userId:user-123");
    expect(tokenSet.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("surfaces credential login failures from the Eight Sleep auth API", async () => {
    const provider = new EightSleepProvider(async () => {
      return new Response("invalid credentials", { status: 401 });
    });
    const setup = provider.authSetup();
    if (!setup.automatedLogin) throw new Error("automatedLogin not defined");

    await expect(setup.automatedLogin("user@example.com", "wrong-password")).rejects.toThrow(
      "Eight Sleep sign-in failed (401): invalid credentials",
    );
  });

  it("returns an auth error when no stored tokens exist", async () => {
    const { db, spies } = createMockDatabase();
    const provider = new EightSleepProvider(async () => {
      throw new Error("fetch should not be called without tokens");
    });

    const result = await provider.sync(createSyncRun(db));

    expect(result.provider).toBe("eight-sleep");
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("not connected");
    expect(spies.execute).toHaveBeenCalled();
  });

  it("fails loudly when the provider row cannot be ensured", async () => {
    const { db, spies } = createMockDatabase();
    spies.execute.mockRejectedValueOnce(new Error("provider table unavailable"));
    const provider = new EightSleepProvider(async () => {
      throw new Error("fetch should not be called when provider setup fails");
    });

    await expect(provider.sync(createSyncRun(db))).rejects.toThrow(
      "ensureProvider(eight-sleep) failed",
    );
  });

  it("returns an auth error when stored token scopes do not include the Eight Sleep user ID", async () => {
    const { db } = createMockDatabase({
      tokensResult: [validEightSleepTokenRow({ scopes: "profile" })],
    });
    const provider = new EightSleepProvider(async () => {
      throw new Error("fetch should not be called without a user ID");
    });

    const result = await provider.sync(createSyncRun(db));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("user ID not found");
  });

  it("returns an auth error when stored Eight Sleep tokens are expired", async () => {
    const { db } = createMockDatabase({
      tokensResult: [validEightSleepTokenRow({ expiresAt: new Date("2020-01-01T00:00:00Z") })],
    });
    const provider = new EightSleepProvider(async () => {
      throw new Error("fetch should not be called with expired tokens");
    });

    const result = await provider.sync(createSyncRun(db));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("access token expired");
  });

  it("syncs parsed sleep, daily metrics, temperature, and heart-rate rows", async () => {
    const { db, spies } = createMockDatabase({
      tokensResult: [validEightSleepTokenRow()],
    });
    const metricStreamCapture = createCapturingMetricStreamPublisher();
    const provider = new EightSleepProvider(createEightSleepTrendsFetch([sampleTrendDay]));

    const result = await provider.sync(createSyncRun(db, metricStreamCapture.publisher));

    expect(result.provider).toBe("eight-sleep");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(7);
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "eight-sleep",
        externalId: "eightsleep-2026-03-01",
        startedAt: new Date("2026-02-28T23:00:00.000Z"),
        endedAt: new Date("2026-03-01T07:00:00.000Z"),
        durationMinutes: 420,
        deepMinutes: 120,
        remMinutes: 90,
        lightMinutes: 180,
        awakeMinutes: 60,
      }),
    );
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        date: "2026-03-01",
        providerId: "eight-sleep",
        hrv: 45.2,
        respiratoryRateAvg: 15.3,
        skinTempC: 28.5,
      }),
    );

    expect(metricStreamCapture.publishedMetricStreamRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: "eight-sleep",
          externalId: "eightsleep-temp-2026-03-01",
          channel: "body_temperature",
          scalar: 28.5,
        }),
        expect.objectContaining({
          providerId: "eight-sleep",
          channel: "heart_rate",
          scalar: 58,
        }),
        expect.objectContaining({
          providerId: "eight-sleep",
          channel: "heart_rate",
          scalar: 48,
        }),
      ]),
    );
  });

  it("skips processing days and trend days without data to store", async () => {
    const { db, spies } = createMockDatabase({
      tokensResult: [validEightSleepTokenRow()],
    });
    const metricStreamCapture = createCapturingMetricStreamPublisher();
    const provider = new EightSleepProvider(
      createEightSleepTrendsFetch([
        makeTrendDay({ day: "2026-03-01", processing: true }),
        makeTrendDay({
          day: "2026-03-02",
          presenceStart: "",
          presenceEnd: "",
          sleepQualityScore: undefined,
          sessions: undefined,
        }),
      ]),
    );

    const result = await provider.sync(createSyncRun(db, metricStreamCapture.publisher));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
    expect(metricStreamCapture.publishedMetricStreamRows).toHaveLength(0);
    expect(spies.values).not.toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "eightsleep-2026-03-01" }),
    );
    expect(spies.values).not.toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "eightsleep-2026-03-02" }),
    );
  });

  it("syncs bed temperature with a day timestamp when presenceStart is absent", async () => {
    const { db } = createMockDatabase({
      tokensResult: [validEightSleepTokenRow()],
    });
    const metricStreamCapture = createCapturingMetricStreamPublisher();
    const provider = new EightSleepProvider(
      createEightSleepTrendsFetch([
        makeTrendDay({
          day: "2026-03-03",
          presenceStart: "",
          presenceEnd: "",
          sessions: [],
          sleepQualityScore: {
            total: 0,
            tempBedC: { average: 31.4 },
          },
        }),
      ]),
    );

    const result = await provider.sync(createSyncRun(db, metricStreamCapture.publisher));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(2);
    expect(metricStreamCapture.publishedMetricStreamRows).toContainEqual(
      expect.objectContaining({
        channel: "body_temperature",
        externalId: "eightsleep-temp-2026-03-03",
        recordedAt: "2026-03-03T00:00:00.000Z",
        scalar: 31.4,
      }),
    );
  });

  it("captures temperature publisher failures and continues remaining sync sections", async () => {
    const { db } = createMockDatabase({
      tokensResult: [validEightSleepTokenRow()],
    });
    const provider = new EightSleepProvider(
      createEightSleepTrendsFetch([
        makeTrendDay({
          day: "2026-03-04",
          sessions: [],
          sleepQualityScore: {
            total: 0,
            tempBedC: { average: 31.8 },
          },
        }),
      ]),
    );

    const result = await provider.sync(
      createSyncRun(db, createRejectingMetricStreamPublisher("temperature publish failed")),
    );

    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      message: "temperature publish failed",
      externalId: "eightsleep-temp-2026-03-04",
    });
  });

  it("captures sleep and daily metric row persistence failures", async () => {
    const { db } = createMockDatabase({
      tokensResult: [validEightSleepTokenRow()],
      insertErrorAfterCalls: 0,
      insertError: new Error("database unavailable"),
    });
    const provider = new EightSleepProvider(
      createEightSleepTrendsFetch([
        makeTrendDay({
          day: "2026-03-05",
          sleepQualityScore: {
            total: 0,
            hrv: { score: 80, current: 44, average: 40 },
          },
          sessions: [],
        }),
      ]),
    );

    const result = await provider.sync(createSyncRun(db));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "database unavailable",
          externalId: "eightsleep-2026-03-05",
        }),
        expect.objectContaining({
          message: "daily 2026-03-05: database unavailable",
        }),
      ]),
    );
  });

  it("captures sleep, daily, and temperature sync-log failures at the section level", async () => {
    const { db, spies } = createMockDatabase({
      tokensResult: [validEightSleepTokenRow()],
    });
    spies.values.mockImplementation((value?: Record<string, unknown>) => {
      if (
        value?.dataType === "sleep" ||
        value?.dataType === "daily_metrics" ||
        value?.dataType === "metric_stream"
      ) {
        throw new Error(`${value.dataType} sync log failed`);
      }
      return {
        onConflictDoNothing: spies.onConflictDoNothing,
        onConflictDoUpdate: spies.onConflictDoUpdate,
      };
    });
    const provider = new EightSleepProvider(
      createEightSleepTrendsFetch([
        makeTrendDay({
          day: "2026-03-06",
          presenceStart: "",
          presenceEnd: "",
          sleepQualityScore: undefined,
          sessions: [],
        }),
      ]),
    );

    const result = await provider.sync(createSyncRun(db));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "sleep: sleep sync log failed",
        }),
        expect.objectContaining({
          message: "daily_metrics: daily_metrics sync log failed",
        }),
        expect.objectContaining({
          message: "metric_stream: metric_stream sync log failed",
        }),
      ]),
    );
  });

  it("captures heart-rate stream publisher failures from the sync section", async () => {
    const { db } = createMockDatabase({
      tokensResult: [validEightSleepTokenRow()],
    });
    const provider = new EightSleepProvider(
      createEightSleepTrendsFetch([
        makeTrendDay({
          day: "2026-03-05",
          presenceStart: "",
          presenceEnd: "",
          sleepQualityScore: undefined,
          sessions: [
            {
              stages: [],
              timeseries: {
                heartRate: [["2026-03-05T02:00:00.000Z", 54]],
              },
            },
          ],
        }),
      ]),
    );

    const result = await provider.sync(
      createSyncRun(db, createRejectingMetricStreamPublisher("heart-rate publish failed")),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("hr_stream: heart-rate publish failed");
  });

  it("returns a getTrends error without attempting data inserts when the API fails", async () => {
    const { db, spies } = createMockDatabase({
      tokensResult: [validEightSleepTokenRow()],
    });
    const provider = new EightSleepProvider(async () => {
      return new Response("upstream down", { status: 500 });
    });

    const result = await provider.sync(createSyncRun(db));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("getTrends: Eight Sleep API error (500): upstream down");
    expect(spies.execute).toHaveBeenCalled();
    expect(spies.values).not.toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "eightsleep-2026-03-01" }),
    );
  });
});
