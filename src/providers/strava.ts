import { sql } from "drizzle-orm";
import type { OAuthConfig, TokenSet } from "../auth/oauth.ts";
import { exchangeCodeForTokens, getOAuthRedirectUri, refreshAccessToken } from "../auth/oauth.ts";
import type { SyncDatabase } from "../db/index.ts";
import { activity, metricStream } from "../db/schema.ts";
import { loadTokens, saveTokens } from "../db/tokens.ts";
import { logger } from "../logger.ts";
import type {
  Provider,
  ProviderAuthSetup,
  ProviderIdentity,
  SyncError,
  SyncResult,
} from "./types.ts";

// ============================================================
// Strava API types
// ============================================================

export interface StravaActivity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  start_date: string;
  elapsed_time: number;
  moving_time: number;
  distance: number;
  total_elevation_gain: number;
  average_speed?: number;
  max_speed?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_watts?: number;
  max_watts?: number;
  weighted_average_watts?: number;
  kilojoules?: number;
  average_cadence?: number;
  suffer_score?: number;
  calories?: number;
  start_latlng?: [number, number];
  end_latlng?: [number, number];
  trainer: boolean;
  commute: boolean;
  manual: boolean;
  gear_id?: string;
  device_watts?: boolean;
  /** Recording device name — only present on detailed activity responses. */
  device_name?: string;
}

/** Detailed activity response from GET /activities/{id}. */
export interface StravaDetailedActivity extends StravaActivity {
  device_name?: string;
}

export interface StravaStream {
  data: number[] | [number, number][];
  series_type: string;
  resolution: string;
  original_size: number;
}

export interface StravaStreamSet {
  time?: StravaStream;
  heartrate?: StravaStream;
  watts?: StravaStream;
  cadence?: StravaStream;
  velocity_smooth?: StravaStream;
  latlng?: StravaStream;
  altitude?: StravaStream;
  distance?: StravaStream;
  temp?: StravaStream;
  grade_smooth?: StravaStream;
}

const STREAM_KEYS = new Set<string>([
  "time",
  "heartrate",
  "watts",
  "cadence",
  "velocity_smooth",
  "latlng",
  "altitude",
  "distance",
  "temp",
  "grade_smooth",
]);

function isStreamKey(key: string): key is keyof StravaStreamSet {
  return STREAM_KEYS.has(key);
}

// ============================================================
// Activity type mapping
// ============================================================

const ACTIVITY_TYPE_MAP: Record<string, string> = {
  Ride: "cycling",
  VirtualRide: "cycling",
  MountainBikeRide: "cycling",
  GravelRide: "cycling",
  EBikeRide: "cycling",
  Run: "running",
  VirtualRun: "running",
  TrailRun: "running",
  Walk: "walking",
  Hike: "hiking",
  Swim: "swimming",
  WeightTraining: "strength",
  Yoga: "yoga",
  Rowing: "rowing",
  Canoeing: "rowing",
  Kayaking: "rowing",
  Elliptical: "elliptical",
  NordicSki: "skiing",
  AlpineSki: "skiing",
  BackcountrySki: "skiing",
  Snowboard: "skiing",
  IceSkate: "skating",
  RollerSki: "skiing",
  Crossfit: "strength",
  RockClimbing: "climbing",
};

export function mapStravaActivityType(sportType: string): string {
  return ACTIVITY_TYPE_MAP[sportType] ?? "other";
}

// ============================================================
// Parsing / mapping (pure functions, easy to test)
// ============================================================

export interface ParsedStravaActivity {
  externalId: string;
  activityType: string;
  name: string;
  startedAt: Date;
  endedAt: Date;
  sourceName: string | undefined;
}

export function parseStravaActivity(act: StravaActivity): ParsedStravaActivity {
  const startedAt = new Date(act.start_date);
  return {
    externalId: String(act.id),
    activityType: mapStravaActivityType(act.sport_type),
    name: act.name,
    startedAt,
    endedAt: new Date(startedAt.getTime() + act.elapsed_time * 1000),
    sourceName: act.device_name,
  };
}

export interface ParsedStravaActivityList {
  activities: ParsedStravaActivity[];
  hasMore: boolean;
}

export function parseStravaActivityList(
  activities: StravaActivity[],
  perPage: number,
): ParsedStravaActivityList {
  return {
    activities: activities.map(parseStravaActivity),
    hasMore: activities.length >= perPage,
  };
}

// ============================================================
// Streams → metric_stream mapping
// ============================================================

export function stravaStreamsToMetricStream(
  streams: StravaStreamSet,
  providerId: string,
  activityId: string,
  startedAt: Date,
): (typeof metricStream.$inferInsert)[] {
  // Scalar streams contain number[], latlng contains [number, number][]
  function isScalarArray(data: number[] | [number, number][]): data is number[] {
    return data.length === 0 || !Array.isArray(data[0]);
  }
  function isTupleArray(data: number[] | [number, number][]): data is [number, number][] {
    return data.length > 0 && Array.isArray(data[0]);
  }
  function scalarData(s: StravaStream | undefined): number[] | undefined {
    if (!s?.data) return undefined;
    return isScalarArray(s.data) ? s.data : undefined;
  }
  function tupleData(s: StravaStream | undefined): [number, number][] | undefined {
    if (!s?.data) return undefined;
    return isTupleArray(s.data) ? s.data : undefined;
  }
  const timeData = scalarData(streams.time);
  if (!timeData || timeData.length === 0) return [];

  const heartrates = scalarData(streams.heartrate);
  const watts = scalarData(streams.watts);
  const cadences = scalarData(streams.cadence);
  const speeds = scalarData(streams.velocity_smooth);
  const latlngs = tupleData(streams.latlng);
  const altitudes = scalarData(streams.altitude);
  const distances = scalarData(streams.distance);
  const temps = scalarData(streams.temp);
  const grades = scalarData(streams.grade_smooth);

  return timeData.map((timeOffset, i) => {
    const latlng = latlngs?.[i];

    const raw: Record<string, unknown> = { time: timeOffset };
    if (heartrates?.[i] !== undefined) raw.heartrate = heartrates[i];
    if (watts?.[i] !== undefined) raw.watts = watts[i];
    if (cadences?.[i] !== undefined) raw.cadence = cadences[i];
    if (speeds?.[i] !== undefined) raw.velocity_smooth = speeds[i];
    if (latlng !== undefined) raw.latlng = latlng;
    if (altitudes?.[i] !== undefined) raw.altitude = altitudes[i];
    if (distances?.[i] !== undefined) raw.distance = distances[i];
    if (temps?.[i] !== undefined) raw.temp = temps[i];
    if (grades?.[i] !== undefined) raw.grade_smooth = grades[i];

    return {
      providerId,
      activityId,
      recordedAt: new Date(startedAt.getTime() + timeOffset * 1000),
      heartRate: heartrates?.[i],
      power: watts?.[i],
      cadence: cadences?.[i],
      speed: speeds?.[i],
      lat: latlng?.[0],
      lng: latlng?.[1],
      altitude: altitudes?.[i],
      temperature: temps?.[i],
      grade: grades?.[i],
      raw,
    };
  });
}

// ============================================================
// Strava API client
// ============================================================

const STRAVA_API_BASE = "https://www.strava.com/api/v3/";

export class StravaClient {
  private accessToken: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.accessToken = accessToken;
    this.fetchFn = fetchFn;
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, STRAVA_API_BASE);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await this.fetchFn(url.toString(), {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (response.status === 429) {
      throw new StravaRateLimitError(`Strava API rate limit exceeded (429)`);
    }

    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      let detail: string;
      if (contentType.includes("application/json")) {
        const json = await response.json();
        detail = JSON.stringify(json);
      } else if (contentType.includes("text/html")) {
        detail = "(HTML error page)";
      } else {
        const text = await response.text();
        detail = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      }
      throw new Error(`Strava API error (${response.status}): ${detail}`);
    }

    return response.json();
  }

  async getActivity(activityId: number): Promise<StravaDetailedActivity> {
    return this.get<StravaDetailedActivity>(`activities/${activityId}`);
  }

  async getActivities(after: number, page = 1, perPage = 30): Promise<StravaActivity[]> {
    return this.get<StravaActivity[]>("athlete/activities", {
      after: String(after),
      page: String(page),
      per_page: String(perPage),
    });
  }

  async getActivityStreams(activityId: number): Promise<StravaStreamSet> {
    const streamTypes = [
      "time",
      "heartrate",
      "watts",
      "cadence",
      "velocity_smooth",
      "latlng",
      "altitude",
      "distance",
      "temp",
      "grade_smooth",
    ];

    const response = await this.get<Array<{ type: string } & StravaStream>>(
      `activities/${activityId}/streams`,
      { keys: streamTypes.join(","), key_type: "time" },
    );

    // Strava returns an array of stream objects; convert to a keyed object
    const streams: StravaStreamSet = {};
    for (const stream of response) {
      const streamKey = stream.type;
      if (!isStreamKey(streamKey)) continue;
      streams[streamKey] = {
        data: stream.data,
        series_type: stream.series_type,
        resolution: stream.resolution,
        original_size: stream.original_size,
      };
    }
    return streams;
  }
}

export class StravaRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StravaRateLimitError";
  }
}

// ============================================================
// Provider implementation
// ============================================================

const STRAVA_AUTH_BASE = "https://www.strava.com/oauth";

export function stravaOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    authorizeUrl: `${STRAVA_AUTH_BASE}/authorize`,
    tokenUrl: `${STRAVA_AUTH_BASE}/token`,
    redirectUri: getOAuthRedirectUri(),
    scopes: ["read", "activity:read_all"],
    scopeSeparator: ",",
  };
}

export class StravaProvider implements Provider {
  readonly id = "strava";
  readonly name = "Strava";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.STRAVA_CLIENT_ID) return "STRAVA_CLIENT_ID is not set";
    if (!process.env.STRAVA_CLIENT_SECRET) return "STRAVA_CLIENT_SECRET is not set";
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const config = stravaOAuthConfig();
    if (!config) throw new Error("STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET are required");
    return {
      oauthConfig: config,
      exchangeCode: (code) => exchangeCodeForTokens(config, code),
      apiBaseUrl: STRAVA_API_BASE,
      getUserIdentity: async (accessToken: string): Promise<ProviderIdentity> => {
        const response = await this.fetchFn(`${STRAVA_API_BASE}athlete`, {
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
          email: athlete.email ?? null,
          name: nameParts.length > 0 ? nameParts.join(" ") : null,
        };
      },
    };
  }

  private async resolveTokens(db: SyncDatabase): Promise<TokenSet> {
    const tokens = await loadTokens(db, this.id);
    if (!tokens) {
      throw new Error("No OAuth tokens found for Strava. Run: health-data auth strava");
    }

    if (tokens.expiresAt > new Date()) {
      return tokens;
    }

    logger.info("[strava] Access token expired, refreshing...");
    const config = stravaOAuthConfig();
    if (!config)
      throw new Error("STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET are required to refresh tokens");
    if (!tokens.refreshToken) throw new Error("No refresh token for Strava");
    const refreshed = await refreshAccessToken(config, tokens.refreshToken, this.fetchFn);
    await saveTokens(db, this.id, refreshed);
    return refreshed;
  }

  async sync(
    db: SyncDatabase,
    since: Date,
    onProgress?: import("./types.ts").SyncProgressCallback,
  ): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    let tokens: TokenSet;
    try {
      tokens = await this.resolveTokens(db);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const client = new StravaClient(tokens.accessToken, this.fetchFn);

    // Strava uses epoch seconds for the `after` parameter
    const afterEpoch = Math.floor(since.getTime() / 1000);

    let page = 1;
    const perPage = 30;
    let hasMore = true;
    let rateLimited = false;

    while (hasMore && !rateLimited) {
      let rawActivities: StravaActivity[];
      try {
        rawActivities = await client.getActivities(afterEpoch, page, perPage);
      } catch (err) {
        if (err instanceof StravaRateLimitError) {
          errors.push({
            message: "Strava API rate limit exceeded — stopping sync. Will resume on next run.",
            cause: err,
          });
          break;
        }
        throw err;
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
              rateLimited = true;
              break;
            }
            errors.push({
              message: `Detail for activity ${act.externalId}: ${detailErr instanceof Error ? detailErr.message : String(detailErr)}`,
              externalId: act.externalId,
              cause: detailErr,
            });
          }

          const [row] = await db
            .insert(activity)
            .values({
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
              target: [activity.providerId, activity.externalId],
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
            );

            if (metricRows.length > 0) {
              // Insert in batches of 500
              for (let i = 0; i < metricRows.length; i += 500) {
                await db.insert(metricStream).values(metricRows.slice(i, i + 500));
              }
              logger.info(
                `[strava] Inserted ${metricRows.length} metric_stream records for activity ${act.externalId}`,
              );
            }
          } catch (streamErr) {
            if (streamErr instanceof StravaRateLimitError) {
              errors.push({
                message: "Strava API rate limit hit while fetching streams — stopping stream sync.",
                cause: streamErr,
              });
              rateLimited = true;
              break;
            }
            errors.push({
              message: `Streams for activity ${act.externalId}: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
              externalId: act.externalId,
              cause: streamErr,
            });
          }
        } catch (err) {
          errors.push({
            message: err instanceof Error ? err.message : String(err),
            externalId: act.externalId,
            cause: err,
          });
        }
      }

      hasMore = parsed.hasMore && !rateLimited;
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
