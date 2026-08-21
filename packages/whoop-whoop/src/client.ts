import { randomUUID } from "node:crypto";
import {
  fetchWithRateLimitHandling,
  isServiceUnavailableStatus,
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
  parseRetryAfterHeader,
} from "@dofek/provider-http/rate-limit";
import { z } from "zod";
import type {
  WhoopAuthToken,
  WhoopCycle,
  WhoopDeveloperWorkoutListResponse,
  WhoopHrValue,
  WhoopMetricResponse,
  WhoopMetricValue,
  WhoopSignInResult,
  WhoopSleepRecord,
  WhoopVerificationMethod,
  WhoopWeightliftingWorkoutResponse,
} from "./types.ts";

const WHOOP_API_BASE = "https://api.prod.whoop.com";
const WHOOP_API_VERSION = "7";
const WHOOP_DEVELOPER_WORKOUT_PATH = "/developer/v2/activity/workout";
/** Minimum delay between consecutive WHOOP API requests (ms). */
export const WHOOP_API_THROTTLE_MS = 1_000;
const WHOOP_AUTH_ORIGIN = "https://id.whoop.com";
const WHOOP_AUTH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0";
const WHOOP_AUTH_AMZ_USER_AGENT =
  "aws-sdk-js/3.848.0 ua/2.1 os/macOS#10.15 lang/js md/browser#Firefox_150.0 api/cognito-identity-provider#3.848.0 m/N,E";

export class WhoopRateLimitError extends ProviderRateLimitError {
  constructor(
    message: string,
    responseBody = "",
    retryAfterSeconds?: number | null,
    userId?: string | null,
  ) {
    super({
      message,
      providerId: "whoop",
      statusCode: 429,
      responseBody,
      retryAfterSeconds,
      scope: userId != null ? "user" : "provider",
      userId: userId ?? null,
    });
    this.name = "WhoopRateLimitError";
  }
}

/** Thrown when metrics-service rejects a metric name (400/404). */
export class WhoopMetricUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhoopMetricUnavailableError";
  }
}

function createWhoopRateLimitError(response: Response, responseBody: string): WhoopRateLimitError {
  const retryAfterSeconds = parseRetryAfterHeader(response.headers.get("Retry-After"));
  return new WhoopRateLimitError(
    `WHOOP API rate limit exceeded (${response.status}): ${responseBody}`,
    responseBody,
    retryAfterSeconds,
  );
}

function createWhoopServiceUnavailableError(
  response: Response,
  responseBody: string,
): ProviderServiceUnavailableError {
  return new ProviderServiceUnavailableError({
    message: `WHOOP API service unavailable (${response.status}): ${responseBody}`,
    providerId: "whoop",
    statusCode: response.status,
    responseBody,
    retryAfterSeconds: parseRetryAfterHeader(response.headers.get("Retry-After")),
  });
}

// Cognito auth config (from id.whoop.com web app)
const COGNITO_ENDPOINT = `${WHOOP_API_BASE}/auth-service/v3/whoop/`;
const COGNITO_CLIENT_ID = "37365lrcda1js3fapqfe2n40eh";

/** Safely extract a string from an untyped record */
function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  return typeof val === "string" ? val : undefined;
}

/** Safely extract a number from an untyped record */
function getNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const val = obj[key];
  return typeof val === "number" ? val : undefined;
}

/** Extract the Cognito AuthenticationResult.ExpiresIn (seconds) and validate it. */
function getExpiresInSeconds(authResult: Record<string, unknown>): number {
  const expiresInSeconds = getNumber(authResult, "ExpiresIn");
  if (!expiresInSeconds || expiresInSeconds <= 0) {
    throw new Error("WHOOP auth: Cognito response missing valid ExpiresIn");
  }
  return expiresInSeconds;
}

/** Type guard: checks if a value is a non-null, non-array object (Record-like) */
function isRecord(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

const whoopDeveloperWorkoutRecordSchema = z
  .object({
    id: z.string(),
    start: z.string(),
    end: z.string(),
    timezone_offset: z.string().optional(),
    sport_name: z.string().optional(),
    sport_id: z.number().optional(),
    score_state: z.string().optional(),
  })
  .passthrough();

const whoopDeveloperWorkoutListResponseSchema = z
  .object({
    records: z.array(whoopDeveloperWorkoutRecordSchema),
    next_token: z.string().nullable().optional(),
  })
  .passthrough();

/** Safely extract a nested record from an untyped record */
function getRecord(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const val = obj[key];
  return isRecord(val) ? val : undefined;
}

/** Make a Cognito API call through WHOOP's proxy endpoint */
async function cognitoCall(
  action: string,
  body: Record<string, unknown>,
  fetchFn: typeof globalThis.fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchWithRateLimitHandling(
    fetchFn,
    COGNITO_ENDPOINT,
    {
      method: "POST",
      headers: {
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/x-amz-json-1.1",
        Origin: WHOOP_AUTH_ORIGIN,
        Priority: "u=4",
        Referer: `${WHOOP_AUTH_ORIGIN}/`,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        "User-Agent": WHOOP_AUTH_USER_AGENT,
        "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
        "amz-sdk-invocation-id": randomUUID(),
        "amz-sdk-request": "attempt=1; max=3",
        "x-amz-user-agent": WHOOP_AUTH_AMZ_USER_AGENT,
      },
      body: JSON.stringify(body),
    },
    {
      createRateLimitError: createWhoopRateLimitError,
      createServiceUnavailableError: createWhoopServiceUnavailableError,
    },
  );

  // Read body as text first — the proxy may return non-JSON errors
  const bodyText = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`WHOOP auth failed (${response.status}): ${bodyText || response.statusText}`);
  }

  if (!response.ok) {
    const errorType = getString(data, "__type")?.split("#").pop() ?? "UnknownError";
    const errorMessage = getString(data, "message") ?? getString(data, "Message") ?? "Auth failed";
    throw new Error(`WHOOP Cognito ${errorType}: ${errorMessage}`);
  }

  return data;
}

export interface WhoopRequestEvent {
  userId: number;
  endpoint: string;
  status: number;
  attempt: number;
  retryAfterSeconds: number | null;
  timestamp: Date;
}

export class WhoopClient {
  #accessToken: string;
  #userId: number;
  #fetchFn: typeof globalThis.fetch;
  #onRequest?: (event: WhoopRequestEvent) => void;

  constructor(
    token: WhoopAuthToken,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
    onRequest?: (event: WhoopRequestEvent) => void,
  ) {
    this.#accessToken = token.accessToken;
    this.#userId = token.userId;
    this.#fetchFn = fetchFn;
    this.#onRequest = onRequest;
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
    const challengeName = getString(data, "ChallengeName");
    if (challengeName) {
      const session = getString(data, "Session");
      if (!session) {
        throw new Error("WHOOP sign-in: MFA challenge but no session returned");
      }
      return {
        type: "verification_required",
        session,
        method: challengeName === "SOFTWARE_TOKEN_MFA" ? "totp" : "sms",
      };
    }

    // No MFA — tokens returned directly
    const authResult = getRecord(data, "AuthenticationResult");
    const accessToken = authResult ? getString(authResult, "AccessToken") : undefined;
    if (!authResult || !accessToken) {
      throw new Error("WHOOP sign-in: no tokens in response");
    }
    const expiresInSeconds = getExpiresInSeconds(authResult);

    const userId = await WhoopClient._fetchUserId(accessToken, fetchFn);
    if (!userId) {
      throw new Error("WHOOP sign-in: could not determine user ID from bootstrap endpoint");
    }

    const refreshToken = getString(authResult, "RefreshToken") ?? "";

    return {
      type: "success",
      token: {
        accessToken,
        refreshToken,
        userId,
        expiresInSeconds,
      },
    };
  }

  /**
   * Step 2: Submit MFA code via Cognito RespondToAuthChallenge.
   */
  static async verifyCode(
    session: string,
    code: string,
    username: string,
    method: WhoopVerificationMethod,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<WhoopAuthToken> {
    const challengeName = method === "totp" ? "SOFTWARE_TOKEN_MFA" : "SMS_MFA";
    const challengeCodeField = method === "totp" ? "SOFTWARE_TOKEN_MFA_CODE" : "SMS_MFA_CODE";
    const data = await cognitoCall(
      "RespondToAuthChallenge",
      {
        ChallengeName: challengeName,
        ClientId: COGNITO_CLIENT_ID,
        Session: session,
        ChallengeResponses: {
          USERNAME: username,
          [challengeCodeField]: code,
        },
      },
      fetchFn,
    );

    const authResult = getRecord(data, "AuthenticationResult");
    const accessToken = authResult ? getString(authResult, "AccessToken") : undefined;
    if (!authResult || !accessToken) {
      throw new Error("WHOOP verification: no tokens in response");
    }
    const expiresInSeconds = getExpiresInSeconds(authResult);

    const userId = await WhoopClient._fetchUserId(accessToken, fetchFn);
    if (!userId) {
      throw new Error("WHOOP verification: could not determine user ID from bootstrap endpoint");
    }

    return {
      accessToken,
      refreshToken: (authResult ? getString(authResult, "RefreshToken") : undefined) ?? "",
      userId,
      expiresInSeconds,
    };
  }

  /**
   * Refresh an expired access token using a Cognito refresh token.
   */
  static async refreshAccessToken(
    refreshToken: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    userId: number | null;
    expiresInSeconds: number;
  }> {
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

    const authResult = getRecord(data, "AuthenticationResult");
    const accessToken = authResult ? getString(authResult, "AccessToken") : undefined;
    if (!authResult || !accessToken) {
      throw new Error("WHOOP token refresh: no tokens in response");
    }
    const expiresInSeconds = getExpiresInSeconds(authResult);

    // Best-effort: try to get userId from bootstrap. Returns null if it fails —
    // caller should fall back to the stored userId from the original auth.
    const userId = await WhoopClient._fetchUserId(accessToken, fetchFn);

    return {
      accessToken,
      // Cognito REFRESH_TOKEN_AUTH doesn't return a new refresh token — reuse the old one
      refreshToken:
        (authResult ? getString(authResult, "RefreshToken") : undefined) ?? refreshToken,
      userId,
      expiresInSeconds,
    };
  }

  /** Backwards-compatible authenticate — works for accounts WITHOUT MFA */
  static async authenticate(
    username: string,
    password: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<WhoopAuthToken> {
    const result = await WhoopClient.signIn(username, password, fetchFn);
    if (result.type === "verification_required") {
      throw new Error("WHOOP account requires MFA — use the web UI to authenticate");
    }
    return result.token;
  }

  /**
   * Fetch user ID from the WHOOP bootstrap endpoint.
   * Returns null if the user ID cannot be extracted (caller should fall back to stored value).
   */
  static async _fetchUserId(
    accessToken: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<number | null> {
    const response = await fetchWithRateLimitHandling(
      fetchFn,
      `${WHOOP_API_BASE}/users-service/v2/bootstrap/?accountType=users&apiVersion=7&include=profile`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      {
        createRateLimitError: createWhoopRateLimitError,
        createServiceUnavailableError: createWhoopServiceUnavailableError,
      },
    );

    if (!response.ok) {
      return null;
    }

    const data: Record<string, unknown> = await response.json();
    const nested = getRecord(data, "user");
    const userId =
      getNumber(data, "id") ??
      getNumber(data, "user_id") ??
      (nested ? getNumber(nested, "id") : undefined) ??
      (nested ? getNumber(nested, "user_id") : undefined);
    if (!userId || typeof userId !== "number") {
      return null;
    }
    return userId;
  }

  async #get<T>(url: string, params?: Record<string, string>, attempt = 0): Promise<T> {
    const requestUrl = new URL(url);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        requestUrl.searchParams.set(key, value);
      }
    }
    requestUrl.searchParams.set("apiVersion", WHOOP_API_VERSION);

    const response = await this.#fetchFn(requestUrl.toString(), {
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        "User-Agent": "WHOOP/4.0",
      },
    });

    const retryAfterSeconds =
      response.status === 429 ? parseRetryAfterHeader(response.headers.get("Retry-After")) : null;

    this.#onRequest?.({
      userId: this.#userId,
      endpoint: requestUrl.pathname,
      status: response.status,
      attempt,
      retryAfterSeconds,
      timestamp: new Date(),
    });

    if (response.ok) {
      return response.json();
    }

    if (response.status === 429) {
      const text = await response.text();
      throw new WhoopRateLimitError(
        `WHOOP API rate limit exceeded (429): ${text}`,
        text,
        retryAfterSeconds,
      );
    }

    const text = await response.text();
    if (
      isServiceUnavailableStatus(response.status) ||
      (requestUrl.pathname === WHOOP_DEVELOPER_WORKOUT_PATH && response.status === 500)
    ) {
      throw createWhoopServiceUnavailableError(response, text);
    }
    throw new Error(`WHOOP API error (${response.status}): ${text}`);
  }

  async #getWithRateLimitRetry<T>(
    url: string,
    params?: Record<string, string>,
    maxRetries = 3,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await this.#get<T>(url, params, attempt);
      } catch (err) {
        if (err instanceof ProviderServiceUnavailableError && attempt < maxRetries) {
          attempt++;
          continue;
        }
        throw err;
      }
    }
  }

  async getHeartRate(start: string, end: string, step = 6): Promise<WhoopHrValue[]> {
    return this.getMetricValues("heart_rate", start, end, step);
  }

  async getSteps(start: string, end: string, step = 300): Promise<WhoopMetricValue[]> {
    return this.getMetricValues("steps", start, end, step);
  }

  /** Strain deep-dive BFF — includes daily step count in CONTRIBUTORS_TILE_STEPS. */
  async getStrainDeepDive(date: string): Promise<unknown> {
    return this.#get<unknown>(`${WHOOP_API_BASE}/home-service/v1/deep-dive/strain`, { date });
  }

  async getMetricValues(
    name: "heart_rate" | "steps",
    start: string,
    end: string,
    step: number,
  ): Promise<WhoopMetricValue[]> {
    try {
      const response = await this.#get<WhoopMetricResponse>(
        `${WHOOP_API_BASE}/metrics-service/v1/metrics/user/${this.#userId}`,
        { start, end, step: String(step), name },
      );
      return response.values ?? [];
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("WHOOP API error (400)") ||
          err.message.includes("WHOOP API error (404)"))
      ) {
        throw new WhoopMetricUnavailableError(err.message);
      }
      throw err;
    }
  }

  async getCycles(start: string, end: string, limit = 200): Promise<WhoopCycle[]> {
    const raw = await this.#get<unknown>(`${WHOOP_API_BASE}/core-details-bff/v0/cycles/details`, {
      id: String(this.#userId),
      startTime: start,
      endTime: end,
      limit: String(limit),
    });
    // BFF may return bare array or wrapped object — normalize
    if (Array.isArray(raw)) {
      const cycles: WhoopCycle[] = raw;
      return cycles;
    }
    if (isRecord(raw)) {
      // Try common wrapper keys
      for (const key of ["cycles", "records", "data", "results"]) {
        const val = raw[key];
        if (Array.isArray(val)) {
          const cycles: WhoopCycle[] = val;
          return cycles;
        }
      }
    }
    return [];
  }

  /**
   * List workouts from the developer API. Paginated via next_token.
   * Unlike the cycles BFF embed, this list omits workouts deleted in WHOOP.
   */
  async listDeveloperWorkouts(options?: {
    limit?: number;
    nextToken?: string;
  }): Promise<WhoopDeveloperWorkoutListResponse> {
    const params: Record<string, string> = {};
    if (options?.limit != null) {
      params.limit = String(options.limit);
    }
    if (options?.nextToken) {
      params.next_token = options.nextToken;
    }
    const raw = await this.#getWithRateLimitRetry<unknown>(
      `${WHOOP_API_BASE}${WHOOP_DEVELOPER_WORKOUT_PATH}`,
      params,
    );
    const parsed = whoopDeveloperWorkoutListResponseSchema.parse(raw);
    return {
      records: parsed.records,
      next_token: parsed.next_token ?? null,
    };
  }

  /**
   * Collect workout IDs present in WHOOP for a sync window using the developer
   * workout list (authoritative for deletions).
   */
  async listDeveloperWorkoutIdsInWindow(windowStart: Date, windowEnd: Date): Promise<Set<string>> {
    const presentExternalIds = new Set<string>();
    const pageLimit = 25;
    let nextToken: string | undefined;
    let reachedWindowStart = false;

    do {
      const page = await this.listDeveloperWorkouts({ limit: pageLimit, nextToken });
      if (page.records.length === 0) {
        break;
      }

      let oldestStartMs = Number.POSITIVE_INFINITY;
      for (const record of page.records) {
        const workoutStartMs = Date.parse(record.start);
        if (!Number.isFinite(workoutStartMs)) {
          continue;
        }
        oldestStartMs = Math.min(oldestStartMs, workoutStartMs);
        if (workoutStartMs >= windowStart.getTime() && workoutStartMs < windowEnd.getTime()) {
          if (record.id) {
            presentExternalIds.add(record.id);
          }
        }
      }

      if (oldestStartMs < windowStart.getTime()) {
        reachedWindowStart = true;
      }

      nextToken = page.next_token ?? undefined;
      if (reachedWindowStart || !nextToken) {
        break;
      }
    } while (nextToken);

    return presentExternalIds;
  }

  async getSleep(sleepId: string | number): Promise<WhoopSleepRecord> {
    return this.#get<WhoopSleepRecord>(`${WHOOP_API_BASE}/sleep-service/v1/sleep-events`, {
      activityId: String(sleepId),
    });
  }

  async getJournal(start: string, end: string): Promise<unknown> {
    return this.#get<unknown>(`${WHOOP_API_BASE}/behavior-impact-service/v1/impact`, {
      startTime: start,
      endTime: end,
    });
  }

  /**
   * Fetch exercise-level strength data for a workout activity.
   * Returns null if the activity has no linked exercises (404).
   */
  async getWeightliftingWorkout(
    activityId: string,
  ): Promise<WhoopWeightliftingWorkoutResponse | null> {
    const requestUrl = new URL(
      `${WHOOP_API_BASE}/weightlifting-service/v2/weightlifting-workout/${activityId}`,
    );
    requestUrl.searchParams.set("apiVersion", WHOOP_API_VERSION);

    const response = await fetchWithRateLimitHandling(
      this.#fetchFn,
      requestUrl.toString(),
      {
        headers: {
          Authorization: `Bearer ${this.#accessToken}`,
          "User-Agent": "WHOOP/4.0",
        },
      },
      {
        createRateLimitError: (response, responseBody) => {
          const retryAfterSeconds = parseRetryAfterHeader(response.headers.get("Retry-After"));
          this.#onRequest?.({
            userId: this.#userId,
            endpoint: requestUrl.pathname,
            status: response.status,
            attempt: 0,
            retryAfterSeconds,
            timestamp: new Date(),
          });
          return createWhoopRateLimitError(response, responseBody);
        },
        createServiceUnavailableError: createWhoopServiceUnavailableError,
      },
    );

    if (response.status === 404) return null;

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`WHOOP weightlifting API error (${response.status}): ${text}`);
    }

    const result: WhoopWeightliftingWorkoutResponse = await response.json();
    return result;
  }
}
