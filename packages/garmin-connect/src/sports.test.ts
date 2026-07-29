import { describe, expect, it } from "vitest";
import { GARMIN_CONNECT_SPORT_MAP, mapGarminConnectSport } from "./sports.ts";

describe("mapGarminConnectSport", () => {
  it("maps running variants", () => {
    expect(mapGarminConnectSport("running").canonicalType).toBe("running");
    expect(mapGarminConnectSport("trail_running").canonicalType).toBe("running");
    expect(mapGarminConnectSport("treadmill_running").canonicalType).toBe("running");
    expect(mapGarminConnectSport("track_running").canonicalType).toBe("running");
    expect(mapGarminConnectSport("ultra_running").canonicalType).toBe("running");
    expect(mapGarminConnectSport("virtual_run").canonicalType).toBe("running");
  });

  it("maps cycling variants", () => {
    expect(mapGarminConnectSport("cycling").canonicalType).toBe("cycling");
    expect(mapGarminConnectSport("mountain_biking").canonicalType).toBe("cycling");
    expect(mapGarminConnectSport("road_biking").canonicalType).toBe("cycling");
    expect(mapGarminConnectSport("indoor_cycling").canonicalType).toBe("cycling");
    expect(mapGarminConnectSport("gravel_cycling").canonicalType).toBe("cycling");
    expect(mapGarminConnectSport("virtual_ride").canonicalType).toBe("cycling");
  });

  it("maps swimming variants", () => {
    expect(mapGarminConnectSport("lap_swimming").canonicalType).toBe("swimming");
    expect(mapGarminConnectSport("open_water_swimming").canonicalType).toBe("swimming");
  });

  it("maps strength and cardio", () => {
    expect(mapGarminConnectSport("strength_training").canonicalType).toBe("strength");
    expect(mapGarminConnectSport("indoor_cardio").canonicalType).toBe("cardio");
    expect(mapGarminConnectSport("fitness_equipment").canonicalType).toBe("cardio");
  });

  it("maps winter sports", () => {
    expect(mapGarminConnectSport("resort_skiing_snowboarding_ws").canonicalType).toBe("skiing");
    expect(mapGarminConnectSport("cross_country_skiing_ws").canonicalType).toBe("skiing");
    expect(mapGarminConnectSport("snowshoeing_ws").canonicalType).toBe("snowshoeing");
  });

  it("maps racket sports", () => {
    expect(mapGarminConnectSport("tennis").canonicalType).toBe("tennis");
    expect(mapGarminConnectSport("pickleball").canonicalType).toBe("pickleball");
    expect(mapGarminConnectSport("badminton").canonicalType).toBe("badminton");
  });

  it("defaults to other for unknown types", () => {
    expect(mapGarminConnectSport("totally_unknown_sport").canonicalType).toBe("other");
    expect(mapGarminConnectSport("").canonicalType).toBe("other");
  });

  it("has a comprehensive sport map", () => {
    expect(Object.keys(GARMIN_CONNECT_SPORT_MAP).length).toBeGreaterThan(70);
  });
});
