import type {
  GarminBodyBatteryData,
  GarminConnectActivity,
  GarminDailyUserSummary,
  GarminEnduranceScore,
  GarminFitnessAge,
  GarminHeartRateData,
  GarminHillScore,
  GarminHrvData,
  GarminIntensityMinutes,
  GarminMaxMetrics,
  GarminMfaChallenge,
  GarminOAuth2Token,
  GarminRacePredictions,
  GarminRespirationData,
  GarminSignInResult,
  GarminSleepData,
  GarminSpO2Data,
  GarminStressData,
  GarminTrainingReadiness,
  GarminTrainingStatus,
  GarminUserProfile,
  GarminWeightResponse,
} from "./types.ts";

// ============================================================
// Garmin Connect SSO URLs
// ============================================================

const SSO_BASE = "https://sso.garmin.com/sso";
const CONNECT_API_BASE = "https://connect.garmin.com";
const OAUTH_BASE = "https://connectapi.garmin.com/oauth-service/oauth";
const USER_AGENT = "com.garmin.android.apps.connectmobile";

// SSO signin params (matches garth library)
const SSO_EMBED_PARAMS = new URLSearchParams({
  id: "gauth-widget",
  embedWidget: "true",
  gauthHost: SSO_BASE,
});

const SSO_SIGNIN_PARAMS = new URLSearchParams({
  id: "gauth-widget",
  embedWidget: "true",
  gauthHost: SSO_BASE,
  service: `${SSO_BASE}/embed`,
  source: `${SSO_BASE}/embed`,
  redirectAfterAccountLoginUrl: `${SSO_BASE}/embed`,
  redirectAfterAccountCreationUrl: `${SSO_BASE}/embed`,
});

// ============================================================
// Cookie jar (minimal implementation for SSO flow)
// ============================================================

interface CookieJar {
  cookies: Map<string, string>;
  set(setCookieHeaders: string[]): void;
  get(): string;
}

function createCookieJar(): CookieJar {
  const cookies = new Map<string, string>();
  return {
    cookies,
    set(setCookieHeaders: string[]) {
      for (const header of setCookieHeaders) {
        const parts = header.split(";")[0];
        if (!parts) continue;
        const eqIndex = parts.indexOf("=");
        if (eqIndex === -1) continue;
        const name = parts.substring(0, eqIndex).trim();
        const value = parts.substring(eqIndex + 1).trim();
        cookies.set(name, value);
      }
    },
    get() {
      return Array.from(cookies.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    },
  };
}

// ============================================================
// SSO Authentication
// ============================================================

/**
 * Parse Set-Cookie headers from a fetch Response.
 * Uses getSetCookie() if available (Node 20+), falls back to parsing raw headers.
 */
function extractSetCookies(response: Response): string[] {
  if ("getSetCookie" in response.headers && typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  // Fallback: try to get the raw header (won't work if the runtime merges them)
  const raw = response.headers.get("set-cookie");
  return raw ? raw.split(/,(?=\s*\w+=)/) : [];
}

/**
 * Sign in to Garmin Connect using the internal SSO flow.
 *
 * This replicates the authentication used by the Garmin Connect mobile app:
 * 1. GET /sso/embed — initialize session cookies
 * 2. GET /sso/signin — extract CSRF token
 * 3. POST /sso/signin — submit credentials, get SSO ticket
 * 4. GET oauth/preauthorized — exchange ticket for OAuth1 token
 * 5. POST oauth/exchange/user/2.0 — exchange OAuth1 for OAuth2 token
 */
async function signIn(
  email: string,
  password: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<GarminSignInResult> {
  const jar = createCookieJar();

  // Step 1: Initialize cookies
  const embedResponse = await fetchFn(`${SSO_BASE}/embed?${SSO_EMBED_PARAMS}`, {
    method: "GET",
    headers: { "User-Agent": USER_AGENT },
    redirect: "manual",
  });
  jar.set(extractSetCookies(embedResponse));
  // Consume body
  await embedResponse.text();

  // Step 2: Get CSRF token from signin page
  const signinPageResponse = await fetchFn(`${SSO_BASE}/signin?${SSO_SIGNIN_PARAMS}`, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Cookie: jar.get(),
    },
    redirect: "manual",
  });
  jar.set(extractSetCookies(signinPageResponse));
  const signinHtml = await signinPageResponse.text();

  const csrfMatch = signinHtml.match(/name="_csrf"\s+value="([^"]+)"/);
  if (!csrfMatch?.[1]) {
    throw new Error("Garmin SSO: could not extract CSRF token from signin page");
  }
  const csrf = csrfMatch[1];

  // Step 3: Submit credentials
  const loginResponse = await fetchFn(`${SSO_BASE}/signin?${SSO_SIGNIN_PARAMS}`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jar.get(),
      Referer: `${SSO_BASE}/signin?${SSO_SIGNIN_PARAMS}`,
    },
    body: new URLSearchParams({
      username: email,
      password,
      embed: "true",
      _csrf: csrf,
    }),
    redirect: "manual",
  });
  jar.set(extractSetCookies(loginResponse));
  const loginHtml = await loginResponse.text();

  // Check for title to determine success/MFA/failure
  const titleMatch = loginHtml.match(/<title>(.+?)<\/title>/);
  const title = titleMatch?.[1] ?? "";

  if (title.includes("MFA") || title.includes("verification") || loginHtml.includes("loginEnterMfaCode")) {
    return {
      type: "mfa_required",
      csrf,
      cookies: jar.get(),
    };
  }

  // Check for ticket in successful response
  const ticketMatch = loginHtml.match(/embed\?ticket=([^"]+)"/);
  if (!ticketMatch?.[1]) {
    // Check for error
    if (title.includes("error") || title.includes("locked") || loginHtml.includes("incorrectCredentials")) {
      throw new Error("Garmin SSO: invalid credentials or account locked");
    }
    throw new Error("Garmin SSO: could not extract SSO ticket from login response");
  }
  const ticket = ticketMatch[1];

  // Step 4: Exchange ticket for OAuth1 token
  const oauth1 = await exchangeTicketForOAuth1(ticket, jar.get(), fetchFn);

  // Step 5: Exchange OAuth1 for OAuth2
  const oauth2 = await exchangeOAuth1ForOAuth2(oauth1.mfaToken, fetchFn);

  return {
    type: "success",
    oauth1Token: oauth1.token,
    oauth1TokenSecret: oauth1.tokenSecret,
    mfaToken: oauth1.mfaToken,
    oauth2,
  };
}

/**
 * Submit MFA code after initial sign-in returned mfa_required.
 */
async function verifyMfa(
  challenge: GarminMfaChallenge,
  code: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<GarminSignInResult> {
  const jar = createCookieJar();
  // Restore cookies from challenge
  for (const pair of challenge.cookies.split("; ")) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex !== -1) {
      jar.cookies.set(pair.substring(0, eqIndex), pair.substring(eqIndex + 1));
    }
  }

  const mfaResponse = await fetchFn(
    `${SSO_BASE}/verifyMFA/loginEnterMfaCode?${SSO_SIGNIN_PARAMS}`,
    {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: jar.get(),
      },
      body: new URLSearchParams({
        "mfa-code": code,
        embed: "true",
        _csrf: challenge.csrf,
        fromPage: "setupEnterMfaCode",
      }),
      redirect: "manual",
    },
  );
  jar.set(extractSetCookies(mfaResponse));
  const mfaHtml = await mfaResponse.text();

  const ticketMatch = mfaHtml.match(/embed\?ticket=([^"]+)"/);
  if (!ticketMatch?.[1]) {
    throw new Error("Garmin SSO: MFA verification failed — no ticket in response");
  }
  const ticket = ticketMatch[1];

  const oauth1 = await exchangeTicketForOAuth1(ticket, jar.get(), fetchFn);
  const oauth2 = await exchangeOAuth1ForOAuth2(oauth1.mfaToken, fetchFn);

  return {
    type: "success",
    oauth1Token: oauth1.token,
    oauth1TokenSecret: oauth1.tokenSecret,
    mfaToken: oauth1.mfaToken,
    oauth2,
  };
}

/** Exchange SSO ticket for OAuth1 token via preauthorized endpoint */
async function exchangeTicketForOAuth1(
  ticket: string,
  cookies: string,
  fetchFn: typeof globalThis.fetch,
): Promise<{ token: string; tokenSecret: string; mfaToken?: string }> {
  const url = `${OAUTH_BASE}/preauthorized?ticket=${encodeURIComponent(ticket)}&login-url=${encodeURIComponent(`${SSO_BASE}/embed`)}&accepts-mfa-tokens=true`;

  const response = await fetchFn(url, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      Cookie: cookies,
    },
    redirect: "manual",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Garmin OAuth1 exchange failed (${response.status}): ${text}`);
  }

  const body = await response.text();
  const params = new URLSearchParams(body);
  const token = params.get("oauth_token");
  const tokenSecret = params.get("oauth_token_secret");

  if (!token || !tokenSecret) {
    throw new Error("Garmin OAuth1 exchange: missing token or secret in response");
  }

  return {
    token,
    tokenSecret,
    mfaToken: params.get("mfa_token") ?? undefined,
  };
}

/** Exchange OAuth1 token for OAuth2 access/refresh tokens */
async function exchangeOAuth1ForOAuth2(
  mfaToken: string | undefined,
  fetchFn: typeof globalThis.fetch,
): Promise<GarminOAuth2Token> {
  const body = new URLSearchParams();
  if (mfaToken) {
    body.set("mfa_token", mfaToken);
  }

  const response = await fetchFn(`${OAUTH_BASE}/exchange/user/2.0`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Garmin OAuth2 exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    expiresIn: data.expires_in as number,
    refreshTokenExpiresIn: data.refresh_token_expires_in as number,
  };
}

// ============================================================
// Garmin Connect API Client
// ============================================================

export class GarminConnectClient {
  private accessToken: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.accessToken = accessToken;
    this.fetchFn = fetchFn;
  }

  // ---- Static auth methods ----

  static signIn = signIn;
  static verifyMfa = verifyMfa;

  // ---- Private helpers ----

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${CONNECT_API_BASE}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await this.fetchFn(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "User-Agent": USER_AGENT,
        "DI-Backend": "connectapi.garmin.com",
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Garmin Connect API error (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  // ---- User profile ----

  async getUserProfile(): Promise<GarminUserProfile> {
    return this.get<GarminUserProfile>("/userprofile-service/userprofile/profile");
  }

  async getUserSettings(): Promise<{ userData: Record<string, unknown> }> {
    return this.get("/userprofile-service/userprofile/user-settings");
  }

  // ---- Activities ----

  /** Search activities with pagination. Returns up to `limit` activities starting from `start`. */
  async searchActivities(start = 0, limit = 20): Promise<GarminConnectActivity[]> {
    return this.get<GarminConnectActivity[]>(
      "/activitylist-service/activities/search/activities",
      { start: String(start), limit: String(limit) },
    );
  }

  /** Get a single activity by ID. */
  async getActivity(activityId: number): Promise<GarminConnectActivity> {
    return this.get<GarminConnectActivity>(`/activity-service/activity/${activityId}`);
  }

  /** Get FIT file download URL for an activity. */
  getActivityFitUrl(activityId: number): string {
    return `${CONNECT_API_BASE}/download-service/files/activity/${activityId}`;
  }

  /** Get TCX export URL for an activity. */
  getActivityTcxUrl(activityId: number): string {
    return `${CONNECT_API_BASE}/download-service/export/tcx/activity/${activityId}`;
  }

  /** Get GPX export URL for an activity. */
  getActivityGpxUrl(activityId: number): string {
    return `${CONNECT_API_BASE}/download-service/export/gpx/activity/${activityId}`;
  }

  // ---- Daily summary ----

  async getDailySummary(date: string): Promise<GarminDailyUserSummary> {
    return this.get<GarminDailyUserSummary>(
      `/usersummary-service/usersummary/daily/${date}`,
    );
  }

  // ---- Sleep ----

  async getSleepData(date: string): Promise<GarminSleepData> {
    return this.get<GarminSleepData>(
      `/wellness-service/wellness/dailySleepData/${date}`,
    );
  }

  // ---- Heart rate ----

  async getHeartRates(date: string): Promise<GarminHeartRateData> {
    return this.get<GarminHeartRateData>(
      `/wellness-service/wellness/dailyHeartRate/${date}`,
    );
  }

  // ---- Stress ----

  async getStressData(date: string): Promise<GarminStressData> {
    return this.get<GarminStressData>(
      `/wellness-service/wellness/dailyStress/${date}`,
    );
  }

  // ---- Body Battery ----

  async getBodyBattery(date: string): Promise<GarminBodyBatteryData[]> {
    return this.get<GarminBodyBatteryData[]>(
      `/wellness-service/wellness/bodyBattery/reports/daily/${date}`,
    );
  }

  // ---- SpO2 ----

  async getSpO2(date: string): Promise<GarminSpO2Data> {
    return this.get<GarminSpO2Data>(
      `/wellness-service/wellness/daily/spo2/${date}`,
    );
  }

  // ---- HRV ----

  async getHrv(date: string): Promise<GarminHrvData> {
    return this.get<GarminHrvData>(`/hrv-service/hrv/${date}`);
  }

  // ---- Respiration ----

  async getRespiration(date: string): Promise<GarminRespirationData> {
    return this.get<GarminRespirationData>(
      `/wellness-service/wellness/daily/respiration/${date}`,
    );
  }

  // ---- Weight / Body Composition ----

  async getWeightRange(startDate: string, endDate: string): Promise<GarminWeightResponse> {
    return this.get<GarminWeightResponse>(
      `/weight-service/weight/dateRange`,
      { startDate, endDate },
    );
  }

  async getWeightDay(date: string): Promise<GarminWeightResponse> {
    return this.get<GarminWeightResponse>(
      `/weight-service/weight/dayview/${date}`,
    );
  }

  // ---- Training metrics ----

  async getTrainingReadiness(date: string): Promise<GarminTrainingReadiness> {
    return this.get<GarminTrainingReadiness>(
      `/metrics-service/metrics/trainingreadiness/${date}`,
    );
  }

  async getTrainingStatus(): Promise<GarminTrainingStatus> {
    return this.get<GarminTrainingStatus>(
      "/metrics-service/metrics/trainingstatus/aggregated",
    );
  }

  async getRacePredictions(): Promise<GarminRacePredictions> {
    return this.get<GarminRacePredictions>(
      "/metrics-service/metrics/racepredictions",
    );
  }

  async getMaxMetrics(date: string): Promise<GarminMaxMetrics> {
    return this.get<GarminMaxMetrics>(
      `/metrics-service/metrics/maxmet/daily/${date}`,
    );
  }

  // ---- Fitness age ----

  async getFitnessAge(): Promise<GarminFitnessAge> {
    return this.get<GarminFitnessAge>("/fitnessage-service/fitnessage");
  }

  // ---- Endurance & Hill scores ----

  async getEnduranceScore(date: string): Promise<GarminEnduranceScore> {
    return this.get<GarminEnduranceScore>(
      `/metrics-service/metrics/endurancescore/${date}`,
    );
  }

  async getHillScore(date: string): Promise<GarminHillScore> {
    return this.get<GarminHillScore>(
      `/metrics-service/metrics/hillscore/${date}`,
    );
  }

  // ---- Intensity minutes ----

  async getIntensityMinutes(date: string): Promise<GarminIntensityMinutes> {
    return this.get<GarminIntensityMinutes>(
      `/wellness-service/wellness/daily/im/${date}`,
    );
  }

  // ---- Steps ----

  async getDailySteps(date: string): Promise<Array<{ calendarDate: string; totalSteps: number }>> {
    return this.get(`/usersummary-service/stats/steps/daily/${date}/7`);
  }
}
