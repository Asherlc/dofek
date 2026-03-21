import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUltrahumanMetrics, UltrahumanClient, UltrahumanProvider } from "./ultrahuman.ts";

describe("parseUltrahumanMetrics", () => {
  it("parses resting HR from night_rhr with avg", () => {
    const { daily } = parseUltrahumanMetrics("2026-03-01", [
      { type: "night_rhr", object: { avg: 58.5 } },
    ]);
    expect(daily.restingHr).toBe(59);
  });

  it("parses resting HR from avg_rhr with value", () => {
    const { daily } = parseUltrahumanMetrics("2026-03-01", [
      { type: "avg_rhr", object: { value: 55 } },
    ]);
    expect(daily.restingHr).toBe(55);
  });

  it("parses HRV", () => {
    const { daily } = parseUltrahumanMetrics("2026-03-01", [
      { type: "avg_sleep_hrv", object: { value: 45.5 } },
    ]);
    expect(daily.hrv).toBe(45.5);
  });

  it("parses steps", () => {
    const { daily } = parseUltrahumanMetrics("2026-03-01", [
      { type: "steps", object: { value: 8500.3 } },
    ]);
    expect(daily.steps).toBe(8500);
  });

  it("parses vo2max", () => {
    const { daily } = parseUltrahumanMetrics("2026-03-01", [
      { type: "vo2_max", object: { value: 48.5 } },
    ]);
    expect(daily.vo2max).toBe(48.5);
  });

  it("parses active minutes", () => {
    const { daily } = parseUltrahumanMetrics("2026-03-01", [
      { type: "active_minutes", object: { value: 45.7 } },
    ]);
    expect(daily.exerciseMinutes).toBe(46);
  });

  it("parses body temperature", () => {
    const { daily } = parseUltrahumanMetrics("2026-03-01", [
      { type: "body_temperature", object: { value: 36.5 } },
    ]);
    expect(daily.skinTempC).toBe(36.5);
  });

  it("parses sleep from quick_metrics", () => {
    const { sleep } = parseUltrahumanMetrics("2026-03-01", [
      {
        type: "sleep",
        object: {
          quick_metrics: [
            { type: "total_sleep", value: 28800 }, // 8 hours in seconds = 480 min
            { type: "sleep_index", value: 85 },
          ],
        },
      },
    ]);
    expect(sleep.durationMinutes).toBe(480);
    expect(sleep.sleepScore).toBe(85);
  });

  it("handles non-numeric values gracefully", () => {
    const { daily } = parseUltrahumanMetrics("2026-03-01", [
      { type: "steps", object: { value: "not a number" } },
      { type: "avg_sleep_hrv", object: { value: "bad" } },
    ]);
    expect(daily.steps).toBeUndefined();
    expect(daily.hrv).toBeUndefined();
  });

  it("parses multiple metrics at once", () => {
    const { daily, sleep } = parseUltrahumanMetrics("2026-03-01", [
      { type: "night_rhr", object: { avg: 58 } },
      { type: "avg_sleep_hrv", object: { value: 42 } },
      { type: "steps", object: { value: 10000 } },
      { type: "vo2_max", object: { value: 50 } },
      {
        type: "sleep",
        object: {
          quick_metrics: [{ type: "total_sleep", value: 25200 }],
        },
      },
    ]);
    expect(daily.restingHr).toBe(58);
    expect(daily.hrv).toBe(42);
    expect(daily.steps).toBe(10000);
    expect(daily.vo2max).toBe(50);
    expect(sleep.durationMinutes).toBe(420);
  });

  it("handles sleep without quick_metrics", () => {
    const { sleep } = parseUltrahumanMetrics("2026-03-01", [{ type: "sleep", object: {} }]);
    expect(sleep.durationMinutes).toBeUndefined();
    expect(sleep.sleepScore).toBeUndefined();
  });
});

describe("UltrahumanClient", () => {
  it("throws on API error", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const client = new UltrahumanClient("token", "test@test.com", mockFetch);
    await expect(client.getDailyMetrics("2026-03-01")).rejects.toThrow(
      "Ultrahuman API error (401)",
    );
  });

  it("returns parsed response on success", async () => {
    const mockData = {
      data: { metrics: { "2026-03-01": [] } },
      error: null,
      status: 200,
    };
    const mockFetch = vi.fn().mockResolvedValue(Response.json(mockData));
    const client = new UltrahumanClient("token", "test@test.com", mockFetch);
    const result = await client.getDailyMetrics("2026-03-01");
    expect(result.status).toBe(200);
  });
});

describe("UltrahumanProvider", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("validate checks env vars", () => {
    delete process.env.ULTRAHUMAN_API_TOKEN;
    delete process.env.ULTRAHUMAN_EMAIL;
    expect(new UltrahumanProvider().validate()).toContain("ULTRAHUMAN_API_TOKEN");
    process.env.ULTRAHUMAN_API_TOKEN = "token";
    expect(new UltrahumanProvider().validate()).toContain("ULTRAHUMAN_EMAIL");
    process.env.ULTRAHUMAN_EMAIL = "email@test.com";
    expect(new UltrahumanProvider().validate()).toBeNull();
  });

  it("does not have authSetup (uses server-side env var auth)", () => {
    const provider = new UltrahumanProvider();
    expect("authSetup" in provider).toBe(false);
  });

  it("sync returns error when no tokens or env vars", async () => {
    delete process.env.ULTRAHUMAN_API_TOKEN;
    delete process.env.ULTRAHUMAN_EMAIL;
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
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };
    const result = await new UltrahumanProvider().sync(mockDb, new Date("2026-01-01"));
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
