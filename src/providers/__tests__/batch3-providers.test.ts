import { describe, expect, it } from "vitest";
import { parseCyclingAnalyticsRide } from "../cycling-analytics.ts";
import { mapDecathlonSport, parseDecathlonActivity } from "../decathlon.ts";
import { mapVeloHeroSport, parseDurationToSeconds, parseVeloHeroWorkout } from "../velohero.ts";
import { parseWgerWeightEntry, parseWgerWorkoutSession } from "../wger.ts";
import { mapXertSport, parseXertActivity } from "../xert.ts";

// ============================================================
// Xert
// ============================================================

describe("Xert Provider", () => {
  describe("mapXertSport", () => {
    it("maps known sports", () => {
      expect(mapXertSport("Cycling")).toBe("cycling");
      expect(mapXertSport("Running")).toBe("running");
      expect(mapXertSport("Virtual Cycling")).toBe("cycling");
      expect(mapXertSport("Mountain Biking")).toBe("mountain_biking");
    });

    it("returns other for unknown sports", () => {
      expect(mapXertSport("Juggling")).toBe("other");
    });
  });

  describe("parseXertActivity", () => {
    it("maps activity fields from UNIX timestamps", () => {
      const raw = {
        id: 12345,
        name: "Morning Ride",
        sport: "Cycling",
        startTimestamp: 1709290800,
        endTimestamp: 1709294400,
        duration: 3600,
        distance: 30000,
        power_avg: 200,
        power_max: 450,
        power_normalized: 220,
        heartrate_avg: 145,
        heartrate_max: 175,
        cadence_avg: 85,
        cadence_max: 110,
        calories: 700,
        elevation_gain: 300,
        elevation_loss: 280,
        xss: 85,
        focus: 120,
        difficulty: 3,
      };

      const parsed = parseXertActivity(raw);
      expect(parsed.externalId).toBe("12345");
      expect(parsed.activityType).toBe("cycling");
      expect(parsed.name).toBe("Morning Ride");
      expect(parsed.startedAt).toEqual(new Date(1709290800000));
      expect(parsed.endedAt).toEqual(new Date(1709294400000));
      expect(parsed.raw.powerAvg).toBe(200);
      expect(parsed.raw.xss).toBe(85);
    });
  });
});

// ============================================================
// Cycling Analytics
// ============================================================

describe("Cycling Analytics Provider", () => {
  describe("parseCyclingAnalyticsRide", () => {
    it("maps ride fields and calculates endedAt", () => {
      const ride = {
        id: 99001,
        title: "Club Ride",
        date: "2026-03-01T09:00:00Z",
        duration: 7200,
        distance: 60000,
        average_power: 180,
        normalized_power: 200,
        max_power: 500,
        average_heart_rate: 140,
        max_heart_rate: 170,
        average_cadence: 88,
        max_cadence: 115,
        elevation_gain: 500,
        elevation_loss: 490,
        average_speed: 8.33,
        max_speed: 15.0,
        calories: 1200,
        training_stress_score: 120,
        intensity_factor: 0.85,
      };

      const parsed = parseCyclingAnalyticsRide(ride);
      expect(parsed.externalId).toBe("99001");
      expect(parsed.activityType).toBe("cycling");
      expect(parsed.name).toBe("Club Ride");
      expect(parsed.startedAt).toEqual(new Date("2026-03-01T09:00:00Z"));
      expect(parsed.endedAt).toEqual(new Date("2026-03-01T11:00:00Z"));
      expect(parsed.raw.averagePower).toBe(180);
      expect(parsed.raw.trainingStressScore).toBe(120);
    });

    it("handles missing optional fields", () => {
      const ride = {
        id: 99002,
        title: "Quick Spin",
        date: "2026-03-01T12:00:00Z",
        duration: 1800,
      };

      const parsed = parseCyclingAnalyticsRide(ride);
      expect(parsed.externalId).toBe("99002");
      expect(parsed.raw.averagePower).toBeUndefined();
      expect(parsed.raw.distance).toBeUndefined();
    });
  });
});

// ============================================================
// Wger
// ============================================================

describe("Wger Provider", () => {
  describe("parseWgerWorkoutSession", () => {
    it("maps workout session fields", () => {
      const session = {
        id: 555,
        date: "2026-03-01",
        comment: "Upper body day",
        impression: "2",
        time_start: "08:00:00",
        time_end: "09:30:00",
      };

      const parsed = parseWgerWorkoutSession(session);
      expect(parsed.externalId).toBe("555");
      expect(parsed.activityType).toBe("strength");
      expect(parsed.name).toBe("Upper body day");
      expect(parsed.raw.impression).toBe("2");
    });

    it("uses default name when comment is empty", () => {
      const session = {
        id: 556,
        date: "2026-03-02",
        comment: "",
        impression: "1",
        time_start: null,
        time_end: null,
      };

      const parsed = parseWgerWorkoutSession(session);
      expect(parsed.name).toBe("Workout");
    });
  });

  describe("parseWgerWeightEntry", () => {
    it("parses weight from string to number", () => {
      const entry = {
        id: 100,
        date: "2026-03-01",
        weight: "82.5",
      };

      const parsed = parseWgerWeightEntry(entry);
      expect(parsed.externalId).toBe("100");
      expect(parsed.weightKg).toBe(82.5);
      expect(parsed.recordedAt).toEqual(new Date("2026-03-01"));
    });
  });
});

// ============================================================
// Decathlon
// ============================================================

describe("Decathlon Provider", () => {
  describe("mapDecathlonSport", () => {
    it("extracts sport ID from URI and maps it", () => {
      expect(mapDecathlonSport("/v2/sports/381")).toBe("running");
      expect(mapDecathlonSport("/v2/sports/121")).toBe("cycling");
      expect(mapDecathlonSport("/v2/sports/260")).toBe("swimming");
      expect(mapDecathlonSport("/v2/sports/110")).toBe("hiking");
    });

    it("returns other for unknown sport URIs", () => {
      expect(mapDecathlonSport("/v2/sports/9999")).toBe("other");
    });
  });

  describe("parseDecathlonActivity", () => {
    it("maps activity fields and extracts data summaries", () => {
      const act = {
        id: "act-789",
        name: "Morning Run",
        sport: "/v2/sports/381",
        startdate: "2026-03-01T07:00:00Z",
        duration: 3600,
        dataSummaries: [
          { id: 5, value: 10.5 },
          { id: 9, value: 650 },
          { id: 1, value: 155 },
          { id: 2, value: 180 },
        ],
      };

      const parsed = parseDecathlonActivity(act);
      expect(parsed.externalId).toBe("act-789");
      expect(parsed.activityType).toBe("running");
      expect(parsed.name).toBe("Morning Run");
      expect(parsed.startedAt).toEqual(new Date("2026-03-01T07:00:00Z"));
      expect(parsed.endedAt).toEqual(new Date("2026-03-01T08:00:00Z"));
      expect(parsed.raw.distanceKm).toBe(10.5);
      expect(parsed.raw.calories).toBe(650);
      expect(parsed.raw.avgHeartRate).toBe(155);
    });
  });
});

// ============================================================
// VeloHero
// ============================================================

describe("VeloHero Provider", () => {
  describe("mapVeloHeroSport", () => {
    it("maps known sport IDs", () => {
      expect(mapVeloHeroSport("1")).toBe("cycling");
      expect(mapVeloHeroSport("2")).toBe("running");
      expect(mapVeloHeroSport("3")).toBe("swimming");
      expect(mapVeloHeroSport("6")).toBe("mountain_biking");
    });

    it("returns other for unknown IDs", () => {
      expect(mapVeloHeroSport("99")).toBe("other");
    });
  });

  describe("parseDurationToSeconds", () => {
    it("parses HH:MM:SS format", () => {
      expect(parseDurationToSeconds("01:30:00")).toBe(5400);
      expect(parseDurationToSeconds("00:45:30")).toBe(2730);
      expect(parseDurationToSeconds("02:00:00")).toBe(7200);
    });

    it("returns 0 for invalid format", () => {
      expect(parseDurationToSeconds("invalid")).toBe(0);
    });
  });

  describe("parseVeloHeroWorkout", () => {
    it("maps workout fields and converts distance", () => {
      const workout = {
        id: "42",
        date_ymd: "2026-03-01",
        start_time: "08:00:00",
        dur_time: "01:30:00",
        sport_id: "1",
        dist_km: "45.5",
        title: "Morning Ride",
        avg_hr: "145",
        max_hr: "175",
        avg_power: "200",
        max_power: "450",
        avg_cadence: "88",
        max_cadence: "110",
        calories: "900",
        ascent: "600",
        descent: "580",
      };

      const parsed = parseVeloHeroWorkout(workout);
      expect(parsed.externalId).toBe("42");
      expect(parsed.activityType).toBe("cycling");
      expect(parsed.name).toBe("Morning Ride");
      expect(parsed.raw.distanceMeters).toBe(45500);
      expect(parsed.raw.avgHeartRate).toBe(145);
      expect(parsed.raw.avgPower).toBe(200);
      // Duration: 1:30:00 = 5400 seconds
      const expectedEnd = new Date(parsed.startedAt.getTime() + 5400000);
      expect(parsed.endedAt).toEqual(expectedEnd);
    });

    it("uses sport type as name when title is missing", () => {
      const workout = {
        id: "43",
        date_ymd: "2026-03-02",
        start_time: "09:00:00",
        dur_time: "00:30:00",
        sport_id: "2",
        dist_km: "5.0",
      };

      const parsed = parseVeloHeroWorkout(workout);
      expect(parsed.name).toBe("running workout");
    });
  });
});
