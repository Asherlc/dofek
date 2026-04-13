import { z } from "zod";
import { ZWIFT_API_BASE, ZWIFT_AUTH_URL, ZwiftClient } from "zwift-client/client";
import { parseZwiftActivity, parseZwiftFitnessData } from "zwift-client/parsing";
import type { SyncDatabase } from "../db/index.ts";
import { activity, dailyMetrics } from "../db/schema.ts";
import { SOURCE_TYPE_API } from "../db/sensor-channels.ts";
import { dualWriteToSensorSample } from "../db/sensor-sample-writer.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { logger } from "../logger.ts";
import type {
  ProviderAuthSetup,
  SyncError,
  SyncOptions,
  SyncProvider,
  SyncResult,
} from "./types.ts";

// ============================================================
// Provider implementation
// ============================================================

export class ZwiftProvider implements SyncProvider {
  readonly id = "zwift";
  readonly name = "Zwift";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://www.zwift.com/activity/${externalId}`;
  }

  authSetup(_options?: { host?: string }): ProviderAuthSetup {
    const fetchFn = this.#fetchFn;
    return {
      oauthConfig: {
        clientId: "Zwift Game Client",
        authorizeUrl: ZWIFT_AUTH_URL,
        tokenUrl: ZWIFT_AUTH_URL,
        redirectUri: "",
        scopes: [],
      },
      automatedLogin: async (email: string, password: string) => {
        const result = await ZwiftClient.signIn(email, password, fetchFn);

        // Decode JWT to get athleteId
        const jwtPayloadSchema = z.object({ sub: z.string().optional() });
        const payload = jwtPayloadSchema.parse(
          JSON.parse(Buffer.from(result.accessToken.split(".")[1] ?? "", "base64url").toString()),
        );
        const athleteId = payload.sub;
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
      exchangeCode: async () => {
        throw new Error("Zwift uses automated login, not OAuth code exchange");
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

    const athleteIdMatch = stored.scopes?.match(/athleteId:(\S+)/);
    let athleteId = athleteIdMatch?.[1];

    // Self-heal: if scopes are missing the athleteId, try to extract it from the JWT
    if (!athleteId) {
      try {
        const jwtParts = stored.accessToken.split(".");
        if (jwtParts.length === 3 && jwtParts[1]) {
          const jwtPayload = JSON.parse(Buffer.from(jwtParts[1], "base64url").toString());
          const jwtPayloadSchema = z.object({ sub: z.string().optional() });
          const parsed = jwtPayloadSchema.parse(jwtPayload);
          if (parsed.sub) {
            athleteId = parsed.sub;
            const correctedScopes = `athleteId:${athleteId}`;
            logger.info(`[zwift] Self-healed missing athleteId from JWT sub claim: ${athleteId}`);
            await saveTokens(db, this.id, {
              accessToken: stored.accessToken,
              refreshToken: stored.refreshToken,
              expiresAt: stored.expiresAt,
              scopes: correctedScopes,
            });
          }
        }
      } catch {
        // JWT decode failed — fall through to the error below
      }
    }

    if (!athleteId) {
      logger.error(`[zwift] Stored scopes missing athlete ID: ${JSON.stringify(stored.scopes)}`);
      throw new Error(
        `Zwift athlete ID not found in scopes (${stored.scopes ?? "null"}) — re-authenticate`,
      );
    }

    // Refresh if expired
    const shouldRefresh = forceRefresh || stored.expiresAt <= new Date();
    if (shouldRefresh) {
      if (!stored.refreshToken) {
        throw new Error(
          "Zwift authentication failed and no refresh token available — re-authenticate",
        );
      }
      logger.info(
        forceRefresh
          ? "[zwift] Authentication failed, forcing token refresh..."
          : "[zwift] Token expired, refreshing...",
      );
      const refreshed = await ZwiftClient.refreshToken(stored.refreshToken, this.#fetchFn);
      const tokens = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken || stored.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
        scopes: `athleteId:${athleteId}`,
      };
      await saveTokens(db, this.id, tokens);
      return { accessToken: refreshed.accessToken, athleteId };
    }

    return { accessToken: stored.accessToken, athleteId };
  }

  #isAuthenticationError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return /\(401\)|\b401\b|\(403\)|\b403\b|unauthorized|invalid_token/i.test(error.message);
  }

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
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
    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          let count = 0;
          let offset = 0;
          const PAGE_SIZE = 20;
          let done = false;

          while (!done) {
            const activities = await runWithAuthRetry((activeClient) =>
              activeClient.getActivities(offset, PAGE_SIZE),
            );
            if (activities.length === 0) break;

            for (const raw of activities) {
              const actStart = new Date(raw.startDate);
              if (actStart < since) {
                done = true;
                break;
              }

              const parsed = parseZwiftActivity(raw);
              try {
                await db
                  .insert(activity)
                  .values({
                    providerId: this.id,
                    externalId: parsed.externalId,
                    activityType: parsed.activityType,
                    name: parsed.name,
                    startedAt: parsed.startedAt,
                    endedAt: parsed.endedAt,
                    raw: parsed.raw,
                  })
                  .onConflictDoUpdate({
                    target: [activity.userId, activity.providerId, activity.externalId],
                    set: {
                      activityType: parsed.activityType,
                      name: parsed.name,
                      startedAt: parsed.startedAt,
                      endedAt: parsed.endedAt,
                      raw: parsed.raw,
                    },
                  });
                count++;

                // Fetch detailed streams
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
                    const metricRows = samples.map((s) => ({
                      providerId: this.id,
                      recordedAt: s.recordedAt,
                      heartRate: s.heartRate,
                      power: s.power,
                      cadence: s.cadence,
                      altitude: s.altitude,
                      lat: s.lat,
                      lng: s.lng,
                    }));
                    await dualWriteToSensorSample(db, metricRows, SOURCE_TYPE_API);
                  }
                } catch (streamErr) {
                  // Non-fatal: log but continue
                  errors.push({
                    message: `streams ${parsed.externalId}: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
                    externalId: parsed.externalId,
                    cause: streamErr,
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

            offset += PAGE_SIZE;
          }

          return { recordCount: count, result: count };
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

    // 2. Sync power curve as daily metrics (FTP, VO2max)
    try {
      const powerCount = await withSyncLog(
        db,
        this.id,
        "power_curve",
        async () => {
          const curve = await runWithAuthRetry((activeClient) => activeClient.getPowerCurve());
          if (!curve.zFtp && !curve.vo2Max) return { recordCount: 0, result: 0 };

          const today = new Date().toISOString().slice(0, 10);
          await db
            .insert(dailyMetrics)
            .values({
              date: today,
              providerId: this.id,
              vo2max: curve.vo2Max,
            })
            .onConflictDoUpdate({
              target: [
                dailyMetrics.userId,
                dailyMetrics.date,
                dailyMetrics.providerId,
                dailyMetrics.sourceName,
              ],
              set: { vo2max: curve.vo2Max },
            });

          return { recordCount: 1, result: 1 };
        },
        options?.userId,
      );
      recordsSynced += powerCount;
    } catch (err) {
      errors.push({
        message: `power_curve: ${err instanceof Error ? err.message : String(err)}`,
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
}
