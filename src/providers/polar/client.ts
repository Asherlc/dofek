import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import { POLAR_API_BASE } from "./oauth.ts";
import type {
  PolarDailyActivity,
  PolarExercise,
  PolarNightlyRecharge,
  PolarSleep,
} from "./types.ts";

interface PolarSleepResponse {
  nights: PolarSleep[];
}

interface PolarNightlyRechargeResponse {
  recharges: PolarNightlyRecharge[];
}

export class PolarNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolarNotFoundError";
  }
}

export class PolarUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolarUnauthorizedError";
  }
}

export class PolarClient {
  readonly #accessToken: string;
  readonly #fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#accessToken = accessToken;
    this.#fetchFn = createProviderRateLimitFetch("polar", fetchFn);
  }

  async #get<TResponse>(
    path: string,
    emptyValue: TResponse,
    parse: (value: unknown) => TResponse,
  ): Promise<TResponse> {
    const response = await this.#fetchFn(`${POLAR_API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        Accept: "application/json",
      },
    });

    if (response.status === 401 || response.status === 403) {
      throw new PolarUnauthorizedError(`Polar API unauthorized (${response.status}): ${path}`);
    }

    if (response.status === 404) {
      throw new PolarNotFoundError(`Polar API 404: ${path}`);
    }

    const textBody = await response.text();

    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      throw new Error(
        `Polar API error (${response.status}): ${formatPolarApiErrorBody(contentType, textBody)}`,
      );
    }

    if (textBody.trim() === "") {
      // Polar sometimes returns 200 with an empty body when there is no data.
      return emptyValue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(textBody);
    } catch (error) {
      throw new Error(
        `Polar API returned invalid JSON for ${path}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    return parse(parsed);
  }

  async getExercises(): Promise<PolarExercise[]> {
    return this.#get("/exercises", [], assertPolarExerciseArray);
  }

  async getSleep(): Promise<PolarSleep[]> {
    const response = this.#get("/users/sleep", { nights: [] }, assertPolarSleepResponse);
    return (await response).nights;
  }

  async getDailyActivity(): Promise<PolarDailyActivity[]> {
    return this.#get("/users/activities", [], assertPolarDailyActivityArray);
  }

  async getNightlyRecharge(): Promise<PolarNightlyRecharge[]> {
    const response = this.#get(
      "/users/nightly-recharge",
      { recharges: [] },
      assertPolarNightlyRechargeResponse,
    );
    return (await response).recharges;
  }

  /**
   * Discover the current user's Polar user ID via GET /v3/users.
   * Returns null if the request fails (e.g. token is expired/revoked).
   */
  async getCurrentUserId(): Promise<string | null> {
    const response = await this.#fetchFn(`${POLAR_API_BASE}/users`, {
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) return null;

    const userData: { polar_user_id?: string | number } = await response.json();
    return userData.polar_user_id != null ? String(userData.polar_user_id) : null;
  }

  /**
   * Register the user with Polar AccessLink. Required after OAuth before
   * data endpoints will work. The caller discovers the Polar user ID
   * (e.g. via {@link getCurrentUserId}) and passes it as `polarUserId`.
   *
   * @see https://www.polar.com/accesslink-api/#register-user
   */
  async registerUser(polarUserId: string): Promise<void> {
    const response = await this.#fetchFn(`${POLAR_API_BASE}/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ "member-id": polarUserId }),
    });

    // 409 Conflict = user already registered — not an error
    if (response.status === 409) return;

    if (!response.ok) {
      throw new Error(
        `Polar user registration failed (${response.status}): ${await this.#readErrorBody(response)}`,
      );
    }
  }

  /**
   * Deregister the user from Polar AccessLink. This revokes the access token
   * and is required before a new token can be issued (Polar limits active
   * tokens per app+user).
   *
   * @see https://www.polar.com/accesslink-api/#delete-user
   */
  async deregisterUser(polarUserId: string): Promise<void> {
    const response = await this.#fetchFn(`${POLAR_API_BASE}/users/${polarUserId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        Accept: "application/json",
      },
    });

    if (response.status === 204) return;

    throw new Error(
      `Polar user deregistration failed (${response.status}): ${await this.#readErrorBody(response)}`,
    );
  }

  /**
   * Deregister during durable account erasure.
   *
   * Polar documents GET 204 as absent and DELETE 204 as successfully
   * deregistered. A precise RFC 6750 invalid_token challenge is terminal
   * because Polar access tokens do not expire unless explicitly revoked.
   *
   * @see https://www.polar.com/accesslink-api/#get-user-information
   * @see https://www.polar.com/accesslink-api/#delete-user
   * @see https://www.rfc-editor.org/rfc/rfc6750#section-3.1
   */
  async deregisterUserForAccountErasure(polarUserId: string): Promise<void> {
    const userUrl = `${POLAR_API_BASE}/users/${polarUserId}`;
    const headers = {
      Authorization: `Bearer ${this.#accessToken}`,
      Accept: "application/json",
    };
    const registration = await this.#fetchFn(userUrl, { headers });
    if (registration.status === 204 || hasInvalidTokenChallenge(registration)) return;
    if (registration.status !== 200) {
      throw new Error(
        `Polar user registration check failed (${registration.status}): ${await this.#readErrorBody(registration)}`,
      );
    }

    const deregistration = await this.#fetchFn(userUrl, {
      method: "DELETE",
      headers,
    });
    if (deregistration.status === 204 || hasInvalidTokenChallenge(deregistration)) return;
    throw new Error(
      `Polar user deregistration failed (${deregistration.status}): ${await this.#readErrorBody(deregistration)}`,
    );
  }

  async #readErrorBody(response: Response): Promise<string> {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) return "(HTML error page)";
    const text = await response.text();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  }

  async downloadTcx(exerciseId: string): Promise<string> {
    const response = await this.#fetchFn(`${POLAR_API_BASE}/exercises/${exerciseId}/tcx`, {
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        Accept: "application/vnd.garmin.tcx+xml",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to download Polar TCX (${response.status})`);
    }

    return response.text();
  }
}

function hasInvalidTokenChallenge(response: Response): boolean {
  if (response.status !== 401) return false;
  const challenge = response.headers.get("www-authenticate")?.trim();
  if (!challenge || !/^Bearer(?:\s|$)/i.test(challenge)) return false;
  const parameters = challenge.slice("Bearer".length).trim();
  return /(?:^|,\s*)error\s*=\s*"invalid_token"(?:\s*,|$)/.test(parameters);
}

function formatPolarApiErrorBody(contentType: string, textBody: string): string {
  if (contentType.includes("text/html")) {
    return "(HTML error page)";
  }

  if (contentType.includes("application/json")) {
    return textBody.trim() === "" ? "(empty JSON error body)" : textBody;
  }

  return textBody.length > 200 ? `${textBody.slice(0, 200)}…` : textBody;
}

function assertPolarExerciseArray(value: unknown, path = "/exercises"): PolarExercise[] {
  if (!Array.isArray(value)) {
    throw new Error(`Polar API returned unexpected JSON shape for ${path}`);
  }
  return value satisfies PolarExercise[];
}

function assertPolarDailyActivityArray(
  value: unknown,
  path = "/users/activities",
): PolarDailyActivity[] {
  if (!Array.isArray(value)) {
    throw new Error(`Polar API returned unexpected JSON shape for ${path}`);
  }
  return value satisfies PolarDailyActivity[];
}

function assertPolarSleepResponse(value: unknown, path = "/users/sleep"): PolarSleepResponse {
  if (typeof value !== "object" || value === null || !("nights" in value)) {
    throw new Error(`Polar API returned unexpected JSON shape for ${path}`);
  }

  const nights = value.nights;
  if (!Array.isArray(nights)) {
    throw new Error(`Polar API returned unexpected JSON shape for ${path}`);
  }

  return { nights: nights satisfies PolarSleep[] };
}

function assertPolarNightlyRechargeResponse(
  value: unknown,
  path = "/users/nightly-recharge",
): PolarNightlyRechargeResponse {
  if (typeof value !== "object" || value === null || !("recharges" in value)) {
    throw new Error(`Polar API returned unexpected JSON shape for ${path}`);
  }

  const recharges = value.recharges;
  if (!Array.isArray(recharges)) {
    throw new Error(`Polar API returned unexpected JSON shape for ${path}`);
  }

  return { recharges: recharges satisfies PolarNightlyRecharge[] };
}
