import type { VeloHeroSsoResponse, VeloHeroWorkout, VeloHeroWorkoutsResponse } from "./types.ts";

const VELOHERO_BASE_URL = "https://app.velohero.com";

export class VeloHeroClient {
  private sessionCookie: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(sessionCookie: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.sessionCookie = sessionCookie;
    this.fetchFn = fetchFn;
  }

  private async get<T>(path: string, params?: URLSearchParams): Promise<T> {
    const url = params ? `${VELOHERO_BASE_URL}${path}?${params}` : `${VELOHERO_BASE_URL}${path}`;
    const response = await this.fetchFn(url, {
      headers: {
        Cookie: this.sessionCookie,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`VeloHero API error (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async getWorkouts(dateFrom: string, dateTo: string): Promise<VeloHeroWorkout[]> {
    const params = new URLSearchParams({
      date_from: dateFrom,
      date_to: dateTo,
    });
    const data = await this.get<VeloHeroWorkoutsResponse>("/export/workouts/json", params);
    return data.workouts ?? [];
  }

  async getWorkout(id: string): Promise<VeloHeroWorkout> {
    return this.get<VeloHeroWorkout>(`/export/workouts/json/${id}`);
  }

  static async signIn(
    username: string,
    password: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<{ sessionCookie: string; userId: string }> {
    const body = new URLSearchParams({
      user: username,
      pass: password,
      view: "json",
    });

    const response = await fetchFn(`${VELOHERO_BASE_URL}/sso`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      redirect: "manual",
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`VeloHero sign-in failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as VeloHeroSsoResponse;
    if (!data.session) {
      throw new Error("VeloHero sign-in did not return a session token");
    }

    // The session token is used as a cookie value
    const sessionCookie = `VeloHero_session=${data.session}`;

    return {
      sessionCookie,
      userId: data["user-id"],
    };
  }
}
