import { createRateLimitAwareFetch } from "@dofek/provider-http/rate-limit";
import { z } from "zod";
import { PelotonAuthenticationError, PelotonResponseError, PelotonServiceError } from "./errors.ts";
import {
  type PelotonPerformanceGraph,
  type PelotonWorkout,
  type PelotonWorkoutListResponse,
  pelotonPerformanceGraphSchema,
  pelotonWorkoutListResponseSchema,
  pelotonWorkoutSchema,
} from "./types.ts";

export const PELOTON_API_BASE = "https://api.onepeloton.com";

const pelotonUserSchema = z.object({ id: z.string().min(1) });

export class PelotonClient {
  #userId: string | null = null;
  #fetchFn: typeof globalThis.fetch;

  constructor(
    accessToken: string | (() => Promise<string>),
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {
    const getAccessToken = typeof accessToken === "string" ? async () => accessToken : accessToken;
    this.#fetchFn = createRateLimitAwareFetch(fetchFn, {
      providerId: "peloton",
      async prepareRequest(input, init) {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        headers.set("Authorization", `Bearer ${await getAccessToken()}`);
        return { ...init, headers };
      },
    });
  }

  async #get(path: string, params?: Record<string, string>): Promise<Response> {
    const url = new URL(path, PELOTON_API_BASE);
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, value);
    }

    const response = await this.#fetchFn(url.toString(), {
      headers: {
        "peloton-platform": "web",
      },
    });
    if (!response.ok) {
      const responseBody = await response.text();
      if (response.status === 401) {
        throw new PelotonAuthenticationError(response.status, responseBody);
      }
      throw new PelotonServiceError(response.status, responseBody);
    }
    return response;
  }

  async getUserId(): Promise<string> {
    if (this.#userId) return this.#userId;
    const response = await this.#get("/api/me");
    try {
      const parsed = pelotonUserSchema.parse(await response.json());
      this.#userId = parsed.id;
      return parsed.id;
    } catch (error: unknown) {
      throw new PelotonResponseError("current-user", error);
    }
  }

  async getWorkouts(page = 0, limit = 20): Promise<PelotonWorkoutListResponse> {
    const userId = await this.getUserId();
    const response = await this.#get(`/api/user/${userId}/workouts`, {
      page: String(page),
      limit: String(limit),
      sort_by: "-created_at",
      joins: "ride",
    });
    try {
      return pelotonWorkoutListResponseSchema.parse(await response.json());
    } catch (error: unknown) {
      throw new PelotonResponseError("workouts", error);
    }
  }

  async getWorkout(workoutId: string): Promise<PelotonWorkout> {
    const response = await this.#get(`/api/workout/${encodeURIComponent(workoutId)}`, {
      joins: "ride",
    });
    return pelotonWorkoutSchema.parse(await response.json());
  }

  async getPerformanceGraph(workoutId: string, everyN = 5): Promise<PelotonPerformanceGraph> {
    const response = await this.#get(`/api/workout/${workoutId}/performance_graph`, {
      every_n: String(everyN),
    });
    try {
      return pelotonPerformanceGraphSchema.parse(await response.json());
    } catch (error: unknown) {
      throw new PelotonResponseError("performance-graph", error);
    }
  }
}
