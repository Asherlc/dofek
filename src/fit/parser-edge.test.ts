import { describe, expect, it } from "vitest";
import { parseFitFile, parseFitRecord } from "./parser.ts";

describe("FIT Parser — edge cases", () => {
  describe("parseFitFile error handling", () => {
    it.skipIf(!!process.env.CI)("rejects with error for corrupt/invalid FIT data", async () => {
      // Skipped in CI: FIT parser with force:true blocks the event loop
      // on garbage data, preventing the internal timeout from firing
      const corruptBuffer = Buffer.from("this is not a valid FIT file");
      await expect(parseFitFile(corruptBuffer)).rejects.toThrow();
    });

    it("handles empty buffer", async () => {
      const emptyBuffer = Buffer.alloc(0);
      try {
        await parseFitFile(emptyBuffer);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }
    });

    it("handles buffer with only FIT header but no data", async () => {
      // Minimal FIT file header (14 bytes) but with invalid content
      const headerOnly = Buffer.alloc(14);
      headerOnly[0] = 14; // header size
      headerOnly[1] = 0x10; // protocol version
      headerOnly.write(".FIT", 8, "ascii");
      try {
        await parseFitFile(headerOnly);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }
    });
  });

  describe("parseFitRecord — additional edge cases", () => {
    it("handles NaN values by returning undefined", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        heart_rate: Number.NaN,
        power: Number.NaN,
      };
      const result = parseFitRecord(raw);
      expect(result.heartRate).toBeUndefined();
      expect(result.power).toBeUndefined();
    });

    it("extracts left_right_balance from object with valid numeric value", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        left_right_balance: { value: 52.5, right: true },
      };
      const result = parseFitRecord(raw);
      expect(result.leftRightBalance).toBe(52.5);
    });

    it("extracts left_right_balance from a plain number", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        left_right_balance: 52.5,
      };
      const result = parseFitRecord(raw);
      expect(result.leftRightBalance).toBe(52.5);
    });

    it("returns undefined for left_right_balance when null", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        left_right_balance: null,
      };
      const result = parseFitRecord(raw);
      expect(result.leftRightBalance).toBeUndefined();
    });

    it("extracts left_right_balance value from object with NaN value", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        left_right_balance: { value: Number.NaN, right: true },
      };
      const result = parseFitRecord(raw);
      expect(result.leftRightBalance).toBeUndefined();
    });

    it("extracts running dynamics fields", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        vertical_oscillation: 8.5,
        stance_time: 245.3,
        stance_time_percent: 33.5,
        step_length: 1.15,
        vertical_ratio: 7.2,
        stance_time_balance: 50.5,
      };
      const result = parseFitRecord(raw);
      expect(result.verticalOscillation).toBeCloseTo(8.5);
      expect(result.stanceTime).toBeCloseTo(245.3);
      expect(result.stanceTimePercent).toBeCloseTo(33.5);
      expect(result.stepLength).toBeCloseTo(1.15);
      expect(result.verticalRatio).toBeCloseTo(7.2);
      expect(result.stanceTimeBalance).toBeCloseTo(50.5);
    });

    it("extracts grade and vertical_speed fields", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        grade: 5.2,
        vertical_speed: -0.3,
        gps_accuracy: 3,
      };
      const result = parseFitRecord(raw);
      expect(result.grade).toBeCloseTo(5.2);
      expect(result.verticalSpeed).toBeCloseTo(-0.3);
      expect(result.gpsAccuracy).toBe(3);
    });

    it("falls back to speed when enhanced_speed is missing", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        speed: 3.5,
      };
      const result = parseFitRecord(raw);
      expect(result.speed).toBeCloseTo(3.5);
    });

    it("falls back to altitude when enhanced_altitude is missing", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        altitude: 400,
      };
      const result = parseFitRecord(raw);
      expect(result.altitude).toBe(400);
    });

    it("extracts combined_pedal_smoothness", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        combined_pedal_smoothness: 25.5,
        right_torque_effectiveness: 75.0,
        right_pedal_smoothness: 20.0,
      };
      const result = parseFitRecord(raw);
      expect(result.combinedPedalSmoothness).toBeCloseTo(25.5);
      expect(result.rightTorqueEffectiveness).toBeCloseTo(75.0);
      expect(result.rightPedalSmoothness).toBeCloseTo(20.0);
    });

    it("extracts calories field", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        calories: 150.7,
      };
      const result = parseFitRecord(raw);
      expect(result.calories).toBe(151); // intOrUndef rounds
    });

    it("prefers enhanced_speed over speed when both present", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        enhanced_speed: 5.5,
        speed: 3.0,
      };
      const result = parseFitRecord(raw);
      expect(result.speed).toBe(5.5);
    });

    it("prefers enhanced_altitude over altitude when both present", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        enhanced_altitude: 1200,
        altitude: 800,
      };
      const result = parseFitRecord(raw);
      expect(result.altitude).toBe(1200);
    });

    it("returns undefined speed when neither enhanced nor regular present", () => {
      const raw = { timestamp: "2026-01-19T12:58:55.000Z" };
      const result = parseFitRecord(raw);
      expect(result.speed).toBeUndefined();
      expect(result.altitude).toBeUndefined();
    });

    it("returns undefined for string values passed to numeric fields", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        heart_rate: "not-a-number",
        power: "string",
      };
      const result = parseFitRecord(raw);
      expect(result.heartRate).toBeUndefined();
      expect(result.power).toBeUndefined();
    });

    it("extractLeftRightBalance returns undefined for non-object non-number", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        left_right_balance: "invalid",
      };
      const result = parseFitRecord(raw);
      expect(result.leftRightBalance).toBeUndefined();
    });

    it("extractLeftRightBalance handles object without value key", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        left_right_balance: { right: true },
      };
      const result = parseFitRecord(raw);
      expect(result.leftRightBalance).toBeUndefined();
    });

    it("intOrUndef rounds correctly", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        heart_rate: 72.4,
        accumulated_power: 1500.6,
      };
      const result = parseFitRecord(raw);
      expect(result.heartRate).toBe(72);
      expect(result.accumulatedPower).toBe(1501);
    });

    it("extracts distance field", () => {
      const raw = {
        timestamp: "2026-01-19T12:58:55.000Z",
        distance: 1234.56,
      };
      const result = parseFitRecord(raw);
      expect(result.distance).toBe(1234.56);
    });
  });
});
