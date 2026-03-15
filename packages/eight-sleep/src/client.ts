import type { EightSleepAuthResponse, EightSleepTrendsResponse } from "./types.ts";

const AUTH_API_BASE = "https://auth-api.8slp.net/v1";
const CLIENT_API_BASE = "https://client-api.8slp.net/v1";

// Hardcoded client credentials extracted from the Eight Sleep Android app
export const EIGHT_SLEEP_CLIENT_ID = "0894c7f33bb94800a03f1f4df13a4f38";
export const EIGHT_SLEEP_CLIENT_SECRET =
  "f0954a3ed5763ba3d06834c73731a32f15f168f47d4f164751275def86db0c76";

export class EightSleepClient {
  private accessToken: string;
  private userId: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(
    accessToken: string,
    userId: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.accessToken = accessToken;
    this.userId = userId;
    this.fetchFn = fetchFn;
  }

  private async get<T>(baseUrl: string, path: string): Promise<T> {
    const url = `${baseUrl}${path}`;
    const response = await this.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "okhttp/4.9.3",
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Eight Sleep API error (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async getTrends(
    timezone: string,
    fromDate: string,
    toDate: string,
  ): Promise<EightSleepTrendsResponse> {
    const params = new URLSearchParams({
      tz: timezone,
      from: fromDate,
      to: toDate,
      "include-main": "false",
      "include-all-sessions": "true",
      "model-version": "v2",
    });
    return this.get<EightSleepTrendsResponse>(
      CLIENT_API_BASE,
      `/users/${this.userId}/trends?${params}`,
    );
  }

  static async signIn(
    email: string,
    password: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<{ accessToken: string; expiresIn: number; userId: string }> {
    const response = await fetchFn(`${AUTH_API_BASE}/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: EIGHT_SLEEP_CLIENT_ID,
        client_secret: EIGHT_SLEEP_CLIENT_SECRET,
        grant_type: "password",
        username: email,
        password,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Eight Sleep sign-in failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as EightSleepAuthResponse;
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
      userId: data.userId,
    };
  }
}
