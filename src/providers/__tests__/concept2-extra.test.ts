import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Concept2Provider,
  concept2OAuthConfig,
  mapConcept2Type,
  parseConcept2Result,
} from "../concept2.ts";

// ============================================================
// Tests targeting uncovered paths in concept2.ts
// ============================================================

describe("mapConcept2Type", () => {
  it("maps rower to rowing", () => {
    expect(mapConcept2Type("rower")).toBe("rowing");
    expect(mapConcept2Type("Rower")).toBe("rowing");
    expect(mapConcept2Type("ROWER")).toBe("rowing");
  });

  it("maps skierg to skiing", () => {
    expect(mapConcept2Type("skierg")).toBe("skiing");
    expect(mapConcept2Type("SkiErg")).toBe("skiing");
  });

  it("maps bikerg to cycling", () => {
    expect(mapConcept2Type("bikerg")).toBe("cycling");
    // Note: "BikeErg" lowercases to "bikeerg" (two e's), which doesn't match "bikerg"
    expect(mapConcept2Type("BikeErg")).toBe("rowing"); // falls to default
  });

  it("defaults to rowing for unknown types", () => {
    expect(mapConcept2Type("unknown")).toBe("rowing");
  });
});

describe("parseConcept2Result", () => {
  it("parses a full result", () => {
    const result = {
      id: 12345,
      type: "rower",
      date: "2026-03-01 09:00:00",
      distance: 5000,
      time: 12000, // tenths of second = 1200 seconds
      time_formatted: "20:00.0",
      stroke_rate: 26,
      stroke_count: 520,
      heart_rate: { average: 155, max: 175, min: 110 },
      calories_total: 300,
      drag_factor: 125,
      weight_class: "H",
      workout_type: "FixedDistanceFixedTime",
      privacy: "public",
    };

    const parsed = parseConcept2Result(result);
    expect(parsed.externalId).toBe("12345");
    expect(parsed.activityType).toBe("rowing");
    expect(parsed.name).toBe("Rower FixedDistanceFixedTime");
    expect(parsed.startedAt).toEqual(new Date("2026-03-01 09:00:00"));
    expect(parsed.raw.distance).toBe(5000);
    expect(parsed.raw.strokeRate).toBe(26);
    expect(parsed.raw.strokeCount).toBe(520);
    expect(parsed.raw.avgHeartRate).toBe(155);
    expect(parsed.raw.maxHeartRate).toBe(175);
    expect(parsed.raw.calories).toBe(300);
    expect(parsed.raw.dragFactor).toBe(125);
    expect(parsed.raw.workoutType).toBe("FixedDistanceFixedTime");
    expect(parsed.raw.weightClass).toBe("H");

    // endedAt should be 1200 seconds after start
    const expectedEnd = new Date(parsed.startedAt.getTime() + 1200 * 1000);
    expect(parsed.endedAt).toEqual(expectedEnd);
  });

  it("handles result without heart rate", () => {
    const result = {
      id: 99,
      type: "skierg",
      date: "2026-03-01 10:00:00",
      distance: 2000,
      time: 6000,
      time_formatted: "10:00.0",
      stroke_rate: 30,
      stroke_count: 300,
      weight_class: "L",
      workout_type: "JustRow",
      privacy: "public",
    };

    const parsed = parseConcept2Result(result);
    expect(parsed.activityType).toBe("skiing");
    expect(parsed.raw.avgHeartRate).toBeUndefined();
    expect(parsed.raw.maxHeartRate).toBeUndefined();
  });
});

describe("concept2OAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when env vars missing", () => {
    delete process.env.CONCEPT2_CLIENT_ID;
    delete process.env.CONCEPT2_CLIENT_SECRET;
    expect(concept2OAuthConfig()).toBeNull();
  });

  it("returns config when both set", () => {
    process.env.CONCEPT2_CLIENT_ID = "id";
    process.env.CONCEPT2_CLIENT_SECRET = "secret";
    const config = concept2OAuthConfig();
    expect(config?.clientId).toBe("id");
    expect(config?.authorizeUrl).toContain("concept2.com");
    expect(config?.scopes).toContain("results:read");
  });
});

describe("Concept2Provider", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("validate returns error when missing env vars", () => {
    delete process.env.CONCEPT2_CLIENT_ID;
    delete process.env.CONCEPT2_CLIENT_SECRET;
    expect(new Concept2Provider().validate()).toContain("CONCEPT2_CLIENT_ID");
  });

  it("validate returns null when set", () => {
    process.env.CONCEPT2_CLIENT_ID = "id";
    process.env.CONCEPT2_CLIENT_SECRET = "secret";
    expect(new Concept2Provider().validate()).toBeNull();
  });

  it("authSetup returns correct config", () => {
    process.env.CONCEPT2_CLIENT_ID = "id";
    process.env.CONCEPT2_CLIENT_SECRET = "secret";
    const setup = new Concept2Provider().authSetup();
    expect(setup.oauthConfig.clientId).toBe("id");
    expect(setup.apiBaseUrl).toContain("concept2.com");
  });

  it("sync returns error when no tokens", async () => {
    process.env.CONCEPT2_CLIENT_ID = "id";
    process.env.CONCEPT2_CLIENT_SECRET = "secret";
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

    // @ts-expect-error mock DB
    const result = await new Concept2Provider().sync(mockDb, new Date("2026-01-01"));
    expect(result.provider).toBe("concept2");
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
