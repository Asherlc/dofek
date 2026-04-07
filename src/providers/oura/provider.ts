import { z } from "zod";
import { exchangeCodeForTokens } from "../../auth/oauth.ts";
import { resolveOAuthTokens } from "../../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { activity, dailyMetrics, healthEvent, sleepSession } from "../../db/schema.ts";
import { SOURCE_TYPE_API } from "../../db/sensor-channels.ts";
import { dualWriteToSensorSample } from "../../db/sensor-sample-writer.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { ensureProvider } from "../../db/tokens.ts";
import type {
  ProviderAuthSetup,
  ProviderIdentity,
  SyncError,
  SyncOptions,
  SyncResult,
  WebhookEvent,
  WebhookProvider,
} from "../types.ts";
import { OURA_API_BASE, OuraClient } from "./client.ts";
import { formatDate, ouraOAuthConfig } from "./oauth.ts";
import { fetchAllPages, fetchAllPagesOptional, HEALTH_EVENT_BATCH_SIZE } from "./pagination.ts";
import {
  mapOuraActivityType,
  mapOuraSessionType,
  parseOuraDailyMetrics,
  parseOuraSleep,
} from "./parsing.ts";
import type {
  OuraDailyActivity,
  OuraDailyReadiness,
  OuraDailyResilience,
  OuraDailySpO2,
  OuraDailyStress,
  OuraHeartRate,
  OuraSleepDocument,
  OuraVO2Max,
} from "./schemas.ts";

export class OuraProvider implements WebhookProvider {
  readonly id = "oura";
  readonly name = "Oura";
  readonly webhookScope = "app" as const;
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.OURA_CLIENT_ID) return "OURA_CLIENT_ID is not set";
    if (!process.env.OURA_CLIENT_SECRET) return "OURA_CLIENT_SECRET is not set";
    return null;
  }

  // ── Webhook implementation ──

  async registerWebhook(
    callbackUrl: string,
    verifyToken: string,
  ): Promise<{ subscriptionId: string; signingSecret?: string; expiresAt?: Date }> {
    const clientId = process.env.OURA_CLIENT_ID;
    const clientSecret = process.env.OURA_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("OURA_CLIENT_ID and OURA_CLIENT_SECRET are required");
    }

    // Oura requires one subscription per data type. We register for all supported types.
    const dataTypes = [
      "daily_activity",
      "daily_readiness",
      "daily_sleep",
      "workout",
      "session",
      "daily_spo2",
      "daily_stress",
      "daily_resilience",
    ];

    let subscriptionId = "";
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // ~30 days

    for (const dataType of dataTypes) {
      const response = await this.#fetchFn("https://api.ouraring.com/v2/webhook/subscription", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-client-id": clientId,
          "x-client-secret": clientSecret,
        },
        body: JSON.stringify({
          callback_url: callbackUrl,
          verification_token: verifyToken,
          event_type: `create.${dataType}`,
          data_type: dataType,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        // 409 means subscription already exists — continue
        if (response.status !== 409) {
          throw new Error(
            `Oura webhook registration for ${dataType} failed (${response.status}): ${text}`,
          );
        }
      } else {
        const data: { id?: string } = await response.json();
        if (data.id && !subscriptionId) subscriptionId = data.id;
      }
    }

    return { subscriptionId: subscriptionId || "oura-multi-subscription", expiresAt };
  }

  async unregisterWebhook(subscriptionId: string): Promise<void> {
    const clientId = process.env.OURA_CLIENT_ID;
    const clientSecret = process.env.OURA_CLIENT_SECRET;
    if (!clientId || !clientSecret) return;

    await this.#fetchFn(`https://api.ouraring.com/v2/webhook/subscription/${subscriptionId}`, {
      method: "DELETE",
      headers: {
        "x-client-id": clientId,
        "x-client-secret": clientSecret,
      },
    });
  }

  verifyWebhookSignature(
    _rawBody: Buffer,
    _headers: Record<string, string | string[] | undefined>,
    _signingSecret: string,
  ): boolean {
    // Oura verifies via the verification_token challenge at registration time.
    // Incoming events are trusted after successful registration.
    return true;
  }

  parseWebhookPayload(body: unknown): WebhookEvent[] {
    // Oura sends a single event or a verification challenge
    const verificationCheck = z.object({ verification_token: z.string() }).safeParse(body);

    // Verification challenge — not a real event
    if (verificationCheck.success) return [];

    const parsed = z
      .object({
        event_type: z.string().optional(),
        data_type: z.string(),
        user_id: z.string(),
      })
      .safeParse(body);

    if (!parsed.success) return [];
    const event = parsed.data;

    return [
      {
        ownerExternalId: event.user_id,
        eventType: "create",
        objectType: event.data_type,
      },
    ];
  }

  handleValidationChallenge(_query: Record<string, string>, _verifyToken: string): unknown | null {
    // Oura uses POST for verification (sends verification_token in body).
    // This is handled in the POST path — parseWebhookPayload returns empty for verification.
    return null;
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = ouraOAuthConfig(options?.host);
    if (!config) throw new Error("OURA_CLIENT_ID and OURA_CLIENT_SECRET are required");
    const fetchFn = this.#fetchFn;

    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn),
      apiBaseUrl: OURA_API_BASE,
      getUserIdentity: async (accessToken: string): Promise<ProviderIdentity> => {
        const response = await fetchFn(`${OURA_API_BASE}/v2/usercollection/personal_info`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Oura personal info API error (${response.status}): ${text}`);
        }
        const ouraPersonalInfoSchema = z.object({
          id: z.string(),
          email: z.string().nullish(),
        });
        const data = ouraPersonalInfoSchema.parse(await response.json());
        return {
          providerAccountId: data.id,
          email: data.email ?? null,
          name: null,
        };
      },
    };
  }

  async #resolveAccessToken(db: SyncDatabase): Promise<string> {
    const tokens = await resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => ouraOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
    return tokens.accessToken;
  }

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, OURA_API_BASE);

    let accessToken: string;
    try {
      accessToken = await this.#resolveAccessToken(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new OuraClient(accessToken, this.#fetchFn);
    const sinceDate = formatDate(since);
    const todayDate = formatDate(new Date());

    // 1. Sync sleep sessions
    try {
      const sleepCount = await withSyncLog(
        db,
        this.id,
        "sleep",
        async () => {
          let count = 0;
          const allSleep = await fetchAllPages((nextToken) =>
            client.getSleep(sinceDate, todayDate, nextToken),
          );

          for (const raw of allSleep) {
            const parsed = parseOuraSleep(raw);
            try {
              await db
                .insert(sleepSession)
                .values({
                  providerId: this.id,
                  externalId: parsed.externalId,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  durationMinutes: parsed.durationMinutes,
                  deepMinutes: parsed.deepMinutes,
                  remMinutes: parsed.remMinutes,
                  lightMinutes: parsed.lightMinutes,
                  awakeMinutes: parsed.awakeMinutes,
                  efficiencyPct: parsed.efficiencyPct,
                  sleepType: parsed.sleepType,
                })
                .onConflictDoUpdate({
                  target: [sleepSession.userId, sleepSession.providerId, sleepSession.externalId],
                  set: {
                    startedAt: parsed.startedAt,
                    endedAt: parsed.endedAt,
                    durationMinutes: parsed.durationMinutes,
                    deepMinutes: parsed.deepMinutes,
                    remMinutes: parsed.remMinutes,
                    lightMinutes: parsed.lightMinutes,
                    awakeMinutes: parsed.awakeMinutes,
                    efficiencyPct: parsed.efficiencyPct,
                    sleepType: parsed.sleepType,
                  },
                });
              count++;
            } catch (err) {
              errors.push({
                message: err instanceof Error ? err.message : String(err),
                externalId: parsed.externalId,
                cause: err,
              });
            }
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += sleepCount;
    } catch (err) {
      errors.push({
        message: `sleep: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 2. Sync workouts → activity table
    try {
      const workoutCount = await withSyncLog(
        db,
        this.id,
        "workouts",
        async () => {
          let count = 0;
          const allWorkouts = await fetchAllPages((nextToken) =>
            client.getWorkouts(sinceDate, todayDate, nextToken),
          );

          for (const w of allWorkouts) {
            try {
              await db
                .insert(activity)
                .values({
                  providerId: this.id,
                  externalId: w.id,
                  activityType: mapOuraActivityType(w.activity),
                  startedAt: new Date(w.start_datetime),
                  endedAt: new Date(w.end_datetime),
                  name: w.label,
                  raw: w,
                })
                .onConflictDoUpdate({
                  target: [activity.userId, activity.providerId, activity.externalId],
                  set: {
                    activityType: mapOuraActivityType(w.activity),
                    startedAt: new Date(w.start_datetime),
                    endedAt: new Date(w.end_datetime),
                    name: w.label,
                    raw: w,
                  },
                });
              count++;
            } catch (err) {
              errors.push({
                message: `workout ${w.id}: ${err instanceof Error ? err.message : String(err)}`,
                externalId: w.id,
                cause: err,
              });
            }
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += workoutCount;
    } catch (err) {
      errors.push({
        message: `workouts: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 3. Sync sessions (meditation, breathing, etc.) → activity table
    try {
      const sessionCount = await withSyncLog(
        db,
        this.id,
        "sessions",
        async () => {
          let count = 0;
          const allSessions = await fetchAllPages((nextToken) =>
            client.getSessions(sinceDate, todayDate, nextToken),
          );

          for (const s of allSessions) {
            try {
              const sessionActivityType = mapOuraSessionType(s.type);
              await db
                .insert(activity)
                .values({
                  providerId: this.id,
                  externalId: s.id,
                  activityType: sessionActivityType,
                  startedAt: new Date(s.start_datetime),
                  endedAt: new Date(s.end_datetime),
                  name: s.type,
                  raw: s,
                })
                .onConflictDoUpdate({
                  target: [activity.userId, activity.providerId, activity.externalId],
                  set: {
                    activityType: sessionActivityType,
                    startedAt: new Date(s.start_datetime),
                    endedAt: new Date(s.end_datetime),
                    name: s.type,
                    raw: s,
                  },
                });
              count++;
            } catch (err) {
              errors.push({
                message: `session ${s.id}: ${err instanceof Error ? err.message : String(err)}`,
                externalId: s.id,
                cause: err,
              });
            }
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += sessionCount;
    } catch (err) {
      errors.push({
        message: `sessions: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 4. Sync heart rate → sensor_sample table (batched)
    // Oura heart rate API enforces a max 30-day window per request
    try {
      const hrCount = await withSyncLog(
        db,
        this.id,
        "heart_rate",
        async () => {
          const allHr: OuraHeartRate[] = [];
          const windowMs = 30 * 24 * 60 * 60 * 1000;
          let windowStart = since.getTime();
          const end = Date.now();

          while (windowStart < end) {
            const windowEnd = Math.min(windowStart + windowMs, end);
            const startStr = formatDate(new Date(windowStart));
            const endStr = formatDate(new Date(windowEnd));
            // Skip degenerate windows where start and end resolve to the same day
            // (can happen when the 30-day boundary falls on "now")
            if (startStr === endStr) break;
            const chunk = await fetchAllPages((nextToken) =>
              client.getHeartRate(startStr, endStr, nextToken),
            );
            allHr.push(...chunk);
            windowStart = windowEnd;
          }

          const rows = allHr.map((hr) => ({
            providerId: this.id,
            recordedAt: new Date(hr.timestamp),
            heartRate: hr.bpm,
          }));

          await dualWriteToSensorSample(db, rows, SOURCE_TYPE_API);

          return { recordCount: rows.length, result: rows.length };
        },
        options?.userId,
      );
      recordsSynced += hrCount;
    } catch (err) {
      errors.push({
        message: `heart_rate: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 5. Sync daily stress → healthEvent table
    try {
      const stressCount = await withSyncLog(
        db,
        this.id,
        "daily_stress",
        async () => {
          const allStress = await fetchAllPagesOptional(
            (nextToken) => client.getDailyStress(sinceDate, todayDate, nextToken),
            "daily_stress",
          );

          const rows = allStress.map((s) => ({
            providerId: this.id,
            externalId: s.id,
            type: "oura_daily_stress",
            value: s.stress_high,
            valueText: s.day_summary,
            startDate: new Date(`${s.day}T00:00:00`),
          }));

          for (let i = 0; i < rows.length; i += HEALTH_EVENT_BATCH_SIZE) {
            await db
              .insert(healthEvent)
              .values(rows.slice(i, i + HEALTH_EVENT_BATCH_SIZE))
              .onConflictDoUpdate({
                target: [healthEvent.userId, healthEvent.providerId, healthEvent.externalId],
                set: {
                  value: rows[i]?.value,
                  valueText: rows[i]?.valueText,
                },
              });
          }

          return { recordCount: rows.length, result: rows.length };
        },
        options?.userId,
      );
      recordsSynced += stressCount;
    } catch (err) {
      errors.push({
        message: `daily_stress: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 6. Sync daily resilience → healthEvent table
    try {
      const resilienceCount = await withSyncLog(
        db,
        this.id,
        "daily_resilience",
        async () => {
          const allResilience = await fetchAllPagesOptional(
            (nextToken) => client.getDailyResilience(sinceDate, todayDate, nextToken),
            "daily_resilience",
          );

          let count = 0;
          for (const r of allResilience) {
            await db
              .insert(healthEvent)
              .values({
                providerId: this.id,
                externalId: r.id,
                type: "oura_daily_resilience",
                valueText: r.level,
                startDate: new Date(`${r.day}T00:00:00`),
              })
              .onConflictDoUpdate({
                target: [healthEvent.userId, healthEvent.providerId, healthEvent.externalId],
                set: {
                  valueText: r.level,
                },
              });
            count++;
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += resilienceCount;
    } catch (err) {
      errors.push({
        message: `daily_resilience: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 7. Sync daily cardiovascular age → healthEvent table
    try {
      const cvAgeCount = await withSyncLog(
        db,
        this.id,
        "cardiovascular_age",
        async () => {
          const allCvAge = await fetchAllPagesOptional(
            (nextToken) => client.getDailyCardiovascularAge(sinceDate, todayDate, nextToken),
            "cardiovascular_age",
          );

          let count = 0;
          for (const cv of allCvAge) {
            if (cv.vascular_age === null) continue;
            await db
              .insert(healthEvent)
              .values({
                providerId: this.id,
                externalId: `oura_cv_age:${cv.day}`,
                type: "oura_cardiovascular_age",
                value: cv.vascular_age,
                startDate: new Date(`${cv.day}T00:00:00`),
              })
              .onConflictDoUpdate({
                target: [healthEvent.userId, healthEvent.providerId, healthEvent.externalId],
                set: { value: cv.vascular_age },
              });
            count++;
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += cvAgeCount;
    } catch (err) {
      errors.push({
        message: `cardiovascular_age: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 8. Sync tags → healthEvent table
    try {
      const tagCount = await withSyncLog(
        db,
        this.id,
        "tags",
        async () => {
          const allTags = await fetchAllPages((nextToken) =>
            client.getTags(sinceDate, todayDate, nextToken),
          );

          let count = 0;
          for (const t of allTags) {
            await db
              .insert(healthEvent)
              .values({
                providerId: this.id,
                externalId: t.id,
                type: "oura_tag",
                valueText: t.tags.join(", "),
                startDate: new Date(t.timestamp),
              })
              .onConflictDoUpdate({
                target: [healthEvent.userId, healthEvent.providerId, healthEvent.externalId],
                set: { valueText: t.tags.join(", ") },
              });
            count++;
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += tagCount;
    } catch (err) {
      errors.push({
        message: `tags: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 9. Sync enhanced tags → healthEvent table
    try {
      const enhancedTagCount = await withSyncLog(
        db,
        this.id,
        "enhanced_tags",
        async () => {
          const allEnhancedTags = await fetchAllPages((nextToken) =>
            client.getEnhancedTags(sinceDate, todayDate, nextToken),
          );

          let count = 0;
          for (const et of allEnhancedTags) {
            const tagName = et.custom_name ?? et.tag_type_code ?? "unknown";
            await db
              .insert(healthEvent)
              .values({
                providerId: this.id,
                externalId: et.id,
                type: "oura_enhanced_tag",
                valueText: tagName,
                startDate: new Date(et.start_time),
                endDate: et.end_time ? new Date(et.end_time) : undefined,
              })
              .onConflictDoUpdate({
                target: [healthEvent.userId, healthEvent.providerId, healthEvent.externalId],
                set: {
                  valueText: tagName,
                  endDate: et.end_time ? new Date(et.end_time) : undefined,
                },
              });
            count++;
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += enhancedTagCount;
    } catch (err) {
      errors.push({
        message: `enhanced_tags: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 10. Sync rest mode periods → healthEvent table
    try {
      const restModeCount = await withSyncLog(
        db,
        this.id,
        "rest_mode",
        async () => {
          const allRestMode = await fetchAllPages((nextToken) =>
            client.getRestModePeriods(sinceDate, todayDate, nextToken),
          );

          let count = 0;
          for (const rm of allRestMode) {
            const startDate = rm.start_time
              ? new Date(rm.start_time)
              : new Date(`${rm.start_day}T00:00:00`);
            const endDate = rm.end_time
              ? new Date(rm.end_time)
              : rm.end_day
                ? new Date(`${rm.end_day}T23:59:59`)
                : undefined;

            await db
              .insert(healthEvent)
              .values({
                providerId: this.id,
                externalId: rm.id,
                type: "oura_rest_mode",
                startDate,
                endDate,
              })
              .onConflictDoUpdate({
                target: [healthEvent.userId, healthEvent.providerId, healthEvent.externalId],
                set: { endDate },
              });
            count++;
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += restModeCount;
    } catch (err) {
      errors.push({
        message: `rest_mode: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 11. Sync sleep time recommendations → healthEvent table
    try {
      const sleepTimeCount = await withSyncLog(
        db,
        this.id,
        "sleep_time",
        async () => {
          const allSleepTime = await fetchAllPages((nextToken) =>
            client.getSleepTime(sinceDate, todayDate, nextToken),
          );

          let count = 0;
          for (const st of allSleepTime) {
            await db
              .insert(healthEvent)
              .values({
                providerId: this.id,
                externalId: st.id,
                type: "oura_sleep_time",
                valueText: st.recommendation,
                startDate: new Date(`${st.day}T00:00:00`),
              })
              .onConflictDoUpdate({
                target: [healthEvent.userId, healthEvent.providerId, healthEvent.externalId],
                set: { valueText: st.recommendation },
              });
            count++;
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += sleepTimeCount;
    } catch (err) {
      errors.push({
        message: `sleep_time: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // 12. Sync daily metrics (readiness + activity + SpO2 + VO2 max + stress + resilience merged by day)
    try {
      const dailyCount = await withSyncLog(
        db,
        this.id,
        "daily_metrics",
        async () => {
          let count = 0;

          const [
            allReadiness,
            allActivity,
            allSpO2,
            allVO2Max,
            allStress,
            allResilience,
            allSleep,
          ] = await Promise.all([
            fetchAllPages((nextToken) => client.getDailyReadiness(sinceDate, todayDate, nextToken)),
            fetchAllPages((nextToken) => client.getDailyActivity(sinceDate, todayDate, nextToken)),
            fetchAllPages((nextToken) => client.getDailySpO2(sinceDate, todayDate, nextToken)),
            fetchAllPagesOptional(
              (nextToken) => client.getVO2Max(sinceDate, todayDate, nextToken),
              "vO2_max",
            ),
            fetchAllPagesOptional(
              (nextToken) => client.getDailyStress(sinceDate, todayDate, nextToken),
              "daily_stress",
            ),
            fetchAllPagesOptional(
              (nextToken) => client.getDailyResilience(sinceDate, todayDate, nextToken),
              "daily_resilience",
            ),
            fetchAllPages((nextToken) => client.getSleep(sinceDate, todayDate, nextToken)),
          ]);

          // Index by day for merging
          const readinessByDay = new Map<string, OuraDailyReadiness>();
          for (const r of allReadiness) readinessByDay.set(r.day, r);

          const activityByDay = new Map<string, OuraDailyActivity>();
          for (const a of allActivity) activityByDay.set(a.day, a);

          const spo2ByDay = new Map<string, OuraDailySpO2>();
          for (const s of allSpO2) spo2ByDay.set(s.day, s);

          const vo2maxByDay = new Map<string, OuraVO2Max>();
          for (const v of allVO2Max) vo2maxByDay.set(v.day, v);

          const stressByDay = new Map<string, OuraDailyStress>();
          for (const s of allStress) stressByDay.set(s.day, s);

          const resilienceByDay = new Map<string, OuraDailyResilience>();
          for (const r of allResilience) resilienceByDay.set(r.day, r);

          // Index primary sleep (long_sleep/sleep) by day for HRV + resting HR.
          // Prefer long_sleep over other types since it represents the main overnight session.
          const primarySleepByDay = new Map<string, OuraSleepDocument>();
          for (const s of allSleep) {
            if (s.type === "long_sleep" || s.type === "sleep") {
              const existing = primarySleepByDay.get(s.day);
              if (!existing || (s.type === "long_sleep" && existing.type !== "long_sleep")) {
                primarySleepByDay.set(s.day, s);
              }
            }
          }

          // Union of all days
          const allDays = new Set([
            ...readinessByDay.keys(),
            ...activityByDay.keys(),
            ...spo2ByDay.keys(),
            ...vo2maxByDay.keys(),
            ...stressByDay.keys(),
            ...resilienceByDay.keys(),
          ]);

          for (const day of allDays) {
            const readiness = readinessByDay.get(day) ?? null;
            const activityDoc = activityByDay.get(day) ?? null;
            const spo2 = spo2ByDay.get(day) ?? null;
            const vo2max = vo2maxByDay.get(day) ?? null;
            const stress = stressByDay.get(day) ?? null;
            const resilience = resilienceByDay.get(day) ?? null;
            const sleep = primarySleepByDay.get(day) ?? null;
            const parsed = parseOuraDailyMetrics(
              readiness,
              activityDoc,
              spo2,
              vo2max,
              stress,
              resilience,
              sleep,
            );

            try {
              await db
                .insert(dailyMetrics)
                .values({
                  date: parsed.date,
                  providerId: this.id,
                  steps: parsed.steps,
                  restingHr: parsed.restingHr,
                  hrv: parsed.hrv,
                  activeEnergyKcal: parsed.activeEnergyKcal,
                  exerciseMinutes: parsed.exerciseMinutes,
                  skinTempC: parsed.skinTempC,
                  spo2Avg: parsed.spo2Avg,
                  vo2max: parsed.vo2max,
                  stressHighMinutes: parsed.stressHighMinutes,
                  recoveryHighMinutes: parsed.recoveryHighMinutes,
                  resilienceLevel: parsed.resilienceLevel,
                })
                .onConflictDoUpdate({
                  target: [
                    dailyMetrics.userId,
                    dailyMetrics.date,
                    dailyMetrics.providerId,
                    dailyMetrics.sourceName,
                  ],
                  set: {
                    steps: parsed.steps,
                    restingHr: parsed.restingHr,
                    hrv: parsed.hrv,
                    activeEnergyKcal: parsed.activeEnergyKcal,
                    exerciseMinutes: parsed.exerciseMinutes,
                    skinTempC: parsed.skinTempC,
                    spo2Avg: parsed.spo2Avg,
                    vo2max: parsed.vo2max,
                    stressHighMinutes: parsed.stressHighMinutes,
                    recoveryHighMinutes: parsed.recoveryHighMinutes,
                    resilienceLevel: parsed.resilienceLevel,
                  },
                });
              count++;
            } catch (err) {
              errors.push({
                message: `daily_metrics ${day}: ${err instanceof Error ? err.message : String(err)}`,
                cause: err,
              });
            }
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += dailyCount;
    } catch (err) {
      errors.push({
        message: `daily_metrics: ${err instanceof Error ? err.message : String(err)}`,
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

  // ── Webhook-triggered targeted sync ──

  async syncWebhookEvent(
    db: SyncDatabase,
    event: WebhookEvent,
    options?: SyncOptions,
  ): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, OURA_API_BASE);

    let accessToken: string;
    try {
      accessToken = await this.#resolveAccessToken(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new OuraClient(accessToken, this.#fetchFn);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sinceDate = formatDate(yesterday);
    const todayDate = formatDate(new Date());
    const dataType = event.objectType;

    // Sync the specific data type that the webhook reported
    switch (dataType) {
      case "workout": {
        try {
          const count = await withSyncLog(
            db,
            this.id,
            "workouts",
            async () => {
              let count = 0;
              const allWorkouts = await fetchAllPages((nextToken) =>
                client.getWorkouts(sinceDate, todayDate, nextToken),
              );

              for (const w of allWorkouts) {
                try {
                  await db
                    .insert(activity)
                    .values({
                      providerId: this.id,
                      externalId: w.id,
                      activityType: mapOuraActivityType(w.activity),
                      startedAt: new Date(w.start_datetime),
                      endedAt: new Date(w.end_datetime),
                      name: w.label,
                      raw: w,
                    })
                    .onConflictDoUpdate({
                      target: [activity.userId, activity.providerId, activity.externalId],
                      set: {
                        activityType: mapOuraActivityType(w.activity),
                        startedAt: new Date(w.start_datetime),
                        endedAt: new Date(w.end_datetime),
                        name: w.label,
                        raw: w,
                      },
                    });
                  count++;
                } catch (err) {
                  errors.push({
                    message: `workout ${w.id}: ${err instanceof Error ? err.message : String(err)}`,
                    externalId: w.id,
                    cause: err,
                  });
                }
              }

              return { recordCount: count, result: count };
            },
            options?.userId,
          );
          recordsSynced += count;
        } catch (err) {
          errors.push({
            message: `workouts: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
        }
        break;
      }

      case "session": {
        try {
          const count = await withSyncLog(
            db,
            this.id,
            "sessions",
            async () => {
              let count = 0;
              const allSessions = await fetchAllPages((nextToken) =>
                client.getSessions(sinceDate, todayDate, nextToken),
              );

              for (const s of allSessions) {
                try {
                  const sessionActivityType = mapOuraSessionType(s.type);
                  await db
                    .insert(activity)
                    .values({
                      providerId: this.id,
                      externalId: s.id,
                      activityType: sessionActivityType,
                      startedAt: new Date(s.start_datetime),
                      endedAt: new Date(s.end_datetime),
                      name: s.type,
                      raw: s,
                    })
                    .onConflictDoUpdate({
                      target: [activity.userId, activity.providerId, activity.externalId],
                      set: {
                        activityType: sessionActivityType,
                        startedAt: new Date(s.start_datetime),
                        endedAt: new Date(s.end_datetime),
                        name: s.type,
                        raw: s,
                      },
                    });
                  count++;
                } catch (err) {
                  errors.push({
                    message: `session ${s.id}: ${err instanceof Error ? err.message : String(err)}`,
                    externalId: s.id,
                    cause: err,
                  });
                }
              }

              return { recordCount: count, result: count };
            },
            options?.userId,
          );
          recordsSynced += count;
        } catch (err) {
          errors.push({
            message: `sessions: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
        }
        break;
      }

      case "sleep":
      case "daily_sleep": {
        try {
          const count = await withSyncLog(
            db,
            this.id,
            "sleep",
            async () => {
              let count = 0;
              const allSleep = await fetchAllPages((nextToken) =>
                client.getSleep(sinceDate, todayDate, nextToken),
              );

              for (const raw of allSleep) {
                const parsed = parseOuraSleep(raw);
                try {
                  await db
                    .insert(sleepSession)
                    .values({
                      providerId: this.id,
                      externalId: parsed.externalId,
                      startedAt: parsed.startedAt,
                      endedAt: parsed.endedAt,
                      durationMinutes: parsed.durationMinutes,
                      deepMinutes: parsed.deepMinutes,
                      remMinutes: parsed.remMinutes,
                      lightMinutes: parsed.lightMinutes,
                      awakeMinutes: parsed.awakeMinutes,
                      efficiencyPct: parsed.efficiencyPct,
                      sleepType: parsed.sleepType,
                    })
                    .onConflictDoUpdate({
                      target: [
                        sleepSession.userId,
                        sleepSession.providerId,
                        sleepSession.externalId,
                      ],
                      set: {
                        startedAt: parsed.startedAt,
                        endedAt: parsed.endedAt,
                        durationMinutes: parsed.durationMinutes,
                        deepMinutes: parsed.deepMinutes,
                        remMinutes: parsed.remMinutes,
                        lightMinutes: parsed.lightMinutes,
                        awakeMinutes: parsed.awakeMinutes,
                        efficiencyPct: parsed.efficiencyPct,
                        sleepType: parsed.sleepType,
                      },
                    });
                  count++;
                } catch (err) {
                  errors.push({
                    message: err instanceof Error ? err.message : String(err),
                    externalId: parsed.externalId,
                    cause: err,
                  });
                }
              }

              return { recordCount: count, result: count };
            },
            options?.userId,
          );
          recordsSynced += count;
        } catch (err) {
          errors.push({
            message: `sleep: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
        }
        break;
      }

      case "daily_stress": {
        // Sync stress healthEvents
        try {
          const stressCount = await withSyncLog(
            db,
            this.id,
            "daily_stress",
            async () => {
              const allStress = await fetchAllPages((nextToken) =>
                client.getDailyStress(sinceDate, todayDate, nextToken),
              );

              const rows = allStress.map((s) => ({
                providerId: this.id,
                externalId: s.id,
                type: "oura_daily_stress",
                value: s.stress_high,
                valueText: s.day_summary,
                startDate: new Date(`${s.day}T00:00:00`),
              }));

              for (let i = 0; i < rows.length; i += HEALTH_EVENT_BATCH_SIZE) {
                await db
                  .insert(healthEvent)
                  .values(rows.slice(i, i + HEALTH_EVENT_BATCH_SIZE))
                  .onConflictDoUpdate({
                    target: [healthEvent.userId, healthEvent.providerId, healthEvent.externalId],
                    set: {
                      value: rows[i]?.value,
                      valueText: rows[i]?.valueText,
                    },
                  });
              }

              return { recordCount: rows.length, result: rows.length };
            },
            options?.userId,
          );
          recordsSynced += stressCount;
        } catch (err) {
          errors.push({
            message: `daily_stress: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
        }

        // Also refresh daily metrics composite (stress columns merge into daily_metrics row)
        recordsSynced += await this.#syncDailyMetrics(
          db,
          client,
          sinceDate,
          todayDate,
          errors,
          options,
        );
        break;
      }

      case "daily_resilience": {
        // Sync resilience healthEvents
        try {
          const resilienceCount = await withSyncLog(
            db,
            this.id,
            "daily_resilience",
            async () => {
              const allResilience = await fetchAllPages((nextToken) =>
                client.getDailyResilience(sinceDate, todayDate, nextToken),
              );

              let count = 0;
              for (const r of allResilience) {
                await db
                  .insert(healthEvent)
                  .values({
                    providerId: this.id,
                    externalId: r.id,
                    type: "oura_daily_resilience",
                    valueText: r.level,
                    startDate: new Date(`${r.day}T00:00:00`),
                  })
                  .onConflictDoUpdate({
                    target: [healthEvent.userId, healthEvent.providerId, healthEvent.externalId],
                    set: {
                      valueText: r.level,
                    },
                  });
                count++;
              }

              return { recordCount: count, result: count };
            },
            options?.userId,
          );
          recordsSynced += resilienceCount;
        } catch (err) {
          errors.push({
            message: `daily_resilience: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
        }

        // Also refresh daily metrics composite (resilience columns merge into daily_metrics row)
        recordsSynced += await this.#syncDailyMetrics(
          db,
          client,
          sinceDate,
          todayDate,
          errors,
          options,
        );
        break;
      }

      case "daily_activity":
      case "daily_readiness":
      case "daily_spo2": {
        // These types only contribute to the daily_metrics composite row
        recordsSynced += await this.#syncDailyMetrics(
          db,
          client,
          sinceDate,
          todayDate,
          errors,
          options,
        );
        break;
      }

      default: {
        // Unknown data type — no-op, return empty result
        break;
      }
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }

  /**
   * Sync the composite daily metrics row (readiness + activity + SpO2 + VO2 max + stress + resilience merged by day).
   * Extracted as a shared helper because multiple webhook data_types need to refresh this composite.
   */
  async #syncDailyMetrics(
    db: SyncDatabase,
    client: OuraClient,
    sinceDate: string,
    todayDate: string,
    errors: SyncError[],
    options?: SyncOptions,
  ): Promise<number> {
    try {
      return await withSyncLog(
        db,
        this.id,
        "daily_metrics",
        async () => {
          let count = 0;

          const [
            allReadiness,
            allActivity,
            allSpO2,
            allVO2Max,
            allStress,
            allResilience,
            allSleep,
          ] = await Promise.all([
            fetchAllPages((nextToken) => client.getDailyReadiness(sinceDate, todayDate, nextToken)),
            fetchAllPages((nextToken) => client.getDailyActivity(sinceDate, todayDate, nextToken)),
            fetchAllPages((nextToken) => client.getDailySpO2(sinceDate, todayDate, nextToken)),
            fetchAllPages((nextToken) => client.getVO2Max(sinceDate, todayDate, nextToken)),
            fetchAllPages((nextToken) => client.getDailyStress(sinceDate, todayDate, nextToken)),
            fetchAllPages((nextToken) =>
              client.getDailyResilience(sinceDate, todayDate, nextToken),
            ),
            fetchAllPages((nextToken) => client.getSleep(sinceDate, todayDate, nextToken)),
          ]);

          // Index by day for merging
          const readinessByDay = new Map<string, OuraDailyReadiness>();
          for (const r of allReadiness) readinessByDay.set(r.day, r);

          const activityByDay = new Map<string, OuraDailyActivity>();
          for (const a of allActivity) activityByDay.set(a.day, a);

          const spo2ByDay = new Map<string, OuraDailySpO2>();
          for (const s of allSpO2) spo2ByDay.set(s.day, s);

          const vo2maxByDay = new Map<string, OuraVO2Max>();
          for (const v of allVO2Max) vo2maxByDay.set(v.day, v);

          const stressByDay = new Map<string, OuraDailyStress>();
          for (const s of allStress) stressByDay.set(s.day, s);

          const resilienceByDay = new Map<string, OuraDailyResilience>();
          for (const r of allResilience) resilienceByDay.set(r.day, r);

          const primarySleepByDay = new Map<string, OuraSleepDocument>();
          for (const s of allSleep) {
            if (s.type === "long_sleep" || s.type === "sleep") {
              const existing = primarySleepByDay.get(s.day);
              if (!existing || (s.type === "long_sleep" && existing.type !== "long_sleep")) {
                primarySleepByDay.set(s.day, s);
              }
            }
          }

          // Union of all days
          const allDays = new Set([
            ...readinessByDay.keys(),
            ...activityByDay.keys(),
            ...spo2ByDay.keys(),
            ...vo2maxByDay.keys(),
            ...stressByDay.keys(),
            ...resilienceByDay.keys(),
          ]);

          for (const day of allDays) {
            const readiness = readinessByDay.get(day) ?? null;
            const activityDoc = activityByDay.get(day) ?? null;
            const spo2 = spo2ByDay.get(day) ?? null;
            const vo2max = vo2maxByDay.get(day) ?? null;
            const stress = stressByDay.get(day) ?? null;
            const resilience = resilienceByDay.get(day) ?? null;
            const sleep = primarySleepByDay.get(day) ?? null;
            const parsed = parseOuraDailyMetrics(
              readiness,
              activityDoc,
              spo2,
              vo2max,
              stress,
              resilience,
              sleep,
            );

            try {
              await db
                .insert(dailyMetrics)
                .values({
                  date: parsed.date,
                  providerId: this.id,
                  steps: parsed.steps,
                  restingHr: parsed.restingHr,
                  hrv: parsed.hrv,
                  activeEnergyKcal: parsed.activeEnergyKcal,
                  exerciseMinutes: parsed.exerciseMinutes,
                  skinTempC: parsed.skinTempC,
                  spo2Avg: parsed.spo2Avg,
                  vo2max: parsed.vo2max,
                  stressHighMinutes: parsed.stressHighMinutes,
                  recoveryHighMinutes: parsed.recoveryHighMinutes,
                  resilienceLevel: parsed.resilienceLevel,
                })
                .onConflictDoUpdate({
                  target: [
                    dailyMetrics.userId,
                    dailyMetrics.date,
                    dailyMetrics.providerId,
                    dailyMetrics.sourceName,
                  ],
                  set: {
                    steps: parsed.steps,
                    restingHr: parsed.restingHr,
                    hrv: parsed.hrv,
                    activeEnergyKcal: parsed.activeEnergyKcal,
                    exerciseMinutes: parsed.exerciseMinutes,
                    skinTempC: parsed.skinTempC,
                    spo2Avg: parsed.spo2Avg,
                    vo2max: parsed.vo2max,
                    stressHighMinutes: parsed.stressHighMinutes,
                    recoveryHighMinutes: parsed.recoveryHighMinutes,
                    resilienceLevel: parsed.resilienceLevel,
                  },
                });
              count++;
            } catch (err) {
              errors.push({
                message: `daily_metrics ${day}: ${err instanceof Error ? err.message : String(err)}`,
                cause: err,
              });
            }
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
    } catch (err) {
      errors.push({
        message: `daily_metrics: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
      return 0;
    }
  }
}
