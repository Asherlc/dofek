import type {
  WhoopAuthToken,
  WhoopCycle,
  WhoopHrResponse,
  WhoopHrValue,
  WhoopSignInResult,
  WhoopSleepRecord,
  WhoopWeightliftingWorkoutResponse,
} from "./types.ts";

const WHOOP_API_BASE = "https://api.prod.whoop.com";
const WHOOP_API_VERSION = "7";

export class WhoopRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhoopRateLimitError";
  }
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

/** Type guard: checks if a value is a non-null, non-array object (Record-like) */
function isRecord(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

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
  const response = await fetchFn(COGNITO_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify(body),
  });

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
            USERNAME: username,
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
            USERNAME: username,
            SOFTWARE_TOKEN_MFA_CODE: code,
          },
        },
        fetchFn,
      );
    }

    const authResult = getRecord(data, "AuthenticationResult");
    const accessToken = authResult ? getString(authResult, "AccessToken") : undefined;
    if (!authResult || !accessToken) {
      throw new Error("WHOOP verification: no tokens in response");
    }

    const userId = await WhoopClient._fetchUserId(accessToken, fetchFn);
    if (!userId) {
      throw new Error("WHOOP verification: could not determine user ID from bootstrap endpoint");
    }

    return {
      accessToken,
      refreshToken: (authResult ? getString(authResult, "RefreshToken") : undefined) ?? "",
      userId,
    };
  }

  /**
   * Refresh an expired access token using a Cognito refresh token.
   */
  static async refreshAccessToken(
    refreshToken: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<{ accessToken: string; refreshToken: string; userId: number | null }> {
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

    // Best-effort: try to get userId from bootstrap. Returns null if it fails —
    // caller should fall back to the stored userId from the original auth.
    const userId = await WhoopClient._fetchUserId(accessToken, fetchFn);

    return {
      accessToken,
      // Cognito REFRESH_TOKEN_AUTH doesn't return a new refresh token — reuse the old one
      refreshToken:
        (authResult ? getString(authResult, "RefreshToken") : undefined) ?? refreshToken,
      userId,
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
    const response = await fetchFn(
      `${WHOOP_API_BASE}/users-service/v2/bootstrap/?accountType=users&apiVersion=7&include=profile`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
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

  async #get<T>(url: string, params?: Record<string, string>): Promise<T> {
    const requestUrl = new URL(url);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        requestUrl.searchParams.set(key, value);
      }
    }
    requestUrl.searchParams.set("apiVersion", WHOOP_API_VERSION);

    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await this.#fetchFn(requestUrl.toString(), {
        headers: {
          Authorization: `Bearer ${this.#accessToken}`,
          "User-Agent": "WHOOP/4.0",
        },
      });

      const retryAfterHeader = response.status === 429 ? response.headers.get("Retry-After") : null;
      const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : null;

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
        if (attempt === maxRetries) {
          const text = await response.text();
          throw new WhoopRateLimitError(`WHOOP API rate limit exceeded (429): ${text}`);
        }
        const delaySeconds = retryAfterSeconds ?? 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
        continue;
      }

      const text = await response.text();
      throw new Error(`WHOOP API error (${response.status}): ${text}`);
    }

    throw new Error("unreachable");
  }

  async getHeartRate(start: string, end: string, step = 6): Promise<WhoopHrValue[]> {
    const response = await this.#get<WhoopHrResponse>(
      `${WHOOP_API_BASE}/metrics-service/v1/metrics/user/${this.#userId}`,
      { start, end, step: String(step), name: "heart_rate" },
    );
    return response.values ?? [];
  }

  async getCycles(start: string, end: string, limit = 26): Promise<WhoopCycle[]> {
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
      // Try known wrapper keys first
      for (const key of ["cycles", "records", "data", "results"]) {
        const val = raw[key];
        if (Array.isArray(val)) {
          const cycles: WhoopCycle[] = val;
          return cycles;
        }
      }
      // Fall back to any array-valued key (defensive against API key renames)
      for (const key of Object.keys(raw)) {
        const val = raw[key];
        if (Array.isArray(val)) {
          const cycles: WhoopCycle[] = val;
          return cycles;
        }
      }
    }
    // Don't silently return empty — surface the problem so sync reports an error
    const shape =
      raw === null
        ? "null"
        : isRecord(raw)
          ? `object keys: ${Object.keys(raw).join(", ")}`
          : typeof raw;
    throw new Error(`Unrecognized WHOOP cycles response format (${shape})`);
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

    const response = await this.#fetchFn(requestUrl.toString(), {
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        "User-Agent": "WHOOP/4.0",
      },
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`WHOOP weightlifting API error (${response.status}): ${text}`);
    }

    const result: WhoopWeightliftingWorkoutResponse = await response.json();
    return result;
  }
}
