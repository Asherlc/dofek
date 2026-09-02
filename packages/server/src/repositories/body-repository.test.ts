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

  it("exposes provider and BMI for server-side summaries", () => {
    const measurement = new BodyMeasurement(makeRow());
    expect(measurement.providerId).toBe("withings");
    expect(measurement.bmi).toBe(22.4);
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
    const query = vi.fn(async (schema: { parse: (row: Record<string, unknown>) => unknown }) =>
      rows.map((row) => schema.parse(row)),
    );
    const repo = new BodyRepository({ query }, "user-1", "UTC");
    return { repo, query };
  }

  it("returns empty array when no data", async () => {
    const { repo } = makeRepository([]);
    expect(await repo.list(90)).toEqual([]);
  });

  it("rejects invalid day windows before querying ClickHouse", async () => {
    const { repo, query } = makeRepository([]);

    await expect(repo.list(-1)).rejects.toThrow("days must be a non-negative integer");
    await expect(repo.list(1.5)).rejects.toThrow("days must be a non-negative integer");
    expect(query).not.toHaveBeenCalled();
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

  it("reads body measurements from the ClickHouse analytics model", async () => {
    const { repo, query } = makeRepository([]);

    await repo.list(30);

    expect(query).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("FROM analytics.v_body_measurement"),
      { userId: "user-1", days: 30 },
    );
    const queryText = query.mock.calls[0]?.[1] ?? "";
    expect(queryText).toContain("toString(body_measurements.recorded_at) AS recorded_at");
    expect(queryText).toContain("ORDER BY body_measurements.recorded_at DESC");
    expect(queryText).not.toContain("fitness.v_body_measurement");
  });

  it("reads an exact local-date range from ClickHouse", async () => {
    const { repo, query } = makeRepository([
      {
        id: "bm-range-1",
        recorded_at: "2024-01-15T08:00:00Z",
        provider_id: "withings",
        user_id: "user-1",
        external_id: null,
        weight_kg: "75.5",
        body_fat_pct: null,
        muscle_mass_kg: null,
        bone_mass_kg: null,
        water_pct: null,
        bmi: null,
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

    const result = await repo.listRange("2024-01-10", "2024-01-15");

    expect(query).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("toDate(toTimeZone(recorded_at, {timezone:String}))"),
      {
        userId: "user-1",
        timezone: "UTC",
        startDate: "2024-01-10",
        endDate: "2024-01-15",
      },
    );
    const queryText = query.mock.calls[0]?.[1] ?? "";
    expect(queryText).toContain("toString(body_measurements.recorded_at) AS recorded_at");
    expect(queryText).toContain(") AS body_measurements");
    expect(queryText).toContain("ORDER BY body_measurements.recorded_at ASC");
    expect(result[0]).toBeInstanceOf(BodyMeasurement);
    expect(result[0]?.id).toBe("bm-range-1");
  });

  it("selects the latest same-provider measurement for each local date", async () => {
    const { repo, query } = makeRepository([]);

    await repo.listRange("2026-05-01", "2026-05-31");

    const queryText = query.mock.calls[0]?.[1] ?? "";
    expect(queryText).toContain(
      "PARTITION BY provider_id, toDate(toTimeZone(recorded_at, {timezone:String}))",
    );
    expect(queryText).toContain("ORDER BY recorded_at DESC, created_at DESC");
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
    expect(detail?.recordedAt).toBe("2024-01-15T08:00:00.000Z");
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
    expect(detail?.createdAt).toBe("2024-01-15T08:01:00.000Z");
  });

  it("maps null external_id to null externalId", async () => {
    const { repo } = makeRepository([
      {
        id: "bm-1",
        recorded_at: "2024-01-15T08:00:00Z",
        provider_id: "withings",
        user_id: "user-1",
        external_id: null,
        weight_kg: null,
        body_fat_pct: null,
        muscle_mass_kg: null,
        bone_mass_kg: null,
        water_pct: null,
        bmi: null,
        height_cm: null,
        waist_circumference_cm: null,
        systolic_bp: null,
        diastolic_bp: null,
        heart_pulse: null,
        temperature_c: null,
        source_name: null,
        created_at: "2024-01-15T08:01:00Z",
      },
    ]);
    const result = await repo.list(90);
    const detail = result[0]?.toDetail();
    expect(detail?.externalId).toBeNull();
    expect(detail?.weightKg).toBeNull();
    expect(detail?.bodyFatPct).toBeNull();
    expect(detail?.muscleMassKg).toBeNull();
    expect(detail?.boneMassKg).toBeNull();
    expect(detail?.waterPct).toBeNull();
    expect(detail?.bmi).toBeNull();
    expect(detail?.heightCm).toBeNull();
    expect(detail?.waistCircumferenceCm).toBeNull();
    expect(detail?.systolicBp).toBeNull();
    expect(detail?.diastolicBp).toBeNull();
    expect(detail?.heartPulse).toBeNull();
    expect(detail?.temperatureC).toBeNull();
    expect(detail?.sourceName).toBeNull();
  });

  it("maps non-null external_id to string externalId", async () => {
    const { repo } = makeRepository([
      {
        id: "bm-2",
        recorded_at: "2024-01-15T08:00:00Z",
        provider_id: "withings",
        user_id: "user-1",
        external_id: "ext-456",
        weight_kg: "80.5",
        body_fat_pct: "20.1",
        muscle_mass_kg: "60.2",
        bone_mass_kg: "3.5",
        water_pct: "55.3",
        bmi: "24.1",
        height_cm: "175",
        waist_circumference_cm: "85.5",
        systolic_bp: "125",
        diastolic_bp: "82",
        heart_pulse: "65",
        temperature_c: "36.8",
        source_name: "Scale Pro",
        created_at: "2024-01-15T08:01:00Z",
      },
    ]);
    const result = await repo.list(90);
    const detail = result[0]?.toDetail();
    expect(detail?.externalId).toBe("ext-456");
    expect(detail?.weightKg).toBe(80.5);
    expect(detail?.bodyFatPct).toBe(20.1);
    expect(detail?.muscleMassKg).toBe(60.2);
    expect(detail?.boneMassKg).toBe(3.5);
    expect(detail?.waterPct).toBe(55.3);
    expect(detail?.bmi).toBe(24.1);
    expect(detail?.heightCm).toBe(175);
    expect(detail?.waistCircumferenceCm).toBe(85.5);
    expect(detail?.systolicBp).toBe(125);
    expect(detail?.diastolicBp).toBe(82);
    expect(detail?.heartPulse).toBe(65);
    expect(detail?.temperatureC).toBe(36.8);
    expect(detail?.sourceName).toBe("Scale Pro");
  });

  it("preserves id, recordedAt, providerId, userId, createdAt from mapping", async () => {
    const { repo } = makeRepository([
      {
        id: "bm-99",
        recorded_at: "2024-03-20T10:30:00Z",
        provider_id: "garmin",
        user_id: "user-42",
        external_id: null,
        weight_kg: null,
        body_fat_pct: null,
        muscle_mass_kg: null,
        bone_mass_kg: null,
        water_pct: null,
        bmi: null,
        height_cm: null,
        waist_circumference_cm: null,
        systolic_bp: null,
        diastolic_bp: null,
        heart_pulse: null,
        temperature_c: null,
        source_name: null,
        created_at: "2024-03-20T10:31:00Z",
      },
    ]);
    const result = await repo.list(90);
    const detail = result[0]?.toDetail();
    expect(detail?.id).toBe("bm-99");
    expect(detail?.recordedAt).toBe("2024-03-20T10:30:00.000Z");
    expect(detail?.providerId).toBe("garmin");
    expect(detail?.userId).toBe("user-42");
    expect(detail?.createdAt).toBe("2024-03-20T10:31:00.000Z");
  });

  it("calls query once", async () => {
    const { repo, query } = makeRepository([]);
    await repo.list(30);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("reconciles each daily metric by configured body priority and preserves sources", async () => {
    const { repo, query } = makeRepository([
      {
        date: "2026-05-14",
        recorded_at: "2026-05-14T15:00:00Z",
        provider_id: "withings",
        body_priority: 10,
        weight_kg: 90,
        body_fat_pct: 18,
        bmi: null,
      },
      {
        date: "2026-05-14",
        recorded_at: "2026-05-14T16:00:00Z",
        provider_id: "apple_health",
        body_priority: 20,
        weight_kg: 89.7,
        body_fat_pct: null,
        bmi: 27.2,
      },
    ]);

    await expect(repo.listReconciledRange("2026-05-01", "2026-05-31")).resolves.toEqual([
      {
        date: "2026-05-14",
        weightKg: 90,
        bodyFatPct: 18,
        leanMassKg: 73.8,
        bmi: 27.2,
        sourceProviderByMetric: {
          weightKg: "withings",
          bodyFatPct: "withings",
          bmi: "apple_health",
        },
        sources: [
          {
            sourceProvider: "withings",
            recordedAt: "2026-05-14T15:00:00.000Z",
            weightKg: 90,
            bodyFatPct: 18,
            bmi: null,
          },
          {
            sourceProvider: "apple_health",
            recordedAt: "2026-05-14T16:00:00.000Z",
            weightKg: 89.7,
            bodyFatPct: null,
            bmi: 27.2,
          },
        ],
        coverage: { sourceCount: 2 },
      },
    ]);
    const queryText = query.mock.calls[0]?.[1] ?? "";
    expect(queryText).toContain("FROM analytics.body_measurement_sample FINAL");
    expect(queryText).toContain("postgres_fitness.provider_priority");
    expect(queryText).toContain("raw_body_samples.channel = 'body_weight'");
  });
});
