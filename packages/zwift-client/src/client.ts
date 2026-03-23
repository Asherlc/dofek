import type {
  ZwiftActivityDetail,
  ZwiftActivitySummary,
  ZwiftFitnessData,
  ZwiftPowerCurve,
  ZwiftProfile,
  ZwiftTokenResponse,
} from "./types.ts";

const ZWIFT_AUTH_URL = "https://secure.zwift.com/auth/realms/zwift/protocol/openid-connect/token";
const ZWIFT_API_BASE = "https://us-or-rly101.zwift.com";

export { ZWIFT_AUTH_URL, ZWIFT_API_BASE };

export class ZwiftClient {
  #accessToken: string;
  #athleteId: number;
  #fetchFn: typeof globalThis.fetch;

  constructor(
    accessToken: string,
    athleteId: number,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.#accessToken = accessToken;
    this.#athleteId = athleteId;
    this.#fetchFn = fetchFn;
  }

  async #get<T>(path: string): Promise<T> {
    const url = `${ZWIFT_API_BASE}${path}`;
    const response = await this.#fetchFn(url, {
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Zwift API error (${response.status}): ${text}`);
    }

    return response.json();
  }

  async getProfile(): Promise<ZwiftProfile> {
    return this.#get<ZwiftProfile>(`/api/profiles/${this.#athleteId}`);
  }

  async getActivities(start = 0, limit = 20): Promise<ZwiftActivitySummary[]> {
    return this.#get<ZwiftActivitySummary[]>(
      `/api/profiles/${this.#athleteId}/activities?start=${start}&limit=${limit}`,
    );
  }

  async getActivityDetail(activityId: number): Promise<ZwiftActivityDetail> {
    return this.#get<ZwiftActivityDetail>(`/api/activities/${activityId}?fetchSnapshots=true`);
  }

  async getFitnessData(url: string): Promise<ZwiftFitnessData> {
    const response = await this.#fetchFn(url, {
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`Zwift fitness data fetch failed (${response.status})`);
    }
    const result: Promise<ZwiftFitnessData> = response.json();
    return result;
  }

  async getPowerCurve(): Promise<ZwiftPowerCurve> {
    return this.#get<ZwiftPowerCurve>("/api/power-curve/power-profile");
  }

  static async signIn(
    username: string,
    password: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const response = await fetchFn(ZWIFT_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "Zwift Game Client",
        grant_type: "password",
        username,
        password,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Zwift sign-in failed (${response.status}): ${text}`);
    }

    const data: ZwiftTokenResponse = await response.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }

  static async refreshToken(
    refreshToken: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const response = await fetchFn(ZWIFT_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "Zwift Game Client",
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Zwift token refresh failed (${response.status}): ${text}`);
    }

    const data: ZwiftTokenResponse = await response.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }
}
