import { describe, expect, it } from "vitest";
import {
  parseWgerWeightEntry,
  parseWgerWorkoutSession,
  WgerProvider,
  wgerOAuthConfig,
} from "./wger.ts";

describe("parseWgerWorkoutSession", () => {
  const sampleSession = {
    id: 42,
    date: "2026-03-15",
    comment: "Chest and arms",
    impression: "2",
    time_start: "08:00:00",
    time_end: "09:30:00",
  };

  it("converts id to string externalId", () => {
    const result = parseWgerWorkoutSession(sampleSession);
    expect(result.externalId).toBe("42");
  });

  it("always sets activityType to strength", () => {
    const result = parseWgerWorkoutSession(sampleSession);
    expect(result.activityType).toBe("strength");
  });

  it("uses comment as name", () => {
    const result = parseWgerWorkoutSession(sampleSession);
    expect(result.name).toBe("Chest and arms");
  });

  it("falls back to Workout when comment is empty", () => {
    const result = parseWgerWorkoutSession({ ...sampleSession, comment: "" });
    expect(result.name).toBe("Workout");
  });

  it("parses date into startedAt", () => {
    const result = parseWgerWorkoutSession(sampleSession);
    expect(result.startedAt).toEqual(new Date("2026-03-15"));
  });

  it("includes all raw fields", () => {
    const result = parseWgerWorkoutSession(sampleSession);
    expect(result.raw).toEqual({
      comment: "Chest and arms",
      impression: "2",
      timeStart: "08:00:00",
      timeEnd: "09:30:00",
    });
  });

  it("handles null time fields", () => {
    const result = parseWgerWorkoutSession({
      ...sampleSession,
      time_start: null,
      time_end: null,
    });
    expect(result.raw.timeStart).toBeNull();
    expect(result.raw.timeEnd).toBeNull();
  });
});

describe("parseWgerWeightEntry", () => {
  const sampleEntry = {
    id: 99,
    date: "2026-03-15",
    weight: "85.5",
  };

  it("converts id to string externalId", () => {
    const result = parseWgerWeightEntry(sampleEntry);
    expect(result.externalId).toBe("99");
  });

  it("parses date into recordedAt", () => {
    const result = parseWgerWeightEntry(sampleEntry);
    expect(result.recordedAt).toEqual(new Date("2026-03-15"));
  });

  it("parses weight string to number", () => {
    const result = parseWgerWeightEntry(sampleEntry);
    expect(result.weightKg).toBe(85.5);
  });

  it("handles integer weight", () => {
    const result = parseWgerWeightEntry({ ...sampleEntry, weight: "90" });
    expect(result.weightKg).toBe(90);
  });

  it("handles small decimal weight", () => {
    const result = parseWgerWeightEntry({ ...sampleEntry, weight: "55.123" });
    expect(result.weightKg).toBeCloseTo(55.123);
  });
});

describe("wgerOAuthConfig", () => {
  it("returns null when env vars are not set", () => {
    const original = { ...process.env };
    delete process.env.WGER_CLIENT_ID;
    delete process.env.WGER_CLIENT_SECRET;

    expect(wgerOAuthConfig()).toBeNull();

    process.env = original;
  });

  it("returns config when env vars are set", () => {
    const original = { ...process.env };
    process.env.WGER_CLIENT_ID = "test-id";
    process.env.WGER_CLIENT_SECRET = "test-secret";

    const config = wgerOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toEqual(["read"]);
    expect(config?.authorizeUrl).toBe("https://wger.de/en/user/authorize");
    expect(config?.tokenUrl).toBe("https://wger.de/api/v2/token");

    process.env = original;
  });

  it("returns null when only client id is set", () => {
    const original = { ...process.env };
    process.env.WGER_CLIENT_ID = "test-id";
    delete process.env.WGER_CLIENT_SECRET;

    expect(wgerOAuthConfig()).toBeNull();

    process.env = original;
  });

  it("returns null when only client secret is set", () => {
    const original = { ...process.env };
    delete process.env.WGER_CLIENT_ID;
    process.env.WGER_CLIENT_SECRET = "test-secret";

    expect(wgerOAuthConfig()).toBeNull();

    process.env = original;
  });

  it("uses custom redirect URI from env", () => {
    const original = { ...process.env };
    process.env.WGER_CLIENT_ID = "test-id";
    process.env.WGER_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";

    const config = wgerOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");

    process.env = original;
  });

  it("uses default redirect URI when env var is not set", () => {
    const original = { ...process.env };
    process.env.WGER_CLIENT_ID = "test-id";
    process.env.WGER_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;

    const config = wgerOAuthConfig();
    expect(config?.redirectUri).toBe("https://localhost:9876/callback");

    process.env = original;
  });
});

describe("WgerProvider", () => {
  it("has correct id and name", () => {
    const provider = new WgerProvider();
    expect(provider.id).toBe("wger");
    expect(provider.name).toBe("Wger");
  });

  describe("validate", () => {
    it("returns error when WGER_CLIENT_ID is not set", () => {
      const original = { ...process.env };
      delete process.env.WGER_CLIENT_ID;
      delete process.env.WGER_CLIENT_SECRET;

      const provider = new WgerProvider();
      expect(provider.validate()).toBe("WGER_CLIENT_ID is not set");

      process.env = original;
    });

    it("returns error when WGER_CLIENT_SECRET is not set", () => {
      const original = { ...process.env };
      process.env.WGER_CLIENT_ID = "test-id";
      delete process.env.WGER_CLIENT_SECRET;

      const provider = new WgerProvider();
      expect(provider.validate()).toBe("WGER_CLIENT_SECRET is not set");

      process.env = original;
    });

    it("returns null when both env vars are set", () => {
      const original = { ...process.env };
      process.env.WGER_CLIENT_ID = "test-id";
      process.env.WGER_CLIENT_SECRET = "test-secret";

      const provider = new WgerProvider();
      expect(provider.validate()).toBeNull();

      process.env = original;
    });
  });

  describe("authSetup", () => {
    it("throws when env vars are not set", () => {
      const original = { ...process.env };
      delete process.env.WGER_CLIENT_ID;
      delete process.env.WGER_CLIENT_SECRET;

      const provider = new WgerProvider();
      expect(() => provider.authSetup()).toThrow("WGER_CLIENT_ID and CLIENT_SECRET required");

      process.env = original;
    });

    it("returns auth setup when configured", () => {
      const original = { ...process.env };
      process.env.WGER_CLIENT_ID = "test-id";
      process.env.WGER_CLIENT_SECRET = "test-secret";

      const provider = new WgerProvider();
      const setup = provider.authSetup();
      expect(setup.oauthConfig.clientId).toBe("test-id");
      expect(setup.apiBaseUrl).toBe("https://wger.de/api/v2");

      process.env = original;
    });
  });
});
