import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.ts";
import { activity, DEFAULT_USER_ID, metricStream, userSettings } from "../db/schema.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import type { Provider, SyncError, SyncResult } from "./types.ts";

// ============================================================
// RideWithGPS API types
// ============================================================

export interface RideWithGpsTrackPoint {
  x: number; // longitude
  y: number; // latitude
  d: number; // distance from start, meters
  e?: number; // elevation, meters
  t?: number; // unix epoch seconds
  s?: number; // speed, km/h
  T?: number; // temperature, celsius
  h?: number; // heart rate, bpm
  c?: number; // cadence, rpm
  p?: number; // power, watts
}

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
}

export interface RideWithGpsTripDetail extends RideWithGpsTripSummary {
  track_points: RideWithGpsTrackPoint[];
}

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

interface RideWithGpsAuthTokenResponse {
  auth_token: {
    auth_token: string;
    user: { id: number; email: string };
  };
}

// ============================================================
// Activity type mapping
// ============================================================

const ACTIVITY_TYPE_MAP: Record<string, string> = {
  cycling: "cycling",
  mountain_biking: "cycling",
  road_cycling: "cycling",
  gravel_cycling: "cycling",
  cyclocross: "cycling",
  track_cycling: "cycling",
  running: "running",
  trail_running: "running",
  walking: "walking",
  hiking: "hiking",
  swimming: "swimming",
};

export function mapActivityType(rawType: string | null | undefined): string {
  if (!rawType) return "cycling";
  return ACTIVITY_TYPE_MAP[rawType] ?? "other";
}

// ============================================================
// Pure parsing functions
// ============================================================

export interface ParsedActivity {
  externalId: string;
  activityType: string;
  name: string;
  startedAt: Date;
  endedAt: Date | undefined;
  notes: string | undefined;
  raw: RideWithGpsTripSummary;
}

export interface ParsedTrackPoint {
  recordedAt: Date;
  lat: number;
  lng: number;
  altitude: number | undefined;
  distance: number | undefined;
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
    raw: trip,
  };
}

export function parseTrackPoints(points: RideWithGpsTrackPoint[]): ParsedTrackPoint[] {
  const result: ParsedTrackPoint[] = [];
  for (const point of points) {
    // Skip points without a timestamp — can't insert into metric_stream
    if (point.t === undefined) continue;

    result.push({
      recordedAt: new Date(point.t * 1000),
      lat: point.y,
      lng: point.x,
      altitude: point.e,
      distance: point.d,
      speed: point.s !== undefined ? point.s / 3.6 : undefined,
      temperature: point.T,
      heartRate: point.h,
      cadence: point.c,
      power: point.p,
    });
  }
  return result;
}

// ============================================================
// API client
// ============================================================

const RWGPS_API_BASE = "https://ridewithgps.com";

export class RideWithGpsClient {
  private apiKey: string;
  private authToken: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(
    apiKey: string,
    authToken: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.apiKey = apiKey;
    this.authToken = authToken;
    this.fetchFn = fetchFn;
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, RWGPS_API_BASE);
    url.searchParams.set("apikey", this.apiKey);
    url.searchParams.set("auth_token", this.authToken);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    const response = await this.fetchFn(url.toString(), {
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`RWGPS API error (${response.status}): ${text}`);
    }
    return response.json() as Promise<T>;
  }

  static async exchangeCredentials(
    apiKey: string,
    email: string,
    password: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<string> {
    const url = new URL("/api/v1/auth_tokens.json", RWGPS_API_BASE);
    url.searchParams.set("apikey", apiKey);
    const response = await fetchFn(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: { email, password } }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`RWGPS auth failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as RideWithGpsAuthTokenResponse;
    return data.auth_token.auth_token;
  }

  async sync(since: string): Promise<RideWithGpsSyncResponse> {
    return this.get<RideWithGpsSyncResponse>("/api/v1/sync.json", {
      since,
      assets: "trips",
    });
  }

  async getTrip(id: number): Promise<{ trip: RideWithGpsTripDetail }> {
    return this.get<{ trip: RideWithGpsTripDetail }>(`/api/v1/trips/${id}.json`);
  }
}

// ============================================================
// Sync cursor helpers
// ============================================================

const SYNC_CURSOR_KEY = "rwgps_sync_cursor";

async function loadSyncCursor(db: Database): Promise<string | null> {
  const rows = await db
    .select({ value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.userId, DEFAULT_USER_ID), eq(userSettings.key, SYNC_CURSOR_KEY)))
    .limit(1);

  if (rows.length === 0 || !rows[0]) return null;
  const value = rows[0].value as { cursor?: string };
  return value.cursor ?? null;
}

async function saveSyncCursor(db: Database, cursor: string): Promise<void> {
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

const METRIC_STREAM_BATCH_SIZE = 500;

export class RideWithGpsProvider implements Provider {
  readonly id = "ride-with-gps";
  readonly name = "RideWithGPS";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    // Credentials are stored in DB via the UI auth modal — always valid
    return null;
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, RWGPS_API_BASE);

    // Load stored tokens (API key stored as refreshToken, auth token as accessToken)
    const tokens = await loadTokens(db, this.id);
    if (!tokens) {
      return {
        provider: this.id,
        recordsSynced: 0,
        errors: [{ message: "No RWGPS credentials found. Connect via the Data Sources page." }],
        duration: Date.now() - start,
      };
    }

    const authToken = tokens.accessToken;
    const apiKey = tokens.refreshToken;
    if (!apiKey) {
      return {
        provider: this.id,
        recordsSynced: 0,
        errors: [{ message: "No RWGPS API key found. Reconnect via the Data Sources page." }],
        duration: Date.now() - start,
      };
    }

    const client = new RideWithGpsClient(apiKey, authToken, this.fetchFn);

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
              raw: parsed.raw,
            },
          })
          .returning({ id: activity.id });

        const activityId = activityRow?.id;
        if (!activityId) continue;

        // Delete old metric_stream rows for this activity, then re-insert
        await db.delete(metricStream).where(eq(metricStream.activityId, activityId));

        // Parse and batch-insert track points
        const trackPoints = parseTrackPoints(trip.track_points ?? []);
        for (let i = 0; i < trackPoints.length; i += METRIC_STREAM_BATCH_SIZE) {
          const batch = trackPoints.slice(i, i + METRIC_STREAM_BATCH_SIZE);
          await db.insert(metricStream).values(
            batch.map((point) => ({
              recordedAt: point.recordedAt,
              activityId,
              providerId: this.id,
              lat: point.lat,
              lng: point.lng,
              altitude: point.altitude,
              distance: point.distance,
              speed: point.speed,
              temperature: point.temperature,
              heartRate: point.heartRate,
              cadence: point.cadence,
              power: point.power,
            })),
          );
        }

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
