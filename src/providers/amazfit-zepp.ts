import { createRateLimitAwareFetch, ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { captureException } from "@sentry/node";
import { signInToZepp } from "zepp-client/client";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import { writeMetricStreamBatch } from "../db/metric-stream-writer.ts";
import { dailyMetrics, sleepSession } from "../db/schema.ts";
import { SOURCE_TYPE_API } from "../db/sensor-channels.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { getTokenUserId } from "../db/token-user-context.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import { ProviderStoredIdentityMissingError } from "./auth-errors.ts";
import type {
  ProviderAuthSetup,
  SyncError,
  SyncOptions,
  SyncProvider,
  SyncResult,
} from "./types.ts";
import { SyncWindow } from "./sync-window.ts";

export const AMAZFIT_ZEPP_API_BASE = "https://api-mifit.zepp.com";
const AMAZFIT_ZEPP_SOURCE_NAME = "Zepp";

const optionalNumber = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return value;
}, z.number().optional());

const zeppStepSummarySchema = z
  .object({
    ttl: optionalNumber,
    dis: optionalNumber,
    cal: optionalNumber,
    wk: optionalNumber,
    runDist: optionalNumber,
    runCal: optionalNumber,
    stage: z.array(z.unknown()).optional(),
  })
  .passthrough();

const zeppSleepSummarySchema = z
  .object({
    st: optionalNumber,
    ed: optionalNumber,
    dp: optionalNumber,
    lt: optionalNumber,
    dt: optionalNumber,
    wk: optionalNumber,
    ss: optionalNumber,
    rhr: optionalNumber,
    stage: z.array(z.unknown()).optional(),
  })
  .passthrough();

const zeppSummarySchema = z
  .object({
    stp: zeppStepSummarySchema.optional(),
    slp: zeppSleepSummarySchema.optional(),
    goal: optionalNumber,
  })
  .passthrough();

export type ZeppSummary = z.infer<typeof zeppSummarySchema>;

const zeppBandDaySchema = z
  .object({
    date_time: z.string().optional(),
    dateTime: z.string().optional(),
    summary: z.string().optional(),
    data_hr: z.string().optional(),
  })
  .passthrough();

const zeppBandDataResponseSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z.array(z.unknown()).default([]),
});

export interface ParsedZeppDailyMetrics {
  date: string;
  steps?: number;
  activeEnergyKcal?: number;
  distanceKm?: number;
}

export interface ParsedZeppSleep {
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
  deepMinutes?: number;
  lightMinutes?: number;
  remMinutes?: number;
  awakeMinutes?: number;
}

export interface ParsedZeppHeartRateSample {
  recordedAt: Date;
  heartRate: number;
}

export interface ParsedZeppBandDay {
  date: string;
  dailyMetrics?: ParsedZeppDailyMetrics;
  sleep?: ParsedZeppSleep;
  heartRateSamples: ParsedZeppHeartRateSample[];
}

export function decodeZeppSummary(encodedSummary: string): ZeppSummary {
  const decoded = Buffer.from(encodedSummary, "base64").toString("utf8");
  const parsedJson: unknown = JSON.parse(decoded);
  return zeppSummarySchema.parse(parsedJson);
}

function dateAtUtcMinute(date: string, minute: number): Date {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + minute * 60_000);
}

export function decodeZeppHeartRateSamples(
  date: string,
  encodedHeartRates: string,
): ParsedZeppHeartRateSample[] {
  const heartRateBytes = Buffer.from(encodedHeartRates, "base64");
  const samples: ParsedZeppHeartRateSample[] = [];

  for (const [minute, heartRate] of heartRateBytes.entries()) {
    if (heartRate <= 0 || heartRate >= 254) continue;
    samples.push({
      recordedAt: dateAtUtcMinute(date, minute),
      heartRate,
    });
  }

  return samples;
}

function zeppSleepBoundaryToDate(date: string, boundary: number): Date {
  if (boundary >= 1_000_000_000) return new Date(boundary * 1000);
  return dateAtUtcMinute(date, boundary);
}

function resolveScopedUserId(userId?: string): string {
  const scopedUserId = userId ?? getTokenUserId();
  if (!scopedUserId) {
    throw new Error("amazfit-zepp sync requires a userId");
  }
  return scopedUserId;
}

interface ResolvedZeppCredentials {
  appToken: string;
  zeppUserId: string;
}

/** Stored in TokenSet.scopes — JSON payload carrying the Zepp-side user id. */
interface ZeppTokenScopes {
  zeppUserId: string;
}

export function encodeZeppTokenScopes(zeppUserId: string): string {
  return JSON.stringify({ zeppUserId } satisfies ZeppTokenScopes);
}

/** Reads zeppUserId from structured scopes, with legacy `userId:<id>` fallback. */
export function decodeZeppUserIdFromScopes(scopes: string | null | undefined): string | null {
  if (!scopes) return null;

  try {
    const parsed: unknown = JSON.parse(scopes);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "zeppUserId" in parsed &&
      typeof parsed.zeppUserId === "string" &&
      parsed.zeppUserId.length > 0
    ) {
      return parsed.zeppUserId;
    }
  } catch {
    // Fall back to legacy string format used during initial rollout.
  }

  const legacyMatch = scopes.match(/^userId:(\S+)$/);
  return legacyMatch?.[1] ?? null;
}

async function resolveZeppCredentials(
  db: SyncDatabase,
  providerId: string,
  scopedUserId: string,
): Promise<ResolvedZeppCredentials | null> {
  const stored = await loadTokens(db, providerId, scopedUserId);
  if (!stored) return null;

  const zeppUserId = decodeZeppUserIdFromScopes(stored.scopes);
  if (!stored.accessToken || !zeppUserId) return null;

  return { appToken: stored.accessToken, zeppUserId };
}

function parseDailyMetrics(date: string, summary: ZeppSummary): ParsedZeppDailyMetrics | undefined {
  const steps = summary.stp?.ttl;
  const distanceMeters = summary.stp?.dis;
  const calories = summary.stp?.cal;

  if (steps === undefined && distanceMeters === undefined && calories === undefined) {
    return undefined;
  }

  return {
    date,
    steps: steps === undefined ? undefined : Math.round(steps),
    activeEnergyKcal: calories,
    distanceKm: distanceMeters === undefined ? undefined : distanceMeters / 1000,
  };
}

function parseSleep(date: string, summary: ZeppSummary): ParsedZeppSleep | undefined {
  const sleep = summary.slp;
  if (!sleep) return undefined;

  const deepMinutes = sleep.dp;
  const lightMinutes = sleep.lt;
  const remMinutes = sleep.dt;
  const awakeMinutes = sleep.wk;
  const durationMinutes = Math.round((deepMinutes ?? 0) + (lightMinutes ?? 0) + (remMinutes ?? 0));
  if (durationMinutes <= 0 || sleep.st === undefined || sleep.ed === undefined) return undefined;

  const startedAt = zeppSleepBoundaryToDate(date, sleep.st);
  const endedAt = zeppSleepBoundaryToDate(date, sleep.ed);

  return {
    externalId: `zepp-sleep-${startedAt.toISOString()}-${endedAt.toISOString()}`,
    startedAt,
    endedAt,
    durationMinutes,
    deepMinutes: deepMinutes === undefined ? undefined : Math.round(deepMinutes),
    lightMinutes: lightMinutes === undefined ? undefined : Math.round(lightMinutes),
    remMinutes: remMinutes === undefined ? undefined : Math.round(remMinutes),
    awakeMinutes: awakeMinutes === undefined ? undefined : Math.round(awakeMinutes),
  };
}

export function parseZeppBandDay(rawDay: unknown): ParsedZeppBandDay {
  const day = zeppBandDaySchema.parse(rawDay);
  const date = day.date_time ?? day.dateTime;
  if (!date) {
    throw new Error("Zepp band day is missing date_time");
  }

  const summary = day.summary ? decodeZeppSummary(day.summary) : undefined;
  return {
    date,
    dailyMetrics: summary ? parseDailyMetrics(date, summary) : undefined,
    sleep: summary ? parseSleep(date, summary) : undefined,
    heartRateSamples: day.data_hr ? decodeZeppHeartRateSamples(date, day.data_hr) : [],
  };
}

export class AmazfitZeppClient {
  #appToken: string;
  #userId: string;
  #fetchFn: typeof globalThis.fetch;
  #apiBaseUrl: string;

  constructor(
    appToken: string,
    userId: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
    apiBaseUrl = process.env.ZEPP_API_BASE_URL ?? AMAZFIT_ZEPP_API_BASE,
  ) {
    this.#appToken = appToken;
    this.#userId = userId;
    this.#fetchFn = createRateLimitAwareFetch(fetchFn, { providerId: "amazfit-zepp" });
    this.#apiBaseUrl = apiBaseUrl;
  }

  async getBandData(fromDate: string, toDate: string): Promise<unknown[]> {
    const url = new URL("/v1/data/band_data.json", this.#apiBaseUrl);
    url.searchParams.set("query_type", "detail");
    url.searchParams.set("device_type", "android_phone");
    url.searchParams.set("userid", this.#userId);
    url.searchParams.set("from_date", fromDate);
    url.searchParams.set("to_date", toDate);

    const response = await this.#fetchFn(url.toString(), {
      headers: {
        apptoken: this.#appToken,
        appPlatform: "web",
        appname: "com.xiaomi.hm.health",
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Amazfit/Zepp API error (${response.status}): ${text}`);
    }

    const payload = zeppBandDataResponseSchema.parse(await response.json());
    if (payload.code !== 1) {
      throw new Error(`Amazfit/Zepp API error: ${payload.message ?? `code ${payload.code}`}`);
    }

    return payload.data;
  }
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class AmazfitZeppProvider implements SyncProvider {
  readonly id = "amazfit-zepp";
  readonly name = "Amazfit/Zepp";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createRateLimitAwareFetch(fetchFn, { providerId: "amazfit-zepp" });
  }

  validate(): string | null {
    return null;
  }

  authSetup(_options?: { host?: string }): ProviderAuthSetup {
    const fetchFn = this.#fetchFn;
    const apiBaseUrl = process.env.ZEPP_API_BASE_URL ?? AMAZFIT_ZEPP_API_BASE;
    return {
      apiBaseUrl,
      automatedLogin: async (email: string, password: string) => {
        const result = await signInToZepp(email, password, fetchFn);
        return {
          accessToken: result.appToken,
          refreshToken: result.loginToken,
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          scopes: encodeZeppTokenScopes(result.userId),
        };
      },
    };
  }

  async sync(db: SyncDatabase, window: SyncWindow, options?: SyncOptions): Promise<SyncResult> {
    const since = window.since;
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;
    const { metricStreamPublisher, onProgress, userId } = options ?? {};
    const scopedUserId = resolveScopedUserId(userId);

    await ensureProvider(
      db,
      this.id,
      this.name,
      process.env.ZEPP_API_BASE_URL ?? AMAZFIT_ZEPP_API_BASE,
      scopedUserId,
    );

    let client: AmazfitZeppClient;
    try {
      const credentials = await resolveZeppCredentials(db, this.id, scopedUserId);
      if (!credentials) {
        throw new ProviderStoredIdentityMissingError(
          "Amazfit/Zepp",
          "credentials — connect via the app",
        );
      }
      client = new AmazfitZeppClient(credentials.appToken, credentials.zeppUserId, this.#fetchFn);
    } catch (err) {
      if (!(err instanceof ProviderStoredIdentityMissingError)) {
        captureException(err, {
          tags: { provider: this.id, dataType: "band_data", phase: "credential_resolution" },
        });
      }
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const sinceDate = formatDate(since);
    const todayDate = formatDate(new Date());

    try {
      const count = await withSyncLog(
        db,
        this.id,
        "band_data",
        async () => {
          let synced = 0;
          onProgress?.(0, "Fetching band data");
          const days = await client.getBandData(sinceDate, todayDate);

          for (const [dayIndex, day] of days.entries()) {
            try {
              const parsed = parseZeppBandDay(day);

              if (parsed.dailyMetrics) {
                await db
                  .insert(dailyMetrics)
                  .values({
                    date: parsed.dailyMetrics.date,
                    providerId: this.id,
                    userId: scopedUserId,
                    sourceName: AMAZFIT_ZEPP_SOURCE_NAME,
                    steps: parsed.dailyMetrics.steps,
                    activeEnergyKcal: parsed.dailyMetrics.activeEnergyKcal,
                    distanceKm: parsed.dailyMetrics.distanceKm,
                  })
                  .onConflictDoUpdate({
                    target: [
                      dailyMetrics.userId,
                      dailyMetrics.date,
                      dailyMetrics.providerId,
                      dailyMetrics.sourceName,
                    ],
                    set: {
                      sourceName: AMAZFIT_ZEPP_SOURCE_NAME,
                      steps: parsed.dailyMetrics.steps,
                      activeEnergyKcal: parsed.dailyMetrics.activeEnergyKcal,
                      distanceKm: parsed.dailyMetrics.distanceKm,
                    },
                  });
                synced++;
              }

              if (parsed.sleep) {
                await db
                  .insert(sleepSession)
                  .values({
                    providerId: this.id,
                    userId: scopedUserId,
                    externalId: parsed.sleep.externalId,
                    startedAt: parsed.sleep.startedAt,
                    endedAt: parsed.sleep.endedAt,
                    durationMinutes: parsed.sleep.durationMinutes,
                    deepMinutes: parsed.sleep.deepMinutes,
                    lightMinutes: parsed.sleep.lightMinutes,
                    remMinutes: parsed.sleep.remMinutes,
                    awakeMinutes: parsed.sleep.awakeMinutes,
                    sourceName: AMAZFIT_ZEPP_SOURCE_NAME,
                  })
                  .onConflictDoUpdate({
                    target: [sleepSession.userId, sleepSession.providerId, sleepSession.externalId],
                    set: {
                      startedAt: parsed.sleep.startedAt,
                      endedAt: parsed.sleep.endedAt,
                      durationMinutes: parsed.sleep.durationMinutes,
                      deepMinutes: parsed.sleep.deepMinutes,
                      lightMinutes: parsed.sleep.lightMinutes,
                      remMinutes: parsed.sleep.remMinutes,
                      awakeMinutes: parsed.sleep.awakeMinutes,
                      sourceName: AMAZFIT_ZEPP_SOURCE_NAME,
                    },
                  });
                synced++;
              }

              if (parsed.heartRateSamples.length > 0) {
                const heartRateRows = parsed.heartRateSamples.map((sample) => ({
                  providerId: this.id,
                  userId: scopedUserId,
                  externalId: `zepp-heart-rate-${sample.recordedAt.toISOString()}`,
                  recordedAt: sample.recordedAt,
                  sourceName: AMAZFIT_ZEPP_SOURCE_NAME,
                  heartRate: sample.heartRate,
                }));
                synced += await writeMetricStreamBatch(
                  db,
                  heartRateRows,
                  SOURCE_TYPE_API,
                  undefined,
                  metricStreamPublisher,
                );
              }
            } catch (error: unknown) {
              captureException(error, {
                tags: { provider: this.id, dataType: "band_data", phase: "day" },
              });
              errors.push({
                message: error instanceof Error ? error.message : String(error),
                cause: error,
              });
            }
            onProgress?.(
              Math.round(((dayIndex + 1) / days.length) * 100),
              `${dayIndex + 1}/${days.length} days`,
            );
          }
          if (days.length === 0) onProgress?.(100, "0/0 days");

          return { recordCount: synced, result: synced };
        },
        scopedUserId,
      );
      recordsSynced += count;
    } catch (error: unknown) {
      if (error instanceof ProviderRateLimitError) throw error;
      captureException(error, {
        tags: { provider: this.id, dataType: "band_data", phase: "sync" },
      });
      errors.push({
        message: `band_data: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
