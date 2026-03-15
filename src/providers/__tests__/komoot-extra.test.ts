import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KomootProvider,
  komootOAuthConfig,
  mapKomootSport,
  parseKomootTour,
} from "../komoot.ts";

describe("mapKomootSport", () => {
  it("maps all known sport types", () => {
    expect(mapKomootSport("BIKING")).toBe("cycling");
    expect(mapKomootSport("E_BIKING")).toBe("cycling");
    expect(mapKomootSport("ROAD_CYCLING")).toBe("cycling");
    expect(mapKomootSport("MT_BIKING")).toBe("mountain_biking");
    expect(mapKomootSport("E_MT_BIKING")).toBe("mountain_biking");
    expect(mapKomootSport("GRAVEL_BIKING")).toBe("cycling");
    expect(mapKomootSport("E_BIKE_TOURING")).toBe("cycling");
    expect(mapKomootSport("RUNNING")).toBe("running");
    expect(mapKomootSport("TRAIL_RUNNING")).toBe("trail_running");
    expect(mapKomootSport("HIKING")).toBe("hiking");
    expect(mapKomootSport("WALKING")).toBe("walking");
    expect(mapKomootSport("CLIMBING")).toBe("climbing");
    expect(mapKomootSport("SKIING")).toBe("skiing");
    expect(mapKomootSport("CROSS_COUNTRY_SKIING")).toBe("cross_country_skiing");
    expect(mapKomootSport("SNOWSHOEING")).toBe("snowshoeing");
    expect(mapKomootSport("PADDLING")).toBe("paddling");
    expect(mapKomootSport("INLINE_SKATING")).toBe("skating");
  });

  it("returns other for unknown", () => {
    expect(mapKomootSport("UNKNOWN")).toBe("other");
  });
});

describe("parseKomootTour", () => {
  it("parses a tour with all fields", () => {
    const tour = {
      id: 12345,
      name: "Morning Ride",
      sport: "BIKING",
      date: "2026-03-01T08:00:00Z",
      distance: 30000,
      duration: 3600,
      elevation_up: 300,
      elevation_down: 280,
      status: "public",
      type: "tour_recorded",
    };

    const parsed = parseKomootTour(tour);
    expect(parsed.externalId).toBe("12345");
    expect(parsed.activityType).toBe("cycling");
    expect(parsed.name).toBe("Morning Ride");
    expect(parsed.startedAt).toEqual(new Date("2026-03-01T08:00:00Z"));
    expect(parsed.endedAt).toEqual(new Date(new Date("2026-03-01T08:00:00Z").getTime() + 3600000));
    expect(parsed.raw.distance).toBe(30000);
    expect(parsed.raw.elevationUp).toBe(300);
    expect(parsed.raw.elevationDown).toBe(280);
    expect(parsed.raw.status).toBe("public");
    expect(parsed.raw.type).toBe("tour_recorded");
  });

  it("handles missing elevation", () => {
    const tour = {
      id: 99,
      name: "Walk",
      sport: "WALKING",
      date: "2026-03-01T12:00:00Z",
      distance: 5000,
      duration: 3600,
      status: "private",
      type: "tour_recorded",
    };

    const parsed = parseKomootTour(tour);
    expect(parsed.raw.elevationUp).toBeUndefined();
    expect(parsed.raw.elevationDown).toBeUndefined();
  });
});

describe("komootOAuthConfig", () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });

  it("returns null when missing env vars", () => {
    delete process.env.KOMOOT_CLIENT_ID;
    delete process.env.KOMOOT_CLIENT_SECRET;
    expect(komootOAuthConfig()).toBeNull();
  });

  it("returns config when set", () => {
    process.env.KOMOOT_CLIENT_ID = "id";
    process.env.KOMOOT_CLIENT_SECRET = "secret";
    const config = komootOAuthConfig();
    expect(config?.clientId).toBe("id");
    expect(config?.tokenAuthMethod).toBe("basic");
  });
});

describe("KomootProvider", () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });

  it("validate returns errors", () => {
    delete process.env.KOMOOT_CLIENT_ID;
    delete process.env.KOMOOT_CLIENT_SECRET;
    expect(new KomootProvider().validate()).toContain("KOMOOT_CLIENT_ID");
    process.env.KOMOOT_CLIENT_ID = "id";
    expect(new KomootProvider().validate()).toContain("KOMOOT_CLIENT_SECRET");
  });

  it("validate returns null when set", () => {
    process.env.KOMOOT_CLIENT_ID = "id";
    process.env.KOMOOT_CLIENT_SECRET = "secret";
    expect(new KomootProvider().validate()).toBeNull();
  });

  it("sync returns error when no tokens", async () => {
    process.env.KOMOOT_CLIENT_ID = "id";
    process.env.KOMOOT_CLIENT_SECRET = "secret";
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
    const result = await new KomootProvider().sync(mockDb as never, new Date("2026-01-01"));
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
