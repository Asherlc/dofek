import { POLAR_API_BASE } from "./oauth.ts";
import type {
  PolarDailyActivity,
  PolarExercise,
  PolarNightlyRecharge,
  PolarSleep,
} from "./types.ts";

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
    this.#fetchFn = fetchFn;
  }

  async #get<TResponse>(path: string): Promise<TResponse> {
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

    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      let detailMessage: string;
      if (contentType.includes("application/json")) {
        detailMessage = JSON.stringify(await response.json());
      } else if (contentType.includes("text/html")) {
        detailMessage = "(HTML error page)";
      } else {
        const textBody = await response.text();
        detailMessage = textBody.length > 200 ? `${textBody.slice(0, 200)}…` : textBody;
      }
      throw new Error(`Polar API error (${response.status}): ${detailMessage}`);
    }

    return response.json();
  }

  async getExercises(): Promise<PolarExercise[]> {
    return this.#get<PolarExercise[]>("/exercises");
  }

  async getSleep(): Promise<PolarSleep[]> {
    return this.#get<PolarSleep[]>("/sleep");
  }

  async getDailyActivity(): Promise<PolarDailyActivity[]> {
    return this.#get<PolarDailyActivity[]>("/activity");
  }

  async getNightlyRecharge(): Promise<PolarNightlyRecharge[]> {
    return this.#get<PolarNightlyRecharge[]>("/nightly-recharge");
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
