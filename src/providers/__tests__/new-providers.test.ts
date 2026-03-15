import { describe, expect, it } from "vitest";
import { mapConcept2Type, parseConcept2Result } from "../concept2.ts";
import { mapCorosSportType, parseCorosWorkout } from "../coros.ts";
import { mapKomootSport, parseKomootTour } from "../komoot.ts";
import { mapMapMyFitnessActivityType, parseMapMyFitnessWorkout } from "../mapmyfitness.ts";
import { mapSuuntoActivityType, parseSuuntoWorkout } from "../suunto.ts";
import { parseUltrahumanMetrics } from "../ultrahuman.ts";

// ============================================================
// Ultrahuman
// ============================================================

describe("Ultrahuman Provider", () => {
  describe("parseUltrahumanMetrics", () => {
    it("extracts HR and HRV metrics", () => {
      const metrics = [
        { type: "night_rhr", object: { avg: 52 } },
        { type: "avg_sleep_hrv", object: { value: 45.2 } },
        { type: "steps", object: { value: 8500 } },
        { type: "vo2_max", object: { value: 48.5 } },
      ];
      const { daily } = parseUltrahumanMetrics("2026-03-01", metrics);

      expect(daily.date).toBe("2026-03-01");
      expect(daily.restingHr).toBe(52);
      expect(daily.hrv).toBe(45.2);
      expect(daily.steps).toBe(8500);
      expect(daily.vo2max).toBe(48.5);
    });

    it("extracts sleep data from quick_metrics", () => {
      const metrics = [
        {
          type: "sleep",
          object: {
            quick_metrics: [
              { type: "total_sleep", value: 28800 },
              { type: "sleep_index", value: 85 },
            ],
          },
        },
      ];
      const { sleep } = parseUltrahumanMetrics("2026-03-01", metrics);

      expect(sleep.durationMinutes).toBe(480); // 28800s / 60
      expect(sleep.sleepScore).toBe(85);
    });

    it("handles missing metrics", () => {
      const { daily, sleep } = parseUltrahumanMetrics("2026-03-01", []);
      expect(daily.restingHr).toBeUndefined();
      expect(daily.hrv).toBeUndefined();
      expect(sleep.durationMinutes).toBeUndefined();
    });

    it("extracts body temperature", () => {
      const metrics = [{ type: "body_temperature", object: { value: 36.8 } }];
      const { daily } = parseUltrahumanMetrics("2026-03-01", metrics);
      expect(daily.skinTempC).toBe(36.8);
    });
  });
});

// ============================================================
// MapMyFitness
// ============================================================

describe("MapMyFitness Provider", () => {
  describe("mapMapMyFitnessActivityType", () => {
    it("maps common activity types", () => {
      expect(mapMapMyFitnessActivityType("Run")).toBe("running");
      expect(mapMapMyFitnessActivityType("Road Cycling")).toBe("cycling");
      expect(mapMapMyFitnessActivityType("Walk")).toBe("walking");
      expect(mapMapMyFitnessActivityType("Swimming")).toBe("swimming");
      expect(mapMapMyFitnessActivityType("Hiking")).toBe("hiking");
    });

    it("returns other for unknown types", () => {
      expect(mapMapMyFitnessActivityType("Circus")).toBe("other");
    });
  });

  describe("parseMapMyFitnessWorkout", () => {
    it("maps workout fields correctly", () => {
      const workout = {
        _links: { self: [{ id: "workout-123" }] },
        name: "Morning Run",
        start_datetime: "2026-03-01T08:00:00+00:00",
        start_locale_timezone: "America/New_York",
        aggregates: {
          distance_total: 5000,
          active_time_total: 1800,
          speed_avg: 2.78,
          heart_rate_avg: 155,
          metabolic_energy_total: 1674400, // 400 kcal in joules
        },
        activity_type: "Run",
      };

      const result = parseMapMyFitnessWorkout(workout);
      expect(result.externalId).toBe("workout-123");
      expect(result.activityType).toBe("running");
      expect(result.name).toBe("Morning Run");
      expect(result.raw.distanceMeters).toBe(5000);
      expect(result.raw.calories).toBe(400);
    });
  });
});

// ============================================================
// Suunto
// ============================================================

describe("Suunto Provider", () => {
  describe("mapSuuntoActivityType", () => {
    it("maps known activity IDs", () => {
      expect(mapSuuntoActivityType(2)).toBe("running");
      expect(mapSuuntoActivityType(3)).toBe("cycling");
      expect(mapSuuntoActivityType(27)).toBe("swimming");
      expect(mapSuuntoActivityType(12)).toBe("hiking");
    });

    it("returns other for unknown IDs", () => {
      expect(mapSuuntoActivityType(999)).toBe("other");
    });
  });

  describe("parseSuuntoWorkout", () => {
    it("maps workout fields from UNIX timestamps", () => {
      const workout = {
        workoutKey: "abc123def456",
        activityId: 2,
        workoutName: "Morning Run",
        startTime: 1709290800000, // 2024-03-01T10:00:00Z
        stopTime: 1709294400000, // 2024-03-01T11:00:00Z
        totalTime: 3600,
        totalDistance: 10000,
        totalAscent: 150,
        totalDescent: 140,
        avgSpeed: 2.78,
        maxSpeed: 4.0,
        energyConsumption: 500,
        stepCount: 8500,
        hrdata: { workoutAvgHR: 155, workoutMaxHR: 180 },
      };

      const result = parseSuuntoWorkout(workout);
      expect(result.externalId).toBe("abc123def456");
      expect(result.activityType).toBe("running");
      expect(result.raw.avgHeartRate).toBe(155);
      expect(result.raw.totalDistance).toBe(10000);
    });
  });
});

// ============================================================
// COROS
// ============================================================

describe("COROS Provider", () => {
  describe("mapCorosSportType", () => {
    it("maps known sport modes", () => {
      expect(mapCorosSportType(8)).toBe("running");
      expect(mapCorosSportType(9)).toBe("cycling");
      expect(mapCorosSportType(10)).toBe("swimming");
      expect(mapCorosSportType(13)).toBe("strength");
    });

    it("returns other for unknown modes", () => {
      expect(mapCorosSportType(999)).toBe("other");
    });
  });

  describe("parseCorosWorkout", () => {
    it("converts UNIX seconds to dates", () => {
      const workout = {
        labelId: "coros-123",
        mode: 8,
        subMode: 1,
        startTime: 1709290800, // seconds
        endTime: 1709294400,
        duration: 3600,
        distance: 10000,
        avgHeartRate: 155,
        maxHeartRate: 180,
        avgSpeed: 2.78,
        maxSpeed: 4.0,
        totalCalories: 500,
      };

      const result = parseCorosWorkout(workout);
      expect(result.externalId).toBe("coros-123");
      expect(result.activityType).toBe("running");
      expect(result.startedAt).toEqual(new Date(1709290800000));
      expect(result.raw.avgHeartRate).toBe(155);
    });
  });
});

// ============================================================
// Concept2
// ============================================================

describe("Concept2 Provider", () => {
  describe("mapConcept2Type", () => {
    it("maps machine types", () => {
      expect(mapConcept2Type("rower")).toBe("rowing");
      expect(mapConcept2Type("skierg")).toBe("skiing");
      expect(mapConcept2Type("bikerg")).toBe("cycling");
    });

    it("defaults to rowing for unknown types", () => {
      expect(mapConcept2Type("unknown")).toBe("rowing");
    });
  });

  describe("parseConcept2Result", () => {
    it("calculates endedAt from tenths of seconds", () => {
      const result = {
        id: 12345,
        type: "rower",
        date: "2026-03-01 10:00:00",
        distance: 2000,
        time: 4200, // 420 seconds (7 minutes) in tenths
        time_formatted: "7:00.0",
        stroke_rate: 28,
        stroke_count: 196,
        heart_rate: { average: 165, max: 185, min: 120 },
        calories_total: 100,
        drag_factor: 130,
        weight_class: "H",
        workout_type: "FixedDistanceSplits",
        privacy: "private",
      };

      const parsed = parseConcept2Result(result);
      expect(parsed.externalId).toBe("12345");
      expect(parsed.activityType).toBe("rowing");
      expect(parsed.startedAt).toEqual(new Date("2026-03-01 10:00:00"));
      // 4200 tenths of a second = 420 seconds = 7 minutes
      const expectedEnd = new Date(parsed.startedAt.getTime() + 420000);
      expect(parsed.endedAt).toEqual(expectedEnd);
      expect(parsed.raw.strokeRate).toBe(28);
      expect(parsed.raw.avgHeartRate).toBe(165);
    });
  });
});

// ============================================================
// Komoot
// ============================================================

describe("Komoot Provider", () => {
  describe("mapKomootSport", () => {
    it("maps common Komoot sports", () => {
      expect(mapKomootSport("BIKING")).toBe("cycling");
      expect(mapKomootSport("RUNNING")).toBe("running");
      expect(mapKomootSport("HIKING")).toBe("hiking");
      expect(mapKomootSport("MT_BIKING")).toBe("mountain_biking");
      expect(mapKomootSport("TRAIL_RUNNING")).toBe("trail_running");
    });

    it("returns other for unknown sports", () => {
      expect(mapKomootSport("PARAGLIDING")).toBe("other");
    });
  });

  describe("parseKomootTour", () => {
    it("calculates endedAt from duration", () => {
      const tour = {
        id: 456789,
        name: "Mountain Hike",
        sport: "HIKING",
        date: "2026-03-01T08:00:00.000Z",
        distance: 15000,
        duration: 18000, // 5 hours
        elevation_up: 800,
        elevation_down: 750,
        status: "public",
        type: "tour_recorded",
      };

      const parsed = parseKomootTour(tour);
      expect(parsed.externalId).toBe("456789");
      expect(parsed.activityType).toBe("hiking");
      expect(parsed.name).toBe("Mountain Hike");
      expect(parsed.endedAt).toEqual(new Date("2026-03-01T13:00:00.000Z"));
      expect(parsed.raw.elevationUp).toBe(800);
    });
  });
});
