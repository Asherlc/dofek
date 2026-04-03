import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity, sensorSample } from "../db/schema.ts";
import { SOURCE_TYPE_API } from "../db/sensor-channels.ts";
import { dualWriteToSensorSample } from "../db/sensor-sample-writer.ts";
import { getTokenUserId } from "../db/token-user-context.ts";
import { logger } from "../logger.ts";
import {
  StravaClient,
  StravaNotFoundError,
  StravaRateLimitError,
  STRAVA_THROTTLE_MS,
  StravaUnauthorizedError,
} from "./strava/client.ts";
import {
  parseStravaActivity,
  parseStravaActivityList,
  stravaStreamsToMetricStream,
} from "./strava/mapping.ts";
import type { StravaActivity } from "./strava/types.ts";
import type {
  ProviderAuthSetup,
  ProviderIdentity,
  SyncError,
  SyncOptions,
  SyncResult,
  WebhookEvent,
  WebhookProvider,
} from "./types.ts";

// ============================================================
// Strava OAuth Config
// ============================================================

const STRAVA_AUTH_BASE = "https://www.strava.com/oauth";
const STRAVA_API_BASE = "https://www.strava.com/api/v3/";

export function stravaOAuthConfig(host?: string): OAuthConfig | null {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    authorizeUrl: `${STRAVA_AUTH_BASE}/authorize`,
    tokenUrl: `${STRAVA_AUTH_BASE}/token`,
    redirectUri: getOAuthRedirectUri(host),
    scopes: ["read", "activity:read_all"],
    scopeSeparator: ",",
  };
}

export { STRAVA_THROTTLE_MS } from "./strava/client.ts";

export class StravaProvider implements WebhookProvider {
  readonly id = "strava";
  readonly name = "Strava";
  readonly webhookScope = "app" as const;
  #fetchFn: typeof globalThis.fetch;
  #throttleMs: number;

  constructor(
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
    throttleMs = STRAVA_THROTTLE_MS,
  ) {
    this.#fetchFn = fetchFn;
    this.#throttleMs = throttleMs;
  }

  validate(): string | null {
    if (!process.env.STRAVA_CLIENT_ID) return "STRAVA_CLIENT_ID is not set";
    if (!process.env.STRAVA_CLIENT_SECRET) return "STRAVA_CLIENT_SECRET is not set";
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://www.strava.com/activities/${externalId}`;
  }

  // ── Webhook implementation ──

  async registerWebhook(
    callbackUrl: string,
    verifyToken: string,
  ): Promise<{ subscriptionId: string; signingSecret?: string; expiresAt?: Date }> {
    const clientId = process.env.STRAVA_CLIENT_ID;
    const clientSecret = process.env.STRAVA_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET are required");
    }

    const response = await this.#fetchFn("https://www.strava.com/api/v3/push_subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        callback_url: callbackUrl,
        verify_token: verifyToken,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Strava webhook registration failed (${response.status}): ${text}`);
    }

    const data: { id: number } = await response.json();
    return { subscriptionId: String(data.id) };
  }

  async unregisterWebhook(subscriptionId: string): Promise<void> {
    const clientId = process.env.STRAVA_CLIENT_ID;
    const clientSecret = process.env.STRAVA_CLIENT_SECRET;
    if (!clientId || !clientSecret) return;

    const url = new URL(`https://www.strava.com/api/v3/push_subscriptions/${subscriptionId}`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("client_secret", clientSecret);

    const response = await this.#fetchFn(url.toString(), { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      logger.warn(`[strava] Failed to unregister webhook ${subscriptionId}: ${text}`);
    }
  }

  verifyWebhookSignature(
    _rawBody: Buffer,
    _headers: Record<string, string | string[] | undefined>,
    _signingSecret: string,
  ): boolean {
    // Strava does not sign webhook payloads — verification happens during
    // the subscription handshake (hub.challenge + verify_token).
    // All POST events to the callback URL are trusted once registered.
    return true;
  }

  parseWebhookPayload(body: unknown): WebhookEvent[] {
    // Strava sends a single event object per POST
    const parsed = z
      .object({
        aspect_type: z.string().optional(),
        event_time: z.number().optional(),
        object_id: z.number().optional(),
        object_type: z.string(),
        owner_id: z.number(),
        subscription_id: z.number().optional(),
        updates: z.record(z.unknown()).optional(),
      })
      .safeParse(body);

    if (!parsed.success) return [];
    const event = parsed.data;

    const eventTypeMap: Record<string, WebhookEvent["eventType"]> = {
      create: "create",
      update: "update",
      delete: "delete",
    };

    return [
      {
        ownerExternalId: String(event.owner_id),
        eventType: eventTypeMap[event.aspect_type ?? ""] ?? "update",
        objectType: event.object_type,
        objectId: event.object_id ? String(event.object_id) : undefined,
      },
    ];
  }

  handleValidationChallenge(query: Record<string, string>, verifyToken: string): unknown | null {
    // Strava sends: GET callback?hub.mode=subscribe&hub.challenge=CHALLENGE&hub.verify_token=TOKEN
    const mode = query["hub.mode"];
    const challenge = query["hub.challenge"];
    const token = query["hub.verify_token"];

    if (mode !== "subscribe" || !challenge) return null;
    if (token !== verifyToken) return null;

    return { "hub.challenge": challenge };
  }

  authSetup(options?: { host?: string }): ProviderAuthSetup {
    const config = stravaOAuthConfig(options?.host);
    if (!config) throw new Error("STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET are required");
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code),
      apiBaseUrl: STRAVA_API_BASE,
      identityCapabilities: { providesEmail: false },
      getUserIdentity: async (accessToken: string): Promise<ProviderIdentity> => {
        const response = await this.#fetchFn(`${STRAVA_API_BASE}athlete`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Strava athlete API error (${response.status}): ${text}`);
        }
        const athlete: {
          id: number;
          email?: string | null;
          firstname?: string | null;
          lastname?: string | null;
        } = await response.json();
        const nameParts = [athlete.firstname, athlete.lastname].filter(Boolean);
        return {
          providerAccountId: String(athlete.id),
          email: null,
          name: nameParts.length > 0 ? nameParts.join(" ") : null,
        };
      },
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => stravaOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  /**
   * Sync a single activity from a webhook event.
   * Makes 2 API calls (detail + streams) instead of a full sync's 1 + 2N.
   */
  async syncWebhookEvent(
    db: SyncDatabase,
    event: WebhookEvent,
    options?: SyncOptions,
  ): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    if (event.objectType !== "activity" || !event.objectId) {
      return { provider: this.id, recordsSynced: 0, errors: [], duration: Date.now() - start };
    }

    const activityExternalId = Number(event.objectId);
    const scopedUserId = options?.userId ?? getTokenUserId();

    if (!scopedUserId) {
      throw new Error(`[strava] Cannot sync webhook event: no userId provided or in context`);
    }

    // Handle delete events — remove the activity and its streams
    if (event.eventType === "delete") {
      const deleted = await db
        .delete(activity)
        .where(
          and(
            eq(activity.userId, scopedUserId),
            eq(activity.providerId, this.id),
            eq(activity.externalId, event.objectId),
          ),
        )
        .returning({ id: activity.id });
      const deletedRow = deleted[0];
      if (deletedRow) {
        await db.delete(sensorSample).where(eq(sensorSample.activityId, deletedRow.id));
        logger.info(
          `[strava] Deleted activity ${event.objectId} via webhook for user ${scopedUserId}`,
        );
      }
      return { provider: this.id, recordsSynced: 0, errors: [], duration: Date.now() - start };
    }

    let tokens: TokenSet;
    try {
      tokens = await this.#resolveTokens(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new StravaClient(tokens.accessToken, this.#fetchFn, this.#throttleMs);

    // Fetch the single activity detail (1 API call)
    const detail = await client.getActivity(activityExternalId);
    const parsed = parseStravaActivity(detail);

    // Upsert the activity row
    const [row] = await db
      .insert(activity)
      .values({
        userId: scopedUserId,
        providerId: this.id,
        externalId: parsed.externalId,
        activityType: parsed.activityType,
        startedAt: parsed.startedAt,
        endedAt: parsed.endedAt,
        name: parsed.name,
        sourceName: detail.device_name,
        raw: detail,
      })
      .onConflictDoUpdate({
        target: [activity.userId, activity.providerId, activity.externalId],
        set: {
          activityType: parsed.activityType,
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          name: parsed.name,
          sourceName: detail.device_name,
          raw: detail,
        },
      })
      .returning({ id: activity.id });

    recordsSynced++;
    const activityId = row?.id;
    if (!activityId) {
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // Fetch streams for sensor data (1 API call)
    try {
      const streams = await client.getActivityStreams(activityExternalId);
      const metricRows = stravaStreamsToMetricStream(
        streams,
        this.id,
        activityId,
        parsed.startedAt,
        parsed.activityType,
      );

      if (metricRows.length > 0) {
        // Delete existing sensor rows then re-insert.
        await db.delete(sensorSample).where(eq(sensorSample.activityId, activityId));
        await dualWriteToSensorSample(db, metricRows, SOURCE_TYPE_API);
        logger.info(
          `[strava] Webhook: inserted ${metricRows.length} sensor sample rows for activity ${event.objectId}`,
        );
      }
    } catch (streamErr) {
      if (streamErr instanceof StravaNotFoundError) {
        logger.info(`[strava] No streams for activity ${event.objectId} (404)`);
      } else {
        errors.push({
          message: `Streams for activity ${event.objectId}: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
          externalId: event.objectId,
          cause: streamErr,
        });
      }
    }

    logger.info(`[strava] Webhook: synced activity ${event.objectId} (${event.eventType})`);
    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }

  async sync(
    db: SyncDatabase,
    since: Date,
    options?: import("./types.ts").SyncOptions,
  ): Promise<SyncResult> {
    const onProgress = options?.onProgress;
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

    const client = new StravaClient(tokens.accessToken, this.#fetchFn, this.#throttleMs);

    // Strava uses epoch seconds for the `after` parameter
    const afterEpoch = Math.floor(since.getTime() / 1000);

    let page = 1;
    const perPage = 30;
    let hasMore = true;
    let shouldStop = false;

    while (hasMore && !shouldStop) {
      let rawActivities: StravaActivity[];
      try {
        rawActivities = await client.getActivities(afterEpoch, page, perPage);
      } catch (err) {
        if (err instanceof StravaRateLimitError) {
          errors.push({
            message: "Strava API rate limit exceeded — stopping sync. Will resume on next run.",
            cause: err,
          });
          shouldStop = true;
          break;
        }
        if (err instanceof StravaUnauthorizedError) {
          errors.push({
            message: "Strava authorization failed — run: health-data auth strava",
            cause: err,
          });
          shouldStop = true;
          break;
        }
        if (err instanceof StravaNotFoundError) {
          errors.push({
            message: "Strava activities endpoint returned 404 — run: health-data auth strava",
            cause: err,
          });
          shouldStop = true;
          break;
        }
        errors.push({
          message: `Strava activities fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        });
        shouldStop = true;
        break;
      }

      const parsed = parseStravaActivityList(rawActivities, perPage);

      for (const act of parsed.activities) {
        try {
          // Fetch detailed activity to get device_name for source tracking
          let sourceName: string | undefined = act.sourceName;
          try {
            const detail = await client.getActivity(Number(act.externalId));
            sourceName = detail.device_name;
          } catch (detailErr) {
            if (detailErr instanceof StravaRateLimitError) {
              errors.push({
                message:
                  "Strava API rate limit hit while fetching activity detail — stopping sync.",
                cause: detailErr,
              });
              shouldStop = true;
              break;
            }
            if (detailErr instanceof StravaUnauthorizedError) {
              errors.push({
                message:
                  "Strava authorization failed while fetching activity detail — run: health-data auth strava",
                cause: detailErr,
              });
              shouldStop = true;
              break;
            }
            if (detailErr instanceof StravaNotFoundError) {
              logger.warn(`[strava] Activity ${act.externalId} not found (404) — skipping detail`);
            } else {
              errors.push({
                message: `Detail for activity ${act.externalId}: ${detailErr instanceof Error ? detailErr.message : String(detailErr)}`,
                externalId: act.externalId,
                cause: detailErr,
              });
            }
          }

          const [row] = await db
            .insert(activity)
            .values({
              userId: scopedUserId,
              providerId: this.id,
              externalId: act.externalId,
              activityType: act.activityType,
              startedAt: act.startedAt,
              endedAt: act.endedAt,
              name: act.name,
              sourceName,
              raw: rawActivities.find((r) => String(r.id) === act.externalId),
            })
            .onConflictDoUpdate({
              target: [activity.userId, activity.providerId, activity.externalId],
              set: {
                activityType: act.activityType,
                startedAt: act.startedAt,
                endedAt: act.endedAt,
                name: act.name,
                sourceName: sql`coalesce(excluded.source_name, ${activity.sourceName})`,
                raw: rawActivities.find((r) => String(r.id) === act.externalId),
              },
            })
            .returning({ id: activity.id });

          recordsSynced++;
          // no-mutate: Progress reporting is UX-only and can't fail in a testable way
          if (onProgress) {
            // no-mutate
            onProgress(0, `${recordsSynced} activities synced`);
          }

          // Fetch streams for sensor data
          const activityId = row?.id;
          if (!activityId) continue;

          try {
            const streams = await client.getActivityStreams(Number(act.externalId));
            const metricRows = stravaStreamsToMetricStream(
              streams,
              this.id,
              activityId,
              act.startedAt,
              act.activityType,
            );

            if (metricRows.length > 0) {
              await dualWriteToSensorSample(db, metricRows, SOURCE_TYPE_API);
              logger.info(
                `[strava] Inserted ${metricRows.length} sensor sample rows for activity ${act.externalId}`,
              );
            }
          } catch (streamErr) {
            if (streamErr instanceof StravaRateLimitError) {
              errors.push({
                message: "Strava API rate limit hit while fetching streams — stopping stream sync.",
                cause: streamErr,
              });
              shouldStop = true;
              break;
            }
            if (streamErr instanceof StravaUnauthorizedError) {
              errors.push({
                message:
                  "Strava authorization failed while fetching streams — run: health-data auth strava",
                cause: streamErr,
              });
              shouldStop = true;
              break;
            }
            if (streamErr instanceof StravaNotFoundError) {
              logger.info(`[strava] No streams for activity ${act.externalId} (404) — skipping`);
            } else {
              errors.push({
                message: `Streams for activity ${act.externalId}: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
                externalId: act.externalId,
                cause: streamErr,
              });
            }
          }
        } catch (err) {
          errors.push({
            message: err instanceof Error ? err.message : String(err),
            externalId: act.externalId,
            cause: err,
          });
        }
      }

      hasMore = parsed.hasMore && !shouldStop;
      page++;
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
