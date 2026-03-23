import type {
  TrainingPeaksCalendarNote,
  TrainingPeaksPersonalRecord,
  TrainingPeaksPmcEntry,
  TrainingPeaksPmcRequest,
  TrainingPeaksTokenResponse,
  TrainingPeaksUser,
  TrainingPeaksWorkout,
  TrainingPeaksWorkoutAnalysis,
} from "./types.ts";

// ============================================================
// TrainingPeaks internal API URLs
// ============================================================

const TP_API_BASE = "https://tpapi.trainingpeaks.com";
const TP_ANALYSIS_BASE = "https://api.peakswaresb.com";
const TP_HOME_BASE = "https://home.trainingpeaks.com";
const TP_APP_ORIGIN = "https://app.trainingpeaks.com";

/** Minimum delay between requests (ms) to avoid rate limiting */
const REQUEST_DELAY_MS = 150;

// ============================================================
// Authentication
// ============================================================

/**
 * Exchange a Production_tpAuth cookie for a Bearer access token.
 *
 * The cookie must be obtained by logging into app.trainingpeaks.com
 * in a browser and copying the `Production_tpAuth` cookie value.
 */
async function exchangeCookieForToken(
  cookie: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ accessToken: string; expiresIn: number }> {
  const response = await fetchFn(`${TP_API_BASE}/users/v3/token`, {
    headers: {
      Cookie: `Production_tpAuth=${cookie}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`TrainingPeaks token exchange failed (${response.status}): ${text}`);
  }

  const data: TrainingPeaksTokenResponse = await response.json();
  if (!data.success) {
    throw new Error("TrainingPeaks token exchange returned success=false");
  }

  return {
    accessToken: data.token.access_token,
    expiresIn: data.token.expires_in,
  };
}

/**
 * Refresh the Production_tpAuth cookie.
 * Returns the new cookie value from the Set-Cookie header.
 */
async function refreshCookie(
  cookie: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const response = await fetchFn(`${TP_HOME_BASE}/refresh`, {
    headers: {
      Cookie: `Production_tpAuth=${cookie}`,
    },
    redirect: "manual",
  });

  const setCookies =
    "getSetCookie" in response.headers && typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : (response.headers.get("set-cookie")?.split(/,(?=\s*\w+=)/) ?? []);

  for (const header of setCookies) {
    if (header.includes("Production_tpAuth=")) {
      const match = header.match(/Production_tpAuth=([^;]+)/);
      if (match?.[1]) return match[1];
    }
  }

  throw new Error("TrainingPeaks cookie refresh did not return a new Production_tpAuth cookie");
}

// ============================================================
// TrainingPeaks Connect Client
// ============================================================

export class TrainingPeaksConnectClient {
  #accessToken: string;
  #fetchFn: typeof globalThis.fetch;
  #lastRequestTime = 0;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#accessToken = accessToken;
    this.#fetchFn = fetchFn;
  }

  // ---- Static auth methods ----

  static exchangeCookieForToken = exchangeCookieForToken;
  static refreshCookie = refreshCookie;

  // ---- Private helpers ----

  async #throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.#lastRequestTime;
    if (elapsed < REQUEST_DELAY_MS) {
      await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS - elapsed));
    }
    this.#lastRequestTime = Date.now();
  }

  async #get<T>(base: string, path: string, params?: Record<string, string>): Promise<T> {
    await this.#throttle();

    const url = new URL(`${base}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await this.#fetchFn(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        Accept: "application/json",
        Origin: TP_APP_ORIGIN,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`TrainingPeaks API error (${response.status}): ${text}`);
    }

    const result: T = await response.json();
    return result;
  }

  async #post<T>(base: string, path: string, body: unknown): Promise<T> {
    await this.#throttle();

    const response = await this.#fetchFn(`${base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: TP_APP_ORIGIN,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`TrainingPeaks API error (${response.status}): ${text}`);
    }

    const result: T = await response.json();
    return result;
  }

  // ---- User profile ----

  async getUser(): Promise<TrainingPeaksUser> {
    return this.#get<TrainingPeaksUser>(TP_API_BASE, "/users/v3/user");
  }

  // ---- Workouts ----

  /**
   * Get workouts in a date range. Max 90 days per request.
   * Dates in YYYY-MM-DD format.
   */
  async getWorkouts(
    athleteId: number,
    startDate: string,
    endDate: string,
  ): Promise<TrainingPeaksWorkout[]> {
    return this.#get<TrainingPeaksWorkout[]>(
      TP_API_BASE,
      `/fitness/v6/athletes/${athleteId}/workouts/${startDate}/${endDate}`,
    );
  }

  /** Get a single workout by ID. */
  async getWorkout(athleteId: number, workoutId: number): Promise<TrainingPeaksWorkout> {
    return this.#get<TrainingPeaksWorkout>(
      TP_API_BASE,
      `/fitness/v6/athletes/${athleteId}/workouts/${workoutId}`,
    );
  }

  /** Get FIT file download URL for a workout. */
  getWorkoutFitUrl(athleteId: number, workoutId: number): string {
    return `${TP_API_BASE}/fitness/v6/athletes/${athleteId}/workouts/${workoutId}/fordevice/fit`;
  }

  // ---- Performance Management Chart ----

  /**
   * Get CTL/ATL/TSB (fitness/fatigue/form) data for a date range.
   * This is the Performance Management Chart data.
   */
  async getPerformanceManagement(
    athleteId: number,
    startDate: string,
    endDate: string,
    options: Partial<TrainingPeaksPmcRequest> = {},
  ): Promise<TrainingPeaksPmcEntry[]> {
    const body: TrainingPeaksPmcRequest = {
      atlConstant: options.atlConstant ?? 7,
      atlStart: options.atlStart ?? 0,
      ctlConstant: options.ctlConstant ?? 42,
      ctlStart: options.ctlStart ?? 0,
      workoutTypes: options.workoutTypes ?? [],
    };

    return this.#post<TrainingPeaksPmcEntry[]>(
      TP_API_BASE,
      `/fitness/v1/athletes/${athleteId}/reporting/performancedata/${startDate}/${endDate}`,
      body,
    );
  }

  // ---- Personal Records ----

  /**
   * Get personal records for a sport type.
   * @param sport - "Bike" or "Run"
   * @param recordType - e.g., "power5sec", "power20min", "speed5K"
   */
  async getPersonalRecords(
    athleteId: number,
    sport: "Bike" | "Run",
    recordType: string,
    startDate?: string,
    endDate?: string,
  ): Promise<TrainingPeaksPersonalRecord[]> {
    const params: Record<string, string> = { prType: recordType };
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;

    return this.#get<TrainingPeaksPersonalRecord[]>(
      TP_API_BASE,
      `/personalrecord/v2/athletes/${athleteId}/${sport}`,
      params,
    );
  }

  // ---- Calendar Notes ----

  async getCalendarNotes(
    athleteId: number,
    startDate: string,
    endDate: string,
  ): Promise<TrainingPeaksCalendarNote[]> {
    return this.#get<TrainingPeaksCalendarNote[]>(
      TP_API_BASE,
      `/fitness/v1/athletes/${athleteId}/calendarNote/${startDate}/${endDate}`,
    );
  }

  // ---- Workout Analysis ----

  /**
   * Get detailed workout analysis with time-series data, zones, and laps.
   * Uses the separate analysis API at api.peakswaresb.com.
   */
  async getWorkoutAnalysis(
    workoutId: number,
    athleteId: number,
  ): Promise<TrainingPeaksWorkoutAnalysis> {
    return this.#post<TrainingPeaksWorkoutAnalysis>(
      TP_ANALYSIS_BASE,
      "/workout-analysis/v1/analyze",
      { workoutId, viewingPersonId: athleteId },
    );
  }
}
