import { describe, expect, it } from "vitest";
import {
  getMeasurementTypeById,
  getMeasurementTypeByLegacyColumn,
  getMeasurementTypeByLegacyField,
  legacyFieldsToMeasurements,
  MEASUREMENT_TYPES,
  type MeasurementCategory,
} from "./body-measurements.ts";

describe("MEASUREMENT_TYPES catalog", () => {
  it("has unique ids", () => {
    const ids = MEASUREMENT_TYPES.map((type) => type.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique legacy field names", () => {
    const fields = MEASUREMENT_TYPES.map((type) => type.legacyFieldName);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("has unique legacy column names", () => {
    const columns = MEASUREMENT_TYPES.map((type) => type.legacyColumnName);
    expect(new Set(columns).size).toBe(columns.length);
  });

  it("every type has a non-empty display name", () => {
    for (const type of MEASUREMENT_TYPES) {
      expect(type.displayName.length).toBeGreaterThan(0);
    }
  });

  it("every type has a valid category", () => {
    const validCategories: MeasurementCategory[] = [
      "composition",
      "dimension",
      "cardiovascular",
      "temperature",
    ];
    for (const type of MEASUREMENT_TYPES) {
      expect(validCategories).toContain(type.category);
    }
  });

  it("includes all original body_measurement columns", () => {
    const ids = MEASUREMENT_TYPES.map((type) => type.id);
    expect(ids).toContain("weight");
    expect(ids).toContain("body_fat_pct");
    expect(ids).toContain("muscle_mass");
    expect(ids).toContain("bone_mass");
    expect(ids).toContain("water_pct");
    expect(ids).toContain("bmi");
    expect(ids).toContain("height");
    expect(ids).toContain("waist_circumference");
    expect(ids).toContain("systolic_bp");
    expect(ids).toContain("diastolic_bp");
    expect(ids).toContain("heart_pulse");
    expect(ids).toContain("temperature");
  });

  it("includes new measurement types not previously tracked", () => {
    const ids = MEASUREMENT_TYPES.map((type) => type.id);
    expect(ids).toContain("lean_body_mass");
    expect(ids).toContain("visceral_fat");
    expect(ids).toContain("metabolic_age");
  });

  it("integer types are correctly flagged", () => {
    const systolic = getMeasurementTypeById("systolic_bp");
    expect(systolic?.isInteger).toBe(true);

    const weight = getMeasurementTypeById("weight");
    expect(weight?.isInteger).toBe(false);
  });
});

describe("getMeasurementTypeById", () => {
  it("returns the type for a valid id", () => {
    const result = getMeasurementTypeById("weight");
    expect(result).not.toBeNull();
    expect(result?.displayName).toBe("Weight");
    expect(result?.unit).toBe("kg");
  });

  it("returns null for an unknown id", () => {
    expect(getMeasurementTypeById("nonexistent")).toBeNull();
  });
});

describe("getMeasurementTypeByLegacyField", () => {
  it("maps camelCase field name to type", () => {
    const result = getMeasurementTypeByLegacyField("bodyFatPct");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("body_fat_pct");
  });
});

describe("getMeasurementTypeByLegacyColumn", () => {
  it("maps snake_case column name to type", () => {
    const result = getMeasurementTypeByLegacyColumn("weight_kg");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("weight");
  });
});

describe("legacyFieldsToMeasurements", () => {
  it("converts legacy fields to measurement id map", () => {
    const result = legacyFieldsToMeasurements({
      weightKg: 80.5,
      bodyFatPct: 18.2,
      systolicBp: 120,
    });
    expect(result).toEqual({
      weight: 80.5,
      body_fat_pct: 18.2,
      systolic_bp: 120,
    });
  });

  it("skips null and non-number values", () => {
    const result = legacyFieldsToMeasurements({
      weightKg: 80.5,
      bodyFatPct: null,
      muscleMassKg: undefined,
      sourceName: "withings",
    });
    expect(result).toEqual({ weight: 80.5 });
  });
});
