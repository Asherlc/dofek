import type { Database } from "../db/index.ts";
import { activity } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import type { Provider, ProviderAuthSetup, SyncError, SyncResult } from "./types.ts";

// ============================================================
// TrainerRoad API types (reverse-engineered)
// ============================================================

const TRAINERROAD_BASE = "https://www.trainerroad.com";

interface TrainerRoadMemberInfo {
  MemberId: number;
  Username: string;
}

interface TrainerRoadActivity {
  Id: number;
  WorkoutName: string;
  CompletedDate: string; // ISO
  Duration: number; // seconds
  Tss: number;
  DistanceInMeters: number;
  IsOutside: boolean;
  ActivityType: string; // "Ride", "Run", "Swim", "VirtualRide", etc.
  IfFactor: number;
  NormalizedPower: number;
  AveragePower: number;
  MaxPower: number;
  AverageHeartRate: number;
  MaxHeartRate: number;
  AverageCadence: number;
  MaxCadence: number;
  Calories: number;
  ElevationGainInMeters: number;
  AverageSpeed: number; // m/s
  MaxSpeed: number; // m/s
}

interface TrainerRoadCareer {
  Ftp: number;
  Weight: number; // kg
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedTrainerRoadActivity {
  externalId: string;
  activityType: string;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

// ============================================================
// Parsing — pure functions
// ============================================================

export function mapTrainerRoadActivityType(activityType: string, isOutside: boolean): string {
  const type = activityType.toLowerCase();
  if (type.includes("ride") || type.includes("cycling")) {
    return isOutside ? "cycling" : "virtual_cycling";
  }
  if (type.includes("run")) return isOutside ? "running" : "virtual_running";
  if (type.includes("swim")) return "swimming";
  return "other";
}

export function parseTrainerRoadActivity(act: TrainerRoadActivity): ParsedTrainerRoadActivity {
  const completedAt = new Date(act.CompletedDate);
  const startedAt = new Date(completedAt.getTime() - act.Duration * 1000);

  return {
    externalId: String(act.Id),
    activityType: mapTrainerRoadActivityType(act.ActivityType, act.IsOutside),
    name: act.WorkoutName,
    startedAt,
    endedAt: completedAt,
    raw: {
      tss: act.Tss,
      distanceMeters: act.DistanceInMeters,
      normalizedPower: act.NormalizedPower,
      avgPower: act.AveragePower,
      maxPower: act.MaxPower,
      avgHeartRate: act.AverageHeartRate,
      maxHeartRate: act.MaxHeartRate,
      avgCadence: act.AverageCadence,
      maxCadence: act.MaxCadence,
      calories: act.Calories,
      elevationGain: act.ElevationGainInMeters,
      avgSpeed: act.AverageSpeed,
      maxSpeed: act.MaxSpeed,
      intensityFactor: act.IfFactor,
      isOutside: act.IsOutside,
    },
  };
}

// ============================================================
// TrainerRoad API client
// ============================================================

export class TrainerRoadClient {
  private authCookie: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(authCookie: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.authCookie = authCookie;
    this.fetchFn = fetchFn;
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${TRAINERROAD_BASE}${path}`;
    const response = await this.fetchFn(url, {
      headers: {
        Cookie: `SharedTrainerRoadAuth=${this.authCookie}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`TrainerRoad API error (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async getMemberInfo(): Promise<TrainerRoadMemberInfo> {
    return this.get<TrainerRoadMemberInfo>("/app/api/member-info");
  }

  async getActivities(
    username: string,
    startDate: string,
    endDate: string,
  ): Promise<TrainerRoadActivity[]> {
    return this.get<TrainerRoadActivity[]>(
      `/app/api/calendar/activities/${username}?startDate=${startDate}&endDate=${endDate}`,
    );
  }

  async getCareer(username: string): Promise<TrainerRoadCareer> {
    return this.get<TrainerRoadCareer>(`/app/api/career/${username}/new`);
  }

  static async signIn(
    username: string,
    password: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<{ authCookie: string; username: string }> {
    // First, get the CSRF token from the login page
    const loginPageResponse = await fetchFn(`${TRAINERROAD_BASE}/app/login`, {
      redirect: "manual",
    });
    const loginPageHtml = await loginPageResponse.text();

    // Extract __RequestVerificationToken from the page
    const tokenMatch = loginPageHtml.match(/name="__RequestVerificationToken"\s+value="([^"]+)"/);
    const csrfToken = tokenMatch?.[1] ?? "";

    // Extract cookies from the login page response
    const pageCookies = loginPageResponse.headers.getSetCookie?.() ?? [];
    const cookieHeader = pageCookies.map((c) => c.split(";")[0]).join("; ");

    // Submit login form
    const loginResponse = await fetchFn(`${TRAINERROAD_BASE}/app/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
      },
      body: new URLSearchParams({
        Username: username,
        Password: password,
        __RequestVerificationToken: csrfToken,
      }),
      redirect: "manual",
    });

    // Extract auth cookie from response
    const responseCookies = loginResponse.headers.getSetCookie?.() ?? [];
    const authCookieEntry = responseCookies.find((c) => c.startsWith("SharedTrainerRoadAuth="));
    if (!authCookieEntry) {
      throw new Error("TrainerRoad login failed — no auth cookie returned");
    }

    const authCookieValue = authCookieEntry.split("=")[1]?.split(";")[0] ?? "";

    // Get username from member info
    const client = new TrainerRoadClient(authCookieValue, fetchFn);
    const memberInfo = await client.getMemberInfo();

    return { authCookie: authCookieValue, username: memberInfo.Username };
  }
}

// ============================================================
// Helper
// ============================================================

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ============================================================
// Provider implementation
// ============================================================

export class TrainerRoadProvider implements Provider {
  readonly id = "trainerroad";
  readonly name = "TrainerRoad";
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
        clientId: "",
        authorizeUrl: `${TRAINERROAD_BASE}/app/login`,
        tokenUrl: `${TRAINERROAD_BASE}/app/login`,
        redirectUri: "",
        scopes: [],
      },
      automatedLogin: async (email: string, password: string) => {
        const result = await TrainerRoadClient.signIn(email, password, fetchFn);
        return {
          accessToken: result.authCookie,
          refreshToken: null,
          // TrainerRoad cookies last a long time; set 30-day expiry
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          scopes: `username:${result.username}`,
        };
      },
      exchangeCode: async () => {
        throw new Error("TrainerRoad uses automated login, not OAuth code exchange");
      },
    };
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name, TRAINERROAD_BASE);

    let client: TrainerRoadClient;
    let username: string;
    try {
      const stored = await loadTokens(db, this.id);
      if (!stored) {
        throw new Error("TrainerRoad not connected — authenticate via the web UI");
      }

      const usernameMatch = stored.scopes?.match(/username:(\S+)/);
      username = usernameMatch?.[1] ?? "";
      if (!username) {
        throw new Error("TrainerRoad username not found — re-authenticate");
      }

      // Re-auth if cookie expired
      if (stored.expiresAt <= new Date()) {
        const email = process.env.TRAINERROAD_USERNAME;
        const password = process.env.TRAINERROAD_PASSWORD;
        if (!email || !password) {
          throw new Error(
            "TrainerRoad cookie expired and TRAINERROAD_USERNAME/TRAINERROAD_PASSWORD not set",
          );
        }
        console.log("[trainerroad] Cookie expired, re-authenticating...");
        const result = await TrainerRoadClient.signIn(email, password, this.fetchFn);
        await saveTokens(db, this.id, {
          accessToken: result.authCookie,
          refreshToken: null,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          scopes: `username:${result.username}`,
        });
        client = new TrainerRoadClient(result.authCookie, this.fetchFn);
        username = result.username;
      } else {
        client = new TrainerRoadClient(stored.accessToken, this.fetchFn);
      }
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // Sync activities
    try {
      const activityCount = await withSyncLog(db, this.id, "activity", async () => {
        let count = 0;
        const sinceDate = formatDate(since);
        const toDate = formatDate(new Date());

        const activities = await client.getActivities(username, sinceDate, toDate);

        for (const raw of activities) {
          const parsed = parseTrainerRoadActivity(raw);
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
