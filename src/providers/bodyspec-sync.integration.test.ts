import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dexaScan, dexaScanRegion } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { saveTokens } from "../db/tokens.ts";
import { BodySpecProvider } from "./bodyspec.ts";

// ============================================================
// Fake BodySpec API responses
// ============================================================

const fakeResult = {
  result_id: "result-1",
  start_time: "2026-03-01T10:00:00Z",
  location: { name: "BodySpec SF" },
  service: { name: "DEXA Scan" },
  create_time: "2026-03-01T10:00:00Z",
};

const fakeScanInfo = {
  result_id: "result-1",
  section_name: "scan-info" as const,
  scanner_model: "GE Lunar iDXA",
  acquire_time: "2026-03-01T10:00:00Z",
  analyze_time: "2026-03-01T10:05:00Z",
  patient_intake: {
    height_inches: 70.5,
    weight_pounds: 165,
    birth_date: "1990-03-15",
    gender: "male",
    ethnicity: "white",
  },
};

const fakeComposition = {
  result_id: "result-1",
  section_name: "composition" as const,
  total: {
    fat_mass_kg: 15.2,
    lean_mass_kg: 55.8,
    bone_mass_kg: 3.1,
    total_mass_kg: 74.1,
    tissue_fat_pct: 20.5,
    region_fat_pct: 100,
  },
  regions: {
    left_arm: {
      fat_mass_kg: 1.1,
      lean_mass_kg: 3.2,
      bone_mass_kg: 0.2,
      total_mass_kg: 4.5,
      tissue_fat_pct: 24.4,
      region_fat_pct: 7.2,
    },
    right_arm: {
      fat_mass_kg: 1.0,
      lean_mass_kg: 3.4,
      bone_mass_kg: 0.2,
      total_mass_kg: 4.6,
      tissue_fat_pct: 21.7,
      region_fat_pct: 6.6,
    },
    trunk: {
      fat_mass_kg: 7.5,
      lean_mass_kg: 26.1,
      bone_mass_kg: 0.8,
      total_mass_kg: 34.4,
      tissue_fat_pct: 21.8,
      region_fat_pct: 49.3,
    },
    left_leg: {
      fat_mass_kg: 2.5,
      lean_mass_kg: 9.2,
      bone_mass_kg: 0.6,
      total_mass_kg: 12.3,
      tissue_fat_pct: 20.3,
      region_fat_pct: 16.4,
    },
    right_leg: {
      fat_mass_kg: 2.4,
      lean_mass_kg: 9.5,
      bone_mass_kg: 0.6,
      total_mass_kg: 12.5,
      tissue_fat_pct: 19.2,
      region_fat_pct: 15.8,
    },
    android: {
      fat_mass_kg: 1.8,
      lean_mass_kg: 4.1,
      bone_mass_kg: 0.1,
      total_mass_kg: 6.0,
      tissue_fat_pct: 30.0,
      region_fat_pct: 11.8,
    },
    gynoid: {
      fat_mass_kg: 2.9,
      lean_mass_kg: 7.8,
      bone_mass_kg: 0.3,
      total_mass_kg: 11.0,
      tissue_fat_pct: 26.4,
      region_fat_pct: 19.1,
    },
  },
  android_gynoid_ratio: 0.62,
};

const fakeBoneDensity = {
  result_id: "result-1",
  section_name: "bone-density" as const,
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

const fakeVisceralFat = {
  result_id: "result-1",
  section_name: "visceral-fat" as const,
  vat_mass_kg: 0.45,
  vat_volume_cm3: 480.2,
};

const fakeRmr = {
  result_id: "result-1",
  section_name: "rmr" as const,
  estimates: [
    { formula: "ten Haaf (2014)", kcal_per_day: 1720 },
    { formula: "Cunningham (1980)", kcal_per_day: 1680 },
  ],
};

function bodyspecHandlers(opts?: { apiError?: boolean }) {
  return [
    // Token refresh
    http.post("https://app.bodyspec.com/oauth/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 7200,
        scope: "read:results",
      });
    }),

    // Results list
    http.get("https://app.bodyspec.com/api/v1/users/me/results/", () => {
      if (opts?.apiError) {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }
      return HttpResponse.json({
        results: [fakeResult],
        pagination: { page: 1, page_size: 100, results: 1, has_more: false },
      });
    }),

    // Scan info
    http.get("https://app.bodyspec.com/api/v1/users/me/results/result-1/dexa/scan-info", () => {
      return HttpResponse.json(fakeScanInfo);
    }),

    // Composition
    http.get(
      "https://app.bodyspec.com/api/v1/users/me/results/result-1/dexa/composition",
      () => {
        return HttpResponse.json(fakeComposition);
      },
    ),

    // Bone density
    http.get(
      "https://app.bodyspec.com/api/v1/users/me/results/result-1/dexa/bone-density",
      () => {
        return HttpResponse.json(fakeBoneDensity);
      },
    ),

    // Visceral fat
    http.get(
      "https://app.bodyspec.com/api/v1/users/me/results/result-1/dexa/visceral-fat",
      () => {
        return HttpResponse.json(fakeVisceralFat);
      },
    ),

    // RMR
    http.get("https://app.bodyspec.com/api/v1/users/me/results/result-1/dexa/rmr", () => {
      return HttpResponse.json(fakeRmr);
    }),

    // Percentiles (404 is ok, optional endpoint)
    http.get(
      "https://app.bodyspec.com/api/v1/users/me/results/result-1/dexa/percentiles",
      () => {
        return new HttpResponse(null, { status: 404 });
      },
    ),
  ];
}

// ============================================================
// Tests
// ============================================================

describe("BodySpecProvider.sync() (integration)", () => {
  let ctx: TestContext;
  let server: ReturnType<typeof setupServer>;

  beforeAll(() => {
    server = setupServer(...bodyspecHandlers());
    server.listen();
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(async () => {
    ctx = await setupTestDatabase();
  });

  it("syncs DEXA scan results with regions", async () => {
    const provider = new BodySpecProvider();

    // Set up auth token
    await saveTokens(ctx.db, "bodyspec", {
      accessToken: "test-token",
      refreshToken: "test-refresh",
      expiresAt: new Date(Date.now() + 7200000),
      scopes: "read:results",
    });

    // Sync
    const result = await provider.sync(ctx.db, new Date("2026-02-01"));

    expect(result.provider).toBe("bodyspec");
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify scan was stored
    const scans = await ctx.db.select().from(dexaScan);
    expect(scans).toHaveLength(1);
    const scan = scans[0];
    expect(scan.externalId).toBe("result-1");
    expect(scan.totalFatMassKg).toBe(15.2);
    expect(scan.totalLeanMassKg).toBe(55.8);
    expect(scan.androidGynoidRatio).toBe(0.62);
    expect(scan.visceralFatMassKg).toBe(0.45);
    expect(scan.totalBoneMineralDensity).toBe(1.25);
    expect(scan.restingMetabolicRateKcal).toBe(1720);

    // Verify regions were stored
    const regions = await ctx.db.select().from(dexaScanRegion);
    expect(regions).toHaveLength(7);
    const leftArm = regions.find((r) => r.region === "left_arm");
    expect(leftArm).toBeDefined();
    expect(leftArm?.fatMassKg).toBe(1.1);
    expect(leftArm?.boneMineralDensity).toBe(0.85);
  });

  it("handles API errors gracefully", async () => {
    server.use(...bodyspecHandlers({ apiError: true }));

    const provider = new BodySpecProvider();

    await saveTokens(ctx.db, "bodyspec", {
      accessToken: "test-token",
      refreshToken: "test-refresh",
      expiresAt: new Date(Date.now() + 7200000),
      scopes: "read:results",
    });

    const result = await provider.sync(ctx.db, new Date("2026-02-01"));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("skips scans before the since date", async () => {
    const provider = new BodySpecProvider();

    await saveTokens(ctx.db, "bodyspec", {
      accessToken: "test-token",
      refreshToken: "test-refresh",
      expiresAt: new Date(Date.now() + 7200000),
      scopes: "read:results",
    });

    const result = await provider.sync(ctx.db, new Date("2026-04-01"));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});
