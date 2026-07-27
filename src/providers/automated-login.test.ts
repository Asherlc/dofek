import { TrainerRoadClient } from "@dofek/trainerroad/client";
import { VeloHeroClient } from "@dofek/velohero/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EightSleepProvider } from "./eight-sleep.ts";
import { TrainerRoadProvider } from "./trainerroad.ts";
import { parseUltrahumanMetrics, UltrahumanClient, UltrahumanProvider } from "./ultrahuman.ts";
import { VeloHeroProvider } from "./velohero.ts";
import { ZwiftProvider } from "./zwift.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

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
    it("returns credential-only auth setup with automatedLogin", () => {
      const provider = new EightSleepProvider();
      const setup = provider.authSetup();
      expect(setup.automatedLogin).toBeTypeOf("function");
      expect(setup.oauthConfig).toBeUndefined();
      expect(setup.exchangeCode).toBeUndefined();
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
    it("returns credential-only auth setup with automatedLogin", () => {
      const provider = new TrainerRoadProvider();
      const setup = provider.authSetup();
      expect(setup.automatedLogin).toBeTypeOf("function");
      expect(setup.oauthConfig).toBeUndefined();
      expect(setup.exchangeCode).toBeUndefined();
    });

    it("passes custom fetch function through automated login", async () => {
      const mockFetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response()));
      const provider = new TrainerRoadProvider(mockFetch);
      const signIn = vi.spyOn(TrainerRoadClient, "signIn").mockResolvedValue({
        authCookie: "trainerroad-cookie",
        username: "testuser",
      });
      vi.spyOn(Date, "now").mockReturnValue(new Date("2026-01-01T00:00:00Z").getTime());

      const tokenSet = await provider.authSetup().automatedLogin?.("test@example.com", "secret");

      // signIn receives the provider's rate-limit-wrapped fetch, which delegates to mockFetch.
      expect(signIn).toHaveBeenCalledWith("test@example.com", "secret", expect.any(Function));
      const passedFetch = signIn.mock.calls[0]?.[2];
      if (!passedFetch) throw new Error("expected a fetch passed to signIn");
      await passedFetch("https://example.com");
      expect(mockFetch).toHaveBeenCalled();
      expect(tokenSet).toEqual({
        accessToken: "trainerroad-cookie",
        refreshToken: null,
        expiresAt: new Date("2026-01-31T00:00:00Z"),
        scopes: "username:testuser",
      });
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
    it("returns credential-only auth setup with automatedLogin", () => {
      const provider = new VeloHeroProvider();
      const setup = provider.authSetup();
      expect(setup.automatedLogin).toBeTypeOf("function");
      expect(setup.oauthConfig).toBeUndefined();
      expect(setup.exchangeCode).toBeUndefined();
    });

    it("passes custom fetch function through automated login", async () => {
      const mockFetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response()));
      const provider = new VeloHeroProvider(mockFetch);
      const signIn = vi.spyOn(VeloHeroClient, "signIn").mockResolvedValue({
        sessionCookie: "VeloHero_session=velohero-session",
        userId: "user-456",
      });
      vi.spyOn(Date, "now").mockReturnValue(new Date("2026-01-01T00:00:00Z").getTime());

      const tokenSet = await provider.authSetup().automatedLogin?.("test@example.com", "secret");

      // signIn receives the provider's rate-limit-wrapped fetch, which delegates to mockFetch.
      expect(signIn).toHaveBeenCalledWith("test@example.com", "secret", expect.any(Function));
      const passedFetch = signIn.mock.calls[0]?.[2];
      if (!passedFetch) throw new Error("expected a fetch passed to signIn");
      await passedFetch("https://example.com");
      expect(mockFetch).toHaveBeenCalled();
      expect(tokenSet).toEqual({
        accessToken: "VeloHero_session=velohero-session",
        refreshToken: null,
        expiresAt: new Date("2026-01-02T00:00:00Z"),
        scopes: "userId:user-456",
      });
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
    it("returns credential-only auth setup with automatedLogin", () => {
      const provider = new ZwiftProvider();
      const setup = provider.authSetup();
      expect(setup.automatedLogin).toBeTypeOf("function");
      expect(setup.oauthConfig).toBeUndefined();
      expect(setup.exchangeCode).toBeUndefined();
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
    it("does not require deployment-wide user credentials", () => {
      delete process.env.ULTRAHUMAN_API_TOKEN;
      delete process.env.ULTRAHUMAN_EMAIL;
      const provider = new UltrahumanProvider();
      expect(provider.validate()).toBeNull();
    });
  });

  describe("auth", () => {
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

describe("UltrahumanClient", () => {
  it("throws on 500 server error", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Internal Server Error", { status: 500 });
    };

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
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json(mockResponse);
    };

    const client = new UltrahumanClient("good-token", "user@example.com", mockFetch);
    const result = await client.getDailyMetrics("2026-03-01");
    expect(result.status).toBe(200);
    expect(result.data.metrics["2026-03-01"]).toEqual([]);
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
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json(mockResponse);
    };

    const client = new UltrahumanClient("good-token", "user@example.com", mockFetch);
    const result = await client.getDailyMetrics("2026-03-01");
    expect(result.data.metrics["2026-03-01"]).toHaveLength(2);
    expect(result.error).toBeNull();
  });
});
