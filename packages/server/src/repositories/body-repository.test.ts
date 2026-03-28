import { describe, expect, it, vi } from "vitest";
import { BodyMeasurement, type BodyMeasurementRow, BodyRepository } from "./body-repository.ts";

describe("BodyMeasurement", () => {
  function makeRow(overrides: Partial<BodyMeasurementRow> = {}): BodyMeasurementRow {
    return {
      id: "bm-1",
      recordedAt: "2024-01-15T08:00:00Z",
      providerId: "withings",
      userId: "user-1",
      externalId: "ext-123",
      weightKg: 75.5,
      bodyFatPct: 18.2,
      muscleMassKg: 58.0,
      boneMassKg: 3.1,
      waterPct: 55.0,
      bmi: 22.4,
      heightCm: 180.0,
      waistCircumferenceCm: 82.0,
      systolicBp: 120,
      diastolicBp: 80,
      heartPulse: 62,
      temperatureC: 36.6,
      sourceName: "Withings Body+",
      createdAt: "2024-01-15T08:01:00Z",
      ...overrides,
    };
  }

  it("exposes id and recordedAt getters", () => {
    const measurement = new BodyMeasurement(makeRow());
    expect(measurement.id).toBe("bm-1");
    expect(measurement.recordedAt).toBe("2024-01-15T08:00:00Z");
  });

  it("exposes weightKg getter with null handling", () => {
    expect(new BodyMeasurement(makeRow({ weightKg: 80.0 })).weightKg).toBe(80.0);
    expect(new BodyMeasurement(makeRow({ weightKg: null })).weightKg).toBeNull();
  });

  it("exposes bodyFatPct getter with null handling", () => {
    expect(new BodyMeasurement(makeRow({ bodyFatPct: 20.5 })).bodyFatPct).toBe(20.5);
    expect(new BodyMeasurement(makeRow({ bodyFatPct: null })).bodyFatPct).toBeNull();
  });

  it("serializes all fields via toDetail()", () => {
    const row = makeRow();
    expect(new BodyMeasurement(row).toDetail()).toEqual(row);
  });

  it("serializes nullable fields as null", () => {
    const detail = new BodyMeasurement(
      makeRow({ weightKg: null, bodyFatPct: null, bmi: null, sourceName: null }),
    ).toDetail();
    expect(detail.weightKg).toBeNull();
    expect(detail.bodyFatPct).toBeNull();
    expect(detail.bmi).toBeNull();
    expect(detail.sourceName).toBeNull();
  });
});

describe("BodyRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new BodyRepository({ execute }, "user-1", "UTC");
    return { repo, execute };
  }

  it("returns empty array when no data", async () => {
    const { repo } = makeRepository([]);
    expect(await repo.list(90)).toEqual([]);
  });

  it("returns BodyMeasurement instances", async () => {
    const { repo } = makeRepository([
      {
        id: "bm-1",
        recorded_at: "2024-01-15T08:00:00Z",
        provider_id: "withings",
        user_id: "user-1",
        external_id: null,
        weight_kg: "75.5",
        body_fat_pct: "18.2",
        muscle_mass_kg: null,
        bone_mass_kg: null,
        water_pct: null,
        bmi: "22.4",
        height_cm: null,
        waist_circumference_cm: null,
        systolic_bp: null,
        diastolic_bp: null,
        heart_pulse: null,
        temperature_c: null,
        source_name: "Withings Body+",
        created_at: "2024-01-15T08:01:00Z",
      },
    ]);
    const result = await repo.list(90);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(BodyMeasurement);
    expect(result[0]?.weightKg).toBe(75.5);
  });

  it("calls execute once", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.list(30);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
