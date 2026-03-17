import { describe, expect, it } from "vitest";
import {
  Concept2Provider,
  concept2OAuthConfig,
  mapConcept2Type,
  parseConcept2Result,
} from "./concept2.ts";

describe("mapConcept2Type", () => {
  it("maps rower to rowing", () => {
    expect(mapConcept2Type("rower")).toBe("rowing");
  });

  it("maps skierg to skiing", () => {
    expect(mapConcept2Type("skierg")).toBe("skiing");
  });

  it("maps bikerg to cycling", () => {
    expect(mapConcept2Type("bikerg")).toBe("cycling");
  });

  it("defaults to rowing for unknown types", () => {
    expect(mapConcept2Type("unknown")).toBe("rowing");
  });

  it("is case-insensitive", () => {
    expect(mapConcept2Type("Rower")).toBe("rowing");
    expect(mapConcept2Type("SKIERG")).toBe("skiing");
    expect(mapConcept2Type("BikeRg")).toBe("cycling");
  });
});

describe("parseConcept2Result", () => {
  const sampleResult = {
    id: 42,
    type: "rower",
    date: "2026-03-15 08:00:00",
    distance: 5000,
    time: 12000, // 12000 tenths of a second = 1200s = 20 min
    time_formatted: "20:00.0",
    stroke_rate: 28,
    stroke_count: 560,
    heart_rate: { average: 155, max: 175, min: 120 },
    calories_total: 250,
    drag_factor: 115,
    weight_class: "H",
    workout_type: "FixedDistance",
    comments: "Good session",
    privacy: "public",
  };

  it("parses external id as string", () => {
    const result = parseConcept2Result(sampleResult);
    expect(result.externalId).toBe("42");
  });

  it("maps activity type using mapConcept2Type", () => {
    const result = parseConcept2Result(sampleResult);
    expect(result.activityType).toBe("rowing");

    const skiResult = parseConcept2Result({ ...sampleResult, type: "skierg" });
    expect(skiResult.activityType).toBe("skiing");
  });

  it("generates name from type and workout type", () => {
    const result = parseConcept2Result(sampleResult);
    expect(result.name).toBe("Rower FixedDistance");
  });

  it("capitalizes first letter of type in name", () => {
    const result = parseConcept2Result({ ...sampleResult, type: "bikerg" });
    expect(result.name).toBe("Bikerg FixedDistance");
  });

  it("calculates start and end times from date and duration", () => {
    const result = parseConcept2Result(sampleResult);
    expect(result.startedAt).toEqual(new Date("2026-03-15 08:00:00"));
    // 12000 tenths of a second = 1200 seconds = 20 minutes
    const expectedEnd = new Date(result.startedAt.getTime() + 1200000);
    expect(result.endedAt).toEqual(expectedEnd);
  });

  it("includes all raw fields", () => {
    const result = parseConcept2Result(sampleResult);
    expect(result.raw).toEqual({
      type: "rower",
      distance: 5000,
      timeFormatted: "20:00.0",
      strokeRate: 28,
      strokeCount: 560,
      avgHeartRate: 155,
      maxHeartRate: 175,
      calories: 250,
      dragFactor: 115,
      workoutType: "FixedDistance",
      weightClass: "H",
    });
  });

  it("handles missing optional heart rate fields", () => {
    const result = parseConcept2Result({ ...sampleResult, heart_rate: undefined });
    expect(result.raw.avgHeartRate).toBeUndefined();
    expect(result.raw.maxHeartRate).toBeUndefined();
  });

  it("handles missing optional calories and drag factor", () => {
    const result = parseConcept2Result({
      ...sampleResult,
      calories_total: undefined,
      drag_factor: undefined,
    });
    expect(result.raw.calories).toBeUndefined();
    expect(result.raw.dragFactor).toBeUndefined();
  });
});

describe("concept2OAuthConfig", () => {
  it("returns null when env vars are not set", () => {
    const original = { ...process.env };
    delete process.env.CONCEPT2_CLIENT_ID;
    delete process.env.CONCEPT2_CLIENT_SECRET;

    expect(concept2OAuthConfig()).toBeNull();

    process.env = original;
  });

  it("returns config when env vars are set", () => {
    const original = { ...process.env };
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    process.env.CONCEPT2_CLIENT_SECRET = "test-secret";

    const config = concept2OAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toEqual(["user:read", "results:read"]);

    process.env = original;
  });

  it("returns null when only client id is set", () => {
    const original = { ...process.env };
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    delete process.env.CONCEPT2_CLIENT_SECRET;

    expect(concept2OAuthConfig()).toBeNull();

    process.env = original;
  });

  it("uses custom redirect URI from env", () => {
    const original = { ...process.env };
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    process.env.CONCEPT2_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";

    const config = concept2OAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");

    process.env = original;
  });

  it("uses default redirect URI when env var is not set", () => {
    const original = { ...process.env };
    process.env.CONCEPT2_CLIENT_ID = "test-id";
    process.env.CONCEPT2_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;

    const config = concept2OAuthConfig();
    expect(config?.redirectUri).toBe("https://localhost:9876/callback");

    process.env = original;
  });
});

describe("Concept2Provider", () => {
  it("has correct id and name", () => {
    const provider = new Concept2Provider();
    expect(provider.id).toBe("concept2");
    expect(provider.name).toBe("Concept2");
  });

  describe("validate", () => {
    it("returns error when CONCEPT2_CLIENT_ID is not set", () => {
      const original = { ...process.env };
      delete process.env.CONCEPT2_CLIENT_ID;
      delete process.env.CONCEPT2_CLIENT_SECRET;

      const provider = new Concept2Provider();
      expect(provider.validate()).toBe("CONCEPT2_CLIENT_ID is not set");

      process.env = original;
    });

    it("returns error when CONCEPT2_CLIENT_SECRET is not set", () => {
      const original = { ...process.env };
      process.env.CONCEPT2_CLIENT_ID = "test-id";
      delete process.env.CONCEPT2_CLIENT_SECRET;

      const provider = new Concept2Provider();
      expect(provider.validate()).toBe("CONCEPT2_CLIENT_SECRET is not set");

      process.env = original;
    });

    it("returns null when both env vars are set", () => {
      const original = { ...process.env };
      process.env.CONCEPT2_CLIENT_ID = "test-id";
      process.env.CONCEPT2_CLIENT_SECRET = "test-secret";

      const provider = new Concept2Provider();
      expect(provider.validate()).toBeNull();

      process.env = original;
    });
  });

  describe("authSetup", () => {
    it("throws when env vars are not set", () => {
      const original = { ...process.env };
      delete process.env.CONCEPT2_CLIENT_ID;
      delete process.env.CONCEPT2_CLIENT_SECRET;

      const provider = new Concept2Provider();
      expect(() => provider.authSetup()).toThrow("CONCEPT2_CLIENT_ID and CLIENT_SECRET required");

      process.env = original;
    });

    it("returns auth setup when configured", () => {
      const original = { ...process.env };
      process.env.CONCEPT2_CLIENT_ID = "test-id";
      process.env.CONCEPT2_CLIENT_SECRET = "test-secret";

      const provider = new Concept2Provider();
      const setup = provider.authSetup();
      expect(setup.oauthConfig.clientId).toBe("test-id");
      expect(setup.apiBaseUrl).toBe("https://log.concept2.com");

      process.env = original;
    });
  });
});
