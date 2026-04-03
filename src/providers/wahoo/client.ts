import type { z } from "zod";
import { ProviderHttpClient } from "../http-client.ts";
import {
  type WahooWorkoutListResponse,
  wahooSingleWorkoutResponseSchema,
  wahooWorkoutListResponseSchema,
} from "./schemas.ts";

export const WAHOO_API_BASE = "https://api.wahooligan.com";

export class WahooClient extends ProviderHttpClient {
  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    super(accessToken, WAHOO_API_BASE, fetchFn);
  }

  async getWorkouts(page = 1, perPage = 30): Promise<WahooWorkoutListResponse> {
    return this.get("/v1/workouts", wahooWorkoutListResponseSchema, {
      page: String(page),
      per_page: String(perPage),
    });
  }

  async getWorkout(id: number): Promise<z.infer<typeof wahooSingleWorkoutResponseSchema>> {
    return this.get(`/v1/workouts/${id}`, wahooSingleWorkoutResponseSchema);
  }

  async downloadFitFile(url: string): Promise<Buffer> {
    // FIT file URLs are pre-signed CDN/S3 URLs — do not send auth headers,
    // as it causes 403 errors and leaks the OAuth token to a third party.
    const response = await this.fetchFn(url);
    if (!response.ok) {
      throw new Error(`Failed to download FIT file (${response.status})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
