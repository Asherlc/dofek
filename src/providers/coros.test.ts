import { describe, expect, it } from "vitest";
import { CorosProvider, corosOAuthConfig, mapCorosSportType, parseCorosWorkout } from "./coros.ts";

describe("mapCorosSportType", () => {
  it("maps running (8)", () => {
    expect(mapCorosSportType(8)).toBe("running");
  });

  it("maps cycling (9)", () => {
    expect(mapCorosSportType(9)).toBe("cycling");
  });

  it("maps swimming (10)", () => {
    expect(mapCorosSportType(10)).toBe("swimming");
  });

  it("maps strength (13)", () => {
    expect(mapCorosSportType(13)).toBe("strength");
  });

  it("maps walking (14)", () => {
    expect(mapCorosSportType(14)).toBe("walking");
  });

  it("maps hiking (15)", () => {
    expect(mapCorosSportType(15)).toBe("hiking");
  });

  it("maps rowing (17)", () => {
    expect(mapCorosSportType(17)).toBe("rowing");
  });

  it("maps yoga (18)", () => {
    expect(mapCorosSportType(18)).toBe("yoga");
  });

  it("maps trail_running (22)", () => {
    expect(mapCorosSportType(22)).toBe("trail_running");
  });

  it("maps skiing (23)", () => {
    expect(mapCorosSportType(23)).toBe("skiing");
  });

  it("maps triathlon (27)", () => {
    expect(mapCorosSportType(27)).toBe("triathlon");
  });

  it("maps other (100)", () => {
    expect(mapCorosSportType(100)).toBe("other");
  });

  it("defaults to other for unknown mode", () => {
    expect(mapCorosSportType(999)).toBe("other");
    expect(mapCorosSportType(0)).toBe("other");
    expect(mapCorosSportType(-1)).toBe("other");
  });
});

describe("parseCorosWorkout", () => {
  const sampleWorkout = {
    labelId: "abc-123",
    mode: 8,
    subMode: 0,
    startTime: 1710500000, // UNIX seconds
    endTime: 1710503600, // 1 hour later
    duration: 3600,
    distance: 10000,
    avgHeartRate: 150,
    maxHeartRate: 180,
    avgSpeed: 2.78,
    maxSpeed: 4.0,
    totalCalories: 500,
    avgCadence: 85,
    avgPower: 200,
    maxPower: 350,
    totalAscent: 100,
    totalDescent: 95,
  };

  it("uses labelId as externalId", () => {
    const result = parseCorosWorkout(sampleWorkout);
    expect(result.externalId).toBe("abc-123");
  });

  it("maps activity type using mapCorosSportType", () => {
    const result = parseCorosWorkout(sampleWorkout);
    expect(result.activityType).toBe("running");

    const cyclingWorkout = { ...sampleWorkout, mode: 9 };
    expect(parseCorosWorkout(cyclingWorkout).activityType).toBe("cycling");
  });

  it("generates name with COROS prefix and sport type", () => {
    const result = parseCorosWorkout(sampleWorkout);
    expect(result.name).toBe("COROS running");

    const cyclingWorkout = { ...sampleWorkout, mode: 9 };
    expect(parseCorosWorkout(cyclingWorkout).name).toBe("COROS cycling");
  });

  it("converts startTime from UNIX seconds to Date", () => {
    const result = parseCorosWorkout(sampleWorkout);
    expect(result.startedAt).toEqual(new Date(1710500000 * 1000));
  });

  it("converts endTime from UNIX seconds to Date", () => {
    const result = parseCorosWorkout(sampleWorkout);
    expect(result.endedAt).toEqual(new Date(1710503600 * 1000));
  });

  it("includes all raw fields", () => {
    const result = parseCorosWorkout(sampleWorkout);
    expect(result.raw).toEqual({
      distance: 10000,
      duration: 3600,
      avgHeartRate: 150,
      maxHeartRate: 180,
      avgSpeed: 2.78,
      maxSpeed: 4.0,
      calories: 500,
      avgCadence: 85,
      avgPower: 200,
      maxPower: 350,
      totalAscent: 100,
      totalDescent: 95,
      mode: 8,
      subMode: 0,
    });
  });

  it("handles undefined optional fields in raw", () => {
    const minimalWorkout = {
      labelId: "min-1",
      mode: 100,
      subMode: 0,
      startTime: 1710500000,
      endTime: 1710503600,
      duration: 3600,
      distance: 0,
      avgHeartRate: 0,
      maxHeartRate: 0,
      avgSpeed: 0,
      maxSpeed: 0,
      totalCalories: 0,
      avgCadence: undefined,
      avgPower: undefined,
      maxPower: undefined,
      totalAscent: undefined,
      totalDescent: undefined,
    };

    const result = parseCorosWorkout(minimalWorkout);
    expect(result.raw.avgCadence).toBeUndefined();
    expect(result.raw.avgPower).toBeUndefined();
    expect(result.raw.maxPower).toBeUndefined();
    expect(result.raw.totalAscent).toBeUndefined();
    expect(result.raw.totalDescent).toBeUndefined();
  });

  it("uses unknown type name for unmapped mode", () => {
    const unknownWorkout = { ...sampleWorkout, mode: 999 };
    const result = parseCorosWorkout(unknownWorkout);
    expect(result.name).toBe("COROS other");
    expect(result.activityType).toBe("other");
  });
});

describe("corosOAuthConfig", () => {
  it("returns null when env vars are not set", () => {
    const original = { ...process.env };
    delete process.env.COROS_CLIENT_ID;
    delete process.env.COROS_CLIENT_SECRET;

    expect(corosOAuthConfig()).toBeNull();

    process.env = original;
  });

  it("returns config when env vars are set", () => {
    const original = { ...process.env };
    process.env.COROS_CLIENT_ID = "test-id";
    process.env.COROS_CLIENT_SECRET = "test-secret";

    const config = corosOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toEqual([]);
    expect(config?.authorizeUrl).toBe("https://open.coros.com/oauth2/authorize");
    expect(config?.tokenUrl).toBe("https://open.coros.com/oauth2/token");

    process.env = original;
  });

  it("returns null when only client id is set", () => {
    const original = { ...process.env };
    process.env.COROS_CLIENT_ID = "test-id";
    delete process.env.COROS_CLIENT_SECRET;

    expect(corosOAuthConfig()).toBeNull();

    process.env = original;
  });

  it("returns null when only client secret is set", () => {
    const original = { ...process.env };
    delete process.env.COROS_CLIENT_ID;
    process.env.COROS_CLIENT_SECRET = "test-secret";

    expect(corosOAuthConfig()).toBeNull();

    process.env = original;
  });

  it("uses custom redirect URI from env", () => {
    const original = { ...process.env };
    process.env.COROS_CLIENT_ID = "test-id";
    process.env.COROS_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";

    const config = corosOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");

    process.env = original;
  });

  it("uses default redirect URI when env var is not set", () => {
    const original = { ...process.env };
    process.env.COROS_CLIENT_ID = "test-id";
    process.env.COROS_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;

    const config = corosOAuthConfig();
    expect(config?.redirectUri).toBe("https://localhost:9876/callback");

    process.env = original;
  });
});

describe("CorosProvider", () => {
  it("has correct id and name", () => {
    const provider = new CorosProvider();
    expect(provider.id).toBe("coros");
    expect(provider.name).toBe("COROS");
  });

  describe("validate", () => {
    it("returns error when COROS_CLIENT_ID is not set", () => {
      const original = { ...process.env };
      delete process.env.COROS_CLIENT_ID;
      delete process.env.COROS_CLIENT_SECRET;

      const provider = new CorosProvider();
      expect(provider.validate()).toBe("COROS_CLIENT_ID is not set");

      process.env = original;
    });

    it("returns error when COROS_CLIENT_SECRET is not set", () => {
      const original = { ...process.env };
      process.env.COROS_CLIENT_ID = "test-id";
      delete process.env.COROS_CLIENT_SECRET;

      const provider = new CorosProvider();
      expect(provider.validate()).toBe("COROS_CLIENT_SECRET is not set");

      process.env = original;
    });

    it("returns null when both env vars are set", () => {
      const original = { ...process.env };
      process.env.COROS_CLIENT_ID = "test-id";
      process.env.COROS_CLIENT_SECRET = "test-secret";

      const provider = new CorosProvider();
      expect(provider.validate()).toBeNull();

      process.env = original;
    });
  });

  describe("authSetup", () => {
    it("throws when env vars are not set", () => {
      const original = { ...process.env };
      delete process.env.COROS_CLIENT_ID;
      delete process.env.COROS_CLIENT_SECRET;

      const provider = new CorosProvider();
      expect(() => provider.authSetup()).toThrow("COROS_CLIENT_ID and CLIENT_SECRET required");

      process.env = original;
    });

    it("returns auth setup when configured", () => {
      const original = { ...process.env };
      process.env.COROS_CLIENT_ID = "test-id";
      process.env.COROS_CLIENT_SECRET = "test-secret";

      const provider = new CorosProvider();
      const setup = provider.authSetup();
      expect(setup.oauthConfig.clientId).toBe("test-id");
      expect(setup.apiBaseUrl).toBe("https://open.coros.com");

      process.env = original;
    });
  });
});
