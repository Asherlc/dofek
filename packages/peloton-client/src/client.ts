import {
  createRateLimitAwareFetch,
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { z } from "zod";
import { PelotonAuthenticationError, PelotonResponseError, PelotonServiceError } from "./errors.ts";
import {
  type PelotonPerformanceGraph,
  type PelotonWorkoutListResponse,
  pelotonPerformanceGraphSchema,
  pelotonWorkoutListResponseSchema,
} from "./types.ts";

export const PELOTON_API_BASE = "https://api.onepeloton.com";

const pelotonUserSchema = z.object({ id: z.string().min(1) });

export class PelotonClient {
  #accessToken: string;
  #userId: string | null = null;
  #fetchFn: typeof globalThis.fetch;

  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.#accessToken = accessToken;
    this.#fetchFn = createRateLimitAwareFetch(fetchFn, { providerId: "peloton" });
  }

  async #get(path: string, params?: Record<string, string>): Promise<unknown> {
    const url = new URL(path, PELOTON_API_BASE);
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, value);
    }

    const response = await this.#fetchFn(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
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
    return response.json();
  }

  async getUserId(): Promise<string> {
    if (this.#userId) return this.#userId;
    try {
      const parsed = pelotonUserSchema.parse(await this.#get("/api/me"));
      this.#userId = parsed.id;
      return parsed.id;
    } catch (error: unknown) {
      if (
        error instanceof PelotonAuthenticationError ||
        error instanceof PelotonServiceError ||
        error instanceof ProviderRateLimitError ||
        error instanceof ProviderServiceUnavailableError
      ) {
        throw error;
      }
      throw new PelotonResponseError("current-user", error);
    }
  }

  async getWorkouts(page = 0, limit = 20): Promise<PelotonWorkoutListResponse> {
    const userId = await this.getUserId();
    try {
      return pelotonWorkoutListResponseSchema.parse(
        await this.#get(`/api/user/${userId}/workouts`, {
          page: String(page),
          limit: String(limit),
          sort_by: "-created_at",
          joins: "ride",
        }),
      );
    } catch (error: unknown) {
      if (
        error instanceof PelotonAuthenticationError ||
        error instanceof PelotonServiceError ||
        error instanceof ProviderRateLimitError ||
        error instanceof ProviderServiceUnavailableError
      ) {
        throw error;
      }
      throw new PelotonResponseError("workouts", error);
    }
  }

  async getPerformanceGraph(workoutId: string, everyN = 5): Promise<PelotonPerformanceGraph> {
    try {
      return pelotonPerformanceGraphSchema.parse(
        await this.#get(`/api/workout/${workoutId}/performance_graph`, {
          every_n: String(everyN),
        }),
      );
    } catch (error: unknown) {
      if (
        error instanceof PelotonAuthenticationError ||
        error instanceof PelotonServiceError ||
        error instanceof ProviderRateLimitError ||
        error instanceof ProviderServiceUnavailableError
      ) {
        throw error;
      }
      throw new PelotonResponseError("performance-graph", error);
    }
  }
}
