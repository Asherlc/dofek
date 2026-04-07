import { createHmac } from "node:crypto";
import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../../auth/oauth.ts";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  getOAuthRedirectUri,
} from "../../auth/oauth.ts";
import { resolveOAuthTokens } from "../../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../../db/index.ts";
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
import { FITBIT_API_BASE, FitbitClient } from "./client.ts";
import {
  parseFitbitActivity,
  parseFitbitDailySummary,
  parseFitbitSleep,
  parseFitbitWeightLog,
} from "./parsers.ts";
import {
  persistActivity,
  persistBodyMeasurement,
  persistDailyMetrics,
  persistSleep,
} from "./persisters.ts";

// ============================================================
// OAuth configuration
// ============================================================

export function fitbitOAuthConfig(host?: string): OAuthConfig | null {
  const clientId = process.env.FITBIT_CLIENT_ID;
  const clientSecret = process.env.FITBIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    authorizeUrl: "https://www.fitbit.com/oauth2/authorize",
    tokenUrl: `${FITBIT_API_BASE}/oauth2/token`,
    redirectUri: getOAuthRedirectUri(host),
    scopes: [
      "activity",
      "heartrate",
      "sleep",
      "weight",
      "profile",
      "oxygen_saturation",
      "respiratory_rate",
      "temperature",
    ],
    usePkce: true,
  };
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ============================================================
// Provider implementation
// ============================================================

export class FitbitProvider implements WebhookProvider {
  readonly id = "fitbit";
  readonly name = "Fitbit";
  readonly webhookScope = "app" as const;
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.FITBIT_CLIENT_ID) return "FITBIT_CLIENT_ID is not set";
    if (!process.env.FITBIT_CLIENT_SECRET) return "FITBIT_CLIENT_SECRET is not set";
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://www.fitbit.com/activities/exercise/${externalId}`;
  }

  // ── Webhook implementation ──

  async registerWebhook(
    _callbackUrl: string,
    verifyToken: string,
  ): Promise<{ subscriptionId: string; signingSecret?: string; expiresAt?: Date }> {
    return {
      subscriptionId: "fitbit-app-subscription",
      signingSecret: verifyToken,
    };
  }

  async unregisterWebhook(_subscriptionId: string): Promise<void> {}

  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    signingSecret: string,
  ): boolean {
    const signature = headers["x-fitbit-signature"];
    if (!signature || typeof signature !== "string") return false;

    const hmac = createHmac("sha1", `${signingSecret}&`);
    hmac.update(rawBody);
    const expected = hmac.digest("base64");
    return signature === expected;
  }

  parseWebhookPayload(body: unknown): WebhookEvent[] {
    if (!Array.isArray(body)) return [];

    const itemSchema = z.object({
      collectionType: z.string(),
      ownerId: z.string(),
      date: z.string().optional(),
      subscriptionId: z.string().optional(),
    });

    return body
      .map((notification: unknown) => itemSchema.safeParse(notification))
      .filter((result): result is z.SafeParseSuccess<z.infer<typeof itemSchema>> => result.success)
      .map((result) => ({
        ownerExternalId: result.data.ownerId,
        eventType: "update" as const,
        objectType: result.data.collectionType,
        metadata: result.data.date ? { date: result.data.date } : undefined,
      }));
  }

  handleValidationChallenge(query: Record<string, string>, verifyToken: string): unknown | null {
    const verify = query.verify;
    if (!verify) return null;
    if (verify !== verifyToken) return null;
    return "";
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = fitbitOAuthConfig(options?.host);
    if (!config) throw new Error("FITBIT_CLIENT_ID and FITBIT_CLIENT_SECRET are required");
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const fetchFn = this.#fetchFn;

    return {
      oauthConfig: config,
      authUrl: buildAuthorizationUrl(config, { codeChallenge }),
      exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn, { codeVerifier }),
      apiBaseUrl: FITBIT_API_BASE,
      getUserIdentity: async (accessToken: string): Promise<ProviderIdentity> => {
        const response = await fetchFn(`${FITBIT_API_BASE}/1/user/-/profile.json`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Fitbit profile API error (${response.status}): ${text}`);
        }
        const data: {
          user: { encodedId: string; displayName?: string | null };
        } = await response.json();
        return {
          providerAccountId: data.user.encodedId,
          email: null,
          name: data.user.displayName ?? null,
        };
      },
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => fitbitOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(db: SyncDatabase, since: Date, options?: SyncOptions): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, FITBIT_API_BASE);

    let tokens: TokenSet;
    try {
      tokens = await this.#resolveTokens(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new FitbitClient(tokens.accessToken, this.#fetchFn);
    const sinceDate = formatDate(since);

    // 1. Sync activities
    try {
      const activityCount = await withSyncLog(
        db,
        this.id,
        "activity",
        async () => {
          let count = 0;
          let offset = 0;
          let hasMore = true;

          while (hasMore) {
            const response = await client.getActivities(sinceDate, offset);

            for (const raw of response.activities) {
              const parsed = parseFitbitActivity(raw);
              try {
                const { errors: activityErrors } = await persistActivity(db, parsed, raw, client);
                errors.push(...activityErrors);
                count++;
              } catch (err) {
                errors.push({
                  message: err instanceof Error ? err.message : String(err),
                  externalId: parsed.externalId,
                  cause: err,
                });
              }
            }

            hasMore = response.pagination.next !== "";
            offset += response.pagination.limit;
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

    // 2. Sync sleep
    try {
      const sleepCount = await withSyncLog(
        db,
        this.id,
        "sleep",
        async () => {
          let count = 0;
          let offset = 0;
          let hasMore = true;

          while (hasMore) {
            const response = await client.getSleepLogs(sinceDate, offset);

            for (const raw of response.sleep) {
              const parsed = parseFitbitSleep(raw);
              try {
                await persistSleep(db, parsed);
                count++;
              } catch (err) {
                errors.push({
                  message: err instanceof Error ? err.message : String(err),
                  externalId: parsed.externalId,
                  cause: err,
                });
              }
            }

            hasMore = response.pagination.next !== "";
            offset += response.pagination.limit;
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

    // 3. Sync daily summaries (day-by-day iteration)
    try {
      const dailyCount = await withSyncLog(
        db,
        this.id,
        "daily_metrics",
        async () => {
          let count = 0;
          const today = new Date();
          const currentDate = new Date(since);

          while (currentDate <= today) {
            const dateStr = formatDate(currentDate);
            try {
              const response = await client.getDailySummary(dateStr);
              const parsed = parseFitbitDailySummary(dateStr, response);
              await persistDailyMetrics(db, parsed);
              count++;
            } catch (err) {
              errors.push({
                message: `daily_metrics ${dateStr}: ${err instanceof Error ? err.message : String(err)}`,
                cause: err,
              });
            }

            currentDate.setDate(currentDate.getDate() + 1);
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

    // 4. Sync body weight logs (30-day windows)
    try {
      const weightCount = await withSyncLog(
        db,
        this.id,
        "body_measurement",
        async () => {
          let count = 0;
          const today = new Date();
          const currentDate = new Date(since);

          while (currentDate <= today) {
            const dateStr = formatDate(currentDate);
            try {
              const response = await client.getWeightLogs(dateStr);

              for (const raw of response.weight) {
                const parsed = parseFitbitWeightLog(raw);
                try {
                  await persistBodyMeasurement(db, parsed);
                  count++;
                } catch (err) {
                  errors.push({
                    message: err instanceof Error ? err.message : String(err),
                    externalId: parsed.externalId,
                    cause: err,
                  });
                }
              }
            } catch (err) {
              errors.push({
                message: `weight ${dateStr}: ${err instanceof Error ? err.message : String(err)}`,
                cause: err,
              });
            }

            currentDate.setDate(currentDate.getDate() + 30);
          }

          return { recordCount: count, result: count };
        },
        options?.userId,
      );
      recordsSynced += weightCount;
    } catch (err) {
      errors.push({
        message: `body_measurement: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }

  async syncWebhookEvent(
    db: SyncDatabase,
    event: WebhookEvent,
    options?: SyncOptions,
  ): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    let tokens: TokenSet;
    try {
      tokens = await this.#resolveTokens(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new FitbitClient(tokens.accessToken, this.#fetchFn);
    const eventDate =
      typeof event.metadata?.date === "string" ? event.metadata.date : formatDate(new Date());

    switch (event.objectType) {
      case "activities": {
        try {
          const activityCount = await withSyncLog(
            db,
            this.id,
            "activity",
            async () => {
              let count = 0;
              let offset = 0;
              let hasMore = true;

              while (hasMore) {
                const response = await client.getActivities(eventDate, offset);

                for (const raw of response.activities) {
                  const parsed = parseFitbitActivity(raw);
                  try {
                    const { errors: activityErrors } = await persistActivity(db, parsed, raw);
                    errors.push(...activityErrors);
                    count++;
                  } catch (err) {
                    errors.push({
                      message: err instanceof Error ? err.message : String(err),
                      externalId: parsed.externalId,
                      cause: err,
                    });
                  }
                }

                hasMore = response.pagination.next !== "";
                offset += response.pagination.limit;
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

        try {
          const dailyCount = await withSyncLog(
            db,
            this.id,
            "daily_metrics",
            async () => {
              const response = await client.getDailySummary(eventDate);
              const parsed = parseFitbitDailySummary(eventDate, response);
              await persistDailyMetrics(db, parsed);
              return { recordCount: 1, result: 1 };
            },
            options?.userId,
          );
          recordsSynced += dailyCount;
        } catch (err) {
          errors.push({
            message: `daily_metrics ${eventDate}: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
        }
        break;
      }

      case "sleep": {
        try {
          const sleepCount = await withSyncLog(
            db,
            this.id,
            "sleep",
            async () => {
              let count = 0;
              let offset = 0;
              let hasMore = true;

              while (hasMore) {
                const response = await client.getSleepLogs(eventDate, offset);

                for (const raw of response.sleep) {
                  const parsed = parseFitbitSleep(raw);
                  try {
                    await persistSleep(db, parsed);
                    count++;
                  } catch (err) {
                    errors.push({
                      message: err instanceof Error ? err.message : String(err),
                      externalId: parsed.externalId,
                      cause: err,
                    });
                  }
                }

                hasMore = response.pagination.next !== "";
                offset += response.pagination.limit;
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
        break;
      }

      case "body": {
        try {
          const weightCount = await withSyncLog(
            db,
            this.id,
            "body_measurement",
            async () => {
              let count = 0;
              const response = await client.getWeightLogs(eventDate);

              for (const raw of response.weight) {
                const parsed = parseFitbitWeightLog(raw);
                try {
                  await persistBodyMeasurement(db, parsed);
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
          recordsSynced += weightCount;
        } catch (err) {
          errors.push({
            message: `body_measurement: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
        }
        break;
      }

      default:
        break;
    }

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }
}
