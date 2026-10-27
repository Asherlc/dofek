import { describe, expect, it } from "vitest";
import { parseFitRecord, parseFitSession } from "./parser.ts";

describe("FIT Parser", () => {
  describe("parseFitRecord", () => {
    it("extracts typed fields from a record with power data", () => {
      const rawRecord = {
        timestamp: "2026-01-19T12:58:55.000Z",
        position_lat: 39.666,
        position_long: 20.847,
        distance: 384.97,
        accumulated_power: 7432,
        enhanced_speed: 3.919,
        enhanced_altitude: 504.8,
        power: 245,
        heart_rate: 90,
        cadence: 69,
        temperature: 18,
        left_right_balance: { value: 127, right: true },
        left_torque_effectiveness: 80.5,
        right_torque_effectiveness: 0,
        left_pedal_smoothness: 22,
        right_pedal_smoothness: 0,
        fractional_cadence: 0,
        elapsed_time: 100,
        timer_time: 100,
      };

      const result = parseFitRecord(rawRecord);

      expect(result.heartRate).toBe(90);
      expect(result.power).toBe(245);
      expect(result.cadence).toBe(69);
      expect(result.speed).toBeCloseTo(3.919);
      expect(result.lat).toBeCloseTo(39.666);
      expect(result.lng).toBeCloseTo(20.847);
      expect(result.altitude).toBeCloseTo(504.8);
      expect(result.temperature).toBe(18);
      expect(result.distance).toBeCloseTo(384.97);
      expect(result.accumulatedPower).toBe(7432);
      expect(result.leftTorqueEffectiveness).toBeCloseTo(80.5);
      expect(result.leftPedalSmoothness).toBe(22);
    });

    it("stores the complete raw record in the raw field", () => {
      const rawRecord = {
        timestamp: "2026-01-19T12:58:55.000Z",
        power: 245,
        heart_rate: 90,
        some_unknown_field: 42,
        another_custom_field: "hello",
      };

      const result = parseFitRecord(rawRecord);

      expect(result.raw).toEqual(rawRecord);
      expect(result.raw.some_unknown_field).toBe(42);
      expect(result.raw.another_custom_field).toBe("hello");
    });

    it("handles records with missing fields gracefully", () => {
      const rawRecord = {
        timestamp: "2026-01-19T12:58:55.000Z",
        heart_rate: 120,
      };

      const result = parseFitRecord(rawRecord);

      expect(result.heartRate).toBe(120);
      expect(result.power).toBeUndefined();
      expect(result.cadence).toBeUndefined();
      expect(result.lat).toBeUndefined();
      expect(result.speed).toBeUndefined();
      expect(result.recordedAt).toEqual(new Date("2026-01-19T12:58:55.000Z"));
    });

    it("prefers enhanced_speed over speed", () => {
      const record = {
        timestamp: "2026-01-19T12:58:55.000Z",
        speed: 3.0,
        enhanced_speed: 3.919,
      };

      const result = parseFitRecord(record);
      expect(result.speed).toBeCloseTo(3.919);
    });

    it("prefers enhanced_altitude over altitude", () => {
      const record = {
        timestamp: "2026-01-19T12:58:55.000Z",
        altitude: 500,
        enhanced_altitude: 504.8,
      };

      const result = parseFitRecord(record);
      expect(result.altitude).toBeCloseTo(504.8);
    });
  });

  describe("parseFitSession", () => {
    it("extracts sport from raw.sport when it is a string", () => {
      const raw = { sport: "cycling", start_time: "2026-01-01T00:00:00Z" };
      const session = parseFitSession(raw);
      expect(session.sport).toBe("cycling");
    });

    it("returns 'unknown' when sport is not a string", () => {
      expect(parseFitSession({ sport: 42, start_time: "2026-01-01T00:00:00Z" }).sport).toBe(
        "unknown",
      );
      expect(parseFitSession({ start_time: "2026-01-01T00:00:00Z" }).sport).toBe("unknown");
    });

    it("extracts subSport when present", () => {
      const raw = {
        sport: "cycling",
        sub_sport: "indoor_cycling",
        start_time: "2026-01-01T00:00:00Z",
      };
      expect(parseFitSession(raw).subSport).toBe("indoor_cycling");
    });

    it("returns undefined for subSport when not a string", () => {
      const raw = { sport: "cycling", sub_sport: 99, start_time: "2026-01-01T00:00:00Z" };
      expect(parseFitSession(raw).subSport).toBeUndefined();
    });

    it("defaults numeric fields to 0 when missing", () => {
      const raw = { start_time: "2026-01-01T00:00:00Z" };
      const session = parseFitSession(raw);
      expect(session.totalElapsedTime).toBe(0);
      expect(session.totalTimerTime).toBe(0);
      expect(session.totalDistance).toBe(0);
    });

    it("returns undefined for optional numeric fields when missing", () => {
      const raw = { start_time: "2026-01-01T00:00:00Z" };
      const session = parseFitSession(raw);
      expect(session.avgHeartRate).toBeUndefined();
      expect(session.maxHeartRate).toBeUndefined();
      expect(session.avgPower).toBeUndefined();
      expect(session.normalizedPower).toBeUndefined();
      expect(session.tss).toBeUndefined();
    });

    it("prefers enhanced_avg_speed over avg_speed", () => {
      const raw = {
        start_time: "2026-01-01T00:00:00Z",
        avg_speed: 3.0,
        enhanced_avg_speed: 5.5,
      };
      expect(parseFitSession(raw).avgSpeed).toBeCloseTo(5.5);
    });

    it("falls back to avg_speed when enhanced_avg_speed is missing", () => {
      const raw = { start_time: "2026-01-01T00:00:00Z", avg_speed: 3.0 };
      expect(parseFitSession(raw).avgSpeed).toBeCloseTo(3.0);
    });

    it("preserves the raw record", () => {
      const raw = { sport: "running", start_time: "2026-01-01T00:00:00Z", custom_field: 42 };
      expect(parseFitSession(raw).raw).toBe(raw);
    });
  });
});
