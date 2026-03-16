import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CyclingAnalyticsProvider,
  cyclingAnalyticsOAuthConfig,
  parseCyclingAnalyticsRide,
} from "../cycling-analytics.ts";

describe("parseCyclingAnalyticsRide — edge cases", () => {
  it("handles ride with minimal fields", () => {
    const ride = {
      id: 1,
      title: "Quick Spin",
      date: "2026-03-01T10:00:00Z",
      duration: 1800,
    };

    const parsed = parseCyclingAnalyticsRide(ride);
    expect(parsed.externalId).toBe("1");
    expect(parsed.activityType).toBe("cycling");
    expect(parsed.name).toBe("Quick Spin");
    expect(parsed.startedAt).toEqual(new Date("2026-03-01T10:00:00Z"));
    expect(parsed.endedAt).toEqual(new Date("2026-03-01T10:30:00Z"));
    expect(parsed.raw.distance).toBeUndefined();
    expect(parsed.raw.averagePower).toBeUndefined();
    expect(parsed.raw.calories).toBeUndefined();
    expect(parsed.raw.trainingStressScore).toBeUndefined();
  });

  it("includes all raw fields when present", () => {
    const ride = {
      id: 99,
      title: "Full Ride",
      date: "2026-03-01T08:00:00Z",
      duration: 7200,
      distance: 60000,
      average_power: 200,
      normalized_power: 220,
      max_power: 500,
      average_heart_rate: 145,
      max_heart_rate: 180,
      average_cadence: 88,
      max_cadence: 115,
      elevation_gain: 500,
      elevation_loss: 490,
      average_speed: 8.33,
      max_speed: 15.0,
      calories: 1200,
      training_stress_score: 150,
      intensity_factor: 0.9,
    };

    const parsed = parseCyclingAnalyticsRide(ride);
    expect(parsed.raw.normalizedPower).toBe(220);
    expect(parsed.raw.maxPower).toBe(500);
    expect(parsed.raw.averageCadence).toBe(88);
    expect(parsed.raw.maxCadence).toBe(115);
    expect(parsed.raw.elevationGain).toBe(500);
    expect(parsed.raw.elevationLoss).toBe(490);
    expect(parsed.raw.averageSpeed).toBe(8.33);
    expect(parsed.raw.maxSpeed).toBe(15.0);
    expect(parsed.raw.intensityFactor).toBe(0.9);
  });
});

describe("cyclingAnalyticsOAuthConfig", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when missing", () => {
    delete process.env.CYCLING_ANALYTICS_CLIENT_ID;
    delete process.env.CYCLING_ANALYTICS_CLIENT_SECRET;
    expect(cyclingAnalyticsOAuthConfig()).toBeNull();
  });

  it("returns config when set", () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "secret";
    const config = cyclingAnalyticsOAuthConfig();
    expect(config?.clientId).toBe("id");
    expect(config?.authorizeUrl).toContain("cyclinganalytics.com");
  });
});

describe("CyclingAnalyticsProvider", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("validate checks env vars", () => {
    delete process.env.CYCLING_ANALYTICS_CLIENT_ID;
    delete process.env.CYCLING_ANALYTICS_CLIENT_SECRET;
    expect(new CyclingAnalyticsProvider().validate()).toContain("CYCLING_ANALYTICS_CLIENT_ID");
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "id";
    expect(new CyclingAnalyticsProvider().validate()).toContain("CYCLING_ANALYTICS_CLIENT_SECRET");
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "secret";
    expect(new CyclingAnalyticsProvider().validate()).toBeNull();
  });

  it("authSetup returns config", () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "secret";
    const setup = new CyclingAnalyticsProvider().authSetup();
    expect(setup.oauthConfig.clientId).toBe("id");
    expect(setup.apiBaseUrl).toContain("cyclinganalytics.com");
  });

  it("sync returns error when no tokens", async () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "secret";
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };
    const result = await new CyclingAnalyticsProvider().sync(
      // @ts-expect-error mock DB
      mockDb,
      new Date("2026-01-01"),
    );
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
