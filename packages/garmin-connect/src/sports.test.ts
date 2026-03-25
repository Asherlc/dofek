import { describe, expect, it } from "vitest";
import { GARMIN_CONNECT_SPORT_MAP, mapGarminConnectSport } from "./sports.ts";

describe("mapGarminConnectSport", () => {
  it("maps running variants", () => {
    expect(mapGarminConnectSport("running")).toBe("running");
    expect(mapGarminConnectSport("trail_running")).toBe("running");
    expect(mapGarminConnectSport("treadmill_running")).toBe("running");
    expect(mapGarminConnectSport("track_running")).toBe("running");
    expect(mapGarminConnectSport("ultra_running")).toBe("running");
    expect(mapGarminConnectSport("virtual_run")).toBe("running");
  });

  it("maps cycling variants", () => {
    expect(mapGarminConnectSport("cycling")).toBe("cycling");
    expect(mapGarminConnectSport("mountain_biking")).toBe("mountain_biking");
    expect(mapGarminConnectSport("road_biking")).toBe("road_cycling");
    expect(mapGarminConnectSport("indoor_cycling")).toBe("indoor_cycling");
    expect(mapGarminConnectSport("gravel_cycling")).toBe("gravel_cycling");
    expect(mapGarminConnectSport("virtual_ride")).toBe("virtual_cycling");
  });

  it("maps swimming variants", () => {
    expect(mapGarminConnectSport("lap_swimming")).toBe("swimming");
    expect(mapGarminConnectSport("open_water_swimming")).toBe("swimming");
  });

  it("maps strength and cardio", () => {
    expect(mapGarminConnectSport("strength_training")).toBe("strength");
    expect(mapGarminConnectSport("indoor_cardio")).toBe("cardio");
    expect(mapGarminConnectSport("fitness_equipment")).toBe("cardio");
  });

  it("maps winter sports", () => {
    expect(mapGarminConnectSport("resort_skiing_snowboarding_ws")).toBe("skiing");
    expect(mapGarminConnectSport("cross_country_skiing_ws")).toBe("skiing");
    expect(mapGarminConnectSport("snowshoeing_ws")).toBe("snowshoeing");
  });

  it("maps racket sports", () => {
    expect(mapGarminConnectSport("tennis")).toBe("tennis");
    expect(mapGarminConnectSport("pickleball")).toBe("pickleball");
    expect(mapGarminConnectSport("badminton")).toBe("badminton");
  });

  it("defaults to other for unknown types", () => {
    expect(mapGarminConnectSport("totally_unknown_sport")).toBe("other");
    expect(mapGarminConnectSport("")).toBe("other");
  });

  it("has a comprehensive sport map", () => {
    expect(Object.keys(GARMIN_CONNECT_SPORT_MAP).length).toBeGreaterThan(70);
  });
});
