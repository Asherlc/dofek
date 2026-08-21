import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { dexaScan, dexaScanRegion } from "../db/schema/events.ts";
import { PartialSyncError, withSyncLog } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { fetchProviderPages } from "../sync/pagination.ts";
import type { SyncDegradation } from "../sync/sync-degradation.ts";
import { ProviderAuthenticationFailedError } from "./auth-errors.ts";
import { ProviderHttpClient } from "./http-client.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// BodySpec API types & Zod schemas
// ============================================================

const BODYSPEC_API_BASE = "https://app.bodyspec.com";
const BODYSPEC_PUBLIC_CLIENT_ID = "bodyspec-api-ext-v1";
const BODYSPEC_OIDC_BASE = "https://auth.bodyspec.com/realms/bodyspec/protocol/openid-connect";

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

type BodySpecResultSummary = z.infer<typeof resultSchema>;
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
    if (err instanceof Error && /\b404\b/.test(err.message)) return null;
    throw err;
  }
}

// ============================================================
// BodySpec OAuth
// ============================================================

function bodySpecOAuthConfig(host?: string): OAuthConfig {
  return {
    clientId: BODYSPEC_PUBLIC_CLIENT_ID,
    authorizeUrl: `${BODYSPEC_OIDC_BASE}/auth`,
    tokenUrl: `${BODYSPEC_OIDC_BASE}/token`,
    redirectUri: getOAuthRedirectUri(host),
    scopes: ["openid", "profile", "email"],
    usePkce: true,
  };
}

// ============================================================
// BodySpec API client
// ============================================================

class BodySpecClient extends ProviderHttpClient {
  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    super(accessToken, BODYSPEC_API_BASE, fetchFn, "bodyspec");
  }

  protected override async handleErrorResponse(response: Response, path: string): Promise<never> {
    if (response.status === 401 || response.status === 403) {
      throw new ProviderAuthenticationFailedError("BodySpec");
    }
    return super.handleErrorResponse(response, path);
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
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch("bodyspec", fetchFn);
  }

  validate(): string | null {
    return null;
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = bodySpecOAuthConfig(options?.host);
    return {
      oauthConfig: config,
      exchangeCode: async (code, codeVerifier) => {
        if (!codeVerifier) {
          throw new Error("BodySpec PKCE verifier is missing");
        }
        return await exchangeCodeForTokens(config, code, this.#fetchFn, { codeVerifier });
      },
      apiBaseUrl: BODYSPEC_API_BASE,
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => bodySpecOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
    const since = window.since;
    const until = window.until;
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, BODYSPEC_API_BASE);

    let tokens: TokenSet;
    try {
      tokens = await this.#resolveTokens(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new BodySpecClient(tokens.accessToken, this.#fetchFn);
    const degradations: SyncDegradation[] = [];

    try {
      const scanCount = await withSyncLog(
        db,
        this.id,
        "dexa_scan",
        async () => {
          let count = 0;

          try {
            const pages = await fetchProviderPages<BodySpecResultSummary, number>({
              providerId: this.id,
              stepName: "dexa_scan",
              initialCursor: 1,
              fetchPage: async (page) => {
                const currentPage = page ?? 1;
                const listResponse = await client.listResults(currentPage);
                return {
                  items: listResponse.results,
                  nextCursor: listResponse.pagination.has_more ? currentPage + 1 : null,
                };
              },
              onPage: async (page) => {
                for (const result of page.items) {
                  const resultTime = new Date(result.start_time);
                  if (resultTime < since) continue;
                  if (resultTime > until) continue;

                  try {
                    count += await this.#syncResult(db, client, result.result_id, resultTime);
                  } catch (err) {
                    errors.push({
                      message: err instanceof Error ? err.message : String(err),
                      externalId: result.result_id,
                      cause: err,
                    });
                  }
                }
              },
            });
            degradations.push(...pages.degradations);
          } catch (err) {
            throw new PartialSyncError(
              `dexa_scan: ${err instanceof Error ? err.message : String(err)}`,
              count,
              err,
            );
          }

          return { recordCount: count, result: count, degradations };
        },
        options?.userId,
      );
      recordsSynced += scanCount;
    } catch (err) {
      if (err instanceof PartialSyncError) {
        recordsSynced += err.recordCount;
      }
      errors.push({
        message: err instanceof Error ? err.message : String(err),
        cause: err instanceof PartialSyncError ? err.cause : err,
      });
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
      degradations,
    };
  }

  async #syncResult(
    db: SyncDatabase,
    client: BodySpecClient,
    resultId: string,
    fallbackTime: Date,
  ): Promise<number> {
    // Fetch all sections for this result. Some may not be available (404).
    const [scanInfo, composition, boneDensity, visceralFat, percentiles] = await Promise.all([
      catchNotFound(client.getScanInfo(resultId)),
      catchNotFound(client.getComposition(resultId)),
      catchNotFound(client.getBoneDensity(resultId)),
      catchNotFound(client.getVisceralFat(resultId)),
      catchNotFound(client.getPercentiles(resultId)),
    ]);

    // Composition is required — without it there's no meaningful scan data
    if (!composition) return 0;

    const parsedComposition = parseComposition(composition);
    const parsedBoneDensity = boneDensity ? parseBoneDensity(boneDensity) : null;
    const parsedVisceralFat = visceralFat ? parseVisceralFat(visceralFat) : null;
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
      percentiles: parsedPercentiles ?? null,
      heightInches: parsedScanInfo?.heightInches ?? null,
      weightPounds: parsedScanInfo?.weightPounds ?? null,
    };

    const [inserted] = await db
      .insert(dexaScan)
      .values(scanValues)
      .onConflictDoUpdate({
        target: [dexaScan.userId, dexaScan.providerId, dexaScan.externalId],
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
