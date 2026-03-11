import type { Database } from "../db/index.ts";
import { activity, dailyMetrics, metricStream, sleepSession } from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import type { Provider, SyncError, SyncResult } from "./types.ts";

// ============================================================
// WHOOP internal API types
// ============================================================

export interface WhoopHrValue {
  time: number; // Unix millis
  data: number; // BPM
}

interface WhoopHrResponse {
  values: WhoopHrValue[];
}

export interface WhoopRecoveryScore {
  user_calibrating: boolean;
  recovery_score: number;
  resting_heart_rate: number;
  hrv_rmssd_milli: number;
  spo2_percentage?: number;
  skin_temp_celsius?: number;
}

export interface WhoopRecoveryRecord {
  cycle_id: number;
  sleep_id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  score_state: string;
  score?: WhoopRecoveryScore;
}

export interface WhoopSleepStageSummary {
  total_in_bed_time_milli: number;
  total_awake_time_milli: number;
  total_no_data_time_milli: number;
  total_light_sleep_time_milli: number;
  total_slow_wave_sleep_time_milli: number;
  total_rem_sleep_time_milli: number;
  sleep_cycle_count: number;
  disturbance_count: number;
}

export interface WhoopSleepNeeded {
  baseline_milli: number;
  need_from_sleep_debt_milli: number;
  need_from_recent_strain_milli: number;
  need_from_recent_nap_milli: number;
}

export interface WhoopSleepScore {
  stage_summary: WhoopSleepStageSummary;
  sleep_needed: WhoopSleepNeeded;
  respiratory_rate: number;
  sleep_performance_percentage: number;
  sleep_consistency_percentage: number;
  sleep_efficiency_percentage: number;
}

export interface WhoopSleepRecord {
  id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  nap: boolean;
  score_state: string;
  score?: WhoopSleepScore;
}

export interface WhoopZoneDuration {
  zone_zero_milli?: number;
  zone_one_milli?: number;
  zone_two_milli?: number;
  zone_three_milli?: number;
  zone_four_milli?: number;
  zone_five_milli?: number;
}

export interface WhoopWorkoutScore {
  strain: number;
  average_heart_rate: number;
  max_heart_rate: number;
  kilojoule: number;
  percent_recorded: number;
  distance_meter?: number;
  altitude_gain_meter?: number;
  altitude_change_meter?: number;
  zone_duration: WhoopZoneDuration;
}

export interface WhoopWorkoutRecord {
  id: number;
  user_id: number;
  created_at: string;
  updated_at: string;
  start: string;
  end: string;
  timezone_offset: string;
  sport_id: number;
  score_state: string;
  score?: WhoopWorkoutScore;
}

// ============================================================
// Sport ID mapping — complete list from WHOOP developer docs
// ============================================================

/* eslint-disable @typescript-eslint/no-duplicate-enum-members */
const WHOOP_SPORT_MAP: Record<number, string> = {
  [-1]: "other",
  0: "running",
  1: "cycling",
  16: "baseball",
  17: "basketball",
  18: "rowing",
  19: "fencing",
  20: "field hockey",
  21: "football",
  22: "golf",
  24: "ice hockey",
  25: "lacrosse",
  27: "rugby",
  28: "sailing",
  29: "skiing",
  30: "soccer",
  31: "softball",
  32: "squash",
  33: "swimming",
  34: "tennis",
  35: "track & field",
  36: "volleyball",
  37: "water polo",
  38: "wrestling",
  39: "boxing",
  42: "dance",
  43: "pilates",
  44: "yoga",
  45: "weightlifting",
  47: "cross country skiing",
  48: "functional fitness",
  49: "duathlon",
  51: "gymnastics",
  52: "hiking",
  53: "horseback riding",
  55: "kayaking",
  56: "martial arts",
  57: "mountain biking",
  59: "powerlifting",
  60: "rock climbing",
  61: "paddleboarding",
  62: "triathlon",
  63: "walking",
  64: "surfing",
  65: "elliptical",
  66: "stairmaster",
  70: "meditation",
  71: "other",
  73: "diving",
  74: "operations - tactical",
  75: "operations - medical",
  76: "operations - flying",
  77: "operations - water",
  82: "ultimate",
  83: "climber",
  84: "jumping rope",
  85: "australian football",
  86: "skateboarding",
  87: "coaching",
  88: "ice bath",
  89: "commuting",
  90: "gaming",
  91: "snowboarding",
  92: "motocross",
  93: "caddying",
  94: "obstacle course racing",
  95: "motor racing",
  96: "hiit",
  97: "spin",
  98: "jiu jitsu",
  99: "manual labor",
  100: "cricket",
  101: "paddle ball",
  102: "inline skating",
  103: "box fitness",
  104: "spikeball",
  105: "wheelchair pushing",
  106: "paddle tennis",
  107: "barre",
  108: "stage performance",
  109: "high stress work",
  110: "parkour",
  111: "gaelic football",
  112: "hurling",
  113: "circus arts",
  121: "massage therapy",
  123: "strength trainer",
  125: "watching sports",
  126: "assault bike",
  127: "kickboxing",
  128: "stretching",
  230: "table tennis",
  231: "badminton",
  232: "netball",
  233: "sauna",
  234: "disc golf",
  235: "yard work",
  236: "air compression",
  237: "percussive massage",
  238: "paintball",
  239: "ice skating",
  240: "handball",
  248: "f45 training",
  249: "padel",
  250: "barry's",
  251: "dedicated parenting",
  252: "stroller walking",
  253: "stroller jogging",
  254: "toddlerwearing",
  255: "babywearing",
  258: "barre3",
  259: "hot yoga",
  261: "stadium steps",
  262: "polo",
  263: "musical performance",
  264: "kite boarding",
  266: "dog walking",
  267: "water skiing",
  268: "wakeboarding",
  269: "cooking",
  270: "cleaning",
  272: "public speaking",
};

function mapSportId(sportId: number): string {
  return WHOOP_SPORT_MAP[sportId] ?? "other";
}

// ============================================================
// Parsing — pure functions
// ============================================================

function milliToMinutes(milli: number): number {
  return Math.round(milli / 60000);
}

export interface ParsedRecovery {
  cycleId: number;
  restingHr?: number;
  hrv?: number;
  spo2?: number;
  skinTemp?: number;
}

export function parseRecovery(record: WhoopRecoveryRecord): ParsedRecovery {
  const score = record.score_state === "SCORED" ? record.score : undefined;
  return {
    cycleId: record.cycle_id,
    restingHr: score?.resting_heart_rate,
    hrv: score?.hrv_rmssd_milli,
    spo2: score?.spo2_percentage,
    skinTemp: score?.skin_temp_celsius,
  };
}

export interface ParsedSleep {
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
  deepMinutes: number;
  remMinutes: number;
  lightMinutes: number;
  awakeMinutes: number;
  efficiencyPct?: number;
  isNap: boolean;
}

export function parseSleep(record: WhoopSleepRecord): ParsedSleep {
  const stages = record.score?.stage_summary;
  const totalSleepMilli =
    (stages?.total_in_bed_time_milli ?? 0) - (stages?.total_awake_time_milli ?? 0);

  return {
    externalId: String(record.id),
    startedAt: new Date(record.start),
    endedAt: new Date(record.end),
    durationMinutes: milliToMinutes(totalSleepMilli),
    deepMinutes: milliToMinutes(stages?.total_slow_wave_sleep_time_milli ?? 0),
    remMinutes: milliToMinutes(stages?.total_rem_sleep_time_milli ?? 0),
    lightMinutes: milliToMinutes(stages?.total_light_sleep_time_milli ?? 0),
    awakeMinutes: milliToMinutes(stages?.total_awake_time_milli ?? 0),
    efficiencyPct: record.score?.sleep_efficiency_percentage,
    isNap: record.nap,
  };
}

export interface ParsedWorkout {
  externalId: string;
  activityType: string;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
  distanceMeters?: number;
  calories?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  totalElevationGain?: number;
}

export function parseWorkout(record: WhoopWorkoutRecord): ParsedWorkout {
  const score = record.score;
  const startedAt = new Date(record.start);
  const endedAt = new Date(record.end);

  return {
    externalId: String(record.id),
    activityType: mapSportId(record.sport_id),
    startedAt,
    endedAt,
    durationSeconds: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
    distanceMeters: score?.distance_meter,
    calories: score?.kilojoule ? Math.round(score.kilojoule / 4.184) : undefined,
    avgHeartRate: score?.average_heart_rate,
    maxHeartRate: score?.max_heart_rate,
    totalElevationGain: score?.altitude_gain_meter,
  };
}

export interface ParsedHrRecord {
  recordedAt: Date;
  heartRate: number;
}

export function parseHeartRateValues(values: WhoopHrValue[]): ParsedHrRecord[] {
  return values.map((v) => ({
    recordedAt: new Date(v.time),
    heartRate: v.data,
  }));
}

// ============================================================
// Cycle — aggregated response from internal API
// ============================================================

export interface WhoopCycle {
  id: number;
  user_id: number;
  days?: string[];
  recovery?: WhoopRecoveryRecord;
  sleep?: { id: number };
  strain?: {
    workouts: WhoopWorkoutRecord[];
  };
}

// ============================================================
// WHOOP internal API client (api.prod.whoop.com)
// ============================================================

const WHOOP_API_BASE = "https://api.prod.whoop.com";
const WHOOP_API_VERSION = "7";

// Cognito auth config (from id.whoop.com web app)
const COGNITO_ENDPOINT = `${WHOOP_API_BASE}/auth-service/v3/whoop/`;
const COGNITO_CLIENT_ID = "37365lrcda1js3fapqfe2n40eh";

export interface WhoopAuthToken {
  accessToken: string;
  refreshToken: string;
  userId: number;
}

/** Result of the initial sign-in — either success or 2FA challenge */
export type WhoopSignInResult =
  | { type: "success"; token: WhoopAuthToken }
  | { type: "verification_required"; session: string; method: string };

/** Make a Cognito API call through WHOOP's proxy endpoint */
async function cognitoCall(
  action: string,
  body: Record<string, unknown>,
  fetchFn: typeof globalThis.fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchFn(COGNITO_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    const errorType = (data.__type as string)?.split("#").pop() ?? "UnknownError";
    const errorMessage = (data.message as string) ?? (data.Message as string) ?? "Auth failed";
    throw new Error(`WHOOP Cognito ${errorType}: ${errorMessage}`);
  }

  return data;
}

export class WhoopInternalClient {
  private accessToken: string;
  private userId: number;
  private fetchFn: typeof globalThis.fetch;

  constructor(token: WhoopAuthToken, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.accessToken = token.accessToken;
    this.userId = token.userId;
    this.fetchFn = fetchFn;
  }

  /**
   * Step 1: Sign in with email + password via Cognito USER_PASSWORD_AUTH.
   * Returns either tokens (no MFA) or an MFA challenge session.
   */
  static async signIn(
    username: string,
    password: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<WhoopSignInResult> {
    const data = await cognitoCall(
      "InitiateAuth",
      {
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: COGNITO_CLIENT_ID,
        AuthParameters: {
          USERNAME: username,
          PASSWORD: password,
        },
      },
      fetchFn,
    );

    // MFA challenge — Cognito returns ChallengeName + Session
    const challengeName = data.ChallengeName as string | undefined;
    if (challengeName) {
      return {
        type: "verification_required",
        session: data.Session as string,
        method: challengeName === "SOFTWARE_TOKEN_MFA" ? "totp" : "sms",
      };
    }

    // No MFA — tokens returned directly
    const authResult = data.AuthenticationResult as Record<string, unknown>;
    if (!authResult?.AccessToken) {
      throw new Error("WHOOP sign-in: no tokens in response");
    }

    const userId = await WhoopInternalClient._fetchUserId(
      authResult.AccessToken as string,
      fetchFn,
    );

    return {
      type: "success",
      token: {
        accessToken: authResult.AccessToken as string,
        refreshToken: (authResult.RefreshToken as string) ?? "",
        userId,
      },
    };
  }

  /**
   * Step 2: Submit MFA code via Cognito RespondToAuthChallenge.
   */
  static async verifyCode(
    session: string,
    code: string,
    username?: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<WhoopAuthToken> {
    // Try SMS_MFA first, fall back to SOFTWARE_TOKEN_MFA
    let data: Record<string, unknown>;
    try {
      data = await cognitoCall(
        "RespondToAuthChallenge",
        {
          ChallengeName: "SMS_MFA",
          ClientId: COGNITO_CLIENT_ID,
          Session: session,
          ChallengeResponses: {
            USERNAME: username ?? "",
            SMS_MFA_CODE: code,
          },
        },
        fetchFn,
      );
    } catch {
      data = await cognitoCall(
        "RespondToAuthChallenge",
        {
          ChallengeName: "SOFTWARE_TOKEN_MFA",
          ClientId: COGNITO_CLIENT_ID,
          Session: session,
          ChallengeResponses: {
            USERNAME: username ?? "",
            SOFTWARE_TOKEN_MFA_CODE: code,
          },
        },
        fetchFn,
      );
    }

    const authResult = data.AuthenticationResult as Record<string, unknown>;
    if (!authResult?.AccessToken) {
      throw new Error("WHOOP verification: no tokens in response");
    }

    const userId = await WhoopInternalClient._fetchUserId(
      authResult.AccessToken as string,
      fetchFn,
    );

    return {
      accessToken: authResult.AccessToken as string,
      refreshToken: (authResult.RefreshToken as string) ?? "",
      userId,
    };
  }

  /**
   * Refresh an expired access token using a Cognito refresh token.
   */
  static async refreshAccessToken(
    refreshToken: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<WhoopAuthToken> {
    const data = await cognitoCall(
      "InitiateAuth",
      {
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: COGNITO_CLIENT_ID,
        AuthParameters: {
          REFRESH_TOKEN: refreshToken,
        },
      },
      fetchFn,
    );

    const authResult = data.AuthenticationResult as Record<string, unknown>;
    if (!authResult?.AccessToken) {
      throw new Error("WHOOP token refresh: no tokens in response");
    }

    const userId = await WhoopInternalClient._fetchUserId(
      authResult.AccessToken as string,
      fetchFn,
    );

    return {
      accessToken: authResult.AccessToken as string,
      // Cognito REFRESH_TOKEN_AUTH doesn't return a new refresh token — reuse the old one
      refreshToken: (authResult.RefreshToken as string) ?? refreshToken,
      userId,
    };
  }

  /** Backwards-compatible authenticate — works for accounts WITHOUT MFA */
  static async authenticate(
    username: string,
    password: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<WhoopAuthToken> {
    const result = await WhoopInternalClient.signIn(username, password, fetchFn);
    if (result.type === "verification_required") {
      throw new Error("WHOOP account requires MFA — use the web UI to authenticate");
    }
    return result.token;
  }

  private static async _fetchUserId(
    accessToken: string,
    fetchFn: typeof globalThis.fetch,
  ): Promise<number> {
    const response = await fetchFn(
      `${WHOOP_API_BASE}/users-service/v2/bootstrap/?accountType=users&apiVersion=7&include=profile`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch WHOOP user ID (${response.status})`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    return (data.id as number) ?? (data.user_id as number) ?? 0;
  }

  private async get<T>(url: string, params?: Record<string, string>): Promise<T> {
    const u = new URL(url);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        u.searchParams.set(key, value);
      }
    }
    u.searchParams.set("apiVersion", WHOOP_API_VERSION);

    const response = await this.fetchFn(u.toString(), {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "User-Agent": "WHOOP/4.0",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`WHOOP API error (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async getHeartRate(start: string, end: string, step = 6): Promise<WhoopHrValue[]> {
    const response = await this.get<WhoopHrResponse>(
      `${WHOOP_API_BASE}/metrics-service/v1/metrics/user/${this.userId}`,
      { start, end, step: String(step), name: "heart_rate" },
    );
    return response.values ?? [];
  }

  async getCycles(start: string, end: string, limit = 26): Promise<WhoopCycle[]> {
    return this.get<WhoopCycle[]>(`${WHOOP_API_BASE}/core-details-bff/v0/cycles/details`, {
      id: String(this.userId),
      startTime: start,
      endTime: end,
      limit: String(limit),
    });
  }

  async getSleep(sleepId: number): Promise<WhoopSleepRecord> {
    return this.get<WhoopSleepRecord>(`${WHOOP_API_BASE}/sleep-service/v1/sleep-events`, {
      activityId: String(sleepId),
    });
  }
}

// ============================================================
// Provider implementation
// ============================================================

export class WhoopProvider implements Provider {
  readonly id = "whoop";
  readonly name = "WHOOP";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    // WHOOP is always "enabled" — auth state is checked at sync time via stored tokens
    return null;
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name);

    let client: WhoopInternalClient;
    try {
      // Try loading stored tokens from DB
      const stored = await loadTokens(db, this.id);
      if (!stored?.refreshToken) {
        throw new Error("WHOOP not connected — authenticate via the web UI");
      }

      // Refresh the access token using the stored refresh token
      const token = await WhoopInternalClient.refreshAccessToken(stored.refreshToken, this.fetchFn);

      // Save the refreshed tokens back to DB
      await saveTokens(db, this.id, {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // assume ~24h expiry
        scopes: "",
      });

      client = new WhoopInternalClient(token, this.fetchFn);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const sinceStr = since.toISOString();
    const nowStr = new Date().toISOString();

    // --- Fetch all cycles (recovery + sleep + workouts embedded) ---
    let cycles: WhoopCycle[] = [];
    try {
      cycles = await client.getCycles(sinceStr, nowStr);
    } catch (err) {
      errors.push({
        message: `getCycles: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    // --- Sync recovery from cycles ---
    try {
      const recoveryCount = await withSyncLog(db, this.id, "recovery", async () => {
        let count = 0;
        for (const cycle of cycles) {
          if (cycle.recovery?.score_state === "SCORED" && cycle.recovery.score) {
            const parsed = parseRecovery(cycle.recovery);
            const cycleDay =
              cycle.days?.[0] ?? new Date(cycle.recovery.created_at).toISOString().split("T")[0];

            await db
              .insert(dailyMetrics)
              .values({
                date: cycleDay,
                providerId: this.id,
                restingHr: parsed.restingHr,
                hrv: parsed.hrv,
                spo2Avg: parsed.spo2,
                skinTempC: parsed.skinTemp,
              })
              .onConflictDoUpdate({
                target: [dailyMetrics.date, dailyMetrics.providerId],
                set: {
                  restingHr: parsed.restingHr,
                  hrv: parsed.hrv,
                  spo2Avg: parsed.spo2,
                  skinTempC: parsed.skinTemp,
                },
              });
            count++;
          }
        }
        return { recordCount: count, result: count };
      });
      recordsSynced += recoveryCount;
    } catch (err) {
      errors.push({
        message: `recovery: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // --- Sync sleep from cycles ---
    try {
      const sleepCount = await withSyncLog(db, this.id, "sleep", async () => {
        let count = 0;
        for (const cycle of cycles) {
          if (cycle.sleep?.id) {
            try {
              const sleepData = await client.getSleep(cycle.sleep.id);
              const parsed = parseSleep(sleepData);

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
                  isNap: parsed.isNap,
                })
                .onConflictDoUpdate({
                  target: [sleepSession.providerId, sleepSession.externalId],
                  set: {
                    startedAt: parsed.startedAt,
                    endedAt: parsed.endedAt,
                    durationMinutes: parsed.durationMinutes,
                    deepMinutes: parsed.deepMinutes,
                    remMinutes: parsed.remMinutes,
                    lightMinutes: parsed.lightMinutes,
                    awakeMinutes: parsed.awakeMinutes,
                    efficiencyPct: parsed.efficiencyPct,
                  },
                });
              count++;
            } catch (err) {
              errors.push({
                message: `Sleep ${cycle.sleep.id}: ${err instanceof Error ? err.message : String(err)}`,
                externalId: String(cycle.sleep.id),
                cause: err,
              });
            }
          }
        }
        return { recordCount: count, result: count };
      });
      recordsSynced += sleepCount;
    } catch (err) {
      errors.push({
        message: `sleep: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // --- Sync workouts from cycles ---
    try {
      const workoutCount = await withSyncLog(db, this.id, "workouts", async () => {
        let count = 0;
        for (const cycle of cycles) {
          const workouts = cycle.strain?.workouts ?? [];
          for (const workoutRecord of workouts) {
            try {
              const parsed = parseWorkout(workoutRecord);

              await db
                .insert(activity)
                .values({
                  providerId: this.id,
                  externalId: parsed.externalId,
                  activityType: parsed.activityType,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  raw: {
                    strain: workoutRecord.score?.strain,
                    avgHeartRate: parsed.avgHeartRate,
                    maxHeartRate: parsed.maxHeartRate,
                    calories: parsed.calories,
                    distanceMeters: parsed.distanceMeters,
                    totalElevationGain: parsed.totalElevationGain,
                    durationSeconds: parsed.durationSeconds,
                    zoneDuration: workoutRecord.score?.zone_duration,
                  },
                })
                .onConflictDoUpdate({
                  target: [activity.providerId, activity.externalId],
                  set: {
                    activityType: parsed.activityType,
                    startedAt: parsed.startedAt,
                    endedAt: parsed.endedAt,
                    raw: {
                      strain: workoutRecord.score?.strain,
                      avgHeartRate: parsed.avgHeartRate,
                      maxHeartRate: parsed.maxHeartRate,
                      calories: parsed.calories,
                      distanceMeters: parsed.distanceMeters,
                      totalElevationGain: parsed.totalElevationGain,
                      durationSeconds: parsed.durationSeconds,
                      zoneDuration: workoutRecord.score?.zone_duration,
                    },
                  },
                });
              count++;
            } catch (err) {
              errors.push({
                message: `Workout ${workoutRecord.id}: ${err instanceof Error ? err.message : String(err)}`,
                externalId: String(workoutRecord.id),
                cause: err,
              });
            }
          }
        }
        return { recordCount: count, result: count };
      });
      recordsSynced += workoutCount;
    } catch (err) {
      errors.push({
        message: `workouts: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // --- Sync HR stream (6s intervals) ---
    try {
      const hrCount = await withSyncLog(db, this.id, "hr_stream", async () => {
        const weekMs = 7 * 24 * 60 * 60 * 1000;
        let windowStart = since.getTime();
        const nowMs = Date.now();
        let totalRecords = 0;
        const BATCH_SIZE = 500;

        while (windowStart < nowMs) {
          const windowEnd = Math.min(windowStart + weekMs, nowMs);
          const startStr = new Date(windowStart).toISOString();
          const endStr = new Date(windowEnd).toISOString();

          const values = await client.getHeartRate(startStr, endStr, 6);
          const parsed = parseHeartRateValues(values);

          for (let i = 0; i < parsed.length; i += BATCH_SIZE) {
            const batch = parsed.slice(i, i + BATCH_SIZE);
            await db
              .insert(metricStream)
              .values(
                batch.map((r) => ({
                  providerId: this.id,
                  recordedAt: r.recordedAt,
                  heartRate: r.heartRate,
                })),
              )
              .onConflictDoNothing();
          }

          totalRecords += parsed.length;
          windowStart = windowEnd;
        }

        return { recordCount: totalRecords, result: totalRecords };
      });
      recordsSynced += hrCount;
    } catch (err) {
      errors.push({
        message: `hr_stream: ${err instanceof Error ? err.message : String(err)}`,
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
