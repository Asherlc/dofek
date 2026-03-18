import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BodySpecBoneDensityResponse,
  type BodySpecCompositionResponse,
  type BodySpecPercentilesResponse,
  BodySpecProvider,
  type BodySpecRmrResponse,
  type BodySpecScanInfoResponse,
  type BodySpecVisceralFatResponse,
  catchNotFound,
  parseBoneDensity,
  parseComposition,
  parsePercentiles,
  parseRegions,
  parseRmr,
  parseScanInfo,
  parseVisceralFat,
} from "./bodyspec.ts";

// ============================================================
// Fixtures
// ============================================================

const COMPOSITION_RESPONSE: BodySpecCompositionResponse = {
  result_id: "result-1",
  section_name: "composition",
  total: {
    fat_mass_kg: 15.2,
    lean_mass_kg: 55.8,
    bone_mass_kg: 3.1,
    total_mass_kg: 74.1,
    tissue_fat_pct: 21.4,
    region_fat_pct: 100,
  },
  regions: {
    left_arm: {
      fat_mass_kg: 1.1,
      lean_mass_kg: 3.2,
      bone_mass_kg: 0.2,
      total_mass_kg: 4.5,
      tissue_fat_pct: 25.5,
      region_fat_pct: 7.2,
    },
    right_arm: {
      fat_mass_kg: 1.0,
      lean_mass_kg: 3.4,
      bone_mass_kg: 0.2,
      total_mass_kg: 4.6,
      tissue_fat_pct: 22.7,
      region_fat_pct: 6.6,
    },
    trunk: {
      fat_mass_kg: 7.5,
      lean_mass_kg: 26.1,
      bone_mass_kg: 0.8,
      total_mass_kg: 34.4,
      tissue_fat_pct: 22.3,
      region_fat_pct: 49.3,
    },
    left_leg: {
      fat_mass_kg: 2.5,
      lean_mass_kg: 9.2,
      bone_mass_kg: 0.6,
      total_mass_kg: 12.3,
      tissue_fat_pct: 21.4,
      region_fat_pct: 16.4,
    },
    right_leg: {
      fat_mass_kg: 2.4,
      lean_mass_kg: 9.5,
      bone_mass_kg: 0.6,
      total_mass_kg: 12.5,
      tissue_fat_pct: 20.2,
      region_fat_pct: 15.8,
    },
    android: {
      fat_mass_kg: 1.8,
      lean_mass_kg: 4.1,
      bone_mass_kg: 0.1,
      total_mass_kg: 6.0,
      tissue_fat_pct: 30.5,
      region_fat_pct: 11.8,
    },
    gynoid: {
      fat_mass_kg: 2.9,
      lean_mass_kg: 7.8,
      bone_mass_kg: 0.3,
      total_mass_kg: 11.0,
      tissue_fat_pct: 27.1,
      region_fat_pct: 19.1,
    },
  },
  android_gynoid_ratio: 0.62,
};

const BONE_DENSITY_RESPONSE: BodySpecBoneDensityResponse = {
  result_id: "result-1",
  section_name: "bone-density",
  total: {
    bone_mineral_density: 1.25,
    bone_area_cm2: 2200.5,
    bone_mineral_content_g: 2750.6,
    age_sex_z_percentile: 72,
    peak_sex_t_percentile: 68,
  },
  regions: {
    left_arm: {
      bone_mineral_density: 0.85,
      bone_area_cm2: 180.2,
      bone_mineral_content_g: 153.2,
      age_sex_z_percentile: 65,
      peak_sex_t_percentile: 60,
    },
    trunk: {
      bone_mineral_density: 1.1,
      bone_area_cm2: 600.0,
      bone_mineral_content_g: 660.0,
      age_sex_z_percentile: 70,
      peak_sex_t_percentile: 65,
    },
  },
};

const VISCERAL_FAT_RESPONSE: BodySpecVisceralFatResponse = {
  result_id: "result-1",
  section_name: "visceral-fat",
  vat_mass_kg: 0.45,
  vat_volume_cm3: 480.2,
};

const RMR_RESPONSE: BodySpecRmrResponse = {
  result_id: "result-1",
  section_name: "rmr",
  estimates: [
    { formula: "ten Haaf (2014)", kcal_per_day: 1720 },
    { formula: "Cunningham (1980)", kcal_per_day: 1680 },
    { formula: "De Lorenzo (1999)", kcal_per_day: 1750 },
    { formula: "Mifflin-St. Jeor (1990)", kcal_per_day: 1695 },
  ],
};

const PERCENTILES_RESPONSE: BodySpecPercentilesResponse = {
  result_id: "result-1",
  section_name: "percentiles",
  params: { min_age: 25, max_age: 35, gender: "male" },
  metrics: {
    bone_density_g_cm2: { percentile: 72, value: 1.25 },
    limb_lmi_kg_m2: { percentile: 85, value: 9.2 },
    total_body_fat_pct: { percentile: 35, value: 21.4 },
    total_lmi_kg_m2: { percentile: 80, value: 18.5 },
    vat_mass_kg: { percentile: 22, value: 0.45 },
  },
};

const SCAN_INFO_RESPONSE: BodySpecScanInfoResponse = {
  result_id: "result-1",
  section_name: "scan-info",
  scanner_model: "GE Lunar iDXA",
  acquire_time: "2025-06-15T10:30:00Z",
  analyze_time: "2025-06-15T10:35:00Z",
  patient_intake: {
    height_inches: 70.5,
    weight_pounds: 163.4,
    birth_date: "1990-03-15",
    gender: "male",
    ethnicity: "white",
  },
};

// ============================================================
// Parsing tests
// ============================================================

describe("parseComposition", () => {
  it("extracts total body composition fields", () => {
    const result = parseComposition(COMPOSITION_RESPONSE);
    expect(result.totalFatMassKg).toBe(15.2);
    expect(result.totalLeanMassKg).toBe(55.8);
    expect(result.totalBoneMassKg).toBe(3.1);
    expect(result.totalMassKg).toBe(74.1);
    expect(result.bodyFatPct).toBe(21.4);
    expect(result.androidGynoidRatio).toBe(0.62);
  });

  it("handles null android_gynoid_ratio", () => {
    const response = { ...COMPOSITION_RESPONSE, android_gynoid_ratio: null };
    const result = parseComposition(response);
    expect(result.androidGynoidRatio).toBeNull();
  });
});

describe("parseRegions", () => {
  it("parses composition regions into region rows", () => {
    const regions = parseRegions(COMPOSITION_RESPONSE, BONE_DENSITY_RESPONSE);
    expect(regions).toHaveLength(7);

    const leftArm = regions.find((r) => r.region === "left_arm");
    expect(leftArm).toBeDefined();
    expect(leftArm?.fatMassKg).toBe(1.1);
    expect(leftArm?.leanMassKg).toBe(3.2);
    expect(leftArm?.boneMassKg).toBe(0.2);
    expect(leftArm?.totalMassKg).toBe(4.5);
    expect(leftArm?.tissueFatPct).toBe(25.5);
    expect(leftArm?.regionFatPct).toBe(7.2);
    // Bone density from left_arm region
    expect(leftArm?.boneMineralDensity).toBe(0.85);
    expect(leftArm?.boneAreaCm2).toBe(180.2);
    expect(leftArm?.boneMineralContentG).toBe(153.2);
    expect(leftArm?.zScorePercentile).toBe(65);
    expect(leftArm?.tScorePercentile).toBe(60);
  });

  it("handles regions with composition data but no bone density data", () => {
    const regions = parseRegions(COMPOSITION_RESPONSE, BONE_DENSITY_RESPONSE);
    const android = regions.find((r) => r.region === "android");
    expect(android).toBeDefined();
    expect(android?.fatMassKg).toBe(1.8);
    // android has no bone density data in fixture
    expect(android?.boneMineralDensity).toBeUndefined();
    expect(android?.boneAreaCm2).toBeUndefined();
  });

  it("handles null bone density response", () => {
    const regions = parseRegions(COMPOSITION_RESPONSE, null);
    expect(regions).toHaveLength(7);
    const leftArm = regions.find((r) => r.region === "left_arm");
    expect(leftArm?.fatMassKg).toBe(1.1);
    expect(leftArm?.boneMineralDensity).toBeUndefined();
  });
});

describe("parseBoneDensity", () => {
  it("extracts total bone density fields", () => {
    const result = parseBoneDensity(BONE_DENSITY_RESPONSE);
    expect(result.totalBoneMineralDensity).toBe(1.25);
    expect(result.boneDensityTPercentile).toBe(68);
    expect(result.boneDensityZPercentile).toBe(72);
  });

  it("handles null percentiles", () => {
    const response: BodySpecBoneDensityResponse = {
      ...BONE_DENSITY_RESPONSE,
      total: {
        ...BONE_DENSITY_RESPONSE.total,
        age_sex_z_percentile: null,
        peak_sex_t_percentile: null,
      },
    };
    const result = parseBoneDensity(response);
    expect(result.boneDensityTPercentile).toBeNull();
    expect(result.boneDensityZPercentile).toBeNull();
  });
});

describe("parseVisceralFat", () => {
  it("extracts visceral fat fields", () => {
    const result = parseVisceralFat(VISCERAL_FAT_RESPONSE);
    expect(result.visceralFatMassKg).toBe(0.45);
    expect(result.visceralFatVolumeCm3).toBe(480.2);
  });
});

describe("parseRmr", () => {
  it("extracts primary RMR estimate and all raw estimates", () => {
    const result = parseRmr(RMR_RESPONSE);
    expect(result.restingMetabolicRateKcal).toBe(1720);
    expect(result.restingMetabolicRateRaw).toEqual(RMR_RESPONSE.estimates);
  });

  it("uses first estimate when ten Haaf is not present", () => {
    const response: BodySpecRmrResponse = {
      ...RMR_RESPONSE,
      estimates: [{ formula: "Custom (2024)", kcal_per_day: 1800 }],
    };
    const result = parseRmr(response);
    expect(result.restingMetabolicRateKcal).toBe(1800);
  });

  it("returns null when no estimates available", () => {
    const response: BodySpecRmrResponse = {
      ...RMR_RESPONSE,
      estimates: [],
    };
    const result = parseRmr(response);
    expect(result.restingMetabolicRateKcal).toBeNull();
  });
});

describe("parsePercentiles", () => {
  it("returns the full percentiles object", () => {
    const result = parsePercentiles(PERCENTILES_RESPONSE);
    expect(result).toEqual({
      params: PERCENTILES_RESPONSE.params,
      metrics: PERCENTILES_RESPONSE.metrics,
    });
  });
});

describe("parseScanInfo", () => {
  it("extracts scan metadata and patient intake", () => {
    const result = parseScanInfo(SCAN_INFO_RESPONSE);
    expect(result.scannerModel).toBe("GE Lunar iDXA");
    expect(result.recordedAt).toEqual(new Date("2025-06-15T10:30:00Z"));
    expect(result.heightInches).toBe(70.5);
    expect(result.weightPounds).toBe(163.4);
  });
});

// ============================================================
// Provider validation tests
// ============================================================

describe("BodySpecProvider", () => {
  describe("validate", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("returns error when BODYSPEC_CLIENT_ID is missing", () => {
      delete process.env.BODYSPEC_CLIENT_ID;
      delete process.env.BODYSPEC_CLIENT_SECRET;
      const provider = new BodySpecProvider();
      expect(provider.validate()).toBe("BODYSPEC_CLIENT_ID is not set");
    });

    it("returns error when BODYSPEC_CLIENT_SECRET is missing", () => {
      process.env.BODYSPEC_CLIENT_ID = "test-id";
      delete process.env.BODYSPEC_CLIENT_SECRET;
      const provider = new BodySpecProvider();
      expect(provider.validate()).toBe("BODYSPEC_CLIENT_SECRET is not set");
    });

    it("returns null when both env vars are set", () => {
      process.env.BODYSPEC_CLIENT_ID = "test-id";
      process.env.BODYSPEC_CLIENT_SECRET = "test-secret";
      const provider = new BodySpecProvider();
      expect(provider.validate()).toBeNull();
    });
  });

  describe("properties", () => {
    it("has correct id and name", () => {
      const provider = new BodySpecProvider();
      expect(provider.id).toBe("bodyspec");
      expect(provider.name).toBe("BodySpec");
    });
  });

  describe("catchNotFound", () => {
    it("returns the resolved value for successful promises", async () => {
      const result = await catchNotFound(Promise.resolve("hello"));
      expect(result).toBe("hello");
    });

    it("returns null for 404 errors", async () => {
      const result = await catchNotFound(
        Promise.reject(new Error("BodySpec API error (404): Not Found")),
      );
      expect(result).toBeNull();
    });

    it("rethrows non-404 errors", async () => {
      await expect(
        catchNotFound(Promise.reject(new Error("BodySpec API error (500): Internal Server Error"))),
      ).rejects.toThrow("BodySpec API error (500): Internal Server Error");
    });

    it("rethrows network errors", async () => {
      await expect(catchNotFound(Promise.reject(new Error("fetch failed")))).rejects.toThrow(
        "fetch failed",
      );
    });
  });
});
