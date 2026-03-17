import { describe, expect, it } from "vitest";
import {
  CyclingAnalyticsProvider,
  cyclingAnalyticsOAuthConfig,
  parseCyclingAnalyticsRide,
} from "./cycling-analytics.ts";

describe("parseCyclingAnalyticsRide", () => {
  const sampleRide = {
    id: 42,
    title: "Morning Ride",
    date: "2026-03-15T08:00:00Z",
    duration: 3600,
    distance: 30000,
    average_power: 200,
    normalized_power: 220,
    max_power: 450,
    average_heart_rate: 150,
    max_heart_rate: 180,
    average_cadence: 90,
    max_cadence: 110,
    elevation_gain: 500,
    elevation_loss: 480,
    average_speed: 8.33,
    max_speed: 15.0,
    calories: 800,
    training_stress_score: 85,
    intensity_factor: 0.88,
  };

  it("converts id to string externalId", () => {
    const result = parseCyclingAnalyticsRide(sampleRide);
    expect(result.externalId).toBe("42");
  });

  it("always sets activityType to cycling", () => {
    const result = parseCyclingAnalyticsRide(sampleRide);
    expect(result.activityType).toBe("cycling");
  });

  it("uses title as name", () => {
    const result = parseCyclingAnalyticsRide(sampleRide);
    expect(result.name).toBe("Morning Ride");
  });

  it("parses date into startedAt", () => {
    const result = parseCyclingAnalyticsRide(sampleRide);
    expect(result.startedAt).toEqual(new Date("2026-03-15T08:00:00Z"));
  });

  it("calculates endedAt from startedAt + duration in seconds", () => {
    const result = parseCyclingAnalyticsRide(sampleRide);
    const expectedEnd = new Date(new Date("2026-03-15T08:00:00Z").getTime() + 3600 * 1000);
    expect(result.endedAt).toEqual(expectedEnd);
  });

  it("includes all raw fields with camelCase keys", () => {
    const result = parseCyclingAnalyticsRide(sampleRide);
    expect(result.raw).toEqual({
      duration: 3600,
      distance: 30000,
      averagePower: 200,
      normalizedPower: 220,
      maxPower: 450,
      averageHeartRate: 150,
      maxHeartRate: 180,
      averageCadence: 90,
      maxCadence: 110,
      elevationGain: 500,
      elevationLoss: 480,
      averageSpeed: 8.33,
      maxSpeed: 15.0,
      calories: 800,
      trainingStressScore: 85,
      intensityFactor: 0.88,
    });
  });

  it("handles undefined optional fields", () => {
    const minimalRide = {
      id: 1,
      title: "Quick Spin",
      date: "2026-03-15T08:00:00Z",
      duration: 1800,
      distance: undefined,
      average_power: undefined,
      normalized_power: undefined,
      max_power: undefined,
      average_heart_rate: undefined,
      max_heart_rate: undefined,
      average_cadence: undefined,
      max_cadence: undefined,
      elevation_gain: undefined,
      elevation_loss: undefined,
      average_speed: undefined,
      max_speed: undefined,
      calories: undefined,
      training_stress_score: undefined,
      intensity_factor: undefined,
    };

    const result = parseCyclingAnalyticsRide(minimalRide);
    expect(result.raw.distance).toBeUndefined();
    expect(result.raw.averagePower).toBeUndefined();
    expect(result.raw.normalizedPower).toBeUndefined();
    expect(result.raw.maxPower).toBeUndefined();
    expect(result.raw.averageHeartRate).toBeUndefined();
    expect(result.raw.maxHeartRate).toBeUndefined();
    expect(result.raw.averageCadence).toBeUndefined();
    expect(result.raw.maxCadence).toBeUndefined();
    expect(result.raw.elevationGain).toBeUndefined();
    expect(result.raw.elevationLoss).toBeUndefined();
    expect(result.raw.averageSpeed).toBeUndefined();
    expect(result.raw.maxSpeed).toBeUndefined();
    expect(result.raw.calories).toBeUndefined();
    expect(result.raw.trainingStressScore).toBeUndefined();
    expect(result.raw.intensityFactor).toBeUndefined();
  });

  it("handles zero duration", () => {
    const result = parseCyclingAnalyticsRide({ ...sampleRide, duration: 0 });
    expect(result.endedAt).toEqual(result.startedAt);
  });
});

describe("cyclingAnalyticsOAuthConfig", () => {
  it("returns null when env vars are not set", () => {
    const original = { ...process.env };
    delete process.env.CYCLING_ANALYTICS_CLIENT_ID;
    delete process.env.CYCLING_ANALYTICS_CLIENT_SECRET;

    expect(cyclingAnalyticsOAuthConfig()).toBeNull();

    process.env = original;
  });

  it("returns config when env vars are set", () => {
    const original = { ...process.env };
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";

    const config = cyclingAnalyticsOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toEqual([]);
    expect(config?.authorizeUrl).toBe("https://www.cyclinganalytics.com/api/auth");
    expect(config?.tokenUrl).toBe("https://www.cyclinganalytics.com/api/token");

    process.env = original;
  });

  it("returns null when only client id is set", () => {
    const original = { ...process.env };
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    delete process.env.CYCLING_ANALYTICS_CLIENT_SECRET;

    expect(cyclingAnalyticsOAuthConfig()).toBeNull();

    process.env = original;
  });

  it("returns null when only client secret is set", () => {
    const original = { ...process.env };
    delete process.env.CYCLING_ANALYTICS_CLIENT_ID;
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";

    expect(cyclingAnalyticsOAuthConfig()).toBeNull();

    process.env = original;
  });

  it("uses custom redirect URI from env", () => {
    const original = { ...process.env };
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";

    const config = cyclingAnalyticsOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");

    process.env = original;
  });

  it("uses default redirect URI when env var is not set", () => {
    const original = { ...process.env };
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;

    const config = cyclingAnalyticsOAuthConfig();
    expect(config?.redirectUri).toBe("https://localhost:9876/callback");

    process.env = original;
  });
});

describe("CyclingAnalyticsProvider", () => {
  it("has correct id and name", () => {
    const provider = new CyclingAnalyticsProvider();
    expect(provider.id).toBe("cycling_analytics");
    expect(provider.name).toBe("Cycling Analytics");
  });

  describe("validate", () => {
    it("returns error when CYCLING_ANALYTICS_CLIENT_ID is not set", () => {
      const original = { ...process.env };
      delete process.env.CYCLING_ANALYTICS_CLIENT_ID;
      delete process.env.CYCLING_ANALYTICS_CLIENT_SECRET;

      const provider = new CyclingAnalyticsProvider();
      expect(provider.validate()).toBe("CYCLING_ANALYTICS_CLIENT_ID is not set");

      process.env = original;
    });

    it("returns error when CYCLING_ANALYTICS_CLIENT_SECRET is not set", () => {
      const original = { ...process.env };
      process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
      delete process.env.CYCLING_ANALYTICS_CLIENT_SECRET;

      const provider = new CyclingAnalyticsProvider();
      expect(provider.validate()).toBe("CYCLING_ANALYTICS_CLIENT_SECRET is not set");

      process.env = original;
    });

    it("returns null when both env vars are set", () => {
      const original = { ...process.env };
      process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
      process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";

      const provider = new CyclingAnalyticsProvider();
      expect(provider.validate()).toBeNull();

      process.env = original;
    });
  });

  describe("authSetup", () => {
    it("throws when env vars are not set", () => {
      const original = { ...process.env };
      delete process.env.CYCLING_ANALYTICS_CLIENT_ID;
      delete process.env.CYCLING_ANALYTICS_CLIENT_SECRET;

      const provider = new CyclingAnalyticsProvider();
      expect(() => provider.authSetup()).toThrow(
        "CYCLING_ANALYTICS_CLIENT_ID and CLIENT_SECRET required",
      );

      process.env = original;
    });

    it("returns auth setup when configured", () => {
      const original = { ...process.env };
      process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
      process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";

      const provider = new CyclingAnalyticsProvider();
      const setup = provider.authSetup();
      expect(setup.oauthConfig.clientId).toBe("test-id");
      expect(setup.apiBaseUrl).toBe("https://www.cyclinganalytics.com/api");

      process.env = original;
    });
  });
});
