import { describe, expect, it, vi } from "vitest";
import { mapXertSport, parseXertActivity, XertProvider, xertOAuthConfig } from "../xert.ts";

describe("mapXertSport — all types", () => {
  it("maps all known sports", () => {
    expect(mapXertSport("Cycling")).toBe("cycling");
    expect(mapXertSport("Running")).toBe("running");
    expect(mapXertSport("Swimming")).toBe("swimming");
    expect(mapXertSport("Walking")).toBe("walking");
    expect(mapXertSport("Hiking")).toBe("hiking");
    expect(mapXertSport("Rowing")).toBe("rowing");
    expect(mapXertSport("Skiing")).toBe("skiing");
    expect(mapXertSport("Virtual Cycling")).toBe("cycling");
    expect(mapXertSport("Mountain Biking")).toBe("mountain_biking");
    expect(mapXertSport("Trail Running")).toBe("trail_running");
    expect(mapXertSport("Cross Country Skiing")).toBe("cross_country_skiing");
  });

  it("returns other for unknown", () => {
    expect(mapXertSport("Unknown")).toBe("other");
  });
});

describe("parseXertActivity — edge cases", () => {
  it("includes all raw fields", () => {
    const raw = {
      id: 1,
      name: "Test",
      sport: "Swimming",
      startTimestamp: 1709290800,
      endTimestamp: 1709294400,
      duration: 3600,
      distance: 2000,
      power_avg: 0,
      power_max: 0,
      power_normalized: 0,
      heartrate_avg: 130,
      heartrate_max: 160,
      cadence_avg: 40,
      cadence_max: 50,
      calories: 400,
      elevation_gain: 0,
      elevation_loss: 0,
      xss: 50,
      focus: 90,
      difficulty: 2,
    };

    const parsed = parseXertActivity(raw);
    expect(parsed.activityType).toBe("swimming");
    expect(parsed.raw.heartrateAvg).toBe(130);
    expect(parsed.raw.cadenceAvg).toBe(40);
    expect(parsed.raw.cadenceMax).toBe(50);
    expect(parsed.raw.elevationGain).toBe(0);
    expect(parsed.raw.elevationLoss).toBe(0);
    expect(parsed.raw.focus).toBe(90);
    expect(parsed.raw.difficulty).toBe(2);
  });
});

describe("xertOAuthConfig", () => {
  it("returns config with default public client credentials", () => {
    const config = xertOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("xert_public");
    expect(config?.tokenAuthMethod).toBe("basic");
  });

  it("uses custom env vars when set", () => {
    const originalEnv = { ...process.env };
    process.env.XERT_CLIENT_ID = "custom-id";
    process.env.XERT_CLIENT_SECRET = "custom-secret";
    const config = xertOAuthConfig();
    expect(config?.clientId).toBe("custom-id");
    expect(config?.clientSecret).toBe("custom-secret");
    process.env = { ...originalEnv };
  });
});

describe("XertProvider", () => {
  it("validate returns null (always valid)", () => {
    expect(new XertProvider().validate()).toBeNull();
  });

  it("authSetup returns config", () => {
    const setup = new XertProvider().authSetup();
    expect(setup.oauthConfig.clientId).toBeDefined();
    expect(setup.apiBaseUrl).toContain("xertonline.com");
  });

  it("sync returns error when no tokens", async () => {
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
    const result = await new XertProvider().sync(mockDb as never, new Date("2026-01-01"));
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
