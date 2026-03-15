import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFitFile, parseFitRecord } from "./parser.ts";

const FIXTURES = resolve(import.meta.dirname, "fixtures");

function loadFixture(name: string): Buffer {
  return readFileSync(resolve(FIXTURES, name));
}

describe("FIT Parser", () => {
  describe("parseFitFile", () => {
    it("parses a cycling FIT file with power data", async () => {
      const buf = loadFixture("road-with-power.fit");
      const result = await parseFitFile(buf);

      expect(result.session.sport).toBe("cycling");
      expect(result.session.totalDistance).toBeGreaterThan(30000);
      expect(result.session.totalCalories).toBe(741);
      expect(result.session.avgPower).toBe(134);
      expect(result.session.maxPower).toBe(1336);
      expect(result.session.normalizedPower).toBe(151);
      expect(result.session.tss).toBeCloseTo(54.5);
      expect(result.session.intensityFactor).toBeCloseTo(0.645);
      expect(result.session.avgHeartRate).toBe(113);
      expect(result.session.maxHeartRate).toBe(137);
      expect(result.session.avgCadence).toBe(73);
      expect(result.session.totalAscent).toBe(198);
      expect(result.session.avgTemperature).toBe(10);

      expect(result.records.length).toBe(4746);
    });

    it("parses a basic cycling FIT file", async () => {
      const buf = loadFixture("test.fit");
      const result = await parseFitFile(buf);

      expect(result.session.sport).toBe("cycling");
      expect(result.records.length).toBe(3229);
    });

    it("extracts start and end times from session", async () => {
      const buf = loadFixture("road-with-power.fit");
      const result = await parseFitFile(buf);

      expect(result.session.startTime).toBeInstanceOf(Date);
      expect(result.session.totalElapsedTime).toBeGreaterThan(0);
      expect(result.session.totalTimerTime).toBeGreaterThan(0);
    });
  });

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

  describe("full pipeline — file to stream rows", () => {
    it("produces records with timestamps and raw data", async () => {
      const buf = loadFixture("road-with-power.fit");
      const result = await parseFitFile(buf);

      const firstRecord = result.records[0];
      expect(firstRecord).toBeDefined();
      expect(firstRecord?.recordedAt).toBeInstanceOf(Date);
      expect(firstRecord?.raw).toBeDefined();
      expect(firstRecord?.raw.timestamp).toBeDefined();
    });

    it("preserves all fields in raw even when not mapped to typed columns", async () => {
      const buf = loadFixture("road-with-power.fit");
      const result = await parseFitFile(buf);

      // The road-with-power file has left_torque_effectiveness — should be in raw
      const recordWithTorque = result.records.find(
        (r) => r.raw.left_torque_effectiveness !== undefined,
      );
      expect(recordWithTorque).toBeDefined();
      expect(recordWithTorque?.raw.left_torque_effectiveness).toBeTypeOf("number");
    });
  });
});
