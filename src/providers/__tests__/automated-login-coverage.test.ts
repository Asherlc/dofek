import { afterEach, describe, expect, it } from "vitest";
import { EightSleepProvider } from "../eight-sleep.ts";
import { TrainerRoadProvider } from "../trainerroad.ts";
import { parseUltrahumanMetrics, UltrahumanClient, UltrahumanProvider } from "../ultrahuman.ts";
import { VeloHeroProvider } from "../velohero.ts";
import { ZwiftProvider } from "../zwift.ts";

// ============================================================
// Eight Sleep
// ============================================================

describe("EightSleepProvider", () => {
  describe("validate()", () => {
    it("returns null (always enabled)", () => {
      const provider = new EightSleepProvider();
      expect(provider.validate()).toBeNull();
    });
  });

  describe("provider identity", () => {
    it("has correct id and name", () => {
      const provider = new EightSleepProvider();
      expect(provider.id).toBe("eight-sleep");
      expect(provider.name).toBe("Eight Sleep");
    });
  });

  describe("authSetup()", () => {
    it("returns auth setup with automatedLogin function", () => {
      const provider = new EightSleepProvider();
      const setup = provider.authSetup();
      expect(setup.automatedLogin).toBeTypeOf("function");
      expect(setup.oauthConfig.authorizeUrl).toContain("8slp.net");
    });

    it("has correct oauthConfig fields", () => {
      const provider = new EightSleepProvider();
      const setup = provider.authSetup();
      expect(setup.oauthConfig.tokenUrl).toContain("8slp.net");
      expect(setup.oauthConfig.redirectUri).toBe("");
      expect(setup.oauthConfig.scopes).toEqual([]);
    });

    it("exchangeCode throws with descriptive message", async () => {
      const provider = new EightSleepProvider();
      const setup = provider.authSetup();
      await expect(setup.exchangeCode("code", "verifier")).rejects.toThrow("automated login");
      await expect(setup.exchangeCode("code", "verifier")).rejects.toThrow(
        "Eight Sleep uses automated login, not OAuth code exchange",
      );
    });

    it("accepts custom fetch function", () => {
      const mockFetch: typeof globalThis.fetch = () => Promise.resolve(new Response());
      const provider = new EightSleepProvider(mockFetch);
      expect(provider.validate()).toBeNull();
    });
  });
});

// ============================================================
// TrainerRoad
// ============================================================

describe("TrainerRoadProvider", () => {
  describe("validate()", () => {
    it("returns null (always enabled)", () => {
      const provider = new TrainerRoadProvider();
      expect(provider.validate()).toBeNull();
    });
  });

  describe("provider identity", () => {
    it("has correct id and name", () => {
      const provider = new TrainerRoadProvider();
      expect(provider.id).toBe("trainerroad");
      expect(provider.name).toBe("TrainerRoad");
    });
  });

  describe("authSetup()", () => {
    it("returns auth setup with automatedLogin function", () => {
      const provider = new TrainerRoadProvider();
      const setup = provider.authSetup();
      expect(setup.automatedLogin).toBeTypeOf("function");
      expect(setup.oauthConfig.authorizeUrl).toContain("trainerroad.com");
    });

    it("has correct oauthConfig fields", () => {
      const provider = new TrainerRoadProvider();
      const setup = provider.authSetup();
      expect(setup.oauthConfig.clientId).toBe("");
      expect(setup.oauthConfig.tokenUrl).toContain("trainerroad.com");
      expect(setup.oauthConfig.redirectUri).toBe("");
      expect(setup.oauthConfig.scopes).toEqual([]);
    });

    it("exchangeCode throws with descriptive message", async () => {
      const provider = new TrainerRoadProvider();
      const setup = provider.authSetup();
      await expect(setup.exchangeCode("code", "verifier")).rejects.toThrow("automated login");
      await expect(setup.exchangeCode("code", "verifier")).rejects.toThrow(
        "TrainerRoad uses automated login, not OAuth code exchange",
      );
    });

    it("accepts custom fetch function", () => {
      const mockFetch: typeof globalThis.fetch = () => Promise.resolve(new Response());
      const provider = new TrainerRoadProvider(mockFetch);
      expect(provider.validate()).toBeNull();
    });
  });
});

// ============================================================
// VeloHero
// ============================================================

describe("VeloHeroProvider", () => {
  describe("validate()", () => {
    it("returns null (always enabled)", () => {
      const provider = new VeloHeroProvider();
      expect(provider.validate()).toBeNull();
    });
  });

  describe("provider identity", () => {
    it("has correct id and name", () => {
      const provider = new VeloHeroProvider();
      expect(provider.id).toBe("velohero");
      expect(provider.name).toBe("VeloHero");
    });
  });

  describe("authSetup()", () => {
    it("returns auth setup with automatedLogin function", () => {
      const provider = new VeloHeroProvider();
      const setup = provider.authSetup();
      expect(setup.automatedLogin).toBeTypeOf("function");
      expect(setup.oauthConfig.authorizeUrl).toContain("velohero.com");
    });

    it("has correct oauthConfig fields", () => {
      const provider = new VeloHeroProvider();
      const setup = provider.authSetup();
      expect(setup.oauthConfig.clientId).toBe("");
      expect(setup.oauthConfig.clientSecret).toBe("");
      expect(setup.oauthConfig.tokenUrl).toContain("velohero.com");
      expect(setup.oauthConfig.redirectUri).toBe("");
      expect(setup.oauthConfig.scopes).toEqual([]);
    });

    it("exchangeCode throws with descriptive message", async () => {
      const provider = new VeloHeroProvider();
      const setup = provider.authSetup();
      await expect(setup.exchangeCode("code", "verifier")).rejects.toThrow("automated login");
      await expect(setup.exchangeCode("code", "verifier")).rejects.toThrow(
        "VeloHero uses automated login, not OAuth code exchange",
      );
    });

    it("accepts custom fetch function", () => {
      const mockFetch: typeof globalThis.fetch = () => Promise.resolve(new Response());
      const provider = new VeloHeroProvider(mockFetch);
      expect(provider.validate()).toBeNull();
    });
  });
});

// ============================================================
// Zwift
// ============================================================

describe("ZwiftProvider", () => {
  describe("validate()", () => {
    it("returns null (always enabled)", () => {
      const provider = new ZwiftProvider();
      expect(provider.validate()).toBeNull();
    });
  });

  describe("provider identity", () => {
    it("has correct id and name", () => {
      const provider = new ZwiftProvider();
      expect(provider.id).toBe("zwift");
      expect(provider.name).toBe("Zwift");
    });
  });

  describe("authSetup()", () => {
    it("returns auth setup with automatedLogin function", () => {
      const provider = new ZwiftProvider();
      const setup = provider.authSetup();
      expect(setup.automatedLogin).toBeTypeOf("function");
      expect(setup.oauthConfig.clientId).toBe("Zwift Game Client");
    });

    it("has correct oauthConfig fields", () => {
      const provider = new ZwiftProvider();
      const setup = provider.authSetup();
      expect(setup.oauthConfig.redirectUri).toBe("");
      expect(setup.oauthConfig.scopes).toEqual([]);
      // authorizeUrl and tokenUrl should point to Zwift auth
      expect(setup.oauthConfig.authorizeUrl).toBeTruthy();
      expect(setup.oauthConfig.tokenUrl).toBeTruthy();
    });

    it("exchangeCode throws with descriptive message", async () => {
      const provider = new ZwiftProvider();
      const setup = provider.authSetup();
      await expect(setup.exchangeCode("code", "verifier")).rejects.toThrow("automated login");
      await expect(setup.exchangeCode("code", "verifier")).rejects.toThrow(
        "Zwift uses automated login, not OAuth code exchange",
      );
    });

    it("accepts custom fetch function", () => {
      const mockFetch: typeof globalThis.fetch = () => Promise.resolve(new Response());
      const provider = new ZwiftProvider(mockFetch);
      expect(provider.validate()).toBeNull();
    });
  });
});

// ============================================================
// Ultrahuman
// ============================================================

describe("UltrahumanProvider", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("provider identity", () => {
    it("has correct id and name", () => {
      const provider = new UltrahumanProvider();
      expect(provider.id).toBe("ultrahuman");
      expect(provider.name).toBe("Ultrahuman");
    });
  });

  describe("validate()", () => {
    it("returns error when ULTRAHUMAN_API_TOKEN is missing", () => {
      delete process.env.ULTRAHUMAN_API_TOKEN;
      delete process.env.ULTRAHUMAN_EMAIL;
      const provider = new UltrahumanProvider();
      expect(provider.validate()).toContain("ULTRAHUMAN_API_TOKEN");
    });

    it("returns error when ULTRAHUMAN_EMAIL is missing", () => {
      process.env.ULTRAHUMAN_API_TOKEN = "test-token";
      delete process.env.ULTRAHUMAN_EMAIL;
      const provider = new UltrahumanProvider();
      expect(provider.validate()).toContain("ULTRAHUMAN_EMAIL");
    });

    it("returns null when both env vars are set", () => {
      process.env.ULTRAHUMAN_API_TOKEN = "test-token";
      process.env.ULTRAHUMAN_EMAIL = "user@example.com";
      const provider = new UltrahumanProvider();
      expect(provider.validate()).toBeNull();
    });

    it("checks ULTRAHUMAN_API_TOKEN before ULTRAHUMAN_EMAIL", () => {
      delete process.env.ULTRAHUMAN_API_TOKEN;
      delete process.env.ULTRAHUMAN_EMAIL;
      const provider = new UltrahumanProvider();
      const result = provider.validate();
      expect(result).toContain("ULTRAHUMAN_API_TOKEN");
      expect(result).not.toContain("ULTRAHUMAN_EMAIL");
    });
  });

  describe("authSetup()", () => {
    it("has empty oauthConfig fields (static API token, no OAuth)", () => {
      const provider = new UltrahumanProvider();
      const setup = provider.authSetup();
      expect(setup.oauthConfig.clientId).toBe("");
      expect(setup.oauthConfig.authorizeUrl).toBe("");
      expect(setup.oauthConfig.tokenUrl).toBe("");
      expect(setup.oauthConfig.redirectUri).toBe("");
      expect(setup.oauthConfig.scopes).toEqual([]);
    });

    it("automatedLogin returns static token with far-future expiry", async () => {
      process.env.ULTRAHUMAN_API_TOKEN = "my-api-token";
      process.env.ULTRAHUMAN_EMAIL = "user@example.com";
      const provider = new UltrahumanProvider();
      const setup = provider.authSetup();
      const result = await setup.automatedLogin?.("ignored", "ignored");
      expect(result).toBeDefined();
      expect(result?.accessToken).toBe("my-api-token");
      expect(result?.refreshToken).toBeNull();
      expect(result?.expiresAt).toEqual(new Date("2099-12-31T23:59:59Z"));
      expect(result?.scopes).toBe("email:user@example.com");
    });

    it("automatedLogin throws when ULTRAHUMAN_API_TOKEN is missing", async () => {
      delete process.env.ULTRAHUMAN_API_TOKEN;
      process.env.ULTRAHUMAN_EMAIL = "user@example.com";
      const provider = new UltrahumanProvider();
      const setup = provider.authSetup();
      await expect(setup.automatedLogin?.("x", "y")).rejects.toThrow(
        "ULTRAHUMAN_API_TOKEN and ULTRAHUMAN_EMAIL required",
      );
    });

    it("automatedLogin throws when ULTRAHUMAN_EMAIL is missing", async () => {
      process.env.ULTRAHUMAN_API_TOKEN = "test-token";
      delete process.env.ULTRAHUMAN_EMAIL;
      const provider = new UltrahumanProvider();
      const setup = provider.authSetup();
      await expect(setup.automatedLogin?.("x", "y")).rejects.toThrow(
        "ULTRAHUMAN_API_TOKEN and ULTRAHUMAN_EMAIL required",
      );
    });

    it("automatedLogin throws when both env vars are missing", async () => {
      delete process.env.ULTRAHUMAN_API_TOKEN;
      delete process.env.ULTRAHUMAN_EMAIL;
      const provider = new UltrahumanProvider();
      const setup = provider.authSetup();
      await expect(setup.automatedLogin?.("x", "y")).rejects.toThrow("ULTRAHUMAN_API_TOKEN");
    });

    it("exchangeCode throws with descriptive message", async () => {
      const provider = new UltrahumanProvider();
      const setup = provider.authSetup();
      await expect(setup.exchangeCode("code", "verifier")).rejects.toThrow("API token auth");
      await expect(setup.exchangeCode("code", "verifier")).rejects.toThrow(
        "Ultrahuman uses API token auth, not OAuth code exchange",
      );
    });

    it("accepts custom fetch function", () => {
      const mockFetch: typeof globalThis.fetch = () => Promise.resolve(new Response());
      const provider = new UltrahumanProvider(mockFetch);
      expect(provider.id).toBe("ultrahuman");
    });
  });

  describe("parseUltrahumanMetrics — edge cases", () => {
    it("handles avg_rhr type with value field", () => {
      const metrics = [{ type: "avg_rhr", object: { value: 60 } }];
      const { daily } = parseUltrahumanMetrics("2026-03-01", metrics);
      expect(daily.restingHr).toBe(60);
    });

    it("handles night_rhr with value instead of avg", () => {
      const metrics = [{ type: "night_rhr", object: { value: 55 } }];
      const { daily } = parseUltrahumanMetrics("2026-03-01", metrics);
      expect(daily.restingHr).toBe(55);
    });

    it("prefers avg over value for night_rhr", () => {
      const metrics = [{ type: "night_rhr", object: { avg: 50, value: 55 } }];
      const { daily } = parseUltrahumanMetrics("2026-03-01", metrics);
      expect(daily.restingHr).toBe(50);
    });

    it("handles active_minutes metric", () => {
      const metrics = [{ type: "active_minutes", object: { value: 45.7 } }];
      const { daily } = parseUltrahumanMetrics("2026-03-01", metrics);
      expect(daily.exerciseMinutes).toBe(46); // rounded
    });

    it("handles non-numeric values gracefully", () => {
      const metrics = [
        { type: "steps", object: { value: "not-a-number" } },
        { type: "avg_sleep_hrv", object: { value: null } },
      ];
      const { daily } = parseUltrahumanMetrics("2026-03-01", metrics);
      expect(daily.steps).toBeUndefined();
      expect(daily.hrv).toBeUndefined();
    });

    it("handles sleep metric without quick_metrics", () => {
      const metrics = [{ type: "sleep", object: {} }];
      const { sleep } = parseUltrahumanMetrics("2026-03-01", metrics);
      expect(sleep.durationMinutes).toBeUndefined();
      expect(sleep.sleepScore).toBeUndefined();
    });

    it("handles unknown metric types without error", () => {
      const metrics = [{ type: "unknown_metric_type", object: { value: 42 } }];
      const { daily, sleep } = parseUltrahumanMetrics("2026-03-01", metrics);
      expect(daily.date).toBe("2026-03-01");
      expect(sleep.date).toBe("2026-03-01");
      // Should not crash and no extra fields set
      expect(daily.restingHr).toBeUndefined();
      expect(daily.hrv).toBeUndefined();
    });

    it("handles multiple metrics of different types in one call", () => {
      const metrics = [
        { type: "night_rhr", object: { avg: 52 } },
        { type: "avg_sleep_hrv", object: { value: 45.2 } },
        { type: "steps", object: { value: 8500 } },
        { type: "vo2_max", object: { value: 48.5 } },
        { type: "active_minutes", object: { value: 30 } },
        { type: "body_temperature", object: { value: 36.6 } },
        {
          type: "sleep",
          object: {
            quick_metrics: [
              { type: "total_sleep", value: 25200 },
              { type: "sleep_index", value: 82 },
            ],
          },
        },
      ];
      const { daily, sleep } = parseUltrahumanMetrics("2026-03-01", metrics);
      expect(daily.restingHr).toBe(52);
      expect(daily.hrv).toBe(45.2);
      expect(daily.steps).toBe(8500);
      expect(daily.vo2max).toBe(48.5);
      expect(daily.exerciseMinutes).toBe(30);
      expect(daily.skinTempC).toBe(36.6);
      expect(sleep.durationMinutes).toBe(420); // 25200 / 60
      expect(sleep.sleepScore).toBe(82);
    });

    it("rounds steps to integer", () => {
      const metrics = [{ type: "steps", object: { value: 10500.7 } }];
      const { daily } = parseUltrahumanMetrics("2026-03-01", metrics);
      expect(daily.steps).toBe(10501);
    });

    it("rounds resting HR to integer", () => {
      const metrics = [{ type: "night_rhr", object: { avg: 55.4 } }];
      const { daily } = parseUltrahumanMetrics("2026-03-01", metrics);
      expect(daily.restingHr).toBe(55);
    });
  });
});

// ============================================================
// UltrahumanClient — error handling
// ============================================================

describe("UltrahumanClient — error handling", () => {
  it("throws on non-OK response with status and body", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Forbidden", { status: 403 });
    }) as typeof globalThis.fetch;

    const client = new UltrahumanClient("bad-token", "user@example.com", mockFetch);
    await expect(client.getDailyMetrics("2026-03-01")).rejects.toThrow(
      "Ultrahuman API error (403)",
    );
  });

  it("throws on 401 unauthorized", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof globalThis.fetch;

    const client = new UltrahumanClient("expired-token", "user@example.com", mockFetch);
    await expect(client.getDailyMetrics("2026-03-01")).rejects.toThrow(
      "Ultrahuman API error (401)",
    );
  });

  it("throws on 500 server error", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Internal Server Error", { status: 500 });
    }) as typeof globalThis.fetch;

    const client = new UltrahumanClient("token", "user@example.com", mockFetch);
    await expect(client.getDailyMetrics("2026-03-01")).rejects.toThrow(
      "Ultrahuman API error (500)",
    );
  });

  it("returns parsed JSON on success", async () => {
    const mockResponse = {
      data: { metrics: { "2026-03-01": [] } },
      error: null,
      status: 200,
    };
    const mockFetch = (async (): Promise<Response> => {
      return Response.json(mockResponse);
    }) as typeof globalThis.fetch;

    const client = new UltrahumanClient("good-token", "user@example.com", mockFetch);
    const result = await client.getDailyMetrics("2026-03-01");
    expect(result.status).toBe(200);
    expect(result.data.metrics["2026-03-01"]).toEqual([]);
  });

  it("includes error body text in thrown error", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Invalid API key", { status: 403 });
    }) as typeof globalThis.fetch;

    const client = new UltrahumanClient("bad-token", "user@example.com", mockFetch);
    await expect(client.getDailyMetrics("2026-03-01")).rejects.toThrow("Invalid API key");
  });

  it("returns metrics with data when API returns populated response", async () => {
    const mockResponse = {
      data: {
        metrics: {
          "2026-03-01": [
            { type: "night_rhr", object: { avg: 52 } },
            { type: "steps", object: { value: 8000 } },
          ],
        },
      },
      error: null,
      status: 200,
    };
    const mockFetch = (async (): Promise<Response> => {
      return Response.json(mockResponse);
    }) as typeof globalThis.fetch;

    const client = new UltrahumanClient("good-token", "user@example.com", mockFetch);
    const result = await client.getDailyMetrics("2026-03-01");
    expect(result.data.metrics["2026-03-01"]).toHaveLength(2);
    expect(result.error).toBeNull();
  });
});
