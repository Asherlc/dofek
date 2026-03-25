import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      expect(mapStravaActivityType("Ride")).toBe("road_cycling");
      expect(mapStravaActivityType("VirtualRide")).toBe("virtual_cycling");
      expect(mapStravaActivityType("MountainBikeRide")).toBe("mountain_biking");
      expect(mapStravaActivityType("GravelRide")).toBe("gravel_cycling");
      expect(mapStravaActivityType("EBikeRide")).toBe("e_bike_cycling");
      expect(mapStravaActivityType("Run")).toBe("running");
      expect(mapStravaActivityType("VirtualRun")).toBe("running");
      expect(mapStravaActivityType("TrailRun")).toBe("running");
      expect(mapStravaActivityType("Walk")).toBe("walking");
      expect(mapStravaActivityType("Hike")).toBe("hiking");
      expect(mapStravaActivityType("Swim")).toBe("swimming");
      expect(mapStravaActivityType("WeightTraining")).toBe("strength");
      expect(mapStravaActivityType("Yoga")).toBe("yoga");
      expect(mapStravaActivityType("Rowing")).toBe("rowing");
      expect(mapStravaActivityType("Elliptical")).toBe("elliptical");
      expect(mapStravaActivityType("NordicSki")).toBe("skiing");
      expect(mapStravaActivityType("AlpineSki")).toBe("skiing");
    });

    it("returns 'other' for unknown types", () => {
      expect(mapStravaActivityType("Handcycle")).toBe("other");
      expect(mapStravaActivityType("UnknownSport")).toBe("other");
    });
  });

  describe("parseStravaActivity", () => {
    it("maps Strava activity to parsed activity fields", () => {
      const result = parseStravaActivity(sampleActivity);

      expect(result.externalId).toBe("12345678");
      expect(result.activityType).toBe("road_cycling");
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
      expect(result.activityType).toBe("running");
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
      expect(result.activityType).toBe("running");
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

  it("uses custom OAUTH_REDIRECT_URI_unencrypted when set", () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI_unencrypted = "https://example.com/callback";
    const config = stravaOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when OAUTH_REDIRECT_URI_unencrypted is not set", () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI_unencrypted;
    const config = stravaOAuthConfig();
    expect(config?.redirectUri).toBe("https://dofek.asherlc.com/callback");
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
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toBe("https://www.strava.com/api/v3/");
    expect(setup.oauthConfig.authorizeUrl).toBe("https://www.strava.com/oauth/authorize");
    expect(setup.oauthConfig.tokenUrl).toBe("https://www.strava.com/oauth/token");
    expect(setup.oauthConfig.scopes).toEqual(["read", "activity:read_all"]);
  });

  it("throws when env vars are missing", () => {
    delete process.env.STRAVA_CLIENT_ID;
    delete process.env.STRAVA_CLIENT_SECRET;
    const provider = new StravaProvider();
    expect(() => provider.authSetup()).toThrow("STRAVA_CLIENT_ID");
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

    const client = new StravaClient("token", mockFetch, 0);
    const result = await client.getActivity(12345678);
    expect(result.device_name).toBe("Garmin Edge 530");
    expect(result.id).toBe(12345678);
  });

  it("returns undefined device_name when not present", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json(sampleActivity);
    };

    const client = new StravaClient("token", mockFetch, 0);
    const result = await client.getActivity(12345678);
    expect(result.device_name).toBeUndefined();
  });
});

describe("StravaClient — error handling", () => {
  it("throws StravaRateLimitError on 429", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Rate Limit Exceeded", { status: 429 });
    };

    const client = new StravaClient("token", mockFetch, 0);
    const err = await client.getActivities(0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StravaRateLimitError);
    expect(err).toHaveProperty("message", expect.stringContaining("(429)"));
  });

  it("throws generic error on non-OK, non-429 response", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Server Error", { status: 500 });
    };

    const client = new StravaClient("token", mockFetch, 0);
    await expect(client.getActivities(0)).rejects.toThrow("Strava API error (500): Server Error");
  });

  it("throws StravaNotFoundError for HTML 404 responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("<html><body>Not Found</body></html>", {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    };

    const client = new StravaClient("token", mockFetch, 0);
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

    const client = new StravaClient("token", mockFetch, 0);
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

    const client = new StravaClient("token", mockFetch, 0);
    const err = await client.getActivities(0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StravaUnauthorizedError);
    expect(err).toHaveProperty("message", expect.stringContaining("unauthorized (401)"));
  });

  it("throws StravaUnauthorizedError for 403 responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Forbidden", { status: 403 });
    };

    const client = new StravaClient("token", mockFetch, 0);
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

    const client = new StravaClient("token", mockFetch, 0);
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

    const client = new StravaClient("token", mockFetch, 0);
    await expect(client.getActivities(0)).rejects.toThrow(
      "Strava API error (500): (HTML error page)",
    );
  });

  it("truncates long plain-text error responses", async () => {
    const longText = "x".repeat(300);
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(longText, { status: 500 });
    };

    const client = new StravaClient("token", mockFetch, 0);
    await expect(client.getActivities(0)).rejects.toThrow(
      `Strava API error (500): ${"x".repeat(200)}…`,
    );
  });
});

describe("StravaClient — request throttling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforces minimum delay between consecutive API requests", async () => {
    const callTimestamps: number[] = [];
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      callTimestamps.push(Date.now());
      return Response.json([]);
    };

    const client = new StravaClient("token", mockFetch);

    // First request — should go immediately
    const p1 = client.getActivities(0);
    await vi.advanceTimersByTimeAsync(0);
    await p1;

    // Second request — should be delayed by the throttle interval
    const p2 = client.getActivities(0);
    // Advance past the throttle delay
    await vi.advanceTimersByTimeAsync(10_000);
    await p2;

    expect(callTimestamps).toHaveLength(2);
    const first = callTimestamps[0] ?? 0;
    const second = callTimestamps[1] ?? 0;
    expect(second - first).toBeGreaterThanOrEqual(10_000);
  });

  it("does not delay the first request", async () => {
    const callTimestamps: number[] = [];
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      callTimestamps.push(Date.now());
      return Response.json([]);
    };

    const client = new StravaClient("token", mockFetch);
    const p = client.getActivities(0);
    await vi.advanceTimersByTimeAsync(0);
    await p;

    // First call should happen at time 0 (no throttle delay)
    expect(callTimestamps).toHaveLength(1);
  });
});

describe("StravaRateLimitError", () => {
  it("has correct name and message", () => {
    const error = new StravaRateLimitError("Rate limited");
    expect(error.name).toBe("StravaRateLimitError");
    expect(error.message).toBe("Rate limited");
    expect(error).toBeInstanceOf(Error);
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

  it("returns identity from athlete API", async () => {
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
    expect(identity.email).toBe("athlete@test.com");
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

function makeStravaInsertMock(returnId = "act-uuid") {
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
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns immediately for non-activity objectType", async () => {
    const provider = new StravaProvider(async () => new Response(), 0);
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "123",
      eventType: "create",
      objectType: "athlete",
      objectId: "456",
    });

    expect(result.provider).toBe("strava");
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("returns immediately when objectId is missing", async () => {
    const provider = new StravaProvider(async () => new Response(), 0);
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "123",
      eventType: "create",
      objectType: "activity",
    });

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles delete events by removing activity and streams", async () => {
    const provider = new StravaProvider(async () => new Response(), 0);
    const mockDelete = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "deleted-act-id" }]),
      }),
    });

    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: mockDelete,
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "123",
      eventType: "delete",
      objectType: "activity",
      objectId: "99999",
    });

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
    // Should call delete twice: once for activity, once for metric_stream
    expect(mockDelete).toHaveBeenCalledTimes(2);
  });

  it("handles delete event when activity not found", async () => {
    const provider = new StravaProvider(async () => new Response(), 0);
    const mockDelete = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    });

    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: mockDelete,
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "123",
      eventType: "delete",
      objectType: "activity",
      objectId: "nonexistent",
    });

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
    // Only called once for the activity delete, not for metric_stream
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it("returns error when token resolution fails", async () => {
    const provider = new StravaProvider(async () => new Response(), 0);
    const mockDb = {
      select: makeStravaSelectMock(null),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "123",
      eventType: "create",
      objectType: "activity",
      objectId: "12345",
    });

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

    const mockDb = {
      select: makeStravaSelectMock(validTokenRow),
      insert: mockInsert,
      delete: mockDelete,
      execute: vi.fn(),
    };

    const provider = new StravaProvider(mockFetch, 0);
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "123",
      eventType: "create",
      objectType: "activity",
      objectId: "12345678",
    });

    expect(result.provider).toBe("strava");
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
    // insert called for: activity upsert, then metric_stream batch
    expect(mockInsert).toHaveBeenCalled();
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

    const provider = new StravaProvider(mockFetch, 0);
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "123",
      eventType: "update",
      objectType: "activity",
      objectId: "12345678",
    });

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

    const provider = new StravaProvider(mockFetch, 0);
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "123",
      eventType: "create",
      objectType: "activity",
      objectId: "12345678",
    });

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

    // Insert returns empty array (no id)
    const mockInsert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const mockDb = {
      select: makeStravaSelectMock(validTokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn(),
    };

    const provider = new StravaProvider(mockFetch, 0);
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "123",
      eventType: "create",
      objectType: "activity",
      objectId: "12345678",
    });

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
    const provider = new StravaProvider(async () => new Response(), 0);
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
    const provider = new StravaProvider(mockFetch, 0);
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
    const provider = new StravaProvider(mockFetch, 0);
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
    const provider = new StravaProvider(mockFetch, 0);
    await provider.unregisterWebhook("42");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("succeeds on 200 response", async () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(null, { status: 200 });
    };
    const provider = new StravaProvider(mockFetch, 0);
    // Should not throw
    await provider.unregisterWebhook("42");
  });

  it("treats 404 as OK (already deleted)", async () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Not Found", { status: 404 });
    };
    const provider = new StravaProvider(mockFetch, 0);
    // Should not throw
    await provider.unregisterWebhook("42");
  });

  it("logs warning on non-OK non-404 response", async () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Server Error", { status: 500 });
    };
    const provider = new StravaProvider(mockFetch, 0);
    // Should not throw, just logs warning
    await provider.unregisterWebhook("42");
  });
});

// ============================================================
// Additional precise assertions for mutation killing
// ============================================================

describe("StravaProvider — precise webhook string/object assertions", () => {
  it("parseWebhookPayload maps all three Strava aspect_types correctly", async () => {
    const provider = new StravaProvider(async () => new Response(), 0);

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
    const provider = new StravaProvider(async () => new Response(), 0);
    const events = provider.parseWebhookPayload({
      aspect_type: "create",
      object_type: "activity",
      owner_id: 0, // edge case: zero
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.ownerExternalId).toBe("0");
  });

  it("parseWebhookPayload converts object_id number to string", async () => {
    const provider = new StravaProvider(async () => new Response(), 0);
    const events = provider.parseWebhookPayload({
      aspect_type: "create",
      object_type: "activity",
      owner_id: 1,
      object_id: 42,
    });
    expect(events[0]?.objectId).toBe("42");
  });

  it("parseWebhookPayload treats object_id=0 as falsy (undefined)", async () => {
    const provider = new StravaProvider(async () => new Response(), 0);
    const events = provider.parseWebhookPayload({
      aspect_type: "create",
      object_type: "activity",
      owner_id: 1,
      object_id: 0, // zero is falsy — ternary produces undefined
    });
    expect(events[0]?.objectId).toBeUndefined();
  });

  it("handleValidationChallenge echoes back the exact challenge string", async () => {
    const provider = new StravaProvider(async () => new Response(), 0);
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
    const provider = new StravaProvider(async () => new Response(), 0);
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

    const provider = new StravaProvider(mockFetch, 0);
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

    const provider = new StravaProvider(mockFetch, 0);
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

    const provider = new StravaProvider(mockFetch, 0);
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

    const provider = new StravaProvider(mockFetch, 0);
    await provider.unregisterWebhook("sub-42");

    const parsed = new URL(capturedUrl);
    expect(parsed.searchParams.get("client_id")).toBe("my-id");
    expect(parsed.searchParams.get("client_secret")).toBe("my-secret");
    expect(parsed.pathname).toContain("push_subscriptions/sub-42");

    process.env = { ...originalEnv };
  });

  it("syncWebhookEvent returns provider as 'strava' for all paths", async () => {
    const provider = new StravaProvider(async () => new Response(), 0);
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
    const mockDelete = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    });
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: mockDelete,
      execute: vi.fn(),
    };

    const provider = new StravaProvider(async () => new Response(), 0);
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "1",
      eventType: "delete",
      objectType: "activity",
      objectId: "999",
    });
    expect(result.provider).toBe("strava");
    expect(result.recordsSynced).toBe(0);
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

    const client = new StravaClient("token", mockFetch, 0);
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

    const client = new StravaClient("token", mockFetch, 0);
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

    const client = new StravaClient("token", mockFetch, 0);
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

    const client = new StravaClient("token", mockFetch, 0);
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

    const client = new StravaClient("token", mockFetch, 0);
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

    const client = new StravaClient("my-secret-token", mockFetch, 0);
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
