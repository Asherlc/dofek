import {
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
  parseRetryAfterHeader,
} from "@dofek/provider-http/rate-limit";
import { resolveRawProviderActivityType } from "@dofek/training/activity-types";
import { z } from "zod";
import type { TokenSet } from "../auth/oauth.ts";
import {
  type MetricStreamSourceRow,
  replaceMetricStreamBatch,
} from "../db/metric-stream-writer.ts";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../db/provider-activity-sync.ts";
import { SOURCE_TYPE_API } from "../db/sensor-channels.ts";
import { deleteTokens, ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { captureException } from "../lib/error-reporting.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import {
  AccessTokenExpiredError,
  ProviderInvalidCredentialsError,
  ProviderVerificationRequiredError,
  RefreshTokenRevokedError,
} from "./auth-errors.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult } from "./types.ts";

const API_BASE = "https://api-v5.alltrails.com";
const remoteIdSchema = z
  .union([z.number().int().positive().safe(), z.string().regex(/^\d+$/)])
  .transform(String);
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive().finite(),
  user: z.object({ id: remoteIdSchema }).optional(),
});
const pageSchema = z.object({
  maps: z.array(z.object({ id: remoteIdSchema })),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    nextCursor: z.string().min(1).nullish(),
  }),
});
const recordingSchema = z.object({
  id: remoteIdSchema,
  name: z.string().optional(),
  activity: z.object({ uid: z.string().min(1) }),
  metadata: z.object({ timezone: z.string().min(1).nullish() }).optional(),
  tracks: z.array(
    z.object({
      id: remoteIdSchema,
      lineTimedSegments: z.array(
        z.object({
          id: remoteIdSchema,
          sequence_num: z.number().int().optional(),
          polyline: z.object({ ndimensionalData: z.string().optional() }),
        }),
      ),
    }),
  ),
});
const detailSchema = z.object({ maps: z.array(z.unknown()) });
const errorResponseSchema = z.object({ error: z.string() });
const MULTIPLIERS = [100_000, 100_000, 100_000, 100, 100_000, 100_000] as const;
type RequestKind = "password" | "refresh_token" | "data";
interface TimedPoint extends MetricStreamSourceRow {
  lat: number;
  lng: number;
  altitude: number;
  horizontalAccuracy: number;
}

/** Native TrackPointLocation encoding: lat/lon/elevation/epoch seconds/accuracy/accuracy. */
function decodeTimedSegment(encoded: string): number[][] {
  const points: number[][] = [];
  const previous = MULTIPLIERS.map(() => 0n);
  let axis = 0;
  let point: number[] = [];
  let cursor = 0;
  const invalid = () =>
    new Error("AllTrails returned malformed native timestamped GPS data. Retry this recording.");
  while (cursor < encoded.length) {
    let unsigned = 0n;
    let shift = 0n;
    while (true) {
      if (cursor >= encoded.length) throw invalid();
      const chunk = encoded.charCodeAt(cursor++) - 63;
      if (chunk < 0 || chunk > 63 || shift > 60n) throw invalid();
      unsigned |= BigInt(chunk & 31) << shift;
      if (unsigned > 0xffffffffffffffffn) throw invalid();
      if ((chunk & 32) === 0) break;
      shift += 5n;
    }
    const delta = (unsigned & 1n) === 1n ? -(unsigned >> 1n) - 1n : unsigned >> 1n;
    const prior = previous[axis];
    const multiplier = MULTIPLIERS[axis];
    if (prior === undefined || multiplier === undefined) throw invalid();
    const value = prior + delta;
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
      throw invalid();
    previous[axis] = value;
    point.push(Number(value) / multiplier);
    axis++;
    if (axis === MULTIPLIERS.length) {
      points.push(point);
      point = [];
      axis = 0;
    }
  }
  if (axis !== 0) throw invalid();
  return points;
}

function recordingPoints(recording: z.infer<typeof recordingSchema>): TimedPoint[] {
  const rows: TimedPoint[] = [];
  for (const track of recording.tracks) {
    for (const [segmentIndex, segment] of track.lineTimedSegments.entries()) {
      const encoded = segment.polyline.ndimensionalData;
      if (!encoded) {
        throw new Error(
          "AllTrails recording has no supported native timestamped GPS data. Its split timing format is unsupported.",
        );
      }
      for (const [pointIndex, point] of decodeTimedSegment(encoded).entries()) {
        const [latitude, longitude, altitude, epochSeconds, accuracy] = point;
        if (
          latitude === undefined ||
          longitude === undefined ||
          altitude === undefined ||
          epochSeconds === undefined ||
          accuracy === undefined ||
          Math.abs(latitude) > 90 ||
          Math.abs(longitude) > 180 ||
          epochSeconds <= 0 ||
          accuracy < 0
        ) {
          throw new Error(
            "AllTrails recording contains invalid native timestamped GPS data. Retry this recording.",
          );
        }
        const recordedAt = new Date(Math.round(epochSeconds * 1000));
        if (!Number.isFinite(recordedAt.getTime())) {
          throw new Error(
            "AllTrails recording contains an invalid GPS timestamp. Retry this recording.",
          );
        }
        rows.push({
          recordedAt,
          providerId: "alltrails",
          externalId: `${recording.id}:${track.id}:${segment.id}:${segmentIndex}:${pointIndex}`,
          lat: latitude,
          lng: longitude,
          altitude,
          horizontalAccuracy: accuracy,
          raw: {
            trackId: track.id,
            segmentId: segment.id,
            segmentIndex,
            sequenceNum: segment.sequence_num,
            pointIndex,
          },
        });
      }
    }
  }
  if (rows.length === 0) {
    throw new Error(
      "AllTrails recording has no supported native timestamped GPS samples. No activity was imported.",
    );
  }
  return rows;
}

export class AllTrailsProvider implements SyncProvider {
  readonly id = "alltrails";
  readonly name = "AllTrails";
  readonly #fetchFn: typeof fetch;

  constructor(fetchFn: typeof fetch = globalThis.fetch) {
    this.#fetchFn = createProviderRateLimitFetch(this.id, fetchFn, {
      createRateLimitError: (response) =>
        new ProviderRateLimitError({
          message: `AllTrails request failed (HTTP ${response.status}). Try again.`,
          providerId: this.id,
          statusCode: response.status,
          responseBody: "[redacted]",
          retryAfterSeconds: parseRetryAfterHeader(response.headers.get("Retry-After")),
        }),
      createServiceUnavailableError: (response) =>
        new ProviderServiceUnavailableError({
          message: `AllTrails request failed (HTTP ${response.status}). Try again.`,
          providerId: this.id,
          statusCode: response.status,
          responseBody: "[redacted]",
          retryAfterSeconds: parseRetryAfterHeader(response.headers.get("Retry-After")),
        }),
    });
  }

  validate(): string | null {
    if (!process.env.ALLTRAILS_API_KEY?.trim()) return "ALLTRAILS_API_KEY is required";
    if (!process.env.ALLTRAILS_CLIENT_ID?.trim()) return "ALLTRAILS_CLIENT_ID is required";
    return null;
  }

  #configuration(): { apiKey: string; clientId: string } {
    const apiKey = process.env.ALLTRAILS_API_KEY?.trim();
    const clientId = process.env.ALLTRAILS_CLIENT_ID?.trim();
    if (!apiKey) throw new Error("ALLTRAILS_API_KEY is required");
    if (!clientId) throw new Error("ALLTRAILS_CLIENT_ID is required");
    return { apiKey, clientId };
  }

  authSetup(): ProviderAuthSetup {
    return {
      apiBaseUrl: API_BASE,
      automatedLogin: async (email, password) => {
        const tokens = await this.#exchangeTokens({
          grant_type: "password",
          username: email,
          password,
        });
        if (!tokens.providerAccountId) {
          throw new Error("AllTrails returned an incomplete token response. Reconnect AllTrails.");
        }
        return tokens;
      },
    };
  }

  async #exchangeTokens(body: Record<string, string>, signal?: AbortSignal): Promise<TokenSet> {
    const { clientId } = this.#configuration();
    const data = await this.#request(
      "/identity/oauth/token",
      {
        method: "POST",
        body: JSON.stringify({ client_id: clientId, ...body }),
        signal,
      },
      body.grant_type === "refresh_token" ? "refresh_token" : "password",
    );
    const parsed = tokenResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error("AllTrails returned an invalid token response. Reconnect AllTrails.");
    }
    const expiresAt = new Date(Date.now() + parsed.data.expires_in * 1000);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new Error("AllTrails returned an invalid token response. Reconnect AllTrails.");
    }
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresAt,
      ...(parsed.data.user ? { providerAccountId: parsed.data.user.id } : {}),
      scopes: null,
    };
  }

  async #request(path: string, init: RequestInit, kind: RequestKind): Promise<unknown> {
    init.signal?.throwIfAborted();
    const { apiKey, clientId } = this.#configuration();
    const response = await this.#fetchFn(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-AT-KEY": apiKey,
        "X-AT-CLIENT-ID": clientId,
        ...init.headers,
      },
    });
    if (
      (response.status === 403 && response.headers.has("x-datadome")) ||
      response.headers.get("content-type")?.includes("text/html")
    ) {
      throw new ProviderVerificationRequiredError(this.name);
    }
    if (response.status === 401 && kind === "data") throw new AccessTokenExpiredError(this.name);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      init.signal?.throwIfAborted();
      const sanitized = new Error("AllTrails returned an invalid JSON response. Try again.");
      if (kind === "password") captureException(sanitized, { tags: { provider: this.id } });
      throw sanitized;
    }
    const remoteError = errorResponseSchema.safeParse(data);
    if (
      (response.status === 400 || response.status === 401) &&
      kind === "password" &&
      remoteError.success &&
      remoteError.data.error === "invalid_grant"
    ) {
      throw new ProviderInvalidCredentialsError(this.name);
    }
    if (
      (response.status === 400 || response.status === 401) &&
      kind === "refresh_token" &&
      remoteError.success &&
      remoteError.data.error === "invalid_grant"
    ) {
      throw new RefreshTokenRevokedError(this.name);
    }
    if (!response.ok)
      throw new Error(`AllTrails request failed (HTTP ${response.status}). Try again.`);
    return data;
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const { db, window, options } = run;
    const { signal, userId } = options;
    signal?.throwIfAborted();
    if (!userId) throw new Error("AllTrails sync requires userId.");
    const start = Date.now();
    const errors: SyncError[] = [];
    const presentExternalIds = new Set<string>();
    let recordsSynced = 0;
    const report = (error: unknown, externalId?: string) => {
      signal?.throwIfAborted();
      captureException(error, { tags: { provider: this.id } });
      errors.push({
        message: error instanceof Error ? error.message : "AllTrails sync failed. Try again.",
        ...(externalId ? { externalId } : {}),
        cause: error,
      });
    };
    try {
      const invalidConfig = this.validate();
      if (invalidConfig) throw new Error(invalidConfig);
      await ensureProvider(db, this.id, this.name, API_BASE, userId);
      const stored = await loadTokens(db, this.id, userId);
      if (!stored) throw new Error("AllTrails is not connected. Connect AllTrails and retry.");
      let tokens: TokenSet = stored;
      const accountId = tokens.providerAccountId;
      if (!accountId || !remoteIdSchema.safeParse(accountId).success) {
        throw new Error("AllTrails account identity is missing. Reconnect AllTrails.");
      }
      const refresh = async () => {
        if (!tokens.refreshToken)
          throw new Error("AllTrails refresh token is missing. Reconnect AllTrails.");
        let rotated: TokenSet;
        try {
          rotated = await this.#exchangeTokens(
            {
              grant_type: "refresh_token",
              refresh_token: tokens.refreshToken,
            },
            signal,
          );
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof RefreshTokenRevokedError) await deleteTokens(db, this.id, userId);
          throw error;
        }
        if (rotated.providerAccountId && rotated.providerAccountId !== accountId) {
          throw new Error(
            "AllTrails returned a different account during refresh. Reconnect AllTrails.",
          );
        }
        rotated.providerAccountId = accountId;
        await saveTokens(db, this.id, rotated, userId);
        tokens = rotated;
      };
      const authenticatedGet = async (path: string) => {
        signal?.throwIfAborted();
        if (tokens.expiresAt.getTime() <= Date.now() + 30_000) await refresh();
        const read = () =>
          this.#request(
            path,
            {
              method: "GET",
              signal,
              headers: { "X-AT-AUTH-TOKEN": tokens.accessToken },
            },
            "data",
          );
        try {
          return await read();
        } catch (error) {
          signal?.throwIfAborted();
          if (!(error instanceof AccessTokenExpiredError)) throw error;
          await refresh();
          return read();
        }
      };
      const cursors = new Set<string>();
      let after: string | undefined;
      while (true) {
        signal?.throwIfAborted();
        const query = new URLSearchParams({
          allow_private: "true",
          presentation_type: "track",
          detail: "deep",
          limit: "50",
        });
        if (after) query.set("after", after);
        const data = await authenticatedGet(
          `/api/alltrails/users/${encodeURIComponent(accountId)}/maps?${query}`,
        );
        const page = pageSchema.safeParse(data);
        if (!page.success)
          throw new Error("AllTrails returned an incomplete recording inventory. Retry the sync.");
        for (const item of page.data.maps) {
          if (presentExternalIds.has(item.id)) continue;
          presentExternalIds.add(item.id);
          try {
            const rawDetail = await authenticatedGet(
              `/api/alltrails/maps/${encodeURIComponent(item.id)}?detail=deep&combine_segments=false`,
            );
            const collection = detailSchema.safeParse(rawDetail);
            if (!collection.success || collection.data.maps.length !== 1) {
              throw new Error("AllTrails returned an invalid recording detail. Retry the sync.");
            }
            const raw = collection.data.maps[0];
            const detail = recordingSchema.safeParse(raw);
            if (!detail.success || detail.data.id !== item.id) {
              throw new Error("AllTrails returned an invalid recording detail. Retry the sync.");
            }
            // Validate every segment before changing previously stored samples.
            const points = recordingPoints(detail.data);
            const firstPoint = points[0];
            let startedAt = firstPoint?.recordedAt;
            let endedAt = startedAt;
            if (!firstPoint || !startedAt || !endedAt)
              throw new Error("AllTrails recording has no raw GPS timestamps.");
            for (const point of points) {
              if (point.recordedAt < startedAt) startedAt = point.recordedAt;
              if (point.recordedAt > endedAt) endedAt = point.recordedAt;
            }
            if (startedAt < window.since || startedAt >= window.until) continue;
            const timezone = detail.data.metadata?.timezone;
            const values = {
              activityType: resolveRawProviderActivityType(detail.data.activity.uid),
              name: detail.data.name,
              startedAt,
              endedAt,
              raw,
              localTimeCoordinates: { latitude: firstPoint.lat, longitude: firstPoint.lng },
              ...(timezone ? { timezone, localTimeSource: "provider_timezone" } : {}),
            };
            const activity = await upsertProviderActivity(
              db,
              {
                ...values,
                userId,
                providerId: this.id,
                externalId: item.id,
              },
              values,
            );
            if (!activity)
              throw new Error("AllTrails activity could not be saved. Retry the sync.");
            await replaceMetricStreamBatch(
              db,
              { activityId: activity.id, userId },
              points.map((point) => ({ ...point, userId, activityId: activity.id })),
              SOURCE_TYPE_API,
              options.metricStreamPublisher,
            );
            recordsSynced++;
          } catch (error) {
            report(error, item.id);
          }
        }
        if (!page.data.pageInfo.hasNextPage) break;
        const cursor = page.data.pageInfo.nextCursor;
        if (!cursor || cursors.has(cursor)) {
          throw new Error(
            "AllTrails returned incomplete or repeated recording pagination. Retry the sync.",
          );
        }
        cursors.add(cursor);
        after = cursor;
      }
      signal?.throwIfAborted();
      if (errors.length === 0) {
        await finishProviderActivityListSync(db, {
          providerId: this.id,
          userId,
          windowStart: window.since,
          windowEnd: window.until,
          presentExternalIds,
        });
      }
    } catch (error) {
      report(error);
    }
    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }
}
