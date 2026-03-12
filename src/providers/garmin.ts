import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.ts";
import {
  activity,
  bodyMeasurement,
  DEFAULT_USER_ID,
  dailyMetrics,
  sleepSession,
  userSettings,
} from "../db/schema.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import type { Provider, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Garmin Connect API types
// ============================================================

export interface GarminActivity {
  activityId: number;
  activityName: string;
  activityType: { typeKey: string; typeId: number };
  startTimeLocal: string; // "2024-06-15 10:30:00"
  startTimeGMT: string; // "2024-06-15 14:30:00"
  duration: number; // seconds
  distance: number; // meters
  averageHR?: number;
  maxHR?: number;
  averageSpeed?: number; // m/s
  calories: number;
  elevationGain?: number;
  elevationLoss?: number;
  averageBikeCadence?: number;
  averageRunCadence?: number;
  averagePower?: number;
  normalizedPower?: number;
  maxPower?: number;
  description?: string;
}

export interface GarminSleepResponse {
  dailySleepDTO: {
    calendarDate: string; // "2024-06-15"
    sleepStartTimestampGMT: number; // ms epoch
    sleepEndTimestampGMT: number;
    sleepTimeSeconds: number;
    deepSleepSeconds: number;
    lightSleepSeconds: number;
    remSleepSeconds: number;
    awakeSleepSeconds: number;
    averageSpO2Value?: number;
    lowestSpO2Value?: number;
    averageRespirationValue?: number;
    sleepScores?: { overall: { value: number } };
  };
}

export interface GarminDailySummary {
  calendarDate: string;
  totalSteps: number;
  totalDistanceMeters: number;
  activeKilocalories: number;
  bmrKilocalories: number;
  restingHeartRate?: number;
  maxHeartRate?: number;
  averageStressLevel?: number;
  maxStressLevel?: number;
  bodyBatteryChargedValue?: number;
  bodyBatteryDrainedValue?: number;
  averageSpo2?: number;
  lowestSpo2?: number;
  respirationAvg?: number;
  floorsAscended?: number;
  moderateIntensityMinutes?: number;
  vigorousIntensityMinutes?: number;
}

export interface GarminWeightEntry {
  samplePk: number;
  date: number; // ms epoch
  calendarDate: string;
  weight: number; // grams
  bmi?: number;
  bodyFat?: number; // percentage
  muscleMass?: number; // grams
  boneMass?: number; // grams
  bodyWater?: number; // percentage
}

// ============================================================
// Parsed types
// ============================================================

export interface ParsedGarminActivity {
  externalId: string;
  activityType: string;
  name: string;
  startedAt: Date;
  endedAt: Date;
  notes: string | undefined;
  raw: GarminActivity;
}

export interface ParsedGarminSleep {
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
  deepMinutes: number;
  lightMinutes: number;
  remMinutes: number;
  awakeMinutes: number;
}

export interface ParsedGarminDailyMetrics {
  date: string;
  steps: number;
  distanceKm: number;
  activeEnergyKcal: number;
  basalEnergyKcal: number;
  restingHr: number | undefined;
  spo2Avg: number | undefined;
  respiratoryRateAvg: number | undefined;
  flightsClimbed: number | undefined;
  exerciseMinutes: number | undefined;
}

export interface ParsedGarminBodyMeasurement {
  externalId: string;
  recordedAt: Date;
  weightKg: number;
  bmi: number | undefined;
  bodyFatPct: number | undefined;
  muscleMassKg: number | undefined;
  boneMassKg: number | undefined;
  waterPct: number | undefined;
}

// ============================================================
// Activity type mapping
// ============================================================

const GARMIN_ACTIVITY_TYPE_MAP: Record<string, string> = {
  // Running
  running: "running",
  trail_running: "running",
  treadmill_running: "running",
  track_running: "running",
  // Cycling
  cycling: "cycling",
  mountain_biking: "cycling",
  road_biking: "cycling",
  indoor_cycling: "cycling",
  gravel_cycling: "cycling",
  virtual_ride: "cycling",
  // Swimming
  swimming: "swimming",
  lap_swimming: "swimming",
  open_water_swimming: "swimming",
  // Walking / Hiking
  walking: "walking",
  hiking: "hiking",
  // Strength / Cardio
  strength_training: "strength",
  indoor_cardio: "cardio",
  // Other fitness
  yoga: "yoga",
  pilates: "pilates",
  elliptical: "elliptical",
  rowing: "rowing",
};

export function mapGarminActivityType(typeKey: string): string {
  return GARMIN_ACTIVITY_TYPE_MAP[typeKey] ?? "other";
}

// ============================================================
// Pure parsing functions
// ============================================================

/**
 * Parse Garmin's GMT time string ("2024-06-15 14:30:00") into a Date.
 * Garmin omits the 'T' and timezone indicator, so we normalize it.
 */
function parseGarminGmtTime(timeString: string): Date {
  // "2024-06-15 14:30:00" → "2024-06-15T14:30:00Z"
  return new Date(`${timeString.replace(" ", "T")}Z`);
}

export function parseGarminActivity(raw: GarminActivity): ParsedGarminActivity {
  const startedAt = parseGarminGmtTime(raw.startTimeGMT);
  const endedAt = new Date(startedAt.getTime() + raw.duration * 1000);

  return {
    externalId: String(raw.activityId),
    activityType: mapGarminActivityType(raw.activityType.typeKey),
    name: raw.activityName,
    startedAt,
    endedAt,
    notes: raw.description,
    raw,
  };
}

export function parseGarminSleep(sleep: GarminSleepResponse): ParsedGarminSleep {
  const dto = sleep.dailySleepDTO;
  return {
    externalId: dto.calendarDate,
    startedAt: new Date(dto.sleepStartTimestampGMT),
    endedAt: new Date(dto.sleepEndTimestampGMT),
    durationMinutes: Math.round(dto.sleepTimeSeconds / 60),
    deepMinutes: Math.round(dto.deepSleepSeconds / 60),
    lightMinutes: Math.round(dto.lightSleepSeconds / 60),
    remMinutes: Math.round(dto.remSleepSeconds / 60),
    awakeMinutes: Math.round(dto.awakeSleepSeconds / 60),
  };
}

export function parseGarminDailySummary(summary: GarminDailySummary): ParsedGarminDailyMetrics {
  const moderate = summary.moderateIntensityMinutes;
  const vigorous = summary.vigorousIntensityMinutes;
  let exerciseMinutes: number | undefined;
  if (moderate !== undefined || vigorous !== undefined) {
    exerciseMinutes = (moderate ?? 0) + (vigorous ?? 0);
  }

  return {
    date: summary.calendarDate,
    steps: summary.totalSteps,
    distanceKm: summary.totalDistanceMeters / 1000,
    activeEnergyKcal: summary.activeKilocalories,
    basalEnergyKcal: summary.bmrKilocalories,
    restingHr: summary.restingHeartRate,
    spo2Avg: summary.averageSpo2,
    respiratoryRateAvg: summary.respirationAvg,
    flightsClimbed: summary.floorsAscended,
    exerciseMinutes,
  };
}

export function parseGarminWeight(entry: GarminWeightEntry): ParsedGarminBodyMeasurement {
  return {
    externalId: String(entry.samplePk),
    recordedAt: new Date(entry.date),
    weightKg: entry.weight / 1000,
    bmi: entry.bmi,
    bodyFatPct: entry.bodyFat,
    muscleMassKg: entry.muscleMass !== undefined ? entry.muscleMass / 1000 : undefined,
    boneMassKg: entry.boneMass !== undefined ? entry.boneMass / 1000 : undefined,
    waterPct: entry.bodyWater,
  };
}

// ============================================================
// Garmin Connect SSO Client
// ============================================================

const GARMIN_SSO_BASE = "https://sso.garmin.com";
const GARMIN_CONNECT_BASE = "https://connect.garmin.com";
const GARMIN_SSO_EMBED_URL = `${GARMIN_SSO_BASE}/sso/embed`;
const GARMIN_SSO_SIGNIN_URL = `${GARMIN_SSO_BASE}/sso/signin`;

interface GarminClientOptions {
  fetchFn?: typeof globalThis.fetch;
}

export class GarminClient {
  private sessionCookies: string | null = null;
  private fetchFn: typeof globalThis.fetch;

  constructor(options: GarminClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  /**
   * Authenticate via Garmin Connect SSO.
   *
   * The flow:
   * 1. GET the SSO signin page to obtain CSRF token and initial cookies
   * 2. POST credentials to the SSO signin endpoint
   * 3. Extract the service ticket from the response
   * 4. Exchange the ticket at connect.garmin.com to establish a session
   */
  async authenticate(email: string, password: string): Promise<string> {
    // Step 1: GET the SSO login page to get CSRF token and cookies
    const params = new URLSearchParams({
      id: "gauth-widget",
      embedWidget: "true",
      gauthHost: GARMIN_SSO_EMBED_URL,
    });

    const loginPageUrl = `${GARMIN_SSO_SIGNIN_URL}?${params.toString()}`;
    const loginPageResponse = await this.fetchFn(loginPageUrl, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
      redirect: "manual",
    });

    const loginPageHtml = await loginPageResponse.text();
    const setCookieHeaders = loginPageResponse.headers.getSetCookie?.() ?? [];
    const cookies = setCookieHeaders.map((c) => c.split(";")[0]).join("; ");

    // Extract CSRF token from the HTML
    const csrfMatch = loginPageHtml.match(/name="_csrf"\s+value="([^"]+)"/);
    const csrfToken = csrfMatch?.[1] ?? "";

    // Step 2: POST credentials
    const signinFormData = new URLSearchParams({
      username: email,
      password: password,
      embed: "true",
      _csrf: csrfToken,
    });

    const signinResponse = await this.fetchFn(`${GARMIN_SSO_SIGNIN_URL}?${params.toString()}`, {
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookies,
        Origin: GARMIN_SSO_BASE,
        Referer: loginPageUrl,
      },
      body: signinFormData.toString(),
      redirect: "manual",
    });

    const signinHtml = await signinResponse.text();

    // Step 3: Extract the ticket from the response
    // The response contains a redirect URL with a ticket parameter
    const ticketMatch = signinHtml.match(/ticket=([A-Za-z0-9-]+)/);
    if (!ticketMatch?.[1]) {
      throw new Error("Garmin SSO: Failed to extract service ticket. Check credentials.");
    }
    const ticket = ticketMatch[1];

    // Step 4: Exchange ticket for session cookies
    const ticketUrl = `${GARMIN_CONNECT_BASE}/modern/?ticket=${ticket}`;
    const ticketResponse = await this.fetchFn(ticketUrl, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "manual",
    });

    const sessionSetCookies = ticketResponse.headers.getSetCookie?.() ?? [];
    this.sessionCookies = sessionSetCookies.map((c) => c.split(";")[0]).join("; ");

    if (!this.sessionCookies) {
      throw new Error("Garmin SSO: No session cookies received after ticket exchange");
    }

    return this.sessionCookies;
  }

  /**
   * Set session cookies directly (e.g., from stored tokens).
   */
  setSessionCookies(cookies: string): void {
    this.sessionCookies = cookies;
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.sessionCookies) {
      throw new Error("Garmin client not authenticated — call authenticate() first");
    }

    const url = `${GARMIN_CONNECT_BASE}${path}`;
    const response = await this.fetchFn(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Cookie: this.sessionCookies,
        Accept: "application/json",
        NK: "NT",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Garmin API error (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async getActivities(start: number, limit: number): Promise<GarminActivity[]> {
    return this.get<GarminActivity[]>(
      `/activitylist-service/activities/search/activities?start=${start}&limit=${limit}`,
    );
  }

  async getSleep(date: string): Promise<GarminSleepResponse> {
    return this.get<GarminSleepResponse>(`/wellness-service/wellness/dailySleepData/${date}`);
  }

  async getDailySummary(date: string): Promise<GarminDailySummary> {
    return this.get<GarminDailySummary>(`/usersummary-service/usersummary/daily/${date}`);
  }

  async getWeightRange(
    startDate: string,
    endDate: string,
  ): Promise<{ dailyWeightSummaries: GarminWeightEntry[] }> {
    return this.get<{ dailyWeightSummaries: GarminWeightEntry[] }>(
      `/weight-service/weight/dateRange?startDate=${startDate}&endDate=${endDate}`,
    );
  }
}

// ============================================================
// Date helpers
// ============================================================

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0] ?? "";
}

function eachDay(start: Date, end: Date): string[] {
  const dates: string[] = [];
  const current = new Date(start);
  current.setUTCHours(0, 0, 0, 0);
  const endDay = new Date(end);
  endDay.setUTCHours(0, 0, 0, 0);

  while (current <= endDay) {
    dates.push(formatDate(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

// ============================================================
// Sync cursor helpers
// ============================================================

const SYNC_CURSOR_KEY = "garmin_sync_cursor";

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

const ACTIVITY_PAGE_SIZE = 20;

export class GarminProvider implements Provider {
  readonly id = "garmin";
  readonly name = "Garmin Connect";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.GARMIN_EMAIL) return "GARMIN_EMAIL is not set";
    if (!process.env.GARMIN_PASSWORD) return "GARMIN_PASSWORD is not set";
    return null;
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    const email = process.env.GARMIN_EMAIL;
    const password = process.env.GARMIN_PASSWORD;
    if (!email || !password) {
      return {
        provider: this.id,
        recordsSynced: 0,
        errors: [{ message: "GARMIN_EMAIL or GARMIN_PASSWORD is not set" }],
        duration: Date.now() - start,
      };
    }

    await ensureProvider(db, this.id, this.name, GARMIN_CONNECT_BASE);

    // Authenticate
    const client = new GarminClient({ fetchFn: this.fetchFn });
    try {
      await client.authenticate(email, password);
    } catch (err) {
      return {
        provider: this.id,
        recordsSynced: 0,
        errors: [
          {
            message: `Auth failed: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          },
        ],
        duration: Date.now() - start,
      };
    }

    // Use sync cursor if available, otherwise fall back to `since` param
    const cursor = await loadSyncCursor(db);
    const effectiveSince = cursor ? new Date(cursor) : since;

    // Sync activities
    try {
      const activityCount = await withSyncLog(db, this.id, "activities", async () => {
        const count = await this.syncActivities(db, client, effectiveSince);
        return { recordCount: count, result: count };
      });
      recordsSynced += activityCount;
    } catch (err) {
      errors.push({
        message: `Activities sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    const now = new Date();
    const dates = eachDay(effectiveSince, now);

    // Sync sleep
    try {
      const sleepCount = await withSyncLog(db, this.id, "sleep", async () => {
        const count = await this.syncSleep(db, client, dates);
        return { recordCount: count, result: count };
      });
      recordsSynced += sleepCount;
    } catch (err) {
      errors.push({
        message: `Sleep sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync daily summaries
    try {
      const dailyCount = await withSyncLog(db, this.id, "daily_metrics", async () => {
        const count = await this.syncDailyMetrics(db, client, dates);
        return { recordCount: count, result: count };
      });
      recordsSynced += dailyCount;
    } catch (err) {
      errors.push({
        message: `Daily metrics sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Sync body composition
    try {
      const weightCount = await withSyncLog(db, this.id, "body_composition", async () => {
        const count = await this.syncBodyComposition(db, client, since, now);
        return { recordCount: count, result: count };
      });
      recordsSynced += weightCount;
    } catch (err) {
      errors.push({
        message: `Body composition sync failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }

    // Save sync cursor
    await saveSyncCursor(db, now.toISOString());

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }

  private async syncActivities(db: Database, client: GarminClient, since: Date): Promise<number> {
    let count = 0;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const activities = await client.getActivities(offset, ACTIVITY_PAGE_SIZE);

      if (activities.length === 0) break;

      for (const raw of activities) {
        const startTime = parseGarminGmtTime(raw.startTimeGMT);
        // Stop paginating once we reach activities before `since`
        if (startTime < since) {
          hasMore = false;
          break;
        }

        const parsed = parseGarminActivity(raw);

        await db
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
          });

        count++;
      }

      if (activities.length < ACTIVITY_PAGE_SIZE) break;
      offset += ACTIVITY_PAGE_SIZE;
    }

    return count;
  }

  private async syncSleep(db: Database, client: GarminClient, dates: string[]): Promise<number> {
    let count = 0;

    for (const date of dates) {
      try {
        const sleepData = await client.getSleep(date);
        if (!sleepData?.dailySleepDTO?.sleepStartTimestampGMT) continue;

        const parsed = parseGarminSleep(sleepData);

        await db
          .insert(sleepSession)
          .values({
            providerId: this.id,
            externalId: parsed.externalId,
            startedAt: parsed.startedAt,
            endedAt: parsed.endedAt,
            durationMinutes: parsed.durationMinutes,
            deepMinutes: parsed.deepMinutes,
            lightMinutes: parsed.lightMinutes,
            remMinutes: parsed.remMinutes,
            awakeMinutes: parsed.awakeMinutes,
          })
          .onConflictDoUpdate({
            target: [sleepSession.providerId, sleepSession.externalId],
            set: {
              startedAt: parsed.startedAt,
              endedAt: parsed.endedAt,
              durationMinutes: parsed.durationMinutes,
              deepMinutes: parsed.deepMinutes,
              lightMinutes: parsed.lightMinutes,
              remMinutes: parsed.remMinutes,
              awakeMinutes: parsed.awakeMinutes,
            },
          });

        count++;
      } catch {
        // Individual date failures are non-fatal — skip and continue
      }
    }

    return count;
  }

  private async syncDailyMetrics(
    db: Database,
    client: GarminClient,
    dates: string[],
  ): Promise<number> {
    let count = 0;

    for (const date of dates) {
      try {
        const summary = await client.getDailySummary(date);
        if (!summary?.calendarDate) continue;

        const parsed = parseGarminDailySummary(summary);

        await db
          .insert(dailyMetrics)
          .values({
            date: parsed.date,
            providerId: this.id,
            steps: parsed.steps,
            distanceKm: parsed.distanceKm,
            activeEnergyKcal: parsed.activeEnergyKcal,
            basalEnergyKcal: parsed.basalEnergyKcal,
            restingHr: parsed.restingHr,
            spo2Avg: parsed.spo2Avg,
            respiratoryRateAvg: parsed.respiratoryRateAvg,
            flightsClimbed: parsed.flightsClimbed,
            exerciseMinutes: parsed.exerciseMinutes,
          })
          .onConflictDoUpdate({
            target: [dailyMetrics.date, dailyMetrics.providerId],
            set: {
              steps: parsed.steps,
              distanceKm: parsed.distanceKm,
              activeEnergyKcal: parsed.activeEnergyKcal,
              basalEnergyKcal: parsed.basalEnergyKcal,
              restingHr: parsed.restingHr,
              spo2Avg: parsed.spo2Avg,
              respiratoryRateAvg: parsed.respiratoryRateAvg,
              flightsClimbed: parsed.flightsClimbed,
              exerciseMinutes: parsed.exerciseMinutes,
            },
          });

        count++;
      } catch {
        // Individual date failures are non-fatal — skip and continue
      }
    }

    return count;
  }

  private async syncBodyComposition(
    db: Database,
    client: GarminClient,
    since: Date,
    until: Date,
  ): Promise<number> {
    let count = 0;

    const startDate = formatDate(since);
    const endDate = formatDate(until);

    const weightData = await client.getWeightRange(startDate, endDate);
    const entries = weightData?.dailyWeightSummaries ?? [];

    for (const entry of entries) {
      if (!entry.weight) continue;

      const parsed = parseGarminWeight(entry);

      await db
        .insert(bodyMeasurement)
        .values({
          providerId: this.id,
          externalId: parsed.externalId,
          recordedAt: parsed.recordedAt,
          weightKg: parsed.weightKg,
          bmi: parsed.bmi,
          bodyFatPct: parsed.bodyFatPct,
          muscleMassKg: parsed.muscleMassKg,
          boneMassKg: parsed.boneMassKg,
          waterPct: parsed.waterPct,
        })
        .onConflictDoUpdate({
          target: [bodyMeasurement.providerId, bodyMeasurement.externalId],
          set: {
            recordedAt: parsed.recordedAt,
            weightKg: parsed.weightKg,
            bmi: parsed.bmi,
            bodyFatPct: parsed.bodyFatPct,
            muscleMassKg: parsed.muscleMassKg,
            boneMassKg: parsed.boneMassKg,
            waterPct: parsed.waterPct,
          },
        });

      count++;
    }

    return count;
  }
}
