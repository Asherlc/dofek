import { z } from "zod";
import {
  parseZwiftActivity,
  parseZwiftFitnessData,
  ZWIFT_API_BASE,
  ZWIFT_AUTH_URL,
  ZwiftClient,
} from "zwift-client";
import type { SyncDatabase } from "../db/index.ts";
import { activity, dailyMetrics, metricStream } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import type { Provider, ProviderAuthSetup, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Provider implementation
// ============================================================

export class ZwiftProvider implements Provider {
  readonly id = "zwift";
  readonly name = "Zwift";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const fetchFn = this.fetchFn;
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
          JSON.parse(Buffer.from(result.accessToken.split(".")[1] ?? "", "base64").toString()),
        );
        const athleteId = payload.sub ?? "";

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

  private async resolveTokens(
    db: SyncDatabase,
  ): Promise<{ accessToken: string; athleteId: number }> {
    const stored = await loadTokens(db, this.id);
    if (!stored) {
      throw new Error("Zwift not connected — authenticate via the web UI");
    }

    const athleteIdMatch = stored.scopes?.match(/athleteId:(\S+)/);
    const athleteId = athleteIdMatch ? Number(athleteIdMatch[1]) : 0;
    if (!athleteId) {
      throw new Error("Zwift athlete ID not found — re-authenticate");
    }

    // Refresh if expired
    if (stored.expiresAt <= new Date()) {
      if (!stored.refreshToken) {
        throw new Error("Zwift token expired and no refresh token — re-authenticate");
      }
      console.log("[zwift] Token expired, refreshing...");
      const refreshed = await ZwiftClient.refreshToken(stored.refreshToken, this.fetchFn);
      const tokens = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
        scopes: `athleteId:${athleteId}`,
      };
      await saveTokens(db, this.id, tokens);
      return { accessToken: refreshed.accessToken, athleteId };
    }

    return { accessToken: stored.accessToken, athleteId };
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, ZWIFT_API_BASE);

    let client: ZwiftClient;
    try {
      const { accessToken, athleteId } = await this.resolveTokens(db);
      client = new ZwiftClient(accessToken, athleteId, this.fetchFn);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // 1. Sync activities (paginated)
    try {
      const activityCount = await withSyncLog(db, this.id, "activity", async () => {
        let count = 0;
        let offset = 0;
        const PAGE_SIZE = 20;
        let done = false;

        while (!done) {
          const activities = await client.getActivities(offset, PAGE_SIZE);
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
                  target: [activity.providerId, activity.externalId],
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
                const detail = await client.getActivityDetail(raw.id);
                if (detail.fitnessData?.fullDataUrl) {
                  const fitnessData = await client.getFitnessData(detail.fitnessData.fullDataUrl);
                  const samples = parseZwiftFitnessData(fitnessData, parsed.startedAt);
                  const BATCH_SIZE = 500;
                  for (let i = 0; i < samples.length; i += BATCH_SIZE) {
                    const batch = samples.slice(i, i + BATCH_SIZE);
                    await db
                      .insert(metricStream)
                      .values(
                        batch.map((s) => ({
                          providerId: this.id,
                          recordedAt: s.recordedAt,
                          heartRate: s.heartRate,
                          power: s.power,
                          cadence: s.cadence,
                          speed: s.speed,
                          altitude: s.altitude,
                          distance: s.distance,
                          lat: s.lat,
                          lng: s.lng,
                        })),
                      )
                      .onConflictDoNothing();
                  }
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
      });
      recordsSynced += activityCount;
    } catch (err) {
      errors.push({
        message: `activity: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 2. Sync power curve as daily metrics (FTP, VO2max)
    try {
      const powerCount = await withSyncLog(db, this.id, "power_curve", async () => {
        const curve = await client.getPowerCurve();
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
            target: [dailyMetrics.date, dailyMetrics.providerId],
            set: { vo2max: curve.vo2Max },
          });

        return { recordCount: 1, result: 1 };
      });
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
