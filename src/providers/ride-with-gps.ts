import { isIndoorCycling } from "@dofek/training/endurance-types";
import {
  type CanonicalActivityType,
  createActivityTypeMapper,
  RIDE_WITH_GPS_ACTIVITY_TYPE_MAP,
} from "@dofek/training/training";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri } from "../auth/oauth.ts";
import { resolveOAuthTokens } from "../auth/resolve-tokens.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity, DEFAULT_USER_ID, sensorSample, userSettings } from "../db/schema.ts";
import { SOURCE_TYPE_API } from "../db/sensor-channels.ts";
import { dualWriteToSensorSample } from "../db/sensor-sample-writer.ts";
import { ensureProvider } from "../db/tokens.ts";
import type {
  ProviderAuthSetup,
  ProviderIdentity,
  SyncError,
  SyncProvider,
  SyncResult,
} from "./types.ts";

// ============================================================
// RideWithGPS API types
// ============================================================

export interface RideWithGpsTrackPoint {
  longitude: number;
  latitude: number;
  distanceMeters: number;
  elevationMeters?: number;
  epochSeconds?: number;
  speedKph?: number;
  temperatureCelsius?: number;
  heartRateBpm?: number;
  cadenceRpm?: number;
  powerWatts?: number;
}

// Zod schema for track points from the RideWithGPS API.
// Transforms the API's compact single-letter field names to descriptive names.
const rideWithGpsTrackPointSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    d: z.number(),
    e: z.number().optional(),
    t: z.number().optional(),
    s: z.number().optional(),
    T: z.number().optional(),
    h: z.number().optional(),
    c: z.number().optional(),
    p: z.number().optional(),
  })
  .transform(
    (raw): RideWithGpsTrackPoint => ({
      longitude: raw.x,
      latitude: raw.y,
      distanceMeters: raw.d,
      elevationMeters: raw.e,
      epochSeconds: raw.t,
      speedKph: raw.s,
      temperatureCelsius: raw.T,
      heartRateBpm: raw.h,
      cadenceRpm: raw.c,
      powerWatts: raw.p,
    }),
  );

/** Raw API track point shape (single-letter keys), for constructing test fixtures */
export type RideWithGpsApiTrackPoint = z.input<typeof rideWithGpsTrackPointSchema>;

export interface RideWithGpsTripSummary {
  id: number;
  name: string;
  description?: string | null;
  departed_at?: string | null;
  activity_type?: string | null;
  distance: number;
  duration: number;
  moving_time: number;
  elevation_gain: number;
  elevation_loss: number;
  created_at: string;
  updated_at: string;
  /** Recording source/device — e.g., "ridewithgps_iphone", "garmin_connect". */
  source?: string | null;
}

// Zod schema for the full trip detail response, including track point transform
const rideWithGpsTripDetailSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable().optional(),
  departed_at: z.string().nullable().optional(),
  activity_type: z.string().nullable().optional(),
  distance: z.number(),
  duration: z.number(),
  moving_time: z.number(),
  elevation_gain: z.number(),
  elevation_loss: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  source: z.string().nullable().optional(),
  track_points: z.array(rideWithGpsTrackPointSchema).default([]),
});

export type RideWithGpsTripDetail = z.output<typeof rideWithGpsTripDetailSchema>;

/** Raw API trip detail shape (single-letter track point keys), for constructing test fixtures */
export type RideWithGpsApiTripDetail = z.input<typeof rideWithGpsTripDetailSchema>;

export interface RideWithGpsSyncItem {
  item_type: "route" | "trip";
  item_id: number;
  action: "created" | "updated" | "deleted" | "added" | "removed";
  datetime: string;
}

export interface RideWithGpsSyncResponse {
  items: RideWithGpsSyncItem[];
  meta: { rwgps_datetime: string };
}

// ============================================================
// OAuth configuration
// ============================================================

const RWGPS_OAUTH_AUTHORIZE_URL = "https://ridewithgps.com/oauth/authorize";
const RWGPS_OAUTH_TOKEN_URL = "https://ridewithgps.com/oauth/token.json";

export function rideWithGpsOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.RWGPS_CLIENT_ID;
  if (!clientId) return null;

  return {
    clientId,
    clientSecret: process.env.RWGPS_CLIENT_SECRET,
    authorizeUrl: RWGPS_OAUTH_AUTHORIZE_URL,
    tokenUrl: RWGPS_OAUTH_TOKEN_URL,
    redirectUri: getOAuthRedirectUri(),
    scopes: ["user"],
  };
}

// ============================================================
// Activity type mapping
// ============================================================

const mapRwgpsType = createActivityTypeMapper(RIDE_WITH_GPS_ACTIVITY_TYPE_MAP);

export function mapActivityType(rawType: string | null | undefined): CanonicalActivityType {
  if (!rawType) return "cycling";
  return mapRwgpsType(rawType);
}

// ============================================================
// Pure parsing functions
// ============================================================

export interface ParsedActivity {
  externalId: string;
  activityType: CanonicalActivityType;
  name: string;
  startedAt: Date;
  endedAt: Date | undefined;
  notes: string | undefined;
  sourceName: string | undefined;
  raw: RideWithGpsTripSummary;
}

export interface ParsedTrackPoint {
  recordedAt: Date;
  lat: number;
  lng: number;
  altitude: number | undefined;
  speed: number | undefined;
  temperature: number | undefined;
  heartRate: number | undefined;
  cadence: number | undefined;
  power: number | undefined;
}

export function parseTripToActivity(trip: RideWithGpsTripSummary): ParsedActivity {
  const startedAt = trip.departed_at ? new Date(trip.departed_at) : new Date(trip.created_at);
  const endedAt = trip.duration ? new Date(startedAt.getTime() + trip.duration * 1000) : undefined;

  return {
    externalId: String(trip.id),
    activityType: mapActivityType(trip.activity_type),
    name: trip.name,
    startedAt,
    endedAt,
    notes: trip.description ?? undefined,
    sourceName: trip.source ?? undefined,
    raw: trip,
  };
}

export function parseTrackPoints(points: RideWithGpsTrackPoint[]): ParsedTrackPoint[] {
  const result: ParsedTrackPoint[] = [];
  for (const point of points) {
    // Skip points without a timestamp — can't insert into metric_stream
    if (point.epochSeconds === undefined) continue;

    result.push({
      recordedAt: new Date(point.epochSeconds * 1000),
      lat: point.latitude,
      lng: point.longitude,
      altitude: point.elevationMeters,
      speed: point.speedKph !== undefined ? point.speedKph / 3.6 : undefined,
      temperature: point.temperatureCelsius,
      heartRate: point.heartRateBpm,
      cadence: point.cadenceRpm,
      power: point.powerWatts,
    });
  }
  return result;
}

// ============================================================
// API client
// ============================================================

const RWGPS_API_BASE = "https://ridewithgps.com";

export class RideWithGpsClient {
  #accessToken: string;
  #fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#accessToken = accessToken;
    this.#fetchFn = fetchFn;
  }

  async #get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, RWGPS_API_BASE);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    const response = await this.#fetchFn(url.toString(), {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#accessToken}`,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`RWGPS API error (${response.status}): ${text}`);
    }
    return response.json();
  }

  async sync(since: string): Promise<RideWithGpsSyncResponse> {
    return this.#get<RideWithGpsSyncResponse>("/api/v1/sync.json", {
      since,
      assets: "trips",
    });
  }

  async getTrip(id: number): Promise<{ trip: RideWithGpsTripDetail }> {
    const data = await this.#get<unknown>(`/api/v1/trips/${id}.json`);
    return z.object({ trip: rideWithGpsTripDetailSchema }).parse(data);
  }
}

// ============================================================
// Sync cursor helpers
// ============================================================

const SYNC_CURSOR_KEY = "rwgps_sync_cursor";

async function loadSyncCursor(db: SyncDatabase): Promise<string | null> {
  const rows = await db
    .select({ value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.userId, DEFAULT_USER_ID), eq(userSettings.key, SYNC_CURSOR_KEY)))
    .limit(1);

  if (rows.length === 0 || !rows[0]) return null;
  const cursorSchema = z.object({ cursor: z.string().optional() }).catch({ cursor: undefined });
  const value = cursorSchema.parse(rows[0].value);
  return value.cursor ?? null;
}

async function saveSyncCursor(db: SyncDatabase, cursor: string): Promise<void> {
  await db
    .insert(userSettings)
    .values({
      userId: DEFAULT_USER_ID,
      key: SYNC_CURSOR_KEY,
      value: { cursor },
    })
    .onConflictDoUpdate({
      target: [userSettings.userId, userSettings.key],
      set: { value: { cursor }, updatedAt: new Date() },
    });
}

// ============================================================
// Provider
// ============================================================

export class RideWithGpsProvider implements SyncProvider {
  readonly id = "ride-with-gps";
  readonly name = "RideWithGPS";
  #fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetchFn = fetchFn;
  }

  validate(): string | null {
    const config = rideWithGpsOAuthConfig();
    if (!config) return "RWGPS_CLIENT_ID is not set";
    return null;
  }

  activityUrl(externalId: string): string {
    return `https://ridewithgps.com/trips/${externalId}`;
  }

  authSetup(): ProviderAuthSetup {
    const config = rideWithGpsOAuthConfig();
    if (!config) throw new Error("RWGPS_CLIENT_ID is required");

    return {
      oauthConfig: config,
      exchangeCode: (code: string, codeVerifier?: string) =>
        exchangeCodeForTokens(
          config,
          code,
          this.#fetchFn,
          codeVerifier ? { codeVerifier } : undefined,
        ),
      apiBaseUrl: RWGPS_API_BASE,
      getUserIdentity: async (accessToken: string): Promise<ProviderIdentity> => {
        const response = await this.#fetchFn(`${RWGPS_API_BASE}/users/current.json`, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`RWGPS user API error (${response.status}): ${text}`);
        }
        const data: {
          user: { id: number; email?: string | null; name?: string | null };
        } = await response.json();
        return {
          providerAccountId: String(data.user.id),
          email: data.user.email ?? null,
          name: data.user.name ?? null,
        };
      },
    };
  }

  async #resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    return resolveOAuthTokens({
      db,
      providerId: this.id,
      providerName: this.name,
      getOAuthConfig: () => rideWithGpsOAuthConfig(),
      fetchFn: this.#fetchFn,
    });
  }

  async sync(db: SyncDatabase, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, RWGPS_API_BASE);

    let tokens: TokenSet;
    try {
      tokens = await this.#resolveTokens(db);
    } catch (err) {
      return {
        provider: this.id,
        recordsSynced: 0,
        errors: [
          {
            message: err instanceof Error ? err.message : String(err),
          },
        ],
        duration: Date.now() - start,
      };
    }

    const client = new RideWithGpsClient(tokens.accessToken, this.#fetchFn);

    // Load sync cursor or fall back to since param
    const cursor = (await loadSyncCursor(db)) ?? since.toISOString();

    let syncResponse: RideWithGpsSyncResponse;
    try {
      syncResponse = await client.sync(cursor);
    } catch (err) {
      return {
        provider: this.id,
        recordsSynced: 0,
        errors: [
          {
            message: `Sync endpoint failed: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          },
        ],
        duration: Date.now() - start,
      };
    }

    for (const item of syncResponse.items) {
      // Only process trips, not routes
      if (item.item_type !== "trip") continue;

      if (item.action === "deleted" || item.action === "removed") {
        try {
          await db
            .delete(activity)
            .where(
              and(eq(activity.providerId, this.id), eq(activity.externalId, String(item.item_id))),
            );
        } catch (err) {
          errors.push({
            message: `Failed to delete trip ${item.item_id}: ${err instanceof Error ? err.message : String(err)}`,
            externalId: String(item.item_id),
            cause: err,
          });
        }
        continue;
      }

      // created, updated, added
      try {
        const { trip } = await client.getTrip(item.item_id);
        const parsed = parseTripToActivity(trip);

        // Upsert activity
        const [activityRow] = await db
          .insert(activity)
          .values({
            providerId: this.id,
            externalId: parsed.externalId,
            activityType: parsed.activityType,
            startedAt: parsed.startedAt,
            endedAt: parsed.endedAt,
            name: parsed.name,
            notes: parsed.notes,
            sourceName: parsed.sourceName,
            raw: parsed.raw,
          })
          .onConflictDoUpdate({
            target: [activity.providerId, activity.externalId],
            set: {
              activityType: parsed.activityType,
              startedAt: parsed.startedAt,
              endedAt: parsed.endedAt,
              name: parsed.name,
              notes: parsed.notes,
              sourceName: parsed.sourceName,
              raw: parsed.raw,
            },
          })
          .returning({ id: activity.id });

        const activityId = activityRow?.id;
        if (!activityId) continue;

        // Delete old sensor_sample rows for this activity, then re-insert
        await db.delete(sensorSample).where(eq(sensorSample.activityId, activityId));

        // Parse and batch-insert track points
        const trackPoints = parseTrackPoints(trip.track_points ?? []);
        const indoor = isIndoorCycling(parsed.activityType);
        const metricRows = trackPoints.map((point) => ({
          recordedAt: point.recordedAt,
          activityId,
          providerId: this.id,
          lat: point.lat,
          lng: point.lng,
          altitude: point.altitude,
          speed: indoor ? undefined : point.speed,
          temperature: point.temperature,
          heartRate: point.heartRate,
          cadence: point.cadence,
          power: point.power,
        }));
        // metricRows still use the legacy shape; convert and insert into sensor_sample.
        await dualWriteToSensorSample(db, metricRows, SOURCE_TYPE_API);

        recordsSynced++;
      } catch (err) {
        errors.push({
          message: `Failed to sync trip ${item.item_id}: ${err instanceof Error ? err.message : String(err)}`,
          externalId: String(item.item_id),
          cause: err,
        });
      }
    }

    // Save sync cursor for next run
    if (syncResponse.meta?.rwgps_datetime) {
      await saveSyncCursor(db, syncResponse.meta.rwgps_datetime);
    }

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }
}
