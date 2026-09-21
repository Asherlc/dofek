import { ProviderHttpClient } from "../http-client.ts";
import {
  type OuraDailyActivity,
  type OuraDailySpO2,
  type OuraEnhancedTag,
  type OuraHeartRate,
  type OuraListResponse,
  type OuraRestModePeriod,
  type OuraSession,
  type OuraSleepDocument,
  type OuraTag,
  type OuraWorkout,
  ouraDailyActivitySchema,
  ouraDailySpO2Schema,
  ouraEnhancedTagSchema,
  ouraHeartRateSchema,
  ouraListResponseSchema,
  ouraRestModePeriodSchema,
  ouraSessionSchema,
  ouraSleepDocumentSchema,
  ouraTagSchema,
  ouraWorkoutSchema,
} from "./schemas.ts";

export const OURA_API_BASE = "https://api.ouraring.com";

export class OuraApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, detail: string) {
    super(`API error ${status} on ${path}: ${detail}`);
    this.name = "OuraApiError";
    this.status = status;
    this.path = path;
  }
}

export class OuraClient extends ProviderHttpClient {
  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    super(accessToken, OURA_API_BASE, fetchFn, "oura");
  }

  protected async handleErrorResponse(response: Response, path: string): Promise<never> {
    const text = await response.text();
    const truncated = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    throw new OuraApiError(response.status, path, truncated);
  }

  #dateQuery(startDate: string, endDate: string, nextToken?: string): string {
    let qs = `start_date=${startDate}&end_date=${endDate}`;
    if (nextToken) qs += `&next_token=${nextToken}`;
    return qs;
  }

  async getSleep(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraSleepDocument>> {
    return this.get(
      `/v2/usercollection/sleep?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraSleepDocumentSchema),
    );
  }

  async getDailyActivity(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyActivity>> {
    return this.get(
      `/v2/usercollection/daily_activity?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraDailyActivitySchema),
    );
  }

  async getDailySpO2(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailySpO2>> {
    return this.get(
      `/v2/usercollection/daily_spo2?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraDailySpO2Schema),
    );
  }

  async getWorkouts(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraWorkout>> {
    return this.get(
      `/v2/usercollection/workout?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraWorkoutSchema),
    );
  }

  async getHeartRate(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraHeartRate>> {
    let qs = `start_datetime=${startDate}T00:00:00&end_datetime=${endDate}T23:59:59`;
    if (nextToken) qs += `&next_token=${nextToken}`;
    return this.get(
      `/v2/usercollection/heartrate?${qs}`,
      ouraListResponseSchema(ouraHeartRateSchema),
    );
  }

  async getSessions(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraSession>> {
    return this.get(
      `/v2/usercollection/session?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraSessionSchema),
    );
  }

  async getTags(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraTag>> {
    return this.get(
      `/v2/usercollection/tag?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraTagSchema),
    );
  }

  async getEnhancedTags(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraEnhancedTag>> {
    return this.get(
      `/v2/usercollection/enhanced_tag?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraEnhancedTagSchema),
    );
  }

  async getRestModePeriods(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraRestModePeriod>> {
    return this.get(
      `/v2/usercollection/rest_mode_period?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraRestModePeriodSchema),
    );
  }
}
