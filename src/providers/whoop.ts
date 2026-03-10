import type { Provider, SyncResult, SyncError } from "./types.js";
import type { Database } from "../db/index.js";
import { sleepSession, dailyMetrics, metricStream } from "../db/schema.js";
import { withSyncLog } from "../db/sync-log.js";
import { ensureProvider } from "../db/tokens.js";

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
  readiness?: number;
  spo2?: number;
  skinTemp?: number;
}

export function parseRecovery(record: WhoopRecoveryRecord): ParsedRecovery {
  const score = record.score_state === "SCORED" ? record.score : undefined;
  return {
    cycleId: record.cycle_id,
    restingHr: score?.resting_heart_rate,
    hrv: score?.hrv_rmssd_milli,
    readiness: score?.recovery_score,
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
  const totalSleepMilli = (stages?.total_in_bed_time_milli ?? 0) - (stages?.total_awake_time_milli ?? 0);

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
// WHOOP internal API client
// ============================================================

const WHOOP_AUTH_BASE = "https://api-7.whoop.com";

interface WhoopAuthToken {
  accessToken: string;
  userId: number;
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

  static async authenticate(
    username: string,
    password: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<WhoopAuthToken> {
    const response = await fetchFn(`${WHOOP_AUTH_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        password,
        grant_type: "password",
        issueRefresh: false,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`WHOOP auth failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const user = data.user as Record<string, unknown>;

    return {
      accessToken: data.access_token as string,
      userId: (user?.id as number) ?? 0,
    };
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, WHOOP_AUTH_BASE);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await this.fetchFn(url.toString(), {
      headers: { Authorization: `bearer ${this.accessToken}` },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`WHOOP API error (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async getHeartRate(start: string, end: string, step = 6): Promise<WhoopHrValue[]> {
    const response = await this.get<WhoopHrResponse>(
      `/users/${this.userId}/metrics/heart_rate`,
      { start, end, step: String(step), order: "t" },
    );
    return response.values ?? [];
  }

  async getCycles(start: string, end: string): Promise<Record<string, unknown>[]> {
    return this.get<Record<string, unknown>[]>(
      `/users/${this.userId}/cycles`,
      { start, end },
    );
  }

  async getSleep(sleepId: number): Promise<WhoopSleepRecord> {
    return this.get<WhoopSleepRecord>(
      `/users/${this.userId}/sleeps/${sleepId}`,
    );
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
    if (!process.env.WHOOP_USERNAME) return "WHOOP_USERNAME is not set";
    if (!process.env.WHOOP_PASSWORD) return "WHOOP_PASSWORD is not set";
    return null;
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name);

    let client: WhoopInternalClient;
    try {
      const token = await WhoopInternalClient.authenticate(
        process.env.WHOOP_USERNAME!,
        process.env.WHOOP_PASSWORD!,
        this.fetchFn,
      );
      client = new WhoopInternalClient(token, this.fetchFn);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), cause: err });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    const sinceStr = since.toISOString();
    const nowStr = new Date().toISOString();

    // --- Sync recovery & sleep from cycles ---
    try {
      const cycleCount = await withSyncLog(db, this.id, "recovery", async () => {
        const cycles = await client.getCycles(sinceStr, nowStr);
        let count = 0;
        for (const raw of cycles) {
          const recovery = raw as unknown as { recovery?: WhoopRecoveryRecord; sleep?: { id: number }; days?: string[] };
          if (recovery.recovery?.score_state === "SCORED" && recovery.recovery.score) {
            const parsed = parseRecovery(recovery.recovery);
            const cycleDay = recovery.days?.[0]
              ?? new Date(recovery.recovery.created_at).toISOString().split("T")[0];

            await db.insert(dailyMetrics).values({
              date: cycleDay,
              providerId: this.id,
              sport: "all",
              restingHr: parsed.restingHr,
              hrv: parsed.hrv,
              readiness: parsed.readiness,
            }).onConflictDoUpdate({
              target: [dailyMetrics.date, dailyMetrics.providerId, dailyMetrics.sport],
              set: {
                restingHr: parsed.restingHr,
                hrv: parsed.hrv,
                readiness: parsed.readiness,
              },
            });
            count++;
          }

          // Sleep from this cycle
          if (recovery.sleep?.id) {
            try {
              const sleepData = await client.getSleep(recovery.sleep.id);
              const parsed = parseSleep(sleepData);

              await db.insert(sleepSession).values({
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
              }).onConflictDoUpdate({
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
                message: `Sleep ${recovery.sleep.id}: ${err instanceof Error ? err.message : String(err)}`,
                externalId: String(recovery.sleep.id),
                cause: err,
              });
            }
          }
        }
        return { recordCount: count, result: count };
      });
      recordsSynced += cycleCount;
    } catch (err) {
      errors.push({ message: `recovery/sleep: ${err instanceof Error ? err.message : String(err)}`, cause: err });
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
            await db.insert(metricStream).values(
              batch.map((r) => ({
                providerId: this.id,
                recordedAt: r.recordedAt,
                heartRate: r.heartRate,
              })),
            ).onConflictDoNothing();
          }

          totalRecords += parsed.length;
          windowStart = windowEnd;
        }

        return { recordCount: totalRecords, result: totalRecords };
      });
      recordsSynced += hrCount;
    } catch (err) {
      errors.push({ message: `hr_stream: ${err instanceof Error ? err.message : String(err)}`, cause: err });
    }

    return {
      provider: this.id,
      recordsSynced,
      errors,
      duration: Date.now() - start,
    };
  }
}
