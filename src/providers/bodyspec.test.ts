import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BodySpecBoneDensityResponse,
  type BodySpecCompositionResponse,
  type BodySpecPercentilesResponse,
  BodySpecProvider,
  type BodySpecScanInfoResponse,
  type BodySpecVisceralFatResponse,
  catchNotFound,
  parseBoneDensity,
  parseComposition,
  parsePercentiles,
  parseRegions,
  parseScanInfo,
  parseVisceralFat,
} from "./bodyspec.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

// ============================================================
// Mocks for unit-testing sync orchestration
// ============================================================

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: vi.fn(),
  loadTokens: vi.fn(),
  saveTokens: vi.fn(),
}));

vi.mock("../db/sync-log.ts", () => ({
  PartialSyncError: class PartialSyncError extends Error {
    readonly recordCount: number;
    override readonly cause: unknown;

    constructor(message: string, recordCount: number, cause: unknown) {
      super(message);
      this.name = "PartialSyncError";
      this.recordCount = recordCount;
      this.cause = cause;
    }
  },
  withSyncLog: vi.fn(
    async (
      _db: unknown,
      _providerId: string,
      _dataType: string,
      fn: () => Promise<{ recordCount: number; result: number; degradations?: unknown[] }>,
    ) => {
      const { result } = await fn();
      return result;
    },
  ),
}));

vi.mock("../auth/oauth.ts", () => ({
  getOAuthRedirectUri: vi.fn(() => "http://localhost/callback"),
  exchangeCodeForTokens: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

// We need to mock the Drizzle schema imports so they don't pull in the real DB
vi.mock("../db/schema/events.ts", () => ({
  dexaScan: {
    providerId: "provider_id",
    externalId: "external_id",
    id: "id",
  },
  dexaScanRegion: {
    scanId: "scan_id",
    region: "region",
  },
}));

import { exchangeCodeForTokens, refreshAccessToken } from "../auth/oauth.ts";
import type { SyncDatabase } from "../db/index.ts";
import { loadTokens, saveTokens } from "../db/tokens.ts";
import { ProviderAuthenticationFailedError } from "./auth-errors.ts";

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

    it("is available without deployment OAuth credentials", () => {
      delete process.env.BODYSPEC_CLIENT_ID;
      delete process.env.BODYSPEC_CLIENT_SECRET;
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
        Promise.reject(new Error("API error 404 on /test: Not Found")),
      );
      expect(result).toBeNull();
    });

    it("rethrows non-404 errors", async () => {
      await expect(
        catchNotFound(Promise.reject(new Error("API error 500 on /test: Internal Server Error"))),
      ).rejects.toThrow("500");
    });

    it("rethrows network errors", async () => {
      await expect(catchNotFound(Promise.reject(new Error("fetch failed")))).rejects.toThrow(
        "fetch failed",
      );
    });
  });

  describe("authSetup", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it("uses BodySpec's public PKCE client and current Keycloak endpoints", () => {
      delete process.env.BODYSPEC_CLIENT_ID;
      delete process.env.BODYSPEC_CLIENT_SECRET;
      const provider = new BodySpecProvider();
      const setup = provider.authSetup();

      expect(setup).toBeDefined();
      expect(setup?.oauthConfig).toMatchObject({
        clientId: "bodyspec-api-ext-v1",
        authorizeUrl: "https://auth.bodyspec.com/realms/bodyspec/protocol/openid-connect/auth",
        tokenUrl: "https://auth.bodyspec.com/realms/bodyspec/protocol/openid-connect/token",
        scopes: ["openid", "profile", "email"],
        usePkce: true,
      });
      expect(setup?.oauthConfig?.clientSecret).toBeUndefined();
    });

    it("exchanges the callback code with the stored PKCE verifier", async () => {
      vi.mocked(exchangeCodeForTokens).mockResolvedValueOnce({
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: new Date("2026-08-01T00:00:00Z"),
        scopes: "openid profile email",
      });
      const provider = new BodySpecProvider();
      const setup = provider.authSetup();

      await setup?.exchangeCode?.("authorization-code", "stored-verifier");

      expect(exchangeCodeForTokens).toHaveBeenCalledWith(
        setup?.oauthConfig,
        "authorization-code",
        expect.any(Function),
        { codeVerifier: "stored-verifier" },
      );
      expect(setup?.apiBaseUrl).toBe("https://app.bodyspec.com");
    });

    it("fails loudly when the callback has no PKCE verifier", async () => {
      const setup = new BodySpecProvider().authSetup();

      await expect(setup?.exchangeCode?.("authorization-code")).rejects.toThrow(
        "BodySpec PKCE verifier is missing",
      );
    });
  });

  describe("sync", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      vi.clearAllMocks();
      process.env = {
        ...originalEnv,
        BODYSPEC_CLIENT_ID: "test-id",
        BODYSPEC_CLIENT_SECRET: "test-secret",
      };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    function mockDb(): SyncDatabase {
      const returningFn = vi.fn().mockResolvedValue([{ id: "scan-uuid-1" }]);
      const onConflictDoUpdateFn = vi.fn().mockReturnValue({ returning: returningFn });
      const valuesFn = vi.fn().mockReturnValue({ onConflictDoUpdate: onConflictDoUpdateFn });
      const insertFn = vi.fn().mockReturnValue({ values: valuesFn });
      return { insert: insertFn, select: vi.fn(), delete: vi.fn(), execute: vi.fn() };
    }

    function jsonResponse(body: unknown, status = 200): Response {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }

    function errorResponse(status: number, text = "Error"): Response {
      return new Response(text, { status });
    }

    it("returns error when no tokens exist", async () => {
      vi.mocked(loadTokens).mockResolvedValue(null);
      const provider = new BodySpecProvider();
      const result = await provider.sync(
        new SyncRun({
          db: mockDb(),
          window: SyncWindow.fromSince({ since: new Date("2025-01-01") }),
        }),
      );
      expect(result.provider).toBe("bodyspec");
      expect(result.recordsSynced).toBe(0);
      expect(result.errors).toHaveLength(1);
      const err = result.errors[0];
      expect(err).toBeDefined();
      if (!err) return;
      expect(err.message).toContain("No OAuth tokens found");
    });

    it("refreshes expired tokens and saves them", async () => {
      delete process.env.BODYSPEC_CLIENT_ID;
      delete process.env.BODYSPEC_CLIENT_SECRET;
      const expiredTokens = {
        accessToken: "expired",
        refreshToken: "refresh-token",
        expiresAt: new Date("2020-01-01"),
        scopes: "read:results",
      };
      const refreshedTokens = {
        accessToken: "new-token",
        refreshToken: "new-refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      };
      vi.mocked(loadTokens).mockResolvedValue(expiredTokens);
      vi.mocked(refreshAccessToken).mockResolvedValue(refreshedTokens);

      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          results: [],
          pagination: { page: 1, page_size: 100, results: 0, has_more: false },
        }),
      );
      const provider = new BodySpecProvider(fetchFn);
      const result = await provider.sync(
        new SyncRun({
          db: mockDb(),
          window: SyncWindow.fromSince({ since: new Date("2025-01-01") }),
        }),
      );

      expect(refreshAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: "bodyspec-api-ext-v1",
          tokenUrl: "https://auth.bodyspec.com/realms/bodyspec/protocol/openid-connect/token",
        }),
        "refresh-token",
        expect.any(Function),
      );
      expect(saveTokens).toHaveBeenCalled();
      expect(result.errors).toHaveLength(0);
    });

    it("syncs a single result successfully", async () => {
      const validTokens = {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      };
      vi.mocked(loadTokens).mockResolvedValue(validTokens);

      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/results/?")) {
          return Promise.resolve(
            jsonResponse({
              results: [{ result_id: "r1", start_time: "2025-06-15T10:00:00Z" }],
              pagination: { page: 1, page_size: 100, results: 1, has_more: false },
            }),
          );
        }
        if (url.includes("/scan-info")) {
          return Promise.resolve(jsonResponse(SCAN_INFO_RESPONSE));
        }
        if (url.includes("/composition")) {
          return Promise.resolve(jsonResponse(COMPOSITION_RESPONSE));
        }
        if (url.includes("/bone-density")) {
          return Promise.resolve(jsonResponse(BONE_DENSITY_RESPONSE));
        }
        if (url.includes("/visceral-fat")) {
          return Promise.resolve(jsonResponse(VISCERAL_FAT_RESPONSE));
        }
        if (url.includes("/percentiles")) {
          return Promise.resolve(jsonResponse(PERCENTILES_RESPONSE));
        }
        return Promise.resolve(errorResponse(404, "Not Found"));
      });

      const db = mockDb();
      const provider = new BodySpecProvider(fetchFn);
      const result = await provider.sync(
        new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2025-01-01") }) }),
      );

      expect(result.provider).toBe("bodyspec");
      expect(result.recordsSynced).toBe(1);
      expect(result.errors).toHaveLength(0);
      // Verify DB inserts were called
      expect(db.insert).toHaveBeenCalled();
    });

    it("skips results older than since date", async () => {
      const validTokens = {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      };
      vi.mocked(loadTokens).mockResolvedValue(validTokens);

      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          results: [{ result_id: "r1", start_time: "2024-01-01T10:00:00Z" }],
          pagination: { page: 1, page_size: 100, results: 1, has_more: false },
        }),
      );

      const provider = new BodySpecProvider(fetchFn);
      const result = await provider.sync(
        new SyncRun({
          db: mockDb(),
          window: SyncWindow.fromSince({ since: new Date("2025-06-01") }),
        }),
      );

      expect(result.recordsSynced).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("syncs results at the window start and skips results before it", async () => {
      const validTokens = {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      };
      vi.mocked(loadTokens).mockResolvedValue(validTokens);

      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/results/?")) {
          return Promise.resolve(
            jsonResponse({
              results: [
                { result_id: "before-start", start_time: "2025-06-01T09:59:59.999Z" },
                { result_id: "at-start", start_time: "2025-06-01T10:00:00.000Z" },
              ],
              pagination: { page: 1, page_size: 100, results: 2, has_more: false },
            }),
          );
        }
        if (url.includes("at-start")) {
          if (url.includes("/scan-info")) return Promise.resolve(jsonResponse(SCAN_INFO_RESPONSE));
          if (url.includes("/composition"))
            return Promise.resolve(jsonResponse(COMPOSITION_RESPONSE));
          if (url.includes("/bone-density")) {
            return Promise.resolve(jsonResponse(BONE_DENSITY_RESPONSE));
          }
          if (url.includes("/visceral-fat")) {
            return Promise.resolve(jsonResponse(VISCERAL_FAT_RESPONSE));
          }
          if (url.includes("/percentiles")) {
            return Promise.resolve(jsonResponse(PERCENTILES_RESPONSE));
          }
        }
        return Promise.resolve(errorResponse(404, "Not Found"));
      });

      const provider = new BodySpecProvider(fetchFn);
      const result = await provider.sync(
        new SyncRun({
          db: mockDb(),
          window: new SyncWindow({
            since: new Date("2025-06-01T10:00:00.000Z"),
            until: new Date("2025-06-15T10:00:00.000Z"),
          }),
        }),
      );

      expect(result.recordsSynced).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(fetchFn).not.toHaveBeenCalledWith(
        expect.stringContaining("before-start"),
        expect.anything(),
      );
    });

    it("syncs results at the window end and skips results after it", async () => {
      const validTokens = {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      };
      vi.mocked(loadTokens).mockResolvedValue(validTokens);

      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/results/?")) {
          return Promise.resolve(
            jsonResponse({
              results: [
                { result_id: "at-end", start_time: "2025-06-15T10:00:00.000Z" },
                { result_id: "after-end", start_time: "2025-06-15T10:00:00.001Z" },
              ],
              pagination: { page: 1, page_size: 100, results: 2, has_more: false },
            }),
          );
        }
        if (url.includes("at-end")) {
          if (url.includes("/scan-info")) return Promise.resolve(jsonResponse(SCAN_INFO_RESPONSE));
          if (url.includes("/composition"))
            return Promise.resolve(jsonResponse(COMPOSITION_RESPONSE));
          if (url.includes("/bone-density")) {
            return Promise.resolve(jsonResponse(BONE_DENSITY_RESPONSE));
          }
          if (url.includes("/visceral-fat")) {
            return Promise.resolve(jsonResponse(VISCERAL_FAT_RESPONSE));
          }
          if (url.includes("/percentiles")) {
            return Promise.resolve(jsonResponse(PERCENTILES_RESPONSE));
          }
        }
        return Promise.resolve(errorResponse(404, "Not Found"));
      });

      const db = mockDb();
      const provider = new BodySpecProvider(fetchFn);
      const result = await provider.sync(
        new SyncRun({
          db,
          window: new SyncWindow({
            since: new Date("2025-06-01T00:00:00.000Z"),
            until: new Date("2025-06-15T10:00:00.000Z"),
          }),
        }),
      );

      expect(result.recordsSynced).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(fetchFn).not.toHaveBeenCalledWith(
        expect.stringContaining("after-end"),
        expect.anything(),
      );
    });

    it("handles missing composition (returns 0 records)", async () => {
      const validTokens = {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      };
      vi.mocked(loadTokens).mockResolvedValue(validTokens);

      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/results/?")) {
          return Promise.resolve(
            jsonResponse({
              results: [{ result_id: "r1", start_time: "2025-06-15T10:00:00Z" }],
              pagination: { page: 1, page_size: 100, results: 1, has_more: false },
            }),
          );
        }
        // All section endpoints return 404
        return Promise.resolve(errorResponse(404, "Not Found"));
      });

      const provider = new BodySpecProvider(fetchFn);
      const result = await provider.sync(
        new SyncRun({
          db: mockDb(),
          window: SyncWindow.fromSince({ since: new Date("2025-01-01") }),
        }),
      );

      expect(result.recordsSynced).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("handles per-result API errors gracefully", async () => {
      const validTokens = {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      };
      vi.mocked(loadTokens).mockResolvedValue(validTokens);

      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/results/?")) {
          return Promise.resolve(
            jsonResponse({
              results: [{ result_id: "r1", start_time: "2025-06-15T10:00:00Z" }],
              pagination: { page: 1, page_size: 100, results: 1, has_more: false },
            }),
          );
        }
        // composition returns 500 — non-404 error propagates
        if (url.includes("/composition")) {
          return Promise.resolve(errorResponse(500, "Internal Server Error"));
        }
        return Promise.resolve(errorResponse(404, "Not Found"));
      });

      const provider = new BodySpecProvider(fetchFn);
      const result = await provider.sync(
        new SyncRun({
          db: mockDb(),
          window: SyncWindow.fromSince({ since: new Date("2025-01-01") }),
        }),
      );

      expect(result.recordsSynced).toBe(0);
      expect(result.errors).toHaveLength(1);
      const err = result.errors[0];
      expect(err).toBeDefined();
      if (!err) return;
      expect(err.message).toContain("500");
      expect(err.externalId).toBe("r1");
    });

    it("paginates through multiple pages of results", async () => {
      const validTokens = {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      };
      vi.mocked(loadTokens).mockResolvedValue(validTokens);

      let listCallCount = 0;
      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/results/?")) {
          listCallCount++;
          if (listCallCount === 1) {
            return Promise.resolve(
              jsonResponse({
                results: [{ result_id: "r1", start_time: "2025-06-15T10:00:00Z" }],
                pagination: { page: 1, page_size: 1, results: 2, has_more: true },
              }),
            );
          }
          return Promise.resolve(
            jsonResponse({
              results: [{ result_id: "r2", start_time: "2025-06-16T10:00:00Z" }],
              pagination: { page: 2, page_size: 1, results: 2, has_more: false },
            }),
          );
        }
        if (url.includes("/composition")) {
          return Promise.resolve(jsonResponse(COMPOSITION_RESPONSE));
        }
        if (url.includes("/scan-info")) {
          return Promise.resolve(jsonResponse(SCAN_INFO_RESPONSE));
        }
        return Promise.resolve(errorResponse(404, "Not Found"));
      });

      const provider = new BodySpecProvider(fetchFn);
      const result = await provider.sync(
        new SyncRun({
          db: mockDb(),
          window: SyncWindow.fromSince({ since: new Date("2025-01-01") }),
        }),
      );

      expect(result.recordsSynced).toBe(2);
      expect(listCallCount).toBe(2);
    });

    it("syncs already fetched results before a later page request fails", async () => {
      const validTokens = {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      };
      vi.mocked(loadTokens).mockResolvedValue(validTokens);

      let listCallCount = 0;
      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/results/?")) {
          listCallCount++;
          if (listCallCount === 1) {
            return Promise.resolve(
              jsonResponse({
                results: [{ result_id: "r1", start_time: "2025-06-15T10:00:00Z" }],
                pagination: { page: 1, page_size: 1, results: 2, has_more: true },
              }),
            );
          }
          return Promise.resolve(errorResponse(500, "Internal Server Error"));
        }
        if (url.includes("/composition")) {
          return Promise.resolve(jsonResponse(COMPOSITION_RESPONSE));
        }
        if (url.includes("/scan-info")) {
          return Promise.resolve(jsonResponse(SCAN_INFO_RESPONSE));
        }
        return Promise.resolve(errorResponse(404, "Not Found"));
      });

      const provider = new BodySpecProvider(fetchFn);
      const result = await provider.sync(
        new SyncRun({
          db: mockDb(),
          window: SyncWindow.fromSince({ since: new Date("2025-01-01") }),
        }),
      );

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.message).toContain("API error 500");
      expect(result.recordsSynced).toBe(1);
      expect(listCallCount).toBe(2);
      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining("/results/r1/dexa/composition"),
        expect.any(Object),
      );
    });

    it("reports degraded pagination when an empty results page still has more results", async () => {
      const validTokens = {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      };
      vi.mocked(loadTokens).mockResolvedValue(validTokens);

      let listCallCount = 0;
      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/results/?")) {
          listCallCount++;
          return Promise.resolve(
            jsonResponse({
              results: [],
              pagination: {
                page: listCallCount,
                page_size: 100,
                results: 101,
                has_more: listCallCount === 1,
              },
            }),
          );
        }
        return Promise.resolve(errorResponse(404, "Not Found"));
      });

      const provider = new BodySpecProvider(fetchFn);
      const result = await provider.sync(
        new SyncRun({
          db: mockDb(),
          window: SyncWindow.fromSince({ since: new Date("2025-01-01") }),
        }),
      );

      expect(result.recordsSynced).toBe(0);
      expect(result.degradations?.[0]?.kind).toBe("pagination_empty_page_with_cursor");
      expect(listCallCount).toBe(1);
    });

    it("reports max-page degradation at the exact page guard", async () => {
      const validTokens = {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      };
      vi.mocked(loadTokens).mockResolvedValue(validTokens);

      let listCallCount = 0;
      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/results/?")) {
          listCallCount++;
          if (listCallCount > 100) {
            return Promise.resolve(
              jsonResponse({
                results: [],
                pagination: {
                  page: listCallCount,
                  page_size: 1,
                  results: 100,
                  has_more: false,
                },
              }),
            );
          }
          return Promise.resolve(
            jsonResponse({
              results: [
                {
                  result_id: `guard-${listCallCount}`,
                  start_time: "2025-06-15T10:00:00Z",
                },
              ],
              pagination: {
                page: listCallCount,
                page_size: 1,
                results: 101,
                has_more: true,
              },
            }),
          );
        }
        if (url.includes("/composition")) {
          return Promise.resolve(jsonResponse(COMPOSITION_RESPONSE));
        }
        if (url.includes("/scan-info")) {
          return Promise.resolve(jsonResponse(SCAN_INFO_RESPONSE));
        }
        return Promise.resolve(errorResponse(404, "Not Found"));
      });

      const provider = new BodySpecProvider(fetchFn);
      const result = await provider.sync(
        new SyncRun({
          db: mockDb(),
          window: SyncWindow.fromSince({ since: new Date("2025-01-01") }),
        }),
      );

      expect(result.recordsSynced).toBe(100);
      expect(result.degradations?.[0]?.kind).toBe("pagination_max_pages_exceeded");
      expect(listCallCount).toBe(100);
    });

    it("syncs with only composition (optional endpoints 404)", async () => {
      const validTokens = {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      };
      vi.mocked(loadTokens).mockResolvedValue(validTokens);

      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/results/?")) {
          return Promise.resolve(
            jsonResponse({
              results: [{ result_id: "r1", start_time: "2025-06-15T10:00:00Z" }],
              pagination: { page: 1, page_size: 100, results: 1, has_more: false },
            }),
          );
        }
        if (url.includes("/composition")) {
          return Promise.resolve(jsonResponse(COMPOSITION_RESPONSE));
        }
        // Everything else is 404
        return Promise.resolve(errorResponse(404, "Not Found"));
      });

      const db = mockDb();
      const provider = new BodySpecProvider(fetchFn);
      const result = await provider.sync(
        new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2025-01-01") }) }),
      );

      expect(result.recordsSynced).toBe(1);
      expect(result.errors).toHaveLength(0);
      // Verify scan insert was called
      expect(db.insert).toHaveBeenCalled();
    });

    it("handles DB insert returning empty (no inserted row)", async () => {
      const validTokens = {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      };
      vi.mocked(loadTokens).mockResolvedValue(validTokens);

      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/results/?")) {
          return Promise.resolve(
            jsonResponse({
              results: [{ result_id: "r1", start_time: "2025-06-15T10:00:00Z" }],
              pagination: { page: 1, page_size: 100, results: 1, has_more: false },
            }),
          );
        }
        if (url.includes("/composition")) {
          return Promise.resolve(jsonResponse(COMPOSITION_RESPONSE));
        }
        return Promise.resolve(errorResponse(404, "Not Found"));
      });

      // DB returns empty array from returning()
      const returningFn = vi.fn().mockResolvedValue([]);
      const onConflictDoUpdateFn = vi.fn().mockReturnValue({ returning: returningFn });
      const valuesFn = vi.fn().mockReturnValue({ onConflictDoUpdate: onConflictDoUpdateFn });
      const insertFn = vi.fn().mockReturnValue({ values: valuesFn });
      const db: SyncDatabase = {
        insert: insertFn,
        select: vi.fn(),
        delete: vi.fn(),
        execute: vi.fn(),
      };

      const provider = new BodySpecProvider(fetchFn);
      const result = await provider.sync(
        new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2025-01-01") }) }),
      );

      expect(result.recordsSynced).toBe(0);
    });

    it("handles token refresh failure when no refresh token", async () => {
      const expiredTokens = {
        accessToken: "expired",
        refreshToken: null,
        expiresAt: new Date("2020-01-01"),
        scopes: "read:results",
      };
      vi.mocked(loadTokens).mockResolvedValue(expiredTokens);

      const provider = new BodySpecProvider();
      const result = await provider.sync(
        new SyncRun({
          db: mockDb(),
          window: SyncWindow.fromSince({ since: new Date("2025-01-01") }),
        }),
      );

      expect(result.errors).toHaveLength(1);
      const err = result.errors[0];
      expect(err).toBeDefined();
      if (!err) return;
      expect(err.message).toContain("No refresh token");
    });

    it("returns correct duration in result", async () => {
      vi.mocked(loadTokens).mockResolvedValue(null);
      const provider = new BodySpecProvider();
      const result = await provider.sync(
        new SyncRun({
          db: mockDb(),
          window: SyncWindow.fromSince({ since: new Date("2025-01-01") }),
        }),
      );
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it("includes fetch URL with correct auth header", async () => {
      const validTokens = {
        accessToken: "my-secret-token",
        refreshToken: "refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      };
      vi.mocked(loadTokens).mockResolvedValue(validTokens);

      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          results: [],
          pagination: { page: 1, page_size: 100, results: 0, has_more: false },
        }),
      );

      const provider = new BodySpecProvider(fetchFn);
      await provider.sync(
        new SyncRun({
          db: mockDb(),
          window: SyncWindow.fromSince({ since: new Date("2025-01-01") }),
        }),
      );

      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining("https://app.bodyspec.com/api/v1/users/me/results/"),
        expect.objectContaining({
          headers: { Authorization: "Bearer my-secret-token" },
        }),
      );
    });

    it.each([
      401, 403,
    ])("classifies a %i data response as a redacted authentication failure", async (status) => {
      vi.mocked(loadTokens).mockResolvedValue({
        accessToken: "revoked-token",
        refreshToken: "refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      });
      const response = errorResponse(status, "upstream-secret-response");
      const provider = new BodySpecProvider(vi.fn().mockResolvedValue(response));

      const result = await provider.sync(
        new SyncRun({
          db: mockDb(),
          window: SyncWindow.fromSince({ since: new Date("2025-01-01") }),
        }),
      );

      expect(result.errors).toHaveLength(1);
      const error = result.errors[0];
      expect(error?.cause).toBeInstanceOf(ProviderAuthenticationFailedError);
      expect(error?.message).not.toContain("upstream-secret-response");
      expect(response.bodyUsed).toBe(false);
    });

    it("truncates long error response bodies", async () => {
      const validTokens = {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      };
      vi.mocked(loadTokens).mockResolvedValue(validTokens);

      const longBody = "x".repeat(500);
      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/results/?")) {
          return Promise.resolve(
            jsonResponse({
              results: [{ result_id: "r1", start_time: "2025-06-15T10:00:00Z" }],
              pagination: { page: 1, page_size: 100, results: 1, has_more: false },
            }),
          );
        }
        // All endpoints return error with long body
        return Promise.resolve(new Response(longBody, { status: 500 }));
      });

      const provider = new BodySpecProvider(fetchFn);
      const result = await provider.sync(
        new SyncRun({
          db: mockDb(),
          window: SyncWindow.fromSince({ since: new Date("2025-01-01") }),
        }),
      );

      expect(result.errors).toHaveLength(1);
      const err = result.errors[0];
      expect(err).toBeDefined();
      if (!err) return;
      // Error message should be truncated
      expect(err.message.length).toBeLessThan(400);
    });
  });

  describe("rate-limit aware fetch wiring", () => {
    const originalEnv = process.env;

    beforeEach(() => {
      vi.clearAllMocks();
      process.env = {
        ...originalEnv,
        BODYSPEC_CLIENT_ID: "test-id",
        BODYSPEC_CLIENT_SECRET: "test-secret",
      };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    function mockDb(): SyncDatabase {
      const insertFn = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "scan-uuid-1" }]),
          }),
        }),
      });
      return { insert: insertFn, select: vi.fn(), delete: vi.fn(), execute: vi.fn() };
    }

    it("surfaces a 429 as a ProviderRateLimitError tagged with providerId 'bodyspec'", async () => {
      vi.mocked(loadTokens).mockResolvedValue({
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date("2030-01-01"),
        scopes: "read:results",
      });

      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } }),
        );

      const provider = new BodySpecProvider(fetchFn);
      const result = await provider.sync(
        new SyncRun({
          db: mockDb(),
          window: SyncWindow.fromSince({ since: new Date("2025-01-01") }),
        }),
      );

      expect(result.errors).toHaveLength(1);
      const cause = result.errors[0]?.cause;
      expect(cause).toBeInstanceOf(ProviderRateLimitError);
      if (cause instanceof ProviderRateLimitError) {
        expect(cause.providerId).toBe("bodyspec");
        expect(cause.statusCode).toBe(429);
      }
    });
  });
});
