import { ZWIFT_API_BASE, ZwiftClient } from "@dofek/zwift/client";
import { parseZwiftActivity, parseZwiftFitnessData } from "@dofek/zwift/parsing";
import type { ZwiftActivitySummary } from "@dofek/zwift/types";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import { writeMetricStreamBatch } from "../db/metric-stream-writer.ts";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../db/provider-activity-sync.ts";
import { SOURCE_TYPE_API } from "../db/sensor-channels.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { logger } from "../logger.ts";
import { fetchProviderPages } from "../sync/pagination.ts";
import type { SyncDegradation } from "../sync/sync-degradation.ts";
import {
  ProviderAuthenticationFailedError,
  ProviderStoredIdentityInvalidError,
  ProviderStoredIdentityMissingError,
} from "./auth-errors.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

// ============================================================
// Provider implementation
// ============================================================

const ZWIFT_ACTIVITY_PAGE_SIZE = 20;
const ZWIFT_MAX_ACTIVITY_PAGES = 100;

export class ZwiftProvider implements SyncProvider {
  readonly id = "zwift";
  readonly name = "Zwift";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch("zwift", fetchFn);
  }

  validate(): string | null {
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://www.zwift.com/activity/${externalId}`;
  }

  #extractAthleteIdFromAccessToken(accessToken: string): string | null {
    try {
      const jwtPayloadSchema = z.object({ sub: z.string().optional() });
      const payload = jwtPayloadSchema.parse(
        JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString()),
      );
      return payload.sub ?? null;
    } catch {
      return null;
    }
  }

  #isNumericAthleteId(athleteId: string): boolean {
    return (
      athleteId.length > 0 &&
      Array.from(athleteId).every((character) => {
        return character >= "0" && character <= "9";
      })
    );
  }

  async #resolveAuthenticatedAthleteId(accessToken: string): Promise<string> {
    const client = new ZwiftClient(accessToken, "me", this.#fetchFn);
    const profile = await client.getAuthenticatedProfile();
    const athleteId = String(profile.id);
    if (!this.#isNumericAthleteId(athleteId)) {
      throw new ProviderStoredIdentityInvalidError(
        `Zwift authenticated profile ID is not numeric (${athleteId}).`,
      );
    }
    return athleteId;
  }

  async #canonicalizeAthleteId(accessToken: string, athleteId: string): Promise<string> {
    if (this.#isNumericAthleteId(athleteId)) {
      return athleteId;
    }

    const resolvedAthleteId = await this.#resolveAuthenticatedAthleteId(accessToken);
    logger.info(
      `[zwift] Resolved numeric athlete ID ${resolvedAthleteId} from non-numeric athlete ID ${athleteId}`,
    );
    return resolvedAthleteId;
  }

  authSetup(_options?: { host?: string }): ProviderAuthSetup {
    const fetchFn = this.#fetchFn;
    return {
      automatedLogin: async (email: string, password: string) => {
        const result = await ZwiftClient.signIn(email, password, fetchFn);

        // Decode JWT subject, then canonicalize to numeric profile ID when needed.
        const subjectAthleteId = this.#extractAthleteIdFromAccessToken(result.accessToken);
        const athleteId = subjectAthleteId
          ? await this.#canonicalizeAthleteId(result.accessToken, subjectAthleteId)
          : null;
        if (!athleteId) {
          throw new Error("Zwift JWT missing athlete ID (sub claim) — cannot authenticate");
        }
        logger.info(`[zwift] Authenticated athlete ${athleteId}`);

        return {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: new Date(Date.now() + result.expiresIn * 1000),
          scopes: `athleteId:${athleteId}`,
        };
      },
    };
  }

  async #resolveTokens(
    db: SyncDatabase,
    forceRefresh = false,
  ): Promise<{ accessToken: string; athleteId: string }> {
    const stored = await loadTokens(db, this.id);
    if (!stored) {
      throw new Error("Zwift not connected — authenticate via the web UI");
    }

    const athleteIdPrefix = "athleteId:";
    const scope = stored.scopes ?? "";
    let athleteId = scope.startsWith(athleteIdPrefix)
      ? scope.slice(athleteIdPrefix.length)
      : undefined;

    // Self-heal: if scopes are missing the athleteId, try to extract it from the JWT.
    const hadMissingScopes = !athleteId;
    if (!athleteId) {
      athleteId = this.#extractAthleteIdFromAccessToken(stored.accessToken) ?? undefined;
      if (athleteId) {
        logger.info(`[zwift] Self-healed missing athleteId from JWT sub claim: ${athleteId}`);
      }
    }

    if (!athleteId) {
      logger.error(`[zwift] Stored scopes missing athlete ID: ${JSON.stringify(stored.scopes)}`);
      throw new ProviderStoredIdentityMissingError("Zwift", "athlete ID");
    }

    let accessToken = stored.accessToken;
    let refreshToken = stored.refreshToken;
    let expiresAt = stored.expiresAt;

    // Refresh if expired
    const shouldRefresh = forceRefresh || stored.expiresAt <= new Date();
    if (shouldRefresh) {
      if (!stored.refreshToken) {
        throw new ProviderAuthenticationFailedError("Zwift");
      }
      logger.info(
        forceRefresh
          ? "[zwift] Authentication failed, forcing token refresh..."
          : "[zwift] Token expired, refreshing...",
      );
      const refreshed = await ZwiftClient.refreshToken(stored.refreshToken, this.#fetchFn);
      accessToken = refreshed.accessToken;
      refreshToken = refreshed.refreshToken || stored.refreshToken;
      expiresAt = new Date(Date.now() + refreshed.expiresIn * 1000);
    }

    // Ensure sync uses the numeric profile ID expected by /api/profiles/{id}/... endpoints.
    const canonicalAthleteId = await this.#canonicalizeAthleteId(accessToken, athleteId);
    const shouldPersistSelfHeal = hadMissingScopes || canonicalAthleteId !== athleteId;

    if (shouldRefresh) {
      await saveTokens(db, this.id, {
        accessToken,
        refreshToken,
        expiresAt,
        scopes: `athleteId:${canonicalAthleteId}`,
      });
    } else if (shouldPersistSelfHeal) {
      try {
        await saveTokens(db, this.id, {
          accessToken,
          refreshToken,
          expiresAt,
          scopes: `athleteId:${canonicalAthleteId}`,
        });
      } catch (saveError) {
        logger.error(
          `[zwift] Failed to persist self-healed scopes: ${saveError instanceof Error ? saveError.message : String(saveError)}`,
        );
      }
    }

    return { accessToken, athleteId: canonicalAthleteId };
  }

  #isAuthenticationError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return /\(401\)|\b401\b|\(403\)|\b403\b|unauthorized|invalid_token/i.test(error.message);
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, ZWIFT_API_BASE);

    let client: ZwiftClient;
    try {
      const { accessToken, athleteId } = await this.#resolveTokens(db);
      client = new ZwiftClient(accessToken, athleteId, this.#fetchFn);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const runWithAuthRetry = async <T>(
      operation: (activeClient: ZwiftClient) => Promise<T>,
    ): Promise<T> => {
      try {
        return await operation(client);
      } catch (error) {
        if (!this.#isAuthenticationError(error)) {
          throw error;
        }
        const { accessToken, athleteId } = await this.#resolveTokens(db, true);
        client = new ZwiftClient(accessToken, athleteId, this.#fetchFn);
        return operation(client);
      }
    };

    // 1. Sync activities (paginated)
    const since = window.since;
    const syncWindowEnd = window.until;
    const presentActivityExternalIds = new Set<string>();
    const degradations: SyncDegradation[] = [];
    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          let count = 0;
          let reachedSyncWindowStart = false;

          const pages = await fetchProviderPages<ZwiftActivitySummary, number>({
            providerId: this.id,
            stepName: "activity_list",
            initialCursor: 0,
            maxPages: ZWIFT_MAX_ACTIVITY_PAGES,
            fetchPage: async (offset) => {
              const currentOffset = offset ?? 0;
              const activities = await runWithAuthRetry((activeClient) =>
                activeClient.getActivities(currentOffset, ZWIFT_ACTIVITY_PAGE_SIZE),
              );
              return {
                items: activities,
                nextCursor:
                  activities.length >= ZWIFT_ACTIVITY_PAGE_SIZE
                    ? currentOffset + ZWIFT_ACTIVITY_PAGE_SIZE
                    : null,
              };
            },
            onPage: async (pageResult) => {
              for (const raw of pageResult.items) {
                const actStart = new Date(raw.startDate);
                if (actStart < since) {
                  reachedSyncWindowStart = true;
                  break;
                }
                if (actStart >= syncWindowEnd) {
                  continue;
                }

                const parsed = parseZwiftActivity(raw);
                presentActivityExternalIds.add(parsed.externalId);
                try {
                  await upsertProviderActivity(
                    db,
                    {
                      providerId: this.id,
                      externalId: parsed.externalId,
                      activityType: parsed.activityType,
                      name: parsed.name,
                      startedAt: parsed.startedAt,
                      endedAt: parsed.endedAt,
                      raw: parsed.raw,
                    },
                    {
                      activityType: parsed.activityType,
                      name: parsed.name,
                      startedAt: parsed.startedAt,
                      endedAt: parsed.endedAt,
                      raw: parsed.raw,
                    },
                  );
                  count++;

                  try {
                    const detail = await runWithAuthRetry((activeClient) =>
                      activeClient.getActivityDetail(raw.id),
                    );
                    const fullDataUrl = detail.fitnessData?.fullDataUrl;
                    if (fullDataUrl) {
                      const fitnessData = await runWithAuthRetry((activeClient) =>
                        activeClient.getFitnessData(fullDataUrl),
                      );
                      const samples = parseZwiftFitnessData(fitnessData, parsed.startedAt);
                      const metricRows = samples.map((sample) => ({
                        providerId: this.id,
                        recordedAt: sample.recordedAt,
                        heartRate: sample.heartRate,
                        power: sample.power,
                        cadence: sample.cadence,
                        altitude: sample.altitude,
                        lat: sample.lat,
                        lng: sample.lng,
                      }));
                      await writeMetricStreamBatch(
                        db,
                        metricRows,
                        SOURCE_TYPE_API,
                        undefined,
                        options?.metricStreamPublisher,
                      );
                    }
                  } catch (streamErr) {
                    errors.push({
                      message: `streams ${parsed.externalId}: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
                      externalId: parsed.externalId,
                      cause: streamErr,
                      context: {
                        activityId: parsed.externalId,
                      },
                    });
                  }
                } catch (err) {
                  errors.push({
                    message: err instanceof Error ? err.message : String(err),
                    externalId: parsed.externalId,
                    cause: err,
                  });
                }
              }
            },
            shouldStopAfterPage: () => reachedSyncWindowStart,
          });

          degradations.push(...pages.degradations);

          if (pages.degradations.length === 0) {
            await finishProviderActivityListSync(db, {
              providerId: this.id,
              userId: options?.userId,
              windowStart: since,
              windowEnd: syncWindowEnd,
              presentExternalIds: presentActivityExternalIds,
            });
          }
          return { recordCount: count, result: count, degradations };
        },
        options?.userId,
      );
      recordsSynced += activityCount;
    } catch (err) {
      errors.push({
        message: `activity: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      degradations: degradations.length > 0 ? degradations : undefined,
      duration: Date.now() - start,
    };
  }
}
