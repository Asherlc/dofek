import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/provider-data-deletion.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

const providerActivityAbsenceMocks = vi.hoisted(() => ({
  markProviderActivityAbsent: vi.fn().mockResolvedValue(undefined),
  finishProviderActivityListSync: vi.fn().mockResolvedValue(undefined),
  upsertProviderActivity: vi.fn().mockResolvedValue({ id: "10000000-0000-4000-8000-000000000001" }),
}));

const { publishedMetricStreamBatches, publishedMetricStreamReplacements } = vi.hoisted<{
  publishedMetricStreamBatches: unknown[][];
  publishedMetricStreamReplacements: Array<{ scope: unknown; rows: unknown[] }>;
}>(() => ({
  publishedMetricStreamBatches: [],
  publishedMetricStreamReplacements: [],
}));

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "00000000-0000-0000-0000-000000000001",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

vi.mock("../db/provider-activity-sync.ts", () => ({
  markProviderActivityAbsent: providerActivityAbsenceMocks.markProviderActivityAbsent,
  finishProviderActivityListSync: providerActivityAbsenceMocks.finishProviderActivityListSync,
  upsertProviderActivity: providerActivityAbsenceMocks.upsertProviderActivity,
}));

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
    replaceRows: async (_scope: unknown, rows: readonly Record<string, unknown>[]) => {
      publishedMetricStreamReplacements.push({ scope: _scope, rows: [...rows] });
      publishedMetricStreamBatches.push([...rows]);
      return {
        deleted: {
          version: 1,
          eventType: "metric_stream_deleted",
          partitionKey: "test",
          scope: _scope,
        },
        rows: rows.map((row, index) => ({
          version: 1,
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          recordedAt:
            row.recordedAt instanceof Date ? row.recordedAt.toISOString() : row.recordedAt,
        })),
      };
    },
  }),
}));

import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import type { SyncDatabase } from "../db/index.ts";
import {
  mapStravaActivityType,
  parseStravaActivity,
  parseStravaActivityList,
  STRAVA_THROTTLE_MS,
  type StravaActivity,
  StravaClient,
  type StravaDetailedActivity,
  StravaNotFoundError,
  StravaProvider,
  StravaRateLimitError,
  type StravaStreamSet,
  StravaUnauthorizedError,
  stravaOAuthConfig,
  stravaStreamsToMetricStream,
} from "./strava.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { makeTransactionalTestDatabase } from "./test-helpers.ts";

beforeEach(() => {
  publishedMetricStreamBatches.length = 0;
  publishedMetricStreamReplacements.length = 0;
  providerActivityAbsenceMocks.markProviderActivityAbsent.mockClear();
  providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
  providerActivityAbsenceMocks.upsertProviderActivity.mockClear();
  providerActivityAbsenceMocks.upsertProviderActivity.mockResolvedValue({
    id: "10000000-0000-4000-8000-000000000001",
  });
});

const sampleActivity: StravaActivity = {
  id: 12345678,
  name: "Morning Ride",
  type: "Ride",
  sport_type: "Ride",
  start_date: "2026-03-01T08:00:00Z",
  elapsed_time: 3700,
  moving_time: 3600,
  distance: 42000.5,
  total_elevation_gain: 350.2,
  average_speed: 11.67,
  max_speed: 15.5,
  average_heartrate: 155,
  max_heartrate: 178,
  average_watts: 220,
  max_watts: 450,
  weighted_average_watts: 235,
  kilojoules: 792,
  average_cadence: 88,
  suffer_score: 120,
  calories: 850,
  start_latlng: [40.7128, -74.006],
  end_latlng: [40.7135, -74.005],
  trainer: false,
  commute: false,
  manual: false,
  gear_id: "b12345",
  device_watts: true,
};

const sampleStreams: StravaStreamSet = {
  time: { data: [0, 1, 2, 3], series_type: "time", resolution: "high", original_size: 4 },
  heartrate: {
    data: [130, 132, 135, 138],
    series_type: "time",
    resolution: "high",
    original_size: 4,
  },
  watts: { data: [200, 210, 205, 215], series_type: "time", resolution: "high", original_size: 4 },
  cadence: { data: [85, 86, 88, 87], series_type: "time", resolution: "high", original_size: 4 },
  velocity_smooth: {
    data: [8.5, 8.7, 8.6, 8.8],
    series_type: "time",
    resolution: "high",
    original_size: 4,
  },
  latlng: {
    data: [
      [40.7128, -74.006],
      [40.7129, -74.0059],
      [40.713, -74.0058],
      [40.7131, -74.0057],
    ],
    series_type: "time",
    resolution: "high",
    original_size: 4,
  },
  altitude: {
    data: [15.2, 15.5, 15.8, 16.0],
    series_type: "time",
    resolution: "high",
    original_size: 4,
  },
  distance: {
    data: [0, 8.5, 17.2, 26.0],
    series_type: "time",
    resolution: "high",
    original_size: 4,
  },
  temp: { data: [22, 22, 22, 23], series_type: "time", resolution: "high", original_size: 4 },
  grade_smooth: {
    data: [0.5, 1.0, 1.2, 0.8],
    series_type: "time",
    resolution: "high",
    original_size: 4,
  },
};

describe("Strava Provider", () => {
  describe("mapStravaActivityType", () => {
    it("maps common Strava types to canonical types", () => {
      expect(mapStravaActivityType("Ride").canonicalType).toBe("cycling");
      expect(mapStravaActivityType("VirtualRide").canonicalType).toBe("cycling");
      expect(mapStravaActivityType("MountainBikeRide").canonicalType).toBe("cycling");
      expect(mapStravaActivityType("GravelRide").canonicalType).toBe("cycling");
      expect(mapStravaActivityType("EBikeRide").canonicalType).toBe("cycling");
      expect(mapStravaActivityType("Run").canonicalType).toBe("running");
      expect(mapStravaActivityType("VirtualRun").canonicalType).toBe("running");
      expect(mapStravaActivityType("TrailRun").canonicalType).toBe("running");
      expect(mapStravaActivityType("Walk").canonicalType).toBe("walking");
      expect(mapStravaActivityType("Hike").canonicalType).toBe("hiking");
      expect(mapStravaActivityType("Swim").canonicalType).toBe("swimming");
      expect(mapStravaActivityType("WeightTraining").canonicalType).toBe("strength");
      expect(mapStravaActivityType("Yoga").canonicalType).toBe("yoga");
      expect(mapStravaActivityType("Rowing").canonicalType).toBe("rowing");
      expect(mapStravaActivityType("Elliptical").canonicalType).toBe("elliptical");
      expect(mapStravaActivityType("NordicSki").canonicalType).toBe("skiing");
      expect(mapStravaActivityType("AlpineSki").canonicalType).toBe("skiing");
      expect(mapStravaActivityType("Ride").modality).toBe("road");
      expect(mapStravaActivityType("VirtualRide").modality).toBe("virtual");
      expect(mapStravaActivityType("EBikeRide").modality).toBe("electric");
    });

    it("returns 'other' for unknown types", () => {
      expect(mapStravaActivityType("Handcycle").canonicalType).toBe("other");
      expect(mapStravaActivityType("UnknownSport").canonicalType).toBe("other");
    });

    it("uses indoor cycling for trainer rides only", () => {
      expect(mapStravaActivityType("Ride", true)).toMatchObject({
        canonicalType: "cycling",
        modality: "indoor",
        providerType: "Ride",
      });
      expect(mapStravaActivityType("Run", true).canonicalType).toBe("running");
    });
  });

  describe("parseStravaActivity", () => {
    it("maps Strava activity to parsed activity fields", () => {
      const result = parseStravaActivity(sampleActivity);

      expect(result.externalId).toBe("12345678");
      expect(result.activityType.canonicalType).toBe("cycling");
      expect(result.name).toBe("Morning Ride");
      expect(result.startedAt).toEqual(new Date("2026-03-01T08:00:00Z"));
      expect(result.endedAt).toEqual(
        new Date(new Date("2026-03-01T08:00:00Z").getTime() + 3700 * 1000),
      );
      expect(result.sourceName).toBeUndefined();
    });

    it("extracts sourceName from device_name on detailed activity", () => {
      const detailed: StravaDetailedActivity = {
        ...sampleActivity,
        device_name: "Garmin Edge 530",
      };
      const result = parseStravaActivity(detailed);
      expect(result.sourceName).toBe("Garmin Edge 530");
    });

    it("extracts sourceName for iPhone recordings", () => {
      const detailed: StravaDetailedActivity = {
        ...sampleActivity,
        device_name: "iPhone",
      };
      const result = parseStravaActivity(detailed);
      expect(result.sourceName).toBe("iPhone");
    });

    it("handles missing optional fields", () => {
      const minimal: StravaActivity = {
        id: 99999,
        name: "Quick Run",
        type: "Run",
        sport_type: "Run",
        start_date: "2026-03-05T14:00:00Z",
        elapsed_time: 1800,
        moving_time: 1750,
        distance: 5000,
        total_elevation_gain: 10,
        trainer: false,
        commute: false,
        manual: false,
      };

      const result = parseStravaActivity(minimal);

      expect(result.externalId).toBe("99999");
      expect(result.activityType.canonicalType).toBe("running");
      expect(result.startedAt).toEqual(new Date("2026-03-05T14:00:00Z"));
      expect(result.sourceName).toBeUndefined();
    });

    it("uses sport_type for type mapping", () => {
      const trailRun: StravaActivity = {
        ...sampleActivity,
        type: "Run",
        sport_type: "TrailRun",
      };
      const result = parseStravaActivity(trailRun);
      expect(result.activityType.canonicalType).toBe("running");
    });
  });

  describe("parseStravaActivityList", () => {
    it("parses a list of activities", () => {
      const activities = [sampleActivity];
      const result = parseStravaActivityList(activities, 30);

      expect(result.activities).toHaveLength(1);
      expect(result.hasMore).toBe(false);
    });

    it("detects more pages when result count equals per_page", () => {
      const activities = Array.from({ length: 30 }, (_, i) => ({
        ...sampleActivity,
        id: i + 1,
      }));
      const result = parseStravaActivityList(activities, 30);

      expect(result.hasMore).toBe(true);
    });

    it("handles empty response", () => {
      const result = parseStravaActivityList([], 30);

      expect(result.activities).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });
  });

  describe("stravaStreamsToMetricStream", () => {
    const startedAt = new Date("2026-03-01T08:00:00Z");

    it("maps stream arrays to metric_stream rows using time offsets", () => {
      const rows = stravaStreamsToMetricStream(sampleStreams, "strava", "act-uuid", startedAt);

      expect(rows).toHaveLength(4);

      expect(rows[0]?.providerId).toBe("strava");
      expect(rows[0]?.activityId).toBe("act-uuid");
      expect(rows[0]?.recordedAt).toEqual(new Date(startedAt.getTime() + 0));
      expect(rows[0]?.heartRate).toBe(130);
      expect(rows[0]?.power).toBe(200);
      expect(rows[0]?.cadence).toBe(85);
      expect(rows[0]?.speed).toBe(8.5);
      expect(rows[0]?.lat).toBe(40.7128);
      expect(rows[0]?.lng).toBe(-74.006);
      expect(rows[0]?.altitude).toBe(15.2);
      expect(rows[0]?.temperature).toBe(22);
      expect(rows[0]?.grade).toBe(0.5);
    });

    it("handles second data point correctly", () => {
      const rows = stravaStreamsToMetricStream(sampleStreams, "strava", "act-uuid", startedAt);

      expect(rows[1]?.recordedAt).toEqual(new Date(startedAt.getTime() + 1000));
      expect(rows[1]?.heartRate).toBe(132);
      expect(rows[1]?.power).toBe(210);
      expect(rows[1]?.lat).toBe(40.7129);
      expect(rows[1]?.lng).toBe(-74.0059);
    });

    it("handles missing stream types gracefully", () => {
      const partialStreams: StravaStreamSet = {
        time: {
          data: [0, 1],
          series_type: "time",
          resolution: "high",
          original_size: 2,
        },
        heartrate: {
          data: [130, 132],
          series_type: "time",
          resolution: "high",
          original_size: 2,
        },
      };

      const rows = stravaStreamsToMetricStream(partialStreams, "strava", "act-uuid", startedAt);

      expect(rows).toHaveLength(2);
      expect(rows[0]?.heartRate).toBe(130);
      expect(rows[0]?.power).toBeUndefined();
      expect(rows[0]?.lat).toBeUndefined();
      expect(rows[0]?.altitude).toBeUndefined();
      // raw should only include keys for streams that are present
      expect(rows[0]?.raw).toEqual({ time: 0, heartrate: 130 });
    });

    it("omits all optional fields when only time stream is present", () => {
      const timeOnly: StravaStreamSet = {
        time: {
          data: [0],
          series_type: "time",
          resolution: "high",
          original_size: 1,
        },
      };

      const rows = stravaStreamsToMetricStream(timeOnly, "strava", "act-uuid", startedAt);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.heartRate).toBeUndefined();
      expect(rows[0]?.power).toBeUndefined();
      expect(rows[0]?.lat).toBeUndefined();
      expect(rows[0]?.lng).toBeUndefined();
      expect(rows[0]?.raw).toEqual({ time: 0 });
    });

    it("returns empty array when no time stream", () => {
      const noTime: StravaStreamSet = {};
      const rows = stravaStreamsToMetricStream(noTime, "strava", "act-uuid", startedAt);
      expect(rows).toHaveLength(0);
    });

    it("returns empty array when time stream data is empty", () => {
      const emptyTime: StravaStreamSet = {
        time: { data: [], series_type: "time", resolution: "high", original_size: 0 },
      };
      const rows = stravaStreamsToMetricStream(emptyTime, "strava", "act-uuid", startedAt);
      expect(rows).toHaveLength(0);
    });

    it("omits heartrate from raw when heartrate stream is absent", () => {
      const noHr: StravaStreamSet = {
        time: { data: [0], series_type: "time", resolution: "high", original_size: 1 },
      };
      const rows = stravaStreamsToMetricStream(noHr, "strava", "act-uuid", startedAt);
      expect(rows[0]?.heartRate).toBeUndefined();
      expect(rows[0]?.raw).not.toHaveProperty("heartrate");
    });

    it("omits latlng from raw when latlng stream is absent", () => {
      const noLatLng: StravaStreamSet = {
        time: { data: [0], series_type: "time", resolution: "high", original_size: 1 },
        heartrate: { data: [130], series_type: "time", resolution: "high", original_size: 1 },
      };
      const rows = stravaStreamsToMetricStream(noLatLng, "strava", "act-uuid", startedAt);
      expect(rows[0]?.lat).toBeUndefined();
      expect(rows[0]?.raw).not.toHaveProperty("latlng");
    });

    it("includes raw JSONB for every record", () => {
      const rows = stravaStreamsToMetricStream(sampleStreams, "strava", "act-uuid", startedAt);

      expect(rows[0]?.raw).toEqual({
        time: 0,
        heartrate: 130,
        watts: 200,
        cadence: 85,
        velocity_smooth: 8.5,
        latlng: [40.7128, -74.006],
        altitude: 15.2,
        distance: 0,
        temp: 22,
        grade_smooth: 0.5,
      });
    });

    it("omits speed for indoor_cycling activities", () => {
      const rows = stravaStreamsToMetricStream(
        sampleStreams,
        "strava",
        "act-uuid",
        startedAt,
        resolveProviderActivityType("Ride", "indoor_cycling"),
      );
      expect(rows[0]?.speed).toBeUndefined();
      expect(rows[1]?.speed).toBeUndefined();
      // Other fields should still be present
      expect(rows[0]?.heartRate).toBe(130);
      expect(rows[0]?.power).toBe(200);
    });

    it("omits speed for virtual_cycling activities", () => {
      const rows = stravaStreamsToMetricStream(
        sampleStreams,
        "strava",
        "act-uuid",
        startedAt,
        resolveProviderActivityType("VirtualRide", "virtual_cycling"),
      );
      expect(rows[0]?.speed).toBeUndefined();
    });

    it("keeps speed for outdoor cycling activities", () => {
      const rows = stravaStreamsToMetricStream(
        sampleStreams,
        "strava",
        "act-uuid",
        startedAt,
        resolveProviderActivityType("Ride", "road_cycling"),
      );
      expect(rows[0]?.speed).toBe(8.5);
    });
  });
});

// ============================================================
// Auth, validation, and client tests (merged from strava-coverage)
// ============================================================

describe("stravaOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when STRAVA_CLIENT_ID is not set", () => {
    delete process.env.STRAVA_CLIENT_ID;
    delete process.env.STRAVA_CLIENT_SECRET;
    expect(stravaOAuthConfig()).toBeNull();
  });

  it("returns null when STRAVA_CLIENT_SECRET is not set", () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    delete process.env.STRAVA_CLIENT_SECRET;
    expect(stravaOAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    const config = stravaOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toEqual(["read", "activity:read_all"]);
    expect(config?.scopeSeparator).toBe(",");
  });

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = stravaOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when OAUTH_REDIRECT_URI is not set", () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;
    const config = stravaOAuthConfig();
    expect(config?.redirectUri).toBe("https://dofek.fit/callback");
  });
});

describe("StravaProvider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when STRAVA_CLIENT_ID is missing", () => {
    delete process.env.STRAVA_CLIENT_ID;
    delete process.env.STRAVA_CLIENT_SECRET;
    const provider = new StravaProvider();
    expect(provider.validate()).toContain("STRAVA_CLIENT_ID");
  });

  it("returns error when STRAVA_CLIENT_SECRET is missing", () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    delete process.env.STRAVA_CLIENT_SECRET;
    const provider = new StravaProvider();
    expect(provider.validate()).toContain("STRAVA_CLIENT_SECRET");
  });

  it("returns null when both are set", () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    const provider = new StravaProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("StravaProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    const provider = new StravaProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig?.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.revokeExistingTokens).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toBe("https://www.strava.com/api/v3/");
    expect(setup.identityCapabilities?.providesEmail).toBe(false);
    expect(setup.oauthConfig?.authorizeUrl).toBe("https://www.strava.com/oauth/authorize");
    expect(setup.oauthConfig?.tokenUrl).toBe("https://www.strava.com/oauth/token");
    expect(setup.oauthConfig?.scopes).toEqual(["read", "activity:read_all"]);
    expect(setup.reconnectStrategy).toBeUndefined();
  });

  it("revokes the Strava grant with the current idempotent endpoint", async () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    const requests: Array<{ authorization: string | null; body: string; url: string }> = [];
    const provider = new StravaProvider(async (input, init) => {
      requests.push({
        authorization: new Headers(init?.headers).get("authorization"),
        body: String(init?.body),
        url: String(input),
      });
      return new Response(null, { status: 200 });
    });
    const revoke = provider.authSetup().revokeExistingTokens;
    if (!revoke) throw new Error("Expected Strava token revocation");

    await revoke({
      accessToken: "strava-access",
      expiresAt: new Date("2026-07-26T12:00:00.000Z"),
      refreshToken: "strava-refresh",
      scopes: "read,activity:read_all",
    });

    expect(requests).toEqual([
      {
        authorization: `Basic ${Buffer.from("test-id:test-secret").toString("base64")}`,
        body: "token=strava-refresh&token_type_hint=refresh_token",
        url: "https://www.strava.com/oauth/revoke",
      },
    ]);
  });

  it("throws when env vars are missing", () => {
    delete process.env.STRAVA_CLIENT_ID;
    delete process.env.STRAVA_CLIENT_SECRET;
    const provider = new StravaProvider();
    expect(() => provider.authSetup()).toThrow("STRAVA_CLIENT_ID");
  });

  it("accepts only Strava's documented 200 revocation response", async () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    const provider = new StravaProvider(async () => new Response(null, { status: 204 }));
    const revoke = provider.authSetup().revokeExistingTokens;
    if (!revoke) throw new Error("Expected Strava token revocation");

    await expect(
      revoke({
        accessToken: "strava-access",
        expiresAt: new Date("2026-07-26T12:00:00.000Z"),
        refreshToken: null,
        scopes: "read",
      }),
    ).rejects.toThrow("Strava token revocation failed (204)");
  });
});

describe("StravaClient.getActivity", () => {
  it("fetches the detailed activity by ID", async () => {
    const mockFetch: typeof globalThis.fetch = async (url): Promise<Response> => {
      expect(String(url)).toContain("activities/12345678");
      return Response.json({
        ...sampleActivity,
        device_name: "Garmin Edge 530",
        description: "Great ride",
      });
    };

    const client = new StravaClient("token", mockFetch);
    const result = await client.getActivity(12345678);
    expect(result.device_name).toBe("Garmin Edge 530");
    expect(result.id).toBe(12345678);
  });

  it("returns undefined device_name when not present", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json(sampleActivity);
    };

    const client = new StravaClient("token", mockFetch);
    const result = await client.getActivity(12345678);
    expect(result.device_name).toBeUndefined();
  });
});

describe("StravaClient — error handling", () => {
  it("throws StravaRateLimitError on 429", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Rate Limit Exceeded", { status: 429 });
    };

    const client = new StravaClient("token", mockFetch);
    const err = await client.getActivities(0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StravaRateLimitError);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect(err).toHaveProperty("message", expect.stringContaining("(429)"));
  });

  it("parses an HTTP-date Retry-After header into seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-01-15T00:00:00Z"));
    const retryAt = new Date("2024-01-15T00:01:00Z").toUTCString();
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Rate Limit Exceeded", {
        status: 429,
        headers: { "Retry-After": retryAt },
      });
    };

    const client = new StravaClient("token", mockFetch);
    const err = await client.getActivities(0).catch((caughtError: unknown) => caughtError);
    expect(err).toBeInstanceOf(StravaRateLimitError);
    expect(err).toHaveProperty("retryAfterSeconds", 60);
    vi.useRealTimers();
  });

  it("throws generic error on non-OK, non-429 response", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Server Error", { status: 500 });
    };

    const client = new StravaClient("token", mockFetch);
    await expect(client.getActivities(0)).rejects.toThrow("Strava API error (500): Server Error");
  });

  it("throws StravaNotFoundError for HTML 404 responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("<html><body>Not Found</body></html>", {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    };

    const client = new StravaClient("token", mockFetch);
    const err = await client.getActivities(0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StravaNotFoundError);
    expect(err).toHaveProperty("message", expect.stringContaining("/athlete/activities"));
  });

  it("throws StravaNotFoundError for JSON 404 responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ message: "Not Found", errors: [] }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    };

    const client = new StravaClient("token", mockFetch);
    const err = await client.getActivities(0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StravaNotFoundError);
    expect(err).toHaveProperty("message", expect.stringContaining("/athlete/activities"));
  });

  it("throws StravaUnauthorizedError for 401 responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ message: "Authorization Error" }), {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    };

    const client = new StravaClient("token", mockFetch);
    const err = await client.getActivities(0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StravaUnauthorizedError);
    expect(err).toHaveProperty("message", expect.stringContaining("unauthorized (401)"));
  });

  it("throws StravaUnauthorizedError for 403 responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Forbidden", { status: 403 });
    };

    const client = new StravaClient("token", mockFetch);
    const err = await client.getActivities(0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StravaUnauthorizedError);
    expect(err).toHaveProperty("message", expect.stringContaining("unauthorized (403)"));
  });

  it("formats JSON error payloads in generic API errors", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ message: "bad request" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new StravaClient("token", mockFetch);
    await expect(client.getActivities(0)).rejects.toThrow(
      'Strava API error (500): {"message":"bad request"}',
    );
  });

  it("redacts HTML error payloads in generic API errors", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("<html><body>Oops</body></html>", {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    };

    const client = new StravaClient("token", mockFetch);
    await expect(client.getActivities(0)).rejects.toThrow(
      "Strava API error (500): (HTML error page)",
    );
  });

  it("truncates long plain-text error responses", async () => {
    const longText = "x".repeat(300);
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(longText, { status: 500 });
    };

    const client = new StravaClient("token", mockFetch);
    await expect(client.getActivities(0)).rejects.toThrow(
      `Strava API error (500): ${"x".repeat(200)}…`,
    );
  });
});

describe("StravaClient — request throttling", () => {
  it("does not delay the first request", async () => {
    vi.useFakeTimers();
    const callTimestamps: number[] = [];
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      callTimestamps.push(Date.now());
      return Response.json([]);
    };

    const client = new StravaClient("token", mockFetch);
    const pendingRequest = client.getActivities(0);
    await vi.advanceTimersByTimeAsync(0);
    await pendingRequest;

    expect(callTimestamps).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe("StravaRateLimitError", () => {
  it("has correct name and message", () => {
    const error = new StravaRateLimitError("Rate limited");
    expect(error.name).toBe("StravaRateLimitError");
    expect(error.message).toBe("Rate limited");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error.providerId).toBe("strava");
  });
});

describe("StravaNotFoundError", () => {
  it("has correct name and message", () => {
    const error = new StravaNotFoundError("Not found");
    expect(error.name).toBe("StravaNotFoundError");
    expect(error.message).toBe("Not found");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("StravaUnauthorizedError", () => {
  it("has correct name and message", () => {
    const error = new StravaUnauthorizedError("Unauthorized");
    expect(error.name).toBe("StravaUnauthorizedError");
    expect(error.message).toBe("Unauthorized");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("StravaProvider.getUserIdentity()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns identity from athlete API without relying on email", async () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";

    let calledUrl = "";
    let calledHeaders: HeadersInit | undefined;
    const mockFetch: typeof globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calledUrl = String(input);
      calledHeaders = init?.headers;
      return Response.json({
        id: 12345,
        email: "athlete@test.com",
        firstname: "Jane",
        lastname: "Doe",
      });
    };

    const provider = new StravaProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");
    const identity = await setup.getUserIdentity("test-token");
    expect(calledUrl).toBe("https://www.strava.com/api/v3/athlete");
    expect(calledHeaders).toEqual(expect.objectContaining({ Authorization: "Bearer test-token" }));
    expect(identity.providerAccountId).toBe("12345");
    expect(identity.email).toBeNull();
    expect(identity.emailVerified).toBe(false);
    expect(identity.name).toBe("Jane Doe");
  });

  it("handles missing name fields", async () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({ id: 99 });
    };

    const provider = new StravaProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");
    const identity = await setup.getUserIdentity("test-token");
    expect(identity.providerAccountId).toBe("99");
    expect(identity.email).toBeNull();
    expect(identity.name).toBeNull();
  });

  it("throws on API error", async () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Forbidden", { status: 403 });
    };

    const provider = new StravaProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");
    await expect(setup.getUserIdentity("bad-token")).rejects.toThrow(
      "Strava athlete API error (403)",
    );
  });
});

// ============================================================
// syncWebhookEvent tests
// ============================================================

function makeStravaInsertMock(returnId = "10000000-0000-4000-8000-000000000001") {
  return vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: returnId }]),
      }),
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    }),
  });
}

function makeStravaSelectMock(
  tokenRow: {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date;
    scopes: string;
  } | null,
) {
  const rows = tokenRow ? [tokenRow] : [];
  return vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

const validTokenRow = {
  accessToken: "valid-access-token",
  refreshToken: "valid-refresh-token",
  expiresAt: new Date("2099-01-01T00:00:00Z"),
  scopes: "read activity:read_all",
};

describe("StravaProvider.syncWebhookEvent", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    providerActivityAbsenceMocks.markProviderActivityAbsent.mockClear();
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000001",
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns immediately for non-activity objectType", async () => {
    const provider = new StravaProvider(async () => new Response());
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(
      mockDb,
      {
        ownerExternalId: "123",
        eventType: "create",
        objectType: "athlete",
        objectId: "456",
      },
      { userId: "00000000-0000-0000-0000-000000000001" },
    );

    expect(result.provider).toBe("strava");
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("returns immediately when objectId is missing", async () => {
    const provider = new StravaProvider(async () => new Response());
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(
      mockDb,
      {
        ownerExternalId: "123",
        eventType: "create",
        objectType: "activity",
      },
      { userId: "00000000-0000-0000-0000-000000000001" },
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles delete events by marking activity provider-absent", async () => {
    const provider = new StravaProvider(async () => new Response());

    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(
      mockDb,
      {
        ownerExternalId: "123",
        eventType: "delete",
        objectType: "activity",
        objectId: "99999",
      },
      { userId: "00000000-0000-0000-0000-000000000001" },
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(providerActivityAbsenceMocks.markProviderActivityAbsent).toHaveBeenCalledWith(mockDb, {
      providerId: "strava",
      externalId: "99999",
      userId: "00000000-0000-0000-0000-000000000001",
    });
    expect(publishedMetricStreamReplacements).toEqual([]);
    expect(publishedMetricStreamBatches).toEqual([]);
  });

  it("handles delete event when activity not found", async () => {
    const provider = new StravaProvider(async () => new Response());

    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(
      mockDb,
      {
        ownerExternalId: "123",
        eventType: "delete",
        objectType: "activity",
        objectId: "nonexistent",
      },
      { userId: "00000000-0000-0000-0000-000000000001" },
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(providerActivityAbsenceMocks.markProviderActivityAbsent).toHaveBeenCalledWith(mockDb, {
      providerId: "strava",
      externalId: "nonexistent",
      userId: "00000000-0000-0000-0000-000000000001",
    });
  });

  it("returns error when token resolution fails", async () => {
    const provider = new StravaProvider(async () => new Response());
    const mockDb = {
      select: makeStravaSelectMock(null),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(
      mockDb,
      {
        ownerExternalId: "123",
        eventType: "create",
        objectType: "activity",
        objectId: "12345",
      },
      { userId: "00000000-0000-0000-0000-000000000001" },
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
  });

  it("upserts activity and streams on create/update happy path", async () => {
    const detailedActivity: StravaDetailedActivity = {
      ...sampleActivity,
      device_name: "Garmin Edge 530",
    };

    const streamResponse = [
      { type: "time", data: [0, 1], series_type: "time", resolution: "high", original_size: 2 },
      {
        type: "heartrate",
        data: [130, 135],
        series_type: "time",
        resolution: "high",
        original_size: 2,
      },
    ];

    const mockFetch: typeof globalThis.fetch = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = String(input);
      if (url.includes("activities/12345678/streams")) {
        return Response.json(streamResponse);
      }
      if (url.includes("activities/12345678")) {
        return Response.json(detailedActivity);
      }
      return new Response("Not Found", { status: 404 });
    };

    const mockInsert = makeStravaInsertMock();
    const mockDelete = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });

    const mockDb = makeTransactionalTestDatabase({
      select: makeStravaSelectMock(validTokenRow),
      insert: mockInsert,
      delete: mockDelete,
      execute: vi.fn().mockResolvedValue([]),
    });

    const provider = new StravaProvider(mockFetch);
    const result = await provider.syncWebhookEvent(
      mockDb,
      {
        ownerExternalId: "123",
        eventType: "create",
        objectType: "activity",
        objectId: "12345678",
      },
      { userId: "00000000-0000-0000-0000-000000000001" },
    );

    expect(result.provider).toBe("strava");
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        externalId: "12345678",
        sourceName: "Garmin Edge 530",
      }),
      expect.objectContaining({
        sourceName: "Garmin Edge 530",
      }),
    );
    expect(publishedMetricStreamReplacements).toEqual([
      {
        scope: {
          activityId: "10000000-0000-4000-8000-000000000001",
          userId: "00000000-0000-0000-0000-000000000001",
        },
        rows: [
          expect.objectContaining({
            activityId: "10000000-0000-4000-8000-000000000001",
            providerId: "strava",
            channel: "heart_rate",
          }),
          expect.objectContaining({
            activityId: "10000000-0000-4000-8000-000000000001",
            providerId: "strava",
            channel: "heart_rate",
          }),
        ],
      },
    ]);
  });

  it("handles stream fetch 404 as non-fatal", async () => {
    const detailedActivity: StravaDetailedActivity = {
      ...sampleActivity,
      device_name: "Wahoo ELEMNT",
    };

    const mockFetch: typeof globalThis.fetch = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = String(input);
      if (url.includes("activities/12345678/streams")) {
        // 404 on streams is non-fatal
        return new Response("Not Found", { status: 404 });
      }
      if (url.includes("activities/12345678")) {
        return Response.json(detailedActivity);
      }
      return new Response("Not Found", { status: 404 });
    };

    const mockInsert = makeStravaInsertMock();
    const mockDb = {
      select: makeStravaSelectMock(validTokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn(),
    };

    const provider = new StravaProvider(mockFetch);
    const result = await provider.syncWebhookEvent(
      mockDb,
      {
        ownerExternalId: "123",
        eventType: "update",
        objectType: "activity",
        objectId: "12345678",
      },
      { userId: "00000000-0000-0000-0000-000000000001" },
    );

    // Activity still synced, no errors from 404 streams
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("collects stream fetch errors (non-404) without failing", async () => {
    const detailedActivity: StravaDetailedActivity = {
      ...sampleActivity,
    };

    const mockFetch: typeof globalThis.fetch = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = String(input);
      if (url.includes("activities/12345678/streams")) {
        return new Response("Server Error", { status: 500 });
      }
      if (url.includes("activities/12345678")) {
        return Response.json(detailedActivity);
      }
      return new Response("Not Found", { status: 404 });
    };

    const mockInsert = makeStravaInsertMock();
    const mockDb = {
      select: makeStravaSelectMock(validTokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn(),
    };

    const provider = new StravaProvider(mockFetch);
    const result = await provider.syncWebhookEvent(
      mockDb,
      {
        ownerExternalId: "123",
        eventType: "create",
        objectType: "activity",
        objectId: "12345678",
      },
      { userId: "00000000-0000-0000-0000-000000000001" },
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Streams for activity 12345678");
  });

  it("returns early when activity insert returns no id", async () => {
    const detailedActivity: StravaDetailedActivity = { ...sampleActivity };

    const mockFetch: typeof globalThis.fetch = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = String(input);
      if (url.includes("activities/12345678")) {
        return Response.json(detailedActivity);
      }
      return new Response("Not Found", { status: 404 });
    };

    providerActivityAbsenceMocks.upsertProviderActivity.mockResolvedValueOnce(undefined);

    const mockDb = {
      select: makeStravaSelectMock(validTokenRow),
      insert: vi.fn(),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn(),
    };

    const provider = new StravaProvider(mockFetch);
    const result = await provider.syncWebhookEvent(
      mockDb,
      {
        ownerExternalId: "123",
        eventType: "create",
        objectType: "activity",
        objectId: "12345678",
      },
      { userId: "00000000-0000-0000-0000-000000000001" },
    );

    // recordsSynced is 1 (activity itself counted), but no stream insert
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
  });
});

// ============================================================
// registerWebhook / unregisterWebhook tests
// ============================================================

describe("StravaProvider.registerWebhook", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws when STRAVA_CLIENT_ID is missing", async () => {
    delete process.env.STRAVA_CLIENT_ID;
    delete process.env.STRAVA_CLIENT_SECRET;
    const provider = new StravaProvider(async () => new Response());
    await expect(
      provider.registerWebhook("https://example.com/webhook", "verify-token"),
    ).rejects.toThrow("STRAVA_CLIENT_ID");
  });

  it("throws when registration response is not OK", async () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Conflict", { status: 409 });
    };
    const provider = new StravaProvider(mockFetch);
    await expect(
      provider.registerWebhook("https://example.com/webhook", "verify-token"),
    ).rejects.toThrow("Strava webhook registration failed (409)");
  });

  it("returns subscriptionId on success", async () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({ id: 42 });
    };
    const provider = new StravaProvider(mockFetch);
    const result = await provider.registerWebhook("https://example.com/webhook", "verify-token");
    expect(result.subscriptionId).toBe("42");
  });
});

describe("StravaProvider.unregisterWebhook", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("does nothing when env vars are missing", async () => {
    delete process.env.STRAVA_CLIENT_ID;
    delete process.env.STRAVA_CLIENT_SECRET;
    const mockFetch = vi.fn();
    const provider = new StravaProvider(mockFetch);
    await provider.unregisterWebhook("42");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("succeeds on 200 response", async () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(null, { status: 200 });
    };
    const provider = new StravaProvider(mockFetch);
    // Should not throw
    await provider.unregisterWebhook("42");
  });

  it("treats 404 as OK (already deleted)", async () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Not Found", { status: 404 });
    };
    const provider = new StravaProvider(mockFetch);
    // Should not throw
    await provider.unregisterWebhook("42");
  });

  it("throws on non-OK non-404 response", async () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Server Error", { status: 500 });
    };
    const provider = new StravaProvider(mockFetch);
    await expect(provider.unregisterWebhook("42")).rejects.toThrow(
      "Strava webhook removal failed (500): Server Error",
    );
  });
});

// ============================================================
// Additional precise assertions for mutation killing
// ============================================================

describe("StravaProvider — precise webhook string/object assertions", () => {
  it("parseWebhookPayload maps all three Strava aspect_types correctly", async () => {
    const provider = new StravaProvider(async () => new Response());

    for (const [aspect, expected] of [
      ["create", "create"],
      ["update", "update"],
      ["delete", "delete"],
    ] as const) {
      const events = provider.parseWebhookPayload({
        aspect_type: aspect,
        object_type: "activity",
        owner_id: 1,
        object_id: 100,
      });
      expect(events[0]?.eventType).toBe(expected);
    }
  });

  it("parseWebhookPayload converts owner_id number to string", async () => {
    const provider = new StravaProvider(async () => new Response());
    const events = provider.parseWebhookPayload({
      aspect_type: "create",
      object_type: "activity",
      owner_id: 0, // edge case: zero
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.ownerExternalId).toBe("0");
  });

  it("parseWebhookPayload converts object_id number to string", async () => {
    const provider = new StravaProvider(async () => new Response());
    const events = provider.parseWebhookPayload({
      aspect_type: "create",
      object_type: "activity",
      owner_id: 1,
      object_id: 42,
    });
    expect(events[0]?.objectId).toBe("42");
  });

  it("parseWebhookPayload treats object_id=0 as falsy (undefined)", async () => {
    const provider = new StravaProvider(async () => new Response());
    const events = provider.parseWebhookPayload({
      aspect_type: "create",
      object_type: "activity",
      owner_id: 1,
      object_id: 0, // zero is falsy — ternary produces undefined
    });
    expect(events[0]?.objectId).toBeUndefined();
  });

  it("handleValidationChallenge echoes back the exact challenge string", async () => {
    const provider = new StravaProvider(async () => new Response());
    const result = provider.handleValidationChallenge(
      {
        "hub.mode": "subscribe",
        "hub.challenge": "specific-challenge-123",
        "hub.verify_token": "tok",
      },
      "tok",
    );
    expect(result).toEqual({ "hub.challenge": "specific-challenge-123" });
  });

  it("handleValidationChallenge compares token exactly (not substring)", async () => {
    const provider = new StravaProvider(async () => new Response());
    // Partial match should fail
    const result = provider.handleValidationChallenge(
      { "hub.mode": "subscribe", "hub.challenge": "abc", "hub.verify_token": "tok" },
      "token-longer",
    );
    expect(result).toBeNull();
  });

  it("registerWebhook sends correct form parameters", async () => {
    const originalEnv = { ...process.env };
    process.env.STRAVA_CLIENT_ID = "my-client-id";
    process.env.STRAVA_CLIENT_SECRET = "my-client-secret";

    let capturedBody: URLSearchParams | undefined;
    const mockFetch: typeof globalThis.fetch = async (_url, init): Promise<Response> => {
      capturedBody = new URLSearchParams(String(init?.body));
      return Response.json({ id: 1 });
    };

    const provider = new StravaProvider(mockFetch);
    await provider.registerWebhook("https://example.com/callback", "my-verify-token");

    expect(capturedBody?.get("client_id")).toBe("my-client-id");
    expect(capturedBody?.get("client_secret")).toBe("my-client-secret");
    expect(capturedBody?.get("callback_url")).toBe("https://example.com/callback");
    expect(capturedBody?.get("verify_token")).toBe("my-verify-token");

    process.env = { ...originalEnv };
  });

  it("registerWebhook POST URL is exactly the Strava push subscriptions endpoint", async () => {
    const originalEnv = { ...process.env };
    process.env.STRAVA_CLIENT_ID = "id";
    process.env.STRAVA_CLIENT_SECRET = "secret";

    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (url): Promise<Response> => {
      capturedUrl = String(url);
      return Response.json({ id: 1 });
    };

    const provider = new StravaProvider(mockFetch);
    await provider.registerWebhook("https://example.com/cb", "tok");
    expect(capturedUrl).toBe("https://www.strava.com/api/v3/push_subscriptions");

    process.env = { ...originalEnv };
  });

  it("registerWebhook includes Content-Type header", async () => {
    const originalEnv = { ...process.env };
    process.env.STRAVA_CLIENT_ID = "id";
    process.env.STRAVA_CLIENT_SECRET = "secret";

    let capturedHeaders: HeadersInit | undefined;
    const mockFetch: typeof globalThis.fetch = async (_url, init): Promise<Response> => {
      capturedHeaders = init?.headers;
      return Response.json({ id: 1 });
    };

    const provider = new StravaProvider(mockFetch);
    await provider.registerWebhook("https://example.com/cb", "tok");
    expect(capturedHeaders).toEqual(
      expect.objectContaining({ "Content-Type": "application/x-www-form-urlencoded" }),
    );

    process.env = { ...originalEnv };
  });

  it("unregisterWebhook includes client_id and client_secret as query params", async () => {
    const originalEnv = { ...process.env };
    process.env.STRAVA_CLIENT_ID = "my-id";
    process.env.STRAVA_CLIENT_SECRET = "my-secret";

    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (url): Promise<Response> => {
      capturedUrl = String(url);
      return new Response(null, { status: 200 });
    };

    const provider = new StravaProvider(mockFetch);
    await provider.unregisterWebhook("sub-42");

    const parsed = new URL(capturedUrl);
    expect(parsed.searchParams.get("client_id")).toBe("my-id");
    expect(parsed.searchParams.get("client_secret")).toBe("my-secret");
    expect(parsed.pathname).toContain("push_subscriptions/sub-42");

    process.env = { ...originalEnv };
  });

  it("syncWebhookEvent returns provider as 'strava' for all paths", async () => {
    const provider = new StravaProvider(async () => new Response());
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    // Non-activity path
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "1",
      eventType: "create",
      objectType: "athlete",
    });
    expect(result.provider).toBe("strava");
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.errors).toEqual([]);
  });

  it("syncWebhookEvent delete path returns provider 'strava'", async () => {
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const provider = new StravaProvider(async () => new Response());
    const result = await provider.syncWebhookEvent(
      mockDb,
      {
        ownerExternalId: "1",
        eventType: "delete",
        objectType: "activity",
        objectId: "999",
      },
      { userId: "00000000-0000-0000-0000-000000000001" },
    );
    expect(result.provider).toBe("strava");
    expect(result.recordsSynced).toBe(0);

    expect(providerActivityAbsenceMocks.markProviderActivityAbsent).toHaveBeenCalledWith(mockDb, {
      providerId: "strava",
      externalId: "999",
      userId: "00000000-0000-0000-0000-000000000001",
    });
    expect(publishedMetricStreamReplacements).toEqual([]);
    expect(publishedMetricStreamBatches).toEqual([]);
  });

  it("syncWebhookEvent falls back to token user context when options.userId is missing", async () => {
    const provider = new StravaProvider(async () => new Response());
    const mockDb = { select: vi.fn(), insert: vi.fn(), delete: vi.fn(), execute: vi.fn() };

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "1",
      eventType: "delete",
      objectType: "activity",
      objectId: "123",
    });

    expect(result.provider).toBe("strava");
    expect(result.errors).toEqual([]);
    expect(providerActivityAbsenceMocks.markProviderActivityAbsent).toHaveBeenCalledWith(mockDb, {
      providerId: "strava",
      externalId: "123",
      userId: "00000000-0000-0000-0000-000000000001",
    });
  });
});

// ============================================================
// getActivityStreams — exercises STREAM_KEYS and isStreamKey
// ============================================================

describe("StravaClient.getActivityStreams", () => {
  it("maps all recognized stream types from the API response to StravaStreamSet keys", async () => {
    // Strava returns an array of stream objects; getActivityStreams converts them
    // to a keyed StravaStreamSet using isStreamKey (which checks STREAM_KEYS).
    const apiResponse = [
      { type: "time", data: [0, 1], series_type: "time", resolution: "high", original_size: 2 },
      {
        type: "heartrate",
        data: [130, 135],
        series_type: "time",
        resolution: "high",
        original_size: 2,
      },
      {
        type: "watts",
        data: [200, 210],
        series_type: "time",
        resolution: "high",
        original_size: 2,
      },
      {
        type: "cadence",
        data: [85, 88],
        series_type: "time",
        resolution: "high",
        original_size: 2,
      },
      {
        type: "velocity_smooth",
        data: [8.5, 8.7],
        series_type: "time",
        resolution: "high",
        original_size: 2,
      },
      {
        type: "latlng",
        data: [
          [40.7, -74.0],
          [40.71, -74.01],
        ],
        series_type: "time",
        resolution: "high",
        original_size: 2,
      },
      {
        type: "altitude",
        data: [15.2, 15.5],
        series_type: "time",
        resolution: "high",
        original_size: 2,
      },
      {
        type: "distance",
        data: [0, 8.5],
        series_type: "time",
        resolution: "high",
        original_size: 2,
      },
      { type: "temp", data: [22, 23], series_type: "time", resolution: "high", original_size: 2 },
      {
        type: "grade_smooth",
        data: [0.5, 1.0],
        series_type: "time",
        resolution: "high",
        original_size: 2,
      },
    ];

    const mockFetch: typeof globalThis.fetch = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = String(input);
      expect(url).toContain("activities/12345/streams");
      return Response.json(apiResponse);
    };

    const client = new StravaClient("token", mockFetch);
    const streams = await client.getActivityStreams(12345);

    // Verify all 10 STREAM_KEYS are present in the result
    expect(streams.time).toBeDefined();
    expect(streams.time?.data).toEqual([0, 1]);
    expect(streams.heartrate).toBeDefined();
    expect(streams.heartrate?.data).toEqual([130, 135]);
    expect(streams.watts).toBeDefined();
    expect(streams.watts?.data).toEqual([200, 210]);
    expect(streams.cadence).toBeDefined();
    expect(streams.cadence?.data).toEqual([85, 88]);
    expect(streams.velocity_smooth).toBeDefined();
    expect(streams.velocity_smooth?.data).toEqual([8.5, 8.7]);
    expect(streams.latlng).toBeDefined();
    expect(streams.latlng?.data).toEqual([
      [40.7, -74.0],
      [40.71, -74.01],
    ]);
    expect(streams.altitude).toBeDefined();
    expect(streams.altitude?.data).toEqual([15.2, 15.5]);
    expect(streams.distance).toBeDefined();
    expect(streams.distance?.data).toEqual([0, 8.5]);
    expect(streams.temp).toBeDefined();
    expect(streams.temp?.data).toEqual([22, 23]);
    expect(streams.grade_smooth).toBeDefined();
    expect(streams.grade_smooth?.data).toEqual([0.5, 1.0]);
  });

  it("filters out unknown stream types via isStreamKey", async () => {
    const apiResponse = [
      { type: "time", data: [0], series_type: "time", resolution: "high", original_size: 1 },
      {
        type: "unknown_stream",
        data: [42],
        series_type: "time",
        resolution: "high",
        original_size: 1,
      },
    ];

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json(apiResponse);
    };

    const client = new StravaClient("token", mockFetch);
    const streams = await client.getActivityStreams(1);

    expect(streams.time).toBeDefined();
    // unknown_stream should not appear in the result
    expect(Object.keys(streams)).toEqual(["time"]);
  });

  it("sends request to correct Strava API URL with query params", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      capturedUrl = String(input);
      return Response.json([]);
    };

    const client = new StravaClient("token", mockFetch);
    await client.getActivityStreams(99999);

    // Verify base URL is the Strava API
    expect(capturedUrl).toContain("https://www.strava.com/api/v3/");
    expect(capturedUrl).toContain("activities/99999/streams");
    expect(capturedUrl).toContain("keys=");
    // Verify all stream keys are requested
    for (const key of [
      "time",
      "heartrate",
      "watts",
      "cadence",
      "velocity_smooth",
      "latlng",
      "altitude",
      "distance",
      "temp",
      "grade_smooth",
    ]) {
      expect(capturedUrl).toContain(key);
    }
  });
});

// ============================================================
// STRAVA_API_BASE — assert exact URL used by StravaClient
// ============================================================

describe("StravaClient — API base URL", () => {
  it("uses https://www.strava.com/api/v3/ as the base URL for all requests", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      capturedUrl = String(input);
      return Response.json([]);
    };

    const client = new StravaClient("token", mockFetch);
    await client.getActivities(0);

    expect(capturedUrl).toMatch(/^https:\/\/www\.strava\.com\/api\/v3\//);
  });

  it("getActivity fetches the exact Strava activities endpoint", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      capturedUrl = String(input);
      return Response.json(sampleActivity);
    };

    const client = new StravaClient("token", mockFetch);
    await client.getActivity(42);
    expect(capturedUrl).toBe("https://www.strava.com/api/v3/activities/42");
  });

  it("sends Authorization Bearer header with access token", async () => {
    let capturedHeaders: HeadersInit | undefined;
    const mockFetch: typeof globalThis.fetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedHeaders = init?.headers;
      return Response.json([]);
    };

    const client = new StravaClient("my-secret-token", mockFetch);
    await client.getActivities(0);
    expect(capturedHeaders).toEqual({ Authorization: "Bearer my-secret-token" });
  });
});

// ============================================================
// STRAVA_THROTTLE_MS export value
// ============================================================

describe("STRAVA_THROTTLE_MS", () => {
  it("is exactly 10000ms", () => {
    expect(STRAVA_THROTTLE_MS).toBe(10_000);
  });
});

describe("StravaClient", () => {
  it("getActivities makes correct API call", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json([
        {
          id: 1,
          name: "Ride",
          type: "Ride",
          sport_type: "Ride",
          start_date: "2026-03-01T08:00:00Z",
          elapsed_time: 3600,
          moving_time: 3500,
          distance: 30000,
          total_elevation_gain: 200,
          trainer: false,
          commute: false,
          manual: false,
        },
      ]),
    );

    const client = new StravaClient("test-token", mockFetch);
    const result = await client.getActivities(1000, 2, 50);

    expect(mockFetch).toHaveBeenCalledOnce();
    const callUrl = String(mockFetch.mock.calls[0]?.[0]);
    const callOptions = mockFetch.mock.calls[0]?.[1];
    const headers = getRequestHeaders(callOptions);
    expect(callUrl).toContain("/athlete/activities");
    expect(callUrl).toContain("after=1000");
    expect(callUrl).toContain("page=2");
    expect(callUrl).toContain("per_page=50");
    expect(headers).toEqual(expect.objectContaining({ Authorization: "Bearer test-token" }));
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(1);
  });

  it("getActivityStreams transforms array to keyed object", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json([
        {
          type: "time",
          data: [0, 1, 2],
          series_type: "time",
          resolution: "high",
          original_size: 3,
        },
        {
          type: "heartrate",
          data: [130, 132, 135],
          series_type: "time",
          resolution: "high",
          original_size: 3,
        },
        {
          type: "watts",
          data: [200, 210, 205],
          series_type: "time",
          resolution: "high",
          original_size: 3,
        },
        {
          type: "mystery_stream",
          data: [1, 2, 3],
          series_type: "time",
          resolution: "high",
          original_size: 3,
        },
      ]),
    );

    const client = new StravaClient("test-token", mockFetch);
    const streams = await client.getActivityStreams(12345);

    const calledUrl = String(mockFetch.mock.calls[0]?.[0]);
    const url = new URL(calledUrl);
    expect(url.searchParams.get("keys")).toBe(
      "time,heartrate,watts,cadence,velocity_smooth,latlng,altitude,distance,temp,grade_smooth",
    );
    expect(url.searchParams.get("key_type")).toBe("time");
    expect(streams.time?.data).toEqual([0, 1, 2]);
    expect(streams.heartrate?.data).toEqual([130, 132, 135]);
    expect(streams.watts?.data).toEqual([200, 210, 205]);
    expect("mystery_stream" in streams).toBe(false);
  });
});

describe("StravaProvider.sync", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when tokens cannot be loaded", async () => {
    process.env.STRAVA_CLIENT_ID = "id";
    process.env.STRAVA_CLIENT_SECRET = "secret";

    const mockFetch = vi.fn();
    const provider = new StravaProvider(mockFetch);

    // Mock db with loadTokens returning null
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn(),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const before = Date.now();
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    const after = Date.now();

    expect(result.provider).toBe("strava");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThanOrEqual(after - before + 100);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
  });

  it("handles rate limit during activity fetch", async () => {
    process.env.STRAVA_CLIENT_ID = "id";
    process.env.STRAVA_CLIENT_SECRET = "secret";

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      // Token load
      if (callCount === 0 && url.includes("/athlete/activities")) {
        callCount++;
        return new Response("Rate limited", { status: 429 });
      }
      return Response.json([]);
    });

    const provider = new StravaProvider(mockFetch);

    // Provide tokens
    const futureDate = new Date("2099-01-01");
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                providerId: "strava",
                accessToken: "token",
                refreshToken: "refresh",
                expiresAt: futureDate,
                scopes: null,
              },
            ]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "10000000-0000-4000-8000-000000000001" }]),
          }),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.provider).toBe("strava");
    expect(result.errors.some((e) => e.message.includes("rate limit"))).toBe(true);
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).not.toHaveBeenCalled();
  });
});

// ============================================================
// Helper factories shared by the sync integration tests below
// ============================================================

const FUTURE_DATE = new Date("2099-01-01");

const VALID_TOKEN = {
  providerId: "strava",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: FUTURE_DATE,
  scopes: null,
};

const EXPIRED_TOKEN = {
  ...VALID_TOKEN,
  accessToken: "old-access-token",
  refreshToken: "refresh-token",
  expiresAt: new Date("2000-01-01"),
};

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function getRequestHeaders(value: unknown): HeadersInit | undefined {
  if (typeof value !== "object" || value === null || !("headers" in value)) return undefined;
  const headers = Reflect.get(value, "headers");
  if (Array.isArray(headers)) return headers;
  if (headers instanceof Headers) return headers;
  if (isStringRecord(headers)) return headers;
  return undefined;
}

function hasQueryChunks(query: unknown): query is { queryChunks: unknown[] } {
  return (
    query !== null &&
    typeof query === "object" &&
    "queryChunks" in query &&
    Array.isArray(query.queryChunks)
  );
}

function createMockDb(tokenRows = [VALID_TOKEN]): SyncDatabase {
  return makeTransactionalTestDatabase<SyncDatabase>({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(tokenRows),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation(() => {
        return Object.assign(Promise.resolve(), {
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "10000000-0000-4000-8000-000000000002" }]),
          }),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        });
      }),
    }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    execute: vi.fn().mockResolvedValue([]),
  });
}

const MOCK_ACTIVITY = {
  id: 12345678,
  name: "Morning Ride",
  type: "Ride",
  sport_type: "Ride",
  start_date: "2026-03-01T08:00:00Z",
  elapsed_time: 3600,
  moving_time: 3500,
  distance: 30000,
  total_elevation_gain: 200,
  trainer: false,
  commute: false,
  manual: false,
};

const MOCK_STREAMS = [
  { type: "time", data: [0, 1, 2], series_type: "time", resolution: "high", original_size: 3 },
  {
    type: "heartrate",
    data: [130, 132, 135],
    series_type: "time",
    resolution: "high",
    original_size: 3,
  },
];

describe("StravaProvider.sync — additional coverage", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  function setupEnv() {
    process.env.STRAVA_CLIENT_ID = "test-client-id";
    process.env.STRAVA_CLIENT_SECRET = "test-client-secret";
  }

  it("happy path: fetches activities, inserts into DB, returns recordsSynced >= 1", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}/streams`)) {
        return Promise.resolve(Response.json(MOCK_STREAMS));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json({ ...MOCK_ACTIVITY, device_name: "Wahoo ELEMNT" }));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch);

    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.provider).toBe("strava");
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);
    expect(result.errors).toHaveLength(0);
    expect(
      mockFetch.mock.calls.some(([url]) =>
        String(url).includes(`/activities/${MOCK_ACTIVITY.id}/streams`),
      ),
    ).toBe(true);
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        providerId: "strava",
        windowStart: new Date("2026-01-01"),
        presentExternalIds: new Set([String(MOCK_ACTIVITY.id)]),
      }),
    );
  });

  it("writes expected upsert payloads for activity records", async () => {
    setupEnv();

    const secondActivity = {
      ...MOCK_ACTIVITY,
      id: 87654321,
      name: "Evening Ride",
    };

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY, secondActivity]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}/streams`)) {
        return Promise.resolve(Response.json(MOCK_STREAMS));
      }
      if (urlStr.includes(`/activities/${secondActivity.id}/streams`)) {
        return Promise.resolve(Response.json(MOCK_STREAMS));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json({ ...MOCK_ACTIVITY, device_name: "Garmin Edge" }));
      }
      if (urlStr.includes(`/activities/${secondActivity.id}`)) {
        return Promise.resolve(Response.json({ ...secondActivity, device_name: "Garmin Edge" }));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.errors).toHaveLength(0);
    const upsertCalls = providerActivityAbsenceMocks.upsertProviderActivity.mock.calls;
    expect(upsertCalls).toHaveLength(2);
    expect(upsertCalls[0]?.[1]).toMatchObject({
      providerId: "strava",
      externalId: String(MOCK_ACTIVITY.id),
      raw: { id: MOCK_ACTIVITY.id },
    });
    expect(upsertCalls[1]?.[1]).toMatchObject({
      providerId: "strava",
      externalId: String(secondActivity.id),
      raw: { id: secondActivity.id },
    });
    expect(upsertCalls[0]?.[2]).toMatchObject({
      raw: expect.objectContaining({ id: MOCK_ACTIVITY.id }),
    });
    expect(upsertCalls[1]?.[2]).toMatchObject({
      raw: expect.objectContaining({ id: secondActivity.id }),
    });
    expect(hasQueryChunks(upsertCalls[0]?.[2]?.sourceName)).toBe(true);
  });

  it("converts since date to epoch seconds using division by 1000", async () => {
    setupEnv();

    const sinceDate = new Date("2026-03-01T00:00:00Z");
    const expectedEpoch = Math.floor(sinceDate.getTime() / 1000);

    let capturedUrl = "";
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        capturedUrl = urlStr;
        return Promise.resolve(Response.json([]));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch);

    await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: sinceDate }) }),
    );

    expect(capturedUrl).toContain(`after=${expectedEpoch}`);
    // Explicitly confirm the value is in seconds, not milliseconds
    expect(capturedUrl).not.toContain(`after=${sinceDate.getTime()}`);
  });

  it("since epoch value is clearly seconds-based (not milliseconds)", async () => {
    setupEnv();

    const sinceDate = new Date("2026-03-01T00:00:00Z");
    const epochSeconds = Math.floor(sinceDate.getTime() / 1000);
    const epochMilliseconds = sinceDate.getTime();

    let capturedUrl = "";
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        capturedUrl = urlStr;
        return Promise.resolve(Response.json([]));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch);

    await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: sinceDate }) }),
    );

    const urlParams = new URL(capturedUrl).searchParams;
    const afterParam = Number(urlParams.get("after"));

    expect(afterParam).toBe(epochSeconds);
    // Division by 1000 produces a ~10-digit value; multiplication would give ~13 digits
    expect(afterParam).toBeLessThan(epochMilliseconds);
    expect(afterParam).toBeGreaterThan(0);
  });

  it("stops pagination when activities page has fewer than perPage items", async () => {
    setupEnv();

    let activitiesCallCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        activitiesCallCount++;
        // Return only 1 activity (< perPage of 30) → hasMore should be false
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}/streams`)) {
        return Promise.resolve(Response.json(MOCK_STREAMS));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json(MOCK_ACTIVITY));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch);

    await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    // Should only call getActivities once since result < perPage
    expect(activitiesCallCount).toBe(1);
  });

  it("continues pagination when a full page of activities is returned", async () => {
    setupEnv();

    const fullPage = Array.from({ length: 30 }, (_, i) => ({ ...MOCK_ACTIVITY, id: i + 1 }));
    let activitiesCallCount = 0;

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        activitiesCallCount++;
        // First page: full 30 activities; second page: empty → stop
        return Promise.resolve(Response.json(activitiesCallCount === 1 ? fullPage : []));
      }
      if (urlStr.includes("/streams")) {
        return Promise.resolve(Response.json(MOCK_STREAMS));
      }
      // Detail fetches for each activity
      return Promise.resolve(Response.json({ ...MOCK_ACTIVITY }));
    });

    // Need a db mock that returns a UUID for every insert
    const mockDb = makeTransactionalTestDatabase<SyncDatabase>({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([VALID_TOKEN]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation(() => {
          return Object.assign(Promise.resolve(), {
            onConflictDoUpdate: vi.fn().mockReturnValue({
              returning: vi
                .fn()
                .mockResolvedValue([{ id: "10000000-0000-4000-8000-000000000004" }]),
            }),
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          });
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    });

    const provider = new StravaProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(activitiesCallCount).toBe(2);
    expect(result.recordsSynced).toBe(30);
    const activityPages = mockFetch.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/athlete/activities"))
      .map((url) => Number(new URL(url).searchParams.get("page")));
    expect(activityPages).toEqual([1, 2]);
  });

  it("stops with degraded pagination when full pages never terminate", async () => {
    setupEnv();

    const fullPage = Array.from({ length: 30 }, (_, index) => ({
      ...MOCK_ACTIVITY,
      id: index + 1,
    }));
    let activitiesCallCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        activitiesCallCount++;
        return Promise.resolve(Response.json(fullPage));
      }
      if (urlStr.includes("/streams")) {
        return Promise.resolve(Response.json([]));
      }
      return Promise.resolve(Response.json(MOCK_ACTIVITY));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(activitiesCallCount).toBe(100);
    expect(result.degradations).toEqual([
      expect.objectContaining({
        kind: "pagination_max_pages_exceeded",
        providerId: "strava",
        stepName: "activity_list",
      }),
    ]);
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("invokes onProgress callback with synced activity count message", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes("/streams")) {
        return Promise.resolve(Response.json(MOCK_STREAMS));
      }
      return Promise.resolve(Response.json(MOCK_ACTIVITY));
    });

    const mockDb = createMockDb();
    const onProgress = vi.fn();
    const provider = new StravaProvider(mockFetch);

    await provider.sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01") }),
        onProgress,
      }),
    );

    expect(onProgress).toHaveBeenCalledWith(0, "1 activities synced");
  });

  it("rate limit on activity detail fetch: sets rateLimited, adds error, returns gracefully", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`) && !urlStr.includes("/streams")) {
        return Promise.resolve(new Response("Rate limited", { status: 429 }));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch);

    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.provider).toBe("strava");
    expect(result.errors.some((e) => e.message.includes("rate limit"))).toBe(true);
    // Should not throw — graceful return
    expect(result.errors.some((e) => e.message.toLowerCase().includes("detail"))).toBe(true);
  });

  it("rate limit on streams fetch: adds error but still counts activity as synced", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes("/streams")) {
        return Promise.resolve(new Response("Rate limited", { status: 429 }));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json(MOCK_ACTIVITY));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch);

    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    // Activity insert happened before streams, so recordsSynced should be 1
    expect(result.recordsSynced).toBe(1);
    expect(result.errors.some((e) => e.message.includes("rate limit"))).toBe(true);
  });

  it("duration in result is positive (Date.now() - start, not + start)", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/athlete/activities")) {
        return Promise.resolve(Response.json([]));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch);

    const before = Date.now();
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    const after = Date.now();

    expect(result.duration).toBeGreaterThanOrEqual(0);
    // If the mutation changed - to +, duration would be ~2x Date.now() (order of 10^12)
    expect(result.duration).toBeLessThanOrEqual(after - before + 100);
  });

  it("token refresh: calls fetch for token endpoint when token is expired", async () => {
    setupEnv();

    const refreshedToken = {
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: FUTURE_DATE,
    };

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("strava.com/oauth/token")) {
        return Promise.resolve(
          Response.json({
            access_token: refreshedToken.accessToken,
            refresh_token: refreshedToken.refreshToken,
            expires_at: Math.floor(FUTURE_DATE.getTime() / 1000),
            token_type: "Bearer",
          }),
        );
      }
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([]));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb([EXPIRED_TOKEN]);
    const provider = new StravaProvider(mockFetch);

    await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    const oauthCall = mockFetch.mock.calls.find(([url]) =>
      String(url).includes("strava.com/oauth/token"),
    );
    expect(oauthCall).toBeDefined();
  });

  it("does not call OAuth token refresh when access token is still valid", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([]));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb([VALID_TOKEN]);
    const provider = new StravaProvider(mockFetch);

    await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    const oauthCall = mockFetch.mock.calls.find(([url]) =>
      String(url).includes("strava.com/oauth/token"),
    );
    expect(oauthCall).toBeUndefined();
  });

  it("hasMore is false when rateLimited is true even if page was full", async () => {
    setupEnv();

    // Full page of activities, but streams trigger rate limit on first one
    const fullPage = Array.from({ length: 30 }, (_, i) => ({ ...MOCK_ACTIVITY, id: i + 1 }));
    let activitiesCallCount = 0;

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        activitiesCallCount++;
        return Promise.resolve(Response.json(fullPage));
      }
      if (urlStr.includes("/streams")) {
        return Promise.resolve(new Response("Rate limited", { status: 429 }));
      }
      return Promise.resolve(Response.json({ ...MOCK_ACTIVITY }));
    });

    const mockDb = makeTransactionalTestDatabase<SyncDatabase>({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([VALID_TOKEN]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation(() => {
          return Object.assign(Promise.resolve(), {
            onConflictDoUpdate: vi.fn().mockReturnValue({
              returning: vi
                .fn()
                .mockResolvedValue([{ id: "10000000-0000-4000-8000-000000000004" }]),
            }),
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          });
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    });

    const provider = new StravaProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    // rateLimited breaks out of inner loop and sets hasMore = false
    // so getActivities should only be called once
    expect(activitiesCallCount).toBe(1);
    expect(result.errors.some((e) => e.message.includes("rate limit"))).toBe(true);
  });

  it("authorization error from getActivities is captured and returned in sync result", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/athlete/activities")) {
        return Promise.resolve(
          new Response(JSON.stringify({ message: "Authorization Error" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("Strava authorization failed.");
    expect(result.errors[0]?.cause).toMatchObject({ authFailureReason: "authorization_failed" });
    expect(result.errors[0]?.cause).toBeInstanceOf(Error);
    if (result.errors[0]?.cause instanceof Error) {
      expect(result.errors[0].cause.cause).toMatchObject({
        name: "StravaUnauthorizedError",
        message: "Strava API unauthorized (401): /api/v3/athlete/activities",
      });
    }
  });

  it("generic getActivities failures are returned as fetch errors", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/athlete/activities")) {
        return Promise.resolve(new Response("Server Error", { status: 500 }));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Strava activities fetch failed");
  });

  it("skips stream fetch when activity upsert does not return an id", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`) && !urlStr.includes("/streams")) {
        return Promise.resolve(Response.json(MOCK_ACTIVITY));
      }
      return Promise.resolve(Response.json([]));
    });

    providerActivityAbsenceMocks.upsertProviderActivity.mockResolvedValueOnce(undefined);

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(
      mockFetch.mock.calls.some(([url]) =>
        String(url).includes(`/activities/${MOCK_ACTIVITY.id}/streams`),
      ),
    ).toBe(false);
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("activity with no streams (empty streams response) still increments recordsSynced", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes("/streams")) {
        // Empty streams array → no metric rows inserted
        return Promise.resolve(Response.json([]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json(MOCK_ACTIVITY));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch);

    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("does not insert metric rows when streams are empty", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}/streams`)) {
        return Promise.resolve(Response.json([]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json(MOCK_ACTIVITY));
      }
      return Promise.resolve(Response.json([]));
    });

    const insertValuesMock = vi.fn().mockImplementation((payload: unknown) => {
      if (Array.isArray(payload)) {
        return {
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        };
      }
      return {
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "10000000-0000-4000-8000-000000000003" }]),
        }),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      };
    });

    const mockDb: SyncDatabase = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([VALID_TOKEN]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: insertValuesMock,
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new StravaProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(publishedMetricStreamBatches.map((batch) => batch.length)).toEqual([]);
    expect(result.errors).toHaveLength(0);
  });

  it("inserts metric rows in 1000-row batches", async () => {
    setupEnv();

    const rowCount = 1001;
    const largeStreams = [
      {
        type: "time",
        data: Array.from({ length: rowCount }, (_, i) => i),
        series_type: "time",
        resolution: "high",
        original_size: rowCount,
      },
      {
        type: "heartrate",
        data: Array.from({ length: rowCount }, () => 140),
        series_type: "time",
        resolution: "high",
        original_size: rowCount,
      },
    ];

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}/streams`)) {
        return Promise.resolve(Response.json(largeStreams));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json(MOCK_ACTIVITY));
      }
      return Promise.resolve(Response.json([]));
    });

    const insertValuesMock = vi.fn().mockImplementation((payload: unknown) => {
      if (Array.isArray(payload)) {
        return {
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        };
      }
      return {
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "10000000-0000-4000-8000-000000000003" }]),
        }),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      };
    });

    const mockDb = makeTransactionalTestDatabase<SyncDatabase>({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([VALID_TOKEN]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: insertValuesMock,
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    });

    const provider = new StravaProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(publishedMetricStreamBatches.map((batch) => batch.length)).toEqual([1000, 1]);
    expect(result.errors).toHaveLength(0);
  });

  it("authorization error while fetching streams is returned with auth guidance", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes("/streams")) {
        return Promise.resolve(new Response("Unauthorized", { status: 401 }));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json(MOCK_ACTIVITY));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("authorization failed while fetching streams");
  });

  it("404 while fetching streams is treated as missing streams, not an error", async () => {
    setupEnv();

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY]));
      }
      if (urlStr.includes("/streams")) {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }
      if (urlStr.includes(`/activities/${MOCK_ACTIVITY.id}`)) {
        return Promise.resolve(Response.json(MOCK_ACTIVITY));
      }
      return Promise.resolve(Response.json([]));
    });

    const mockDb = createMockDb();
    const provider = new StravaProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("non-rate-limit stream error is recorded but does not stop processing", async () => {
    setupEnv();

    const secondActivity = { ...MOCK_ACTIVITY, id: 99999999 };
    let streamCallCount = 0;

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/athlete/activities")) {
        return Promise.resolve(Response.json([MOCK_ACTIVITY, secondActivity]));
      }
      if (urlStr.includes("/streams")) {
        streamCallCount++;
        if (streamCallCount === 1) {
          // First streams call returns server error (non-rate-limit)
          return Promise.resolve(
            new Response(JSON.stringify({ message: "Server Error" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(Response.json(MOCK_STREAMS));
      }
      return Promise.resolve(Response.json(MOCK_ACTIVITY));
    });

    const mockDb: SyncDatabase = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([VALID_TOKEN]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation(() => {
          return Object.assign(Promise.resolve(), {
            onConflictDoUpdate: vi.fn().mockReturnValue({
              returning: vi
                .fn()
                .mockResolvedValue([{ id: "10000000-0000-4000-8000-000000000004" }]),
            }),
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          });
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new StravaProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    // Both activities should be counted even though first streams call failed
    expect(result.recordsSynced).toBe(2);
    expect(result.errors.some((e) => e.message.includes("Streams for activity"))).toBe(true);
  });
});

describe("mapStravaActivityType — additional types", () => {
  it("maps Canoeing and Kayaking to rowing", () => {
    expect(mapStravaActivityType("Canoeing").canonicalType).toBe("rowing");
    expect(mapStravaActivityType("Kayaking").canonicalType).toBe("rowing");
  });

  it("maps BackcountrySki to skiing", () => {
    expect(mapStravaActivityType("BackcountrySki").canonicalType).toBe("skiing");
  });

  it("maps Snowboard to skiing", () => {
    expect(mapStravaActivityType("Snowboard").canonicalType).toBe("skiing");
  });

  it("maps IceSkate to skating", () => {
    expect(mapStravaActivityType("IceSkate").canonicalType).toBe("skating");
  });

  it("maps RollerSki to skiing", () => {
    expect(mapStravaActivityType("RollerSki").canonicalType).toBe("skiing");
  });

  it("maps Crossfit to strength", () => {
    expect(mapStravaActivityType("Crossfit").canonicalType).toBe("strength");
  });

  it("maps RockClimbing to climbing", () => {
    expect(mapStravaActivityType("RockClimbing").canonicalType).toBe("climbing");
  });
});
