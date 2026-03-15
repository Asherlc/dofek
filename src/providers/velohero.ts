import type { Database } from "../db/index.ts";
import { activity } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import type { Provider, ProviderAuthSetup, SyncError, SyncResult } from "./types.ts";

// ============================================================
// VeloHero API types (reverse-engineered via tapiriik)
// ============================================================

const VELOHERO_BASE_URL = "https://app.velohero.com";

interface VeloHeroWorkout {
  id: string;
  date_ymd: string;
  start_time: string;
  dur_time: string; // HH:MM:SS
  sport_id: string;
  dist_km: string;
  title?: string;
  ascent?: string;
  descent?: string;
  avg_hr?: string;
  max_hr?: string;
  avg_power?: string;
  max_power?: string;
  avg_cadence?: string;
  max_cadence?: string;
  calories?: string;
  file?: string;
  hide?: string;
}

interface VeloHeroWorkoutsResponse {
  workouts: VeloHeroWorkout[];
}

interface VeloHeroSsoResponse {
  session: string;
  "user-id": string;
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedVeloHeroWorkout {
  externalId: string;
  activityType: string;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

// ============================================================
// Sport type mapping
// ============================================================

const VELOHERO_SPORT_MAP: Record<string, string> = {
  "0": "other",
  "1": "cycling",
  "2": "running",
  "3": "swimming",
  "4": "gym",
  "5": "strength",
  "6": "mountain_biking",
  "7": "hiking",
  "8": "cross_country_skiing",
  "9": "cycling", // velomobil / HPV
  "10": "ball_games",
  "11": "rowing",
  "12": "cycling", // pedelec / e-bike
};

export function mapVeloHeroSport(sportId: string): string {
  return VELOHERO_SPORT_MAP[sportId] ?? "other";
}

// ============================================================
// Parsing — pure functions
// ============================================================

/**
 * Parse a duration string in HH:MM:SS format to total seconds.
 */
export function parseDurationToSeconds(durTime: string): number {
  const parts = durTime.split(":");
  if (parts.length !== 3) return 0;
  const hours = Number.parseInt(parts[0] ?? "0", 10);
  const minutes = Number.parseInt(parts[1] ?? "0", 10);
  const seconds = Number.parseInt(parts[2] ?? "0", 10);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Parse a numeric string, returning undefined if empty/invalid.
 */
function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value || value.trim() === "") return undefined;
  const num = Number.parseFloat(value);
  return Number.isNaN(num) ? undefined : num;
}

export function parseVeloHeroWorkout(workout: VeloHeroWorkout): ParsedVeloHeroWorkout {
  const durationSeconds = parseDurationToSeconds(workout.dur_time);

  // Build startedAt from date_ymd + start_time
  const dateStr = workout.date_ymd;
  const timeStr = workout.start_time || "00:00:00";
  const startedAt = new Date(`${dateStr}T${timeStr}`);
  const endedAt = new Date(startedAt.getTime() + durationSeconds * 1000);

  const distanceKm = parseOptionalNumber(workout.dist_km);
  const distanceMeters = distanceKm !== undefined ? Math.round(distanceKm * 1000) : undefined;
  const avgHeartRate = parseOptionalNumber(workout.avg_hr);
  const maxHeartRate = parseOptionalNumber(workout.max_hr);
  const avgPower = parseOptionalNumber(workout.avg_power);
  const maxPower = parseOptionalNumber(workout.max_power);
  const avgCadence = parseOptionalNumber(workout.avg_cadence);
  const maxCadence = parseOptionalNumber(workout.max_cadence);
  const calories = parseOptionalNumber(workout.calories);
  const ascent = parseOptionalNumber(workout.ascent);
  const descent = parseOptionalNumber(workout.descent);

  return {
    externalId: String(workout.id),
    activityType: mapVeloHeroSport(workout.sport_id),
    name: workout.title || `${mapVeloHeroSport(workout.sport_id)} workout`,
    startedAt,
    endedAt,
    raw: {
      sportId: workout.sport_id,
      durationSeconds,
      distanceMeters,
      avgHeartRate,
      maxHeartRate,
      avgPower,
      maxPower,
      avgCadence,
      maxCadence,
      calories,
      ascent,
      descent,
    },
  };
}

// ============================================================
// VeloHero API client
// ============================================================

export class VeloHeroClient {
  private sessionCookie: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(sessionCookie: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.sessionCookie = sessionCookie;
    this.fetchFn = fetchFn;
  }

  private async get<T>(path: string, params?: URLSearchParams): Promise<T> {
    const url = params ? `${VELOHERO_BASE_URL}${path}?${params}` : `${VELOHERO_BASE_URL}${path}`;
    const response = await this.fetchFn(url, {
      headers: {
        Cookie: this.sessionCookie,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`VeloHero API error (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async getWorkouts(dateFrom: string, dateTo: string): Promise<VeloHeroWorkout[]> {
    const params = new URLSearchParams({
      date_from: dateFrom,
      date_to: dateTo,
    });
    const data = await this.get<VeloHeroWorkoutsResponse>("/export/workouts/json", params);
    return data.workouts ?? [];
  }

  async getWorkout(id: string): Promise<VeloHeroWorkout> {
    return this.get<VeloHeroWorkout>(`/export/workouts/json/${id}`);
  }

  static async signIn(
    username: string,
    password: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<{ sessionCookie: string; userId: string }> {
    const body = new URLSearchParams({
      user: username,
      pass: password,
      view: "json",
    });

    const response = await fetchFn(`${VELOHERO_BASE_URL}/sso`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      redirect: "manual",
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`VeloHero sign-in failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as VeloHeroSsoResponse;
    if (!data.session) {
      throw new Error("VeloHero sign-in did not return a session token");
    }

    // The session token is used as a cookie value
    const sessionCookie = `VeloHero_session=${data.session}`;

    return {
      sessionCookie,
      userId: data["user-id"],
    };
  }
}

// ============================================================
// Helper: format date as YYYY-MM-DD
// ============================================================

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ============================================================
// Provider implementation
// ============================================================

export class VeloHeroProvider implements Provider {
  readonly id = "velohero";
  readonly name = "VeloHero";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    // VeloHero is always "enabled" — auth state checked at sync time via stored tokens
    return null;
  }

  authSetup(): ProviderAuthSetup {
    const fetchFn = this.fetchFn;
    return {
      oauthConfig: {
        clientId: "",
        clientSecret: "",
        authorizeUrl: `${VELOHERO_BASE_URL}/sso`,
        tokenUrl: `${VELOHERO_BASE_URL}/sso`,
        redirectUri: "",
        scopes: [],
      },
      automatedLogin: async (email: string, password: string) => {
        const result = await VeloHeroClient.signIn(email, password, fetchFn);
        return {
          accessToken: result.sessionCookie,
          refreshToken: null,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // sessions likely expire in ~24h
          scopes: `userId:${result.userId}`,
        };
      },
      exchangeCode: async () => {
        throw new Error("VeloHero uses automated login, not OAuth code exchange");
      },
    };
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, VELOHERO_BASE_URL);

    // Resolve session — re-authenticate if expired
    let client: VeloHeroClient;
    try {
      const stored = await loadTokens(db, this.id);
      if (!stored) {
        throw new Error("VeloHero not connected — authenticate via the web UI");
      }

      // Re-authenticate if token expired (session cookies expire)
      if (stored.expiresAt <= new Date()) {
        const username = process.env.VELOHERO_USERNAME;
        const password = process.env.VELOHERO_PASSWORD;
        if (!username || !password) {
          throw new Error(
            "VeloHero session expired and VELOHERO_USERNAME/VELOHERO_PASSWORD not set for re-auth",
          );
        }
        console.log("[velohero] Session expired, re-authenticating...");
        const result = await VeloHeroClient.signIn(username, password, this.fetchFn);
        const tokens = {
          accessToken: result.sessionCookie,
          refreshToken: null,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          scopes: `userId:${result.userId}`,
        };
        await saveTokens(db, this.id, tokens);
        client = new VeloHeroClient(result.sessionCookie, this.fetchFn);
      } else {
        client = new VeloHeroClient(stored.accessToken, this.fetchFn);
      }
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // Fetch and sync activities
    const sinceDate = formatDate(since);
    const toDate = formatDate(new Date());

    try {
      const activityCount = await withSyncLog(db, this.id, "activity", async () => {
        let count = 0;

        console.log(`[velohero] Fetching workouts from ${sinceDate} to ${toDate}`);
        const workouts = await client.getWorkouts(sinceDate, toDate);
        console.log(`[velohero] Fetched ${workouts.length} workouts`);

        for (const workout of workouts) {
          const parsed = parseVeloHeroWorkout(workout);
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
          } catch (err) {
            errors.push({
              message: err instanceof Error ? err.message : String(err),
              externalId: parsed.externalId,
              cause: err,
            });
          }
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

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
