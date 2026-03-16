/**
 * Garmin Connect internal API client.
 *
 * Authentication flow (mirrors garth/python-garminconnect):
 * 1. GET SSO embed page → set cookies
 * 2. GET SSO signin page → extract CSRF token
 * 3. POST SSO signin with email/password/CSRF → get ticket
 * 4. Use ticket to get OAuth1 token (OAuth 1.0a signed request)
 * 5. Exchange OAuth1 for OAuth2 (OAuth 1.0a signed request)
 * 6. All API calls use OAuth2 Bearer token
 */

import { buildOAuth1Header } from "./oauth1.ts";
import type {
  BodyBatteryDay,
  ConnectActivityDetail,
  ConnectActivitySummary,
  ConnectDailySummary,
  ConnectSleepData,
  DailyHeartRate,
  DailyIntensityMinutes,
  DailyRespiration,
  DailySpO2,
  DailyStress,
  EnduranceScore,
  GarminTokens,
  GarminUserProfile,
  HillScore,
  HrvSummary,
  OAuth1Token,
  OAuth2Token,
  OAuthConsumer,
  RacePrediction,
  TrainingReadiness,
  TrainingStatus,
  Vo2MaxMetric,
} from "./types.ts";

const OAUTH_CONSUMER_URL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";
const USER_AGENT = "com.garmin.android.apps.connectmobile";
const API_USER_AGENT = "GCM-iOS-5.19.1.2";

const CSRF_RE = /name="_csrf"\s+value="(.+?)"/;
const TITLE_RE = /<title>(.+?)<\/title>/;
const TICKET_RE = /embed\?ticket=([^"]+)"/;

export class GarminConnectClient {
  private oauth1Token: OAuth1Token | null = null;
  private oauth2Token: OAuth2Token | null = null;
  private consumer: OAuthConsumer | null = null;
  private displayName: string | null = null;
  private domain: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(domain: string = "garmin.com", fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.domain = domain;
    this.fetchFn = fetchFn;
  }

  // ============================================================
  // Authentication
  // ============================================================

  /**
   * Sign in with email and password via Garmin SSO.
   * Returns both OAuth1 and OAuth2 tokens for persistence.
   */
  static async signIn(
    email: string,
    password: string,
    domain: string = "garmin.com",
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<{ client: GarminConnectClient; tokens: GarminTokens }> {
    const client = new GarminConnectClient(domain, fetchFn);
    await client.loadConsumer();

    const ssoBase = `https://sso.${domain}/sso`;
    const ssoEmbed = `${ssoBase}/embed`;

    const embedParams = new URLSearchParams({
      id: "gauth-widget",
      embedWidget: "true",
      gauthHost: ssoBase,
    });

    const signinParams = new URLSearchParams({
      id: "gauth-widget",
      embedWidget: "true",
      gauthHost: ssoEmbed,
      service: ssoEmbed,
      source: ssoEmbed,
      redirectAfterAccountLoginUrl: ssoEmbed,
      redirectAfterAccountCreationUrl: ssoEmbed,
    });

    // Step 1: Set cookies by visiting embed page
    const embedResponse = await fetchFn(`${ssoEmbed}?${embedParams.toString()}`, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });

    // Extract cookies from response for subsequent requests
    const cookies = extractSetCookies(embedResponse);

    // Step 2: Get CSRF token from signin page
    const signinPageResponse = await fetchFn(`${ssoBase}/signin?${signinParams.toString()}`, {
      headers: {
        "User-Agent": USER_AGENT,
        Cookie: cookies,
        Referer: embedResponse.url,
      },
      redirect: "follow",
    });

    const signinHtml = await signinPageResponse.text();
    const csrfToken = extractCsrf(signinHtml);
    const allCookies = mergeCookies(cookies, extractSetCookies(signinPageResponse));

    // Step 3: POST login form
    const loginBody = new URLSearchParams({
      username: email,
      password: password,
      embed: "true",
      _csrf: csrfToken,
    });

    const loginResponse = await fetchFn(`${ssoBase}/signin?${signinParams.toString()}`, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: allCookies,
        Referer: signinPageResponse.url,
      },
      body: loginBody.toString(),
      redirect: "follow",
    });

    const loginHtml = await loginResponse.text();
    const title = extractTitle(loginHtml);

    if (title !== "Success") {
      if (title.includes("MFA")) {
        throw new GarminMfaRequiredError(
          "MFA is required. MFA is not yet supported in this client.",
        );
      }
      throw new GarminAuthError(`Login failed. SSO returned title: "${title}"`);
    }

    // Step 4: Extract ticket and get OAuth1 token
    const ticket = extractTicket(loginHtml);
    const oauth1 = await client.getOAuth1Token(ticket);
    client.oauth1Token = oauth1;

    // Step 5: Exchange for OAuth2
    const oauth2 = await client.exchangeForOAuth2(oauth1);
    client.oauth2Token = oauth2;

    // Load profile to get displayName
    await client.loadProfile();

    return {
      client,
      tokens: { oauth1, oauth2 },
    };
  }

  /**
   * Create a client from previously saved tokens.
   */
  static async fromTokens(
    tokens: GarminTokens,
    domain: string = "garmin.com",
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<GarminConnectClient> {
    const client = new GarminConnectClient(domain, fetchFn);
    await client.loadConsumer();
    client.oauth1Token = tokens.oauth1;
    client.oauth2Token = tokens.oauth2;

    // Refresh OAuth2 if expired
    if (tokens.oauth2.expires_at < Date.now() / 1000) {
      const refreshed = await client.exchangeForOAuth2(tokens.oauth1);
      client.oauth2Token = refreshed;
    }

    await client.loadProfile();
    return client;
  }

  /**
   * Get current tokens for persistence.
   */
  getTokens(): GarminTokens | null {
    if (!this.oauth1Token || !this.oauth2Token) return null;
    return { oauth1: this.oauth1Token, oauth2: this.oauth2Token };
  }

  private async loadConsumer(): Promise<void> {
    const response = await this.fetchFn(OAUTH_CONSUMER_URL);
    if (!response.ok) {
      throw new GarminAuthError("Failed to fetch OAuth consumer credentials");
    }
    const consumer: OAuthConsumer = await response.json();
    this.consumer = consumer;
  }

  private async getOAuth1Token(ticket: string): Promise<OAuth1Token> {
    if (!this.consumer) throw new GarminAuthError("OAuth consumer not loaded");

    const loginUrl = `https://sso.${this.domain}/sso/embed`;
    const baseUrl = `https://connectapi.${this.domain}/oauth-service/oauth`;
    const url = `${baseUrl}/preauthorized?ticket=${encodeURIComponent(ticket)}&login-url=${encodeURIComponent(loginUrl)}&accepts-mfa-tokens=true`;

    const authHeader = buildOAuth1Header("GET", url, this.consumer);

    const response = await this.fetchFn(url, {
      headers: {
        Authorization: authHeader,
        "User-Agent": USER_AGENT,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new GarminAuthError(`Failed to get OAuth1 token (${response.status}): ${text}`);
    }

    const text = await response.text();
    const params = new URLSearchParams(text);

    return {
      oauth_token: params.get("oauth_token") ?? "",
      oauth_token_secret: params.get("oauth_token_secret") ?? "",
      mfa_token: params.get("mfa_token") ?? undefined,
      mfa_expiration_timestamp: params.get("mfa_expiration_timestamp") ?? undefined,
    };
  }

  private async exchangeForOAuth2(oauth1: OAuth1Token): Promise<OAuth2Token> {
    if (!this.consumer) throw new GarminAuthError("OAuth consumer not loaded");

    const baseUrl = `https://connectapi.${this.domain}/oauth-service/oauth`;
    const url = `${baseUrl}/exchange/user/2.0`;

    const bodyParams: Record<string, string> = {};
    if (oauth1.mfa_token) {
      bodyParams.mfa_token = oauth1.mfa_token;
    }

    const authHeader = buildOAuth1Header("POST", url, this.consumer, oauth1, bodyParams);

    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams(bodyParams).toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new GarminAuthError(`Failed to exchange for OAuth2 (${response.status}): ${text}`);
    }

    const token: Record<string, unknown> = await response.json();
    const now = Math.floor(Date.now() / 1000);

    return {
      scope: String(token.scope ?? ""),
      jti: String(token.jti ?? ""),
      token_type: String(token.token_type ?? "Bearer"),
      access_token: String(token.access_token ?? ""),
      refresh_token: String(token.refresh_token ?? ""),
      expires_in: Number(token.expires_in ?? 0),
      expires_at: now + Number(token.expires_in ?? 0),
      refresh_token_expires_in: Number(token.refresh_token_expires_in ?? 0),
      refresh_token_expires_at: now + Number(token.refresh_token_expires_in ?? 0),
    };
  }

  private async loadProfile(): Promise<void> {
    const profile = await this.connectApi<GarminUserProfile>("/userprofile-service/socialProfile");
    this.displayName = profile.displayName;
  }

  // ============================================================
  // API request helpers
  // ============================================================

  private async ensureValidToken(): Promise<string> {
    if (!this.oauth2Token) {
      throw new GarminAuthError("Not authenticated");
    }

    if (this.oauth2Token.expires_at < Date.now() / 1000) {
      if (!this.oauth1Token) {
        throw new GarminAuthError("OAuth2 token expired and no OAuth1 token available for refresh");
      }
      this.oauth2Token = await this.exchangeForOAuth2(this.oauth1Token);
    }

    return this.oauth2Token.access_token;
  }

  private async connectApi<T>(path: string, params?: Record<string, string>): Promise<T> {
    const accessToken = await this.ensureValidToken();
    const url = new URL(`https://connectapi.${this.domain}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await this.fetchFn(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": API_USER_AGENT,
        Accept: "application/json",
      },
    });

    if (response.status === 401) {
      throw new GarminAuthError("Authentication failed (401)");
    }

    if (response.status === 429) {
      throw new GarminRateLimitError("Rate limit exceeded (429)");
    }

    if (!response.ok) {
      const text = await response.text();
      throw new GarminApiError(`API error (${response.status}): ${text}`, response.status);
    }

    if (response.status === 204) {
      throw new GarminApiError("No content available (204)", 204);
    }

    return response.json();
  }

  private async downloadBytes(path: string): Promise<ArrayBuffer> {
    const accessToken = await this.ensureValidToken();
    const url = `https://connectapi.${this.domain}${path}`;

    const response = await this.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": API_USER_AGENT,
      },
    });

    if (!response.ok) {
      throw new GarminApiError(`Download failed (${response.status})`, response.status);
    }

    return response.arrayBuffer();
  }

  // ============================================================
  // User profile
  // ============================================================

  getDisplayName(): string {
    if (!this.displayName) {
      throw new GarminAuthError("Display name not loaded. Call signIn() or fromTokens() first.");
    }
    return this.displayName;
  }

  async getUserSettings(): Promise<Record<string, unknown>> {
    return this.connectApi("/userprofile-service/userprofile/user-settings");
  }

  // ============================================================
  // Daily summary
  // ============================================================

  async getDailySummary(date: string): Promise<ConnectDailySummary> {
    return this.connectApi(`/usersummary-service/usersummary/daily/${this.getDisplayName()}`, {
      calendarDate: date,
    });
  }

  // ============================================================
  // Activities
  // ============================================================

  async getActivities(start: number = 0, limit: number = 20): Promise<ConnectActivitySummary[]> {
    return this.connectApi("/activitylist-service/activities/search/activities", {
      start: String(start),
      limit: String(limit),
    });
  }

  async getActivityDetail(
    activityId: number,
    maxChartSize: number = 2000,
    maxPolylineSize: number = 4000,
  ): Promise<ConnectActivityDetail> {
    return this.connectApi(`/activity-service/activity/${activityId}/details`, {
      maxChartSize: String(maxChartSize),
      maxPolylineSize: String(maxPolylineSize),
    });
  }

  async downloadFitFile(activityId: number): Promise<ArrayBuffer> {
    return this.downloadBytes(`/download-service/files/activity/${activityId}`);
  }

  // ============================================================
  // Sleep
  // ============================================================

  async getSleepData(date: string): Promise<ConnectSleepData> {
    return this.connectApi(`/wellness-service/wellness/dailySleepData/${this.getDisplayName()}`, {
      date,
    });
  }

  // ============================================================
  // Heart rate
  // ============================================================

  async getDailyHeartRate(date: string): Promise<DailyHeartRate> {
    return this.connectApi(`/wellness-service/wellness/dailyHeartRate/${this.getDisplayName()}`, {
      date,
    });
  }

  // ============================================================
  // Stress
  // ============================================================

  async getDailyStress(date: string): Promise<DailyStress> {
    return this.connectApi(`/wellness-service/wellness/dailyStress/${date}`);
  }

  // ============================================================
  // Body battery
  // ============================================================

  async getBodyBatteryDaily(date: string): Promise<BodyBatteryDay[]> {
    return this.connectApi(`/wellness-service/wellness/bodyBattery/reports/daily/${date}`);
  }

  async getBodyBatteryEvents(date: string): Promise<Record<string, unknown>> {
    return this.connectApi(`/wellness-service/wellness/bodyBattery/events/${date}`);
  }

  // ============================================================
  // HRV
  // ============================================================

  async getHrvSummary(date: string): Promise<HrvSummary> {
    return this.connectApi(`/hrv-service/hrv/${date}`);
  }

  // ============================================================
  // Training metrics
  // ============================================================

  async getTrainingStatus(date: string): Promise<TrainingStatus> {
    return this.connectApi(`/metrics-service/metrics/trainingstatus/aggregated/${date}`);
  }

  async getTrainingReadiness(date: string): Promise<TrainingReadiness> {
    return this.connectApi(`/metrics-service/metrics/trainingreadiness/${date}`);
  }

  async getVo2Max(startDate: string, endDate: string): Promise<Vo2MaxMetric[]> {
    return this.connectApi(`/metrics-service/metrics/maxmet/daily/${startDate}/${endDate}`);
  }

  async getRacePredictions(): Promise<RacePrediction> {
    return this.connectApi("/metrics-service/metrics/racepredictions");
  }

  async getHillScore(startDate: string, endDate: string): Promise<HillScore[]> {
    return this.connectApi(`/metrics-service/metrics/hillscore/${startDate}/${endDate}`);
  }

  async getEnduranceScore(startDate: string, endDate: string): Promise<EnduranceScore[]> {
    return this.connectApi(`/metrics-service/metrics/endurancescore/${startDate}/${endDate}`);
  }

  // ============================================================
  // Respiration & SpO2
  // ============================================================

  async getDailyRespiration(date: string): Promise<DailyRespiration> {
    return this.connectApi(`/wellness-service/wellness/daily/respiration/${date}`);
  }

  async getDailySpO2(date: string): Promise<DailySpO2> {
    return this.connectApi(`/wellness-service/wellness/daily/spo2/${date}`);
  }

  // ============================================================
  // Intensity minutes
  // ============================================================

  async getDailyIntensityMinutes(date: string): Promise<DailyIntensityMinutes[]> {
    return this.connectApi(`/wellness-service/wellness/daily/im/${date}`);
  }

  // ============================================================
  // Steps
  // ============================================================

  async getDailySteps(startDate: string, endDate: string): Promise<Array<Record<string, unknown>>> {
    return this.connectApi(`/usersummary-service/stats/steps/daily/${startDate}/${endDate}`);
  }

  // ============================================================
  // Floors
  // ============================================================

  async getFloors(date: string): Promise<Record<string, unknown>> {
    return this.connectApi(`/wellness-service/wellness/floorsChartData/daily/${date}`);
  }
}

// ============================================================
// Helper functions
// ============================================================

function extractSetCookies(response: Response): string {
  const setCookieHeaders = response.headers.getSetCookie?.() ?? [];
  return setCookieHeaders
    .map((header) => {
      const parts = header.split(";");
      return parts[0]?.trim() ?? "";
    })
    .filter(Boolean)
    .join("; ");
}

function mergeCookies(existing: string, newer: string): string {
  if (!newer) return existing;
  if (!existing) return newer;
  return `${existing}; ${newer}`;
}

function extractCsrf(html: string): string {
  const match = CSRF_RE.exec(html);
  if (!match?.[1]) {
    throw new GarminAuthError("Could not find CSRF token in login page");
  }
  return match[1];
}

function extractTitle(html: string): string {
  const match = TITLE_RE.exec(html);
  if (!match?.[1]) {
    throw new GarminAuthError("Could not find title in response page");
  }
  return match[1];
}

function extractTicket(html: string): string {
  const match = TICKET_RE.exec(html);
  if (!match?.[1]) {
    throw new GarminAuthError("Could not find SSO ticket in response");
  }
  return match[1];
}

// ============================================================
// Error classes
// ============================================================

export class GarminAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GarminAuthError";
  }
}

export class GarminMfaRequiredError extends GarminAuthError {
  constructor(message: string) {
    super(message);
    this.name = "GarminMfaRequiredError";
  }
}

export class GarminApiError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "GarminApiError";
    this.statusCode = statusCode;
  }
}

export class GarminRateLimitError extends GarminApiError {
  constructor(message: string) {
    super(message, 429);
    this.name = "GarminRateLimitError";
  }
}
