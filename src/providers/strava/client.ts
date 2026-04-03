import type {
  StravaActivity,
  StravaDetailedActivity,
  StravaStream,
  StravaStreamSet,
} from "./types.ts";
import { isStreamKey } from "./types.ts";

const STRAVA_API_BASE = "https://www.strava.com/api/v3/";

/** Minimum delay between consecutive Strava API requests (ms).
 *  Strava allows 100 requests per 15 minutes = 9s/request average.
 *  10s provides a safety margin. */
export const STRAVA_THROTTLE_MS = 10_000;

export class StravaClient {
  #accessToken: string;
  #fetchFn: typeof globalThis.fetch;
  #lastRequestTime = 0;
  #throttleMs: number;

  constructor(
    accessToken: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
    throttleMs = STRAVA_THROTTLE_MS,
  ) {
    this.#accessToken = accessToken;
    this.#fetchFn = fetchFn;
    this.#throttleMs = throttleMs;
  }

  async #throttle(): Promise<void> {
    if (this.#throttleMs <= 0) return;
    const now = Date.now();
    const elapsed = now - this.#lastRequestTime;
    if (this.#lastRequestTime > 0 && elapsed < this.#throttleMs) {
      await new Promise((resolve) => setTimeout(resolve, this.#throttleMs - elapsed));
    }
    this.#lastRequestTime = Date.now();
  }

  async #get<T>(path: string, params?: Record<string, string>): Promise<T> {
    await this.#throttle();
    const url = new URL(path, STRAVA_API_BASE);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await this.#fetchFn(url.toString(), {
      headers: { Authorization: `Bearer ${this.#accessToken}` },
    });

    if (response.status === 429) {
      throw new StravaRateLimitError(`Strava API rate limit exceeded (429)`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new StravaUnauthorizedError(
        `Strava API unauthorized (${response.status}): ${url.pathname}`,
      );
    }

    if (response.status === 404) {
      throw new StravaNotFoundError(`Strava API 404: ${url.pathname}`);
    }

    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      let detail: string;
      if (contentType.includes("application/json")) {
        const json = await response.json();
        detail = JSON.stringify(json);
      } else if (contentType.includes("text/html")) {
        detail = "(HTML error page)";
      } else {
        const text = await response.text();
        detail = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      }
      throw new Error(`Strava API error (${response.status}): ${detail}`);
    }

    return response.json();
  }

  async getActivity(activityId: number): Promise<StravaDetailedActivity> {
    return this.#get<StravaDetailedActivity>(`activities/${activityId}`);
  }

  async getActivities(after: number, page = 1, perPage = 30): Promise<StravaActivity[]> {
    return this.#get<StravaActivity[]>("athlete/activities", {
      after: String(after),
      page: String(page),
      per_page: String(perPage),
    });
  }

  async getActivityStreams(activityId: number): Promise<StravaStreamSet> {
    const streamTypes = [
      "time",
      "heartrate",
      "watts",
      "cadence",
      "velocity_smooth",
      "latlng",
      "altitude",
      "distance",
      "temp",
      "grade_smooth",
    ];

    const response = await this.#get<Array<{ type: string } & StravaStream>>(
      `activities/${activityId}/streams`,
      { keys: streamTypes.join(","), key_type: "time" },
    );

    // Strava returns an array of stream objects; convert to a keyed object
    const streams: StravaStreamSet = {};
    for (const stream of response) {
      const streamKey = stream.type;
      if (!isStreamKey(streamKey)) continue;
      streams[streamKey] = {
        data: stream.data,
        series_type: stream.series_type,
        resolution: stream.resolution,
        original_size: stream.original_size,
      };
    }
    return streams;
  }
}

export class StravaRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StravaRateLimitError";
  }
}

export class StravaUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StravaUnauthorizedError";
  }
}

export class StravaNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StravaNotFoundError";
  }
}
