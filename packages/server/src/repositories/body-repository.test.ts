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

  it("maps all snake_case DB fields to camelCase", async () => {
    const { repo } = makeRepository([
      {
        id: "bm-1",
        recorded_at: "2024-01-15T08:00:00Z",
        provider_id: "withings",
        user_id: "user-1",
        external_id: "ext-123",
        weight_kg: "75.5",
        body_fat_pct: "18.2",
        muscle_mass_kg: "58",
        bone_mass_kg: "3.1",
        water_pct: "55",
        bmi: "22.4",
        height_cm: "180",
        waist_circumference_cm: "82",
        systolic_bp: "120",
        diastolic_bp: "80",
        heart_pulse: "62",
        temperature_c: "36.6",
        source_name: "Withings Body+",
        created_at: "2024-01-15T08:01:00Z",
      },
    ]);
    const result = await repo.list(90);
    const detail = result[0]?.toDetail();
    expect(detail?.id).toBe("bm-1");
    expect(detail?.recordedAt).toBe("2024-01-15T08:00:00Z");
    expect(detail?.providerId).toBe("withings");
    expect(detail?.userId).toBe("user-1");
    expect(detail?.externalId).toBe("ext-123");
    expect(detail?.weightKg).toBe(75.5);
    expect(detail?.bodyFatPct).toBe(18.2);
    expect(detail?.muscleMassKg).toBe(58);
    expect(detail?.boneMassKg).toBe(3.1);
    expect(detail?.waterPct).toBe(55);
    expect(detail?.bmi).toBe(22.4);
    expect(detail?.heightCm).toBe(180);
    expect(detail?.waistCircumferenceCm).toBe(82);
    expect(detail?.systolicBp).toBe(120);
    expect(detail?.diastolicBp).toBe(80);
    expect(detail?.heartPulse).toBe(62);
    expect(detail?.temperatureC).toBe(36.6);
    expect(detail?.sourceName).toBe("Withings Body+");
    expect(detail?.createdAt).toBe("2024-01-15T08:01:00Z");
  });

  it("calls execute once", async () => {
    const { repo, execute } = makeRepository([]);
    await repo.list(30);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
