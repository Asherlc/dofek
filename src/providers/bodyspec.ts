import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri, refreshAccessToken } from "../auth/oauth.ts";
import type { SyncDatabase } from "../db/index.ts";
import { dexaScan, dexaScanRegion } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { logger } from "../logger.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// BodySpec API types & Zod schemas
// ============================================================

const BODYSPEC_API_BASE = "https://app.bodyspec.com";

const bodyRegionSchema = z.object({
  fat_mass_kg: z.number(),
  lean_mass_kg: z.number(),
  bone_mass_kg: z.number(),
  total_mass_kg: z.number(),
  tissue_fat_pct: z.number(),
  region_fat_pct: z.number(),
});

const compositionResponseSchema = z.object({
  result_id: z.string(),
  section_name: z.literal("composition"),
  total: bodyRegionSchema,
  regions: z.record(z.string(), bodyRegionSchema),
  android_gynoid_ratio: z.number().nullable(),
});

export type BodySpecCompositionResponse = z.infer<typeof compositionResponseSchema>;

const boneDensityRegionSchema = z.object({
  bone_mineral_density: z.number(),
  bone_area_cm2: z.number(),
  bone_mineral_content_g: z.number(),
  age_sex_z_percentile: z.number().nullable(),
  peak_sex_t_percentile: z.number().nullable(),
});

const boneDensityResponseSchema = z.object({
  result_id: z.string(),
  section_name: z.literal("bone-density"),
  total: boneDensityRegionSchema,
  regions: z.record(z.string(), boneDensityRegionSchema),
});

export type BodySpecBoneDensityResponse = z.infer<typeof boneDensityResponseSchema>;

const visceralFatResponseSchema = z.object({
  result_id: z.string(),
  section_name: z.literal("visceral-fat"),
  vat_mass_kg: z.number(),
  vat_volume_cm3: z.number(),
});

export type BodySpecVisceralFatResponse = z.infer<typeof visceralFatResponseSchema>;

const rmrEstimateSchema = z.object({
  formula: z.string(),
  kcal_per_day: z.number(),
});

const rmrResponseSchema = z.object({
  result_id: z.string(),
  section_name: z.literal("rmr"),
  estimates: z.array(rmrEstimateSchema),
});

export type BodySpecRmrResponse = z.infer<typeof rmrResponseSchema>;

const percentileMetricSchema = z.object({
  percentile: z.number(),
  value: z.number(),
});

const percentilesResponseSchema = z.object({
  result_id: z.string(),
  section_name: z.literal("percentiles"),
  params: z.record(z.string(), z.unknown()),
  metrics: z.record(z.string(), percentileMetricSchema),
});

export type BodySpecPercentilesResponse = z.infer<typeof percentilesResponseSchema>;

const patientIntakeSchema = z.object({
  height_inches: z.number().optional(),
  weight_pounds: z.number().optional(),
  birth_date: z.string().optional(),
  gender: z.string().optional(),
  ethnicity: z.string().optional(),
});

const scanInfoResponseSchema = z.object({
  result_id: z.string(),
  section_name: z.literal("scan-info"),
  scanner_model: z.string(),
  acquire_time: z.string(),
  analyze_time: z.string(),
  patient_intake: patientIntakeSchema,
});

export type BodySpecScanInfoResponse = z.infer<typeof scanInfoResponseSchema>;

const resultSchema = z.object({
  result_id: z.string(),
  start_time: z.string(),
  location: z
    .object({
      location_id: z.string().optional(),
      name: z.string().optional(),
      location_type: z.string().optional(),
    })
    .optional(),
  service: z
    .object({
      name: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
});

const paginationSchema = z.object({
  page: z.number(),
  page_size: z.number(),
  results: z.number(),
  has_more: z.boolean(),
});

const resultsListResponseSchema = z.object({
  results: z.array(resultSchema),
  pagination: paginationSchema,
});

export type BodySpecResultsListResponse = z.infer<typeof resultsListResponseSchema>;

// ============================================================
// Parsing — pure functions
// ============================================================

export function parseComposition(response: BodySpecCompositionResponse) {
  return {
    totalFatMassKg: response.total.fat_mass_kg,
    totalLeanMassKg: response.total.lean_mass_kg,
    totalBoneMassKg: response.total.bone_mass_kg,
    totalMassKg: response.total.total_mass_kg,
    bodyFatPct: response.total.tissue_fat_pct,
    androidGynoidRatio: response.android_gynoid_ratio,
  };
}

export function parseRegions(
  composition: BodySpecCompositionResponse,
  boneDensity: BodySpecBoneDensityResponse | null,
) {
  return Object.entries(composition.regions).map(([region, comp]) => {
    const bone = boneDensity?.regions[region];
    return {
      region,
      fatMassKg: comp.fat_mass_kg,
      leanMassKg: comp.lean_mass_kg,
      boneMassKg: comp.bone_mass_kg,
      totalMassKg: comp.total_mass_kg,
      tissueFatPct: comp.tissue_fat_pct,
      regionFatPct: comp.region_fat_pct,
      boneMineralDensity: bone?.bone_mineral_density,
      boneAreaCm2: bone?.bone_area_cm2,
      boneMineralContentG: bone?.bone_mineral_content_g,
      zScorePercentile: bone?.age_sex_z_percentile ?? undefined,
      tScorePercentile: bone?.peak_sex_t_percentile ?? undefined,
    };
  });
}

export function parseBoneDensity(response: BodySpecBoneDensityResponse) {
  return {
    totalBoneMineralDensity: response.total.bone_mineral_density,
    boneDensityTPercentile: response.total.peak_sex_t_percentile,
    boneDensityZPercentile: response.total.age_sex_z_percentile,
  };
}

export function parseVisceralFat(response: BodySpecVisceralFatResponse) {
  return {
    visceralFatMassKg: response.vat_mass_kg,
    visceralFatVolumeCm3: response.vat_volume_cm3,
  };
}

export function parseRmr(response: BodySpecRmrResponse) {
  const tenHaaf = response.estimates.find((e) => e.formula.startsWith("ten Haaf"));
  const primary = tenHaaf ?? response.estimates[0];
  return {
    restingMetabolicRateKcal: primary?.kcal_per_day ?? null,
    restingMetabolicRateRaw: response.estimates,
  };
}

export function parsePercentiles(response: BodySpecPercentilesResponse) {
  return {
    params: response.params,
    metrics: response.metrics,
  };
}

export function parseScanInfo(response: BodySpecScanInfoResponse) {
  return {
    scannerModel: response.scanner_model,
    recordedAt: new Date(response.acquire_time),
    heightInches: response.patient_intake.height_inches,
    weightPounds: response.patient_intake.weight_pounds,
  };
}

export async function catchNotFound<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof Error && err.message.includes("(404)")) return null;
    throw err;
  }
}

// ============================================================
// BodySpec OAuth
// ============================================================

function bodySpecOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.BODYSPEC_CLIENT_ID;
  const clientSecret = process.env.BODYSPEC_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    authorizeUrl: `${BODYSPEC_API_BASE}/oauth/authorize`,
    tokenUrl: `${BODYSPEC_API_BASE}/oauth/token`,
    redirectUri: getOAuthRedirectUri(),
    scopes: ["read:results"],
  };
}

// ============================================================
// BodySpec API client
// ============================================================

class BodySpecClient {
  private accessToken: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.accessToken = accessToken;
    this.fetchFn = fetchFn;
  }

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.fetchFn(`${BODYSPEC_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!response.ok) {
      const text = await response.text();
      const truncated = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      throw new Error(`BodySpec API error (${response.status}): ${truncated}`);
    }

    const json: unknown = await response.json();
    return schema.parse(json);
  }

  async listResults(page = 1, pageSize = 100): Promise<BodySpecResultsListResponse> {
    return this.get(
      `/api/v1/users/me/results/?page=${page}&page_size=${pageSize}`,
      resultsListResponseSchema,
    );
  }

  async getComposition(resultId: string): Promise<BodySpecCompositionResponse> {
    return this.get(
      `/api/v1/users/me/results/${resultId}/dexa/composition`,
      compositionResponseSchema,
    );
  }

  async getBoneDensity(resultId: string): Promise<BodySpecBoneDensityResponse> {
    return this.get(
      `/api/v1/users/me/results/${resultId}/dexa/bone-density`,
      boneDensityResponseSchema,
    );
  }

  async getVisceralFat(resultId: string): Promise<BodySpecVisceralFatResponse> {
    return this.get(
      `/api/v1/users/me/results/${resultId}/dexa/visceral-fat`,
      visceralFatResponseSchema,
    );
  }

  async getRmr(resultId: string): Promise<BodySpecRmrResponse> {
    return this.get(`/api/v1/users/me/results/${resultId}/dexa/rmr`, rmrResponseSchema);
  }

  async getPercentiles(resultId: string): Promise<BodySpecPercentilesResponse> {
    return this.get(
      `/api/v1/users/me/results/${resultId}/dexa/percentiles`,
      percentilesResponseSchema,
    );
  }

  async getScanInfo(resultId: string): Promise<BodySpecScanInfoResponse> {
    return this.get(`/api/v1/users/me/results/${resultId}/dexa/scan-info`, scanInfoResponseSchema);
  }
}

// ============================================================
// Provider implementation
// ============================================================

export class BodySpecProvider implements SyncProvider {
  readonly id = "bodyspec";
  readonly name = "BodySpec";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.BODYSPEC_CLIENT_ID) return "BODYSPEC_CLIENT_ID is not set";
    if (!process.env.BODYSPEC_CLIENT_SECRET) return "BODYSPEC_CLIENT_SECRET is not set";
    return null;
  }

  authSetup(): ProviderAuthSetup | undefined {
    const config = bodySpecOAuthConfig();
    if (!config) return undefined;
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, this.fetchFn),
      apiBaseUrl: BODYSPEC_API_BASE,
    };
  }

  private async resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) {
      throw new Error("No OAuth tokens found for BodySpec. Run: health-data auth bodyspec");
    }

    if (tokens.expiresAt > new Date()) {
      return tokens;
    }

    logger.info("[bodyspec] Access token expired, refreshing...");
    const config = bodySpecOAuthConfig();
    if (!config) {
      throw new Error(
        "BODYSPEC_CLIENT_ID and BODYSPEC_CLIENT_SECRET are required to refresh tokens",
      );
    }
    if (!tokens.refreshToken) throw new Error("No refresh token for BodySpec");
    const refreshed = await refreshAccessToken(config, tokens.refreshToken, this.fetchFn);
    await saveTokens(db, this.id, refreshed);
    return refreshed;
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, BODYSPEC_API_BASE);

    let tokens: TokenSet;
    try {
      tokens = await this.resolveTokens(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new BodySpecClient(tokens.accessToken, this.fetchFn);

    try {
      const scanCount = await withSyncLog(db, this.id, "dexa_scan", async () => {
        let count = 0;
        let page = 1;
        let hasMore = true;

        while (hasMore) {
          const listResponse = await client.listResults(page);

          for (const result of listResponse.results) {
            const resultTime = new Date(result.start_time);
            if (resultTime < since) continue;

            try {
              count += await this.syncResult(db, client, result.result_id, resultTime);
            } catch (err) {
              errors.push({
                message: err instanceof Error ? err.message : String(err),
                externalId: result.result_id,
                cause: err,
              });
            }
          }

          hasMore = listResponse.pagination.has_more;
          page++;
        }

        return { recordCount: count, result: count };
      });
      recordsSynced += scanCount;
    } catch (err) {
      errors.push({
        message: `dexa_scan: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }

  private async syncResult(
    db: SyncDatabase,
    client: BodySpecClient,
    resultId: string,
    fallbackTime: Date,
  ): Promise<number> {
    // Fetch all sections for this result. Some may not be available (404).
    const [scanInfo, composition, boneDensity, visceralFat, rmr, percentiles] = await Promise.all([
      catchNotFound(client.getScanInfo(resultId)),
      catchNotFound(client.getComposition(resultId)),
      catchNotFound(client.getBoneDensity(resultId)),
      catchNotFound(client.getVisceralFat(resultId)),
      catchNotFound(client.getRmr(resultId)),
      catchNotFound(client.getPercentiles(resultId)),
    ]);

    // Composition is required — without it there's no meaningful scan data
    if (!composition) return 0;

    const parsedComposition = parseComposition(composition);
    const parsedBoneDensity = boneDensity ? parseBoneDensity(boneDensity) : null;
    const parsedVisceralFat = visceralFat ? parseVisceralFat(visceralFat) : null;
    const parsedRmr = rmr ? parseRmr(rmr) : null;
    const parsedPercentiles = percentiles ? parsePercentiles(percentiles) : null;
    const parsedScanInfo = scanInfo ? parseScanInfo(scanInfo) : null;

    const scanValues = {
      providerId: this.id,
      externalId: resultId,
      recordedAt: parsedScanInfo?.recordedAt ?? fallbackTime,
      scannerModel: parsedScanInfo?.scannerModel ?? null,
      ...parsedComposition,
      ...(parsedBoneDensity ?? {}),
      ...(parsedVisceralFat ?? {}),
      restingMetabolicRateKcal: parsedRmr?.restingMetabolicRateKcal ?? null,
      restingMetabolicRateRaw: parsedRmr?.restingMetabolicRateRaw ?? null,
      percentiles: parsedPercentiles ?? null,
      heightInches: parsedScanInfo?.heightInches ?? null,
      weightPounds: parsedScanInfo?.weightPounds ?? null,
    };

    const [inserted] = await db
      .insert(dexaScan)
      .values(scanValues)
      .onConflictDoUpdate({
        target: [dexaScan.providerId, dexaScan.externalId],
        set: scanValues,
      })
      .returning({ id: dexaScan.id });

    if (!inserted) return 0;

    // Upsert region rows
    const regions = parseRegions(composition, boneDensity);
    for (const region of regions) {
      await db
        .insert(dexaScanRegion)
        .values({
          scanId: inserted.id,
          ...region,
        })
        .onConflictDoUpdate({
          target: [dexaScanRegion.scanId, dexaScanRegion.region],
          set: region,
        });
    }

    return 1;
  }
}
