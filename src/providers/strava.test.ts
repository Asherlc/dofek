import { afterEach, describe, expect, it } from "vitest";
import {
  mapStravaActivityType,
  parseStravaActivity,
  parseStravaActivityList,
  type StravaActivity,
  StravaClient,
  type StravaDetailedActivity,
  StravaProvider,
  StravaRateLimitError,
  type StravaStreamSet,
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
      expect(mapStravaActivityType("Ride")).toBe("cycling");
      expect(mapStravaActivityType("VirtualRide")).toBe("cycling");
      expect(mapStravaActivityType("MountainBikeRide")).toBe("cycling");
      expect(mapStravaActivityType("GravelRide")).toBe("cycling");
      expect(mapStravaActivityType("EBikeRide")).toBe("cycling");
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
      expect(result.activityType).toBe("cycling");
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
      expect(rows[0]?.distance).toBe(0);
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
    expect(config?.scopes).toContain("activity:read_all");
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
    expect(config?.redirectUri).toContain("dofek");
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
    expect(setup.apiBaseUrl).toContain("strava.com");
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
    await expect(client.getActivities(0)).rejects.toBeInstanceOf(StravaRateLimitError);
  });

  it("throws generic error on non-OK, non-429 response", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Server Error", { status: 500 });
    };

    const client = new StravaClient("token", mockFetch);
    await expect(client.getActivities(0)).rejects.toThrow("Strava API error (500): Server Error");
  });

  it("shows clean message for HTML error responses instead of dumping HTML", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("<html><body>Not Found</body></html>", {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    };

    const client = new StravaClient("token", mockFetch);
    await expect(client.getActivities(0)).rejects.toThrow(
      "Strava API error (404): (HTML error page)",
    );
  });

  it("includes JSON body for JSON error responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ message: "Not Found", errors: [] }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    };

    const client = new StravaClient("token", mockFetch);
    await expect(client.getActivities(0)).rejects.toThrow(
      'Strava API error (404): {"message":"Not Found","errors":[]}',
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

describe("StravaRateLimitError", () => {
  it("has correct name and message", () => {
    const error = new StravaRateLimitError("Rate limited");
    expect(error.name).toBe("StravaRateLimitError");
    expect(error.message).toBe("Rate limited");
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

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
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
