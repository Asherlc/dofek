import { describe, expect, it } from "vitest";
import { parseUltrahumanMetrics, UltrahumanProvider } from "./ultrahuman.ts";

describe("parseUltrahumanMetrics", () => {
  it("parses resting heart rate from night_rhr with avg", () => {
    const metrics = [{ type: "night_rhr", object: { avg: 58.7 } }];
    const { daily } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(daily.restingHr).toBe(59); // Math.round(58.7)
  });

  it("parses resting heart rate from avg_rhr with value", () => {
    const metrics = [{ type: "avg_rhr", object: { value: 62.3 } }];
    const { daily } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(daily.restingHr).toBe(62); // Math.round(62.3)
  });

  it("prefers avg over value for night_rhr", () => {
    const metrics = [{ type: "night_rhr", object: { avg: 55.0, value: 60.0 } }];
    const { daily } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(daily.restingHr).toBe(55);
  });

  it("falls back to value when avg is missing for rhr", () => {
    const metrics = [{ type: "night_rhr", object: { value: 60.0 } }];
    const { daily } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(daily.restingHr).toBe(60);
  });

  it("sets restingHr to undefined when neither avg nor value is a number", () => {
    const metrics = [{ type: "night_rhr", object: { avg: "not-a-number" } }];
    const { daily } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(daily.restingHr).toBeUndefined();
  });

  it("parses HRV from avg_sleep_hrv", () => {
    const metrics = [{ type: "avg_sleep_hrv", object: { value: 45.2 } }];
    const { daily } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(daily.hrv).toBe(45.2);
  });

  it("sets hrv to undefined when value is not a number", () => {
    const metrics = [{ type: "avg_sleep_hrv", object: { value: "n/a" } }];
    const { daily } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(daily.hrv).toBeUndefined();
  });

  it("parses steps", () => {
    const metrics = [{ type: "steps", object: { value: 8542.7 } }];
    const { daily } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(daily.steps).toBe(8543); // Math.round
  });

  it("parses vo2max", () => {
    const metrics = [{ type: "vo2_max", object: { value: 52.3 } }];
    const { daily } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(daily.vo2max).toBe(52.3);
  });

  it("parses active_minutes into exerciseMinutes", () => {
    const metrics = [{ type: "active_minutes", object: { value: 45.8 } }];
    const { daily } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(daily.exerciseMinutes).toBe(46); // Math.round
  });

  it("parses body_temperature into skinTempC", () => {
    const metrics = [{ type: "body_temperature", object: { value: 36.8 } }];
    const { daily } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(daily.skinTempC).toBe(36.8);
  });

  it("parses sleep duration from quick_metrics total_sleep", () => {
    const metrics = [
      {
        type: "sleep",
        object: {
          quick_metrics: [
            { type: "total_sleep", value: 28800 }, // 8 hours in seconds
            { type: "sleep_index", value: 85 },
          ],
        },
      },
    ];
    const { sleep } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(sleep.durationMinutes).toBe(480); // 28800 / 60
    expect(sleep.sleepScore).toBe(85);
  });

  it("rounds sleep duration to nearest minute", () => {
    const metrics = [
      {
        type: "sleep",
        object: {
          quick_metrics: [{ type: "total_sleep", value: 27030 }], // 450.5 minutes
        },
      },
    ];
    const { sleep } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(sleep.durationMinutes).toBe(451);
  });

  it("handles sleep with no quick_metrics", () => {
    const metrics = [{ type: "sleep", object: {} }];
    const { sleep } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(sleep.durationMinutes).toBeUndefined();
    expect(sleep.sleepScore).toBeUndefined();
  });

  it("handles sleep with non-array quick_metrics", () => {
    const metrics = [{ type: "sleep", object: { quick_metrics: "invalid" } }];
    const { sleep } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(sleep.durationMinutes).toBeUndefined();
  });

  it("sets date on both daily and sleep objects", () => {
    const { daily, sleep } = parseUltrahumanMetrics("2026-03-15", []);
    expect(daily.date).toBe("2026-03-15");
    expect(sleep.date).toBe("2026-03-15");
  });

  it("handles empty metrics array", () => {
    const { daily, sleep } = parseUltrahumanMetrics("2026-03-15", []);
    expect(daily.restingHr).toBeUndefined();
    expect(daily.hrv).toBeUndefined();
    expect(daily.steps).toBeUndefined();
    expect(daily.vo2max).toBeUndefined();
    expect(daily.exerciseMinutes).toBeUndefined();
    expect(daily.skinTempC).toBeUndefined();
    expect(sleep.durationMinutes).toBeUndefined();
    expect(sleep.sleepScore).toBeUndefined();
  });

  it("handles multiple metrics of different types together", () => {
    const metrics = [
      { type: "night_rhr", object: { avg: 58 } },
      { type: "avg_sleep_hrv", object: { value: 42 } },
      { type: "steps", object: { value: 10000 } },
      { type: "vo2_max", object: { value: 50 } },
      { type: "active_minutes", object: { value: 30 } },
      { type: "body_temperature", object: { value: 36.5 } },
      {
        type: "sleep",
        object: {
          quick_metrics: [
            { type: "total_sleep", value: 25200 },
            { type: "sleep_index", value: 90 },
          ],
        },
      },
    ];
    const { daily, sleep } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(daily.restingHr).toBe(58);
    expect(daily.hrv).toBe(42);
    expect(daily.steps).toBe(10000);
    expect(daily.vo2max).toBe(50);
    expect(daily.exerciseMinutes).toBe(30);
    expect(daily.skinTempC).toBe(36.5);
    expect(sleep.durationMinutes).toBe(420);
    expect(sleep.sleepScore).toBe(90);
  });

  it("ignores unknown metric types", () => {
    const metrics = [{ type: "unknown_metric", object: { value: 999 } }];
    const { daily } = parseUltrahumanMetrics("2026-03-15", metrics);
    expect(daily.restingHr).toBeUndefined();
    expect(daily.hrv).toBeUndefined();
  });
});

describe("UltrahumanProvider", () => {
  it("has correct id and name", () => {
    const provider = new UltrahumanProvider();
    expect(provider.id).toBe("ultrahuman");
    expect(provider.name).toBe("Ultrahuman");
  });

  describe("validate", () => {
    it("returns error when ULTRAHUMAN_API_TOKEN is not set", () => {
      const original = { ...process.env };
      delete process.env.ULTRAHUMAN_API_TOKEN;
      delete process.env.ULTRAHUMAN_EMAIL;

      const provider = new UltrahumanProvider();
      expect(provider.validate()).toBe("ULTRAHUMAN_API_TOKEN is not set");

      process.env = original;
    });

    it("returns error when ULTRAHUMAN_EMAIL is not set", () => {
      const original = { ...process.env };
      process.env.ULTRAHUMAN_API_TOKEN = "test-token";
      delete process.env.ULTRAHUMAN_EMAIL;

      const provider = new UltrahumanProvider();
      expect(provider.validate()).toBe("ULTRAHUMAN_EMAIL is not set");

      process.env = original;
    });

    it("returns null when both env vars are set", () => {
      const original = { ...process.env };
      process.env.ULTRAHUMAN_API_TOKEN = "test-token";
      process.env.ULTRAHUMAN_EMAIL = "test@example.com";

      const provider = new UltrahumanProvider();
      expect(provider.validate()).toBeNull();

      process.env = original;
    });
  });

  describe("authSetup", () => {
    it("returns auth setup with empty OAuth config", () => {
      const provider = new UltrahumanProvider();
      const setup = provider.authSetup();
      expect(setup.oauthConfig.clientId).toBe("");
      expect(setup.oauthConfig.authorizeUrl).toBe("");
      expect(setup.oauthConfig.tokenUrl).toBe("");
      expect(setup.oauthConfig.redirectUri).toBe("");
      expect(setup.oauthConfig.scopes).toEqual([]);
    });

    it("has automatedLogin function", () => {
      const provider = new UltrahumanProvider();
      const setup = provider.authSetup();
      expect(setup.automatedLogin).toBeDefined();
    });

    it("automatedLogin returns token and far-future expiry", async () => {
      const original = { ...process.env };
      process.env.ULTRAHUMAN_API_TOKEN = "my-api-token";
      process.env.ULTRAHUMAN_EMAIL = "user@example.com";

      const provider = new UltrahumanProvider();
      const setup = provider.authSetup();
      if (!setup.automatedLogin) throw new Error("automatedLogin should be defined");
      const result = await setup.automatedLogin("", "");
      expect(result.accessToken).toBe("my-api-token");
      expect(result.refreshToken).toBeNull();
      expect(result.expiresAt).toEqual(new Date("2099-12-31T23:59:59Z"));
      expect(result.scopes).toBe("email:user@example.com");

      process.env = original;
    });

    it("automatedLogin throws when env vars not set", async () => {
      const original = { ...process.env };
      delete process.env.ULTRAHUMAN_API_TOKEN;
      delete process.env.ULTRAHUMAN_EMAIL;

      const provider = new UltrahumanProvider();
      const setup = provider.authSetup();
      if (!setup.automatedLogin) throw new Error("automatedLogin should be defined");
      await expect(setup.automatedLogin("", "")).rejects.toThrow(
        "ULTRAHUMAN_API_TOKEN and ULTRAHUMAN_EMAIL required",
      );

      process.env = original;
    });

    it("exchangeCode throws error", async () => {
      const provider = new UltrahumanProvider();
      const setup = provider.authSetup();
      await expect(setup.exchangeCode("some-code")).rejects.toThrow(
        "Ultrahuman uses API token auth, not OAuth code exchange",
      );
    });
  });
});
