import { describe, expect, it } from "vitest";
import {
  mapSuuntoActivityType,
  parseSuuntoWorkout,
  SuuntoProvider,
  suuntoOAuthConfig,
} from "./suunto.ts";

describe("mapSuuntoActivityType", () => {
  it("maps 1 to other", () => {
    expect(mapSuuntoActivityType(1)).toBe("other");
  });

  it("maps 2 to running", () => {
    expect(mapSuuntoActivityType(2)).toBe("running");
  });

  it("maps 3 to cycling", () => {
    expect(mapSuuntoActivityType(3)).toBe("cycling");
  });

  it("maps 4 to cross_country_skiing", () => {
    expect(mapSuuntoActivityType(4)).toBe("cross_country_skiing");
  });

  it("maps 5 to other", () => {
    expect(mapSuuntoActivityType(5)).toBe("other");
  });

  it("maps 11 to walking", () => {
    expect(mapSuuntoActivityType(11)).toBe("walking");
  });

  it("maps 12 to hiking", () => {
    expect(mapSuuntoActivityType(12)).toBe("hiking");
  });

  it("maps 14 to strength", () => {
    expect(mapSuuntoActivityType(14)).toBe("strength");
  });

  it("maps 23 to yoga", () => {
    expect(mapSuuntoActivityType(23)).toBe("yoga");
  });

  it("maps 27 to swimming", () => {
    expect(mapSuuntoActivityType(27)).toBe("swimming");
  });

  it("maps 67 to trail_running", () => {
    expect(mapSuuntoActivityType(67)).toBe("trail_running");
  });

  it("maps 69 to rowing", () => {
    expect(mapSuuntoActivityType(69)).toBe("rowing");
  });

  it("maps 82 to virtual_cycling", () => {
    expect(mapSuuntoActivityType(82)).toBe("virtual_cycling");
  });

  it("maps 83 to virtual_running", () => {
    expect(mapSuuntoActivityType(83)).toBe("virtual_running");
  });

  it("defaults to other for unknown id", () => {
    expect(mapSuuntoActivityType(999)).toBe("other");
    expect(mapSuuntoActivityType(0)).toBe("other");
    expect(mapSuuntoActivityType(-1)).toBe("other");
  });
});

describe("parseSuuntoWorkout", () => {
  const sampleWorkout = {
    workoutKey: "abc-def-123",
    activityId: 2,
    workoutName: "Morning Run",
    startTime: 1710500000000, // UNIX milliseconds
    stopTime: 1710503600000,
    totalTime: 3600,
    totalDistance: 10000,
    totalAscent: 150,
    totalDescent: 140,
    avgSpeed: 2.78,
    maxSpeed: 4.5,
    energyConsumption: 500,
    stepCount: 8000,
    hrdata: {
      workoutAvgHR: 155,
      workoutMaxHR: 180,
    },
  };

  it("uses workoutKey as externalId", () => {
    const result = parseSuuntoWorkout(sampleWorkout);
    expect(result.externalId).toBe("abc-def-123");
  });

  it("maps activity type using mapSuuntoActivityType", () => {
    const result = parseSuuntoWorkout(sampleWorkout);
    expect(result.activityType).toBe("running");

    const cyclingWorkout = { ...sampleWorkout, activityId: 3 };
    expect(parseSuuntoWorkout(cyclingWorkout).activityType).toBe("cycling");
  });

  it("uses workoutName when provided", () => {
    const result = parseSuuntoWorkout(sampleWorkout);
    expect(result.name).toBe("Morning Run");
  });

  it("falls back to Suunto + type name when workoutName is missing", () => {
    const result = parseSuuntoWorkout({ ...sampleWorkout, workoutName: undefined });
    expect(result.name).toBe("Suunto running");
  });

  it("converts startTime from UNIX milliseconds to Date", () => {
    const result = parseSuuntoWorkout(sampleWorkout);
    expect(result.startedAt).toEqual(new Date(1710500000000));
  });

  it("converts stopTime from UNIX milliseconds to Date", () => {
    const result = parseSuuntoWorkout(sampleWorkout);
    expect(result.endedAt).toEqual(new Date(1710503600000));
  });

  it("includes all raw fields", () => {
    const result = parseSuuntoWorkout(sampleWorkout);
    expect(result.raw).toEqual({
      totalDistance: 10000,
      totalTime: 3600,
      totalAscent: 150,
      totalDescent: 140,
      avgSpeed: 2.78,
      maxSpeed: 4.5,
      calories: 500,
      steps: 8000,
      avgHeartRate: 155,
      maxHeartRate: 180,
    });
  });

  it("handles missing hrdata", () => {
    const result = parseSuuntoWorkout({ ...sampleWorkout, hrdata: undefined });
    expect(result.raw.avgHeartRate).toBeUndefined();
    expect(result.raw.maxHeartRate).toBeUndefined();
  });

  it("uses fallback name with mapped type for unknown activityId", () => {
    const result = parseSuuntoWorkout({
      ...sampleWorkout,
      workoutName: undefined,
      activityId: 999,
    });
    expect(result.name).toBe("Suunto other");
  });
});

describe("suuntoOAuthConfig", () => {
  it("returns null when env vars are not set", () => {
    const original = { ...process.env };
    delete process.env.SUUNTO_CLIENT_ID;
    delete process.env.SUUNTO_CLIENT_SECRET;

    expect(suuntoOAuthConfig()).toBeNull();

    process.env = original;
  });

  it("returns config when env vars are set", () => {
    const original = { ...process.env };
    process.env.SUUNTO_CLIENT_ID = "test-id";
    process.env.SUUNTO_CLIENT_SECRET = "test-secret";

    const config = suuntoOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toEqual(["workout"]);
    expect(config?.authorizeUrl).toBe("https://cloudapi-oauth.suunto.com/oauth/authorize");
    expect(config?.tokenUrl).toBe("https://cloudapi-oauth.suunto.com/oauth/token");
    expect(config?.tokenAuthMethod).toBe("basic");

    process.env = original;
  });

  it("returns null when only client id is set", () => {
    const original = { ...process.env };
    process.env.SUUNTO_CLIENT_ID = "test-id";
    delete process.env.SUUNTO_CLIENT_SECRET;

    expect(suuntoOAuthConfig()).toBeNull();

    process.env = original;
  });

  it("uses custom redirect URI from env", () => {
    const original = { ...process.env };
    process.env.SUUNTO_CLIENT_ID = "test-id";
    process.env.SUUNTO_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";

    const config = suuntoOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");

    process.env = original;
  });

  it("uses default redirect URI when env var is not set", () => {
    const original = { ...process.env };
    process.env.SUUNTO_CLIENT_ID = "test-id";
    process.env.SUUNTO_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;

    const config = suuntoOAuthConfig();
    expect(config?.redirectUri).toBe("https://localhost:9876/callback");

    process.env = original;
  });
});

describe("SuuntoProvider", () => {
  it("has correct id and name", () => {
    const provider = new SuuntoProvider();
    expect(provider.id).toBe("suunto");
    expect(provider.name).toBe("Suunto");
  });

  describe("validate", () => {
    it("returns error when SUUNTO_CLIENT_ID is not set", () => {
      const original = { ...process.env };
      delete process.env.SUUNTO_CLIENT_ID;
      delete process.env.SUUNTO_CLIENT_SECRET;
      delete process.env.SUUNTO_SUBSCRIPTION_KEY;

      const provider = new SuuntoProvider();
      expect(provider.validate()).toBe("SUUNTO_CLIENT_ID is not set");

      process.env = original;
    });

    it("returns error when SUUNTO_CLIENT_SECRET is not set", () => {
      const original = { ...process.env };
      process.env.SUUNTO_CLIENT_ID = "test-id";
      delete process.env.SUUNTO_CLIENT_SECRET;
      delete process.env.SUUNTO_SUBSCRIPTION_KEY;

      const provider = new SuuntoProvider();
      expect(provider.validate()).toBe("SUUNTO_CLIENT_SECRET is not set");

      process.env = original;
    });

    it("returns error when SUUNTO_SUBSCRIPTION_KEY is not set", () => {
      const original = { ...process.env };
      process.env.SUUNTO_CLIENT_ID = "test-id";
      process.env.SUUNTO_CLIENT_SECRET = "test-secret";
      delete process.env.SUUNTO_SUBSCRIPTION_KEY;

      const provider = new SuuntoProvider();
      expect(provider.validate()).toBe("SUUNTO_SUBSCRIPTION_KEY is not set");

      process.env = original;
    });

    it("returns null when all env vars are set", () => {
      const original = { ...process.env };
      process.env.SUUNTO_CLIENT_ID = "test-id";
      process.env.SUUNTO_CLIENT_SECRET = "test-secret";
      process.env.SUUNTO_SUBSCRIPTION_KEY = "test-key";

      const provider = new SuuntoProvider();
      expect(provider.validate()).toBeNull();

      process.env = original;
    });
  });

  describe("authSetup", () => {
    it("throws when env vars are not set", () => {
      const original = { ...process.env };
      delete process.env.SUUNTO_CLIENT_ID;
      delete process.env.SUUNTO_CLIENT_SECRET;

      const provider = new SuuntoProvider();
      expect(() => provider.authSetup()).toThrow("SUUNTO_CLIENT_ID and CLIENT_SECRET required");

      process.env = original;
    });

    it("returns auth setup when configured", () => {
      const original = { ...process.env };
      process.env.SUUNTO_CLIENT_ID = "test-id";
      process.env.SUUNTO_CLIENT_SECRET = "test-secret";

      const provider = new SuuntoProvider();
      const setup = provider.authSetup();
      expect(setup.oauthConfig.clientId).toBe("test-id");
      expect(setup.apiBaseUrl).toBe("https://cloudapi.suunto.com");

      process.env = original;
    });
  });
});
