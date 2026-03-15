import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SuuntoProvider,
  mapSuuntoActivityType,
  parseSuuntoWorkout,
  suuntoOAuthConfig,
} from "../suunto.ts";

describe("mapSuuntoActivityType", () => {
  it("maps all known activity types", () => {
    expect(mapSuuntoActivityType(2)).toBe("running");
    expect(mapSuuntoActivityType(3)).toBe("cycling");
    expect(mapSuuntoActivityType(4)).toBe("cross_country_skiing");
    expect(mapSuuntoActivityType(11)).toBe("walking");
    expect(mapSuuntoActivityType(12)).toBe("hiking");
    expect(mapSuuntoActivityType(14)).toBe("strength");
    expect(mapSuuntoActivityType(23)).toBe("yoga");
    expect(mapSuuntoActivityType(27)).toBe("swimming");
    expect(mapSuuntoActivityType(67)).toBe("trail_running");
    expect(mapSuuntoActivityType(69)).toBe("rowing");
    expect(mapSuuntoActivityType(82)).toBe("virtual_cycling");
    expect(mapSuuntoActivityType(83)).toBe("virtual_running");
    expect(mapSuuntoActivityType(1)).toBe("other");
    expect(mapSuuntoActivityType(5)).toBe("other");
  });

  it("returns other for unknown", () => {
    expect(mapSuuntoActivityType(999)).toBe("other");
  });
});

describe("parseSuuntoWorkout", () => {
  it("parses a workout with all fields", () => {
    const workout = {
      workoutKey: "suunto-w-123",
      activityId: 3,
      workoutName: "Morning Ride",
      startTime: 1709290800000,
      stopTime: 1709294400000,
      totalTime: 3600,
      totalDistance: 30000,
      totalAscent: 300,
      totalDescent: 280,
      avgSpeed: 8.33,
      maxSpeed: 12.0,
      energyConsumption: 700,
      stepCount: 0,
      hrdata: { workoutAvgHR: 145, workoutMaxHR: 175 },
    };

    const parsed = parseSuuntoWorkout(workout);
    expect(parsed.externalId).toBe("suunto-w-123");
    expect(parsed.activityType).toBe("cycling");
    expect(parsed.name).toBe("Morning Ride");
    expect(parsed.startedAt).toEqual(new Date(1709290800000));
    expect(parsed.endedAt).toEqual(new Date(1709294400000));
    expect(parsed.raw.totalDistance).toBe(30000);
    expect(parsed.raw.avgHeartRate).toBe(145);
    expect(parsed.raw.maxHeartRate).toBe(175);
    expect(parsed.raw.calories).toBe(700);
    expect(parsed.raw.steps).toBe(0);
  });

  it("generates name when workoutName is missing", () => {
    const workout = {
      workoutKey: "w-min",
      activityId: 2,
      startTime: 1709290800000,
      stopTime: 1709292600000,
      totalTime: 1800,
      totalDistance: 5000,
      totalAscent: 50,
      totalDescent: 50,
      avgSpeed: 2.78,
      maxSpeed: 3.5,
      energyConsumption: 300,
      stepCount: 3000,
    };

    const parsed = parseSuuntoWorkout(workout);
    expect(parsed.name).toBe("Suunto running");
    expect(parsed.raw.avgHeartRate).toBeUndefined();
    expect(parsed.raw.maxHeartRate).toBeUndefined();
  });
});

describe("suuntoOAuthConfig", () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });

  it("returns null when missing", () => {
    delete process.env.SUUNTO_CLIENT_ID;
    delete process.env.SUUNTO_CLIENT_SECRET;
    expect(suuntoOAuthConfig()).toBeNull();
  });

  it("returns config when set", () => {
    process.env.SUUNTO_CLIENT_ID = "id";
    process.env.SUUNTO_CLIENT_SECRET = "secret";
    const config = suuntoOAuthConfig();
    expect(config?.clientId).toBe("id");
    expect(config?.tokenAuthMethod).toBe("basic");
  });
});

describe("SuuntoProvider", () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });

  it("validate returns errors for missing env vars", () => {
    delete process.env.SUUNTO_CLIENT_ID;
    delete process.env.SUUNTO_CLIENT_SECRET;
    delete process.env.SUUNTO_SUBSCRIPTION_KEY;
    expect(new SuuntoProvider().validate()).toContain("SUUNTO_CLIENT_ID");
    process.env.SUUNTO_CLIENT_ID = "id";
    expect(new SuuntoProvider().validate()).toContain("SUUNTO_CLIENT_SECRET");
    process.env.SUUNTO_CLIENT_SECRET = "secret";
    expect(new SuuntoProvider().validate()).toContain("SUUNTO_SUBSCRIPTION_KEY");
    process.env.SUUNTO_SUBSCRIPTION_KEY = "key";
    expect(new SuuntoProvider().validate()).toBeNull();
  });

  it("sync returns error when no tokens", async () => {
    process.env.SUUNTO_CLIENT_ID = "id";
    process.env.SUUNTO_CLIENT_SECRET = "secret";
    process.env.SUUNTO_SUBSCRIPTION_KEY = "key";
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
    const result = await new SuuntoProvider().sync(mockDb as never, new Date("2026-01-01"));
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
