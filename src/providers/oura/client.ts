import { ProviderHttpClient } from "../http-client.ts";
import {
  type OuraDailyActivity,
  type OuraDailyCardiovascularAge,
  type OuraDailyReadiness,
  type OuraDailyResilience,
  type OuraDailySpO2,
  type OuraDailyStress,
  type OuraEnhancedTag,
  type OuraHeartRate,
  type OuraListResponse,
  type OuraRestModePeriod,
  type OuraSession,
  type OuraSleepDocument,
  type OuraSleepTime,
  type OuraTag,
  type OuraVO2Max,
  type OuraWorkout,
  ouraDailyActivitySchema,
  ouraDailyCardiovascularAgeSchema,
  ouraDailyReadinessSchema,
  ouraDailyResilienceSchema,
  ouraDailySpO2Schema,
  ouraDailyStressSchema,
  ouraEnhancedTagSchema,
  ouraHeartRateSchema,
  ouraListResponseSchema,
  ouraRestModePeriodSchema,
  ouraSessionSchema,
  ouraSleepDocumentSchema,
  ouraSleepTimeSchema,
  ouraTagSchema,
  ouraVO2MaxSchema,
  ouraWorkoutSchema,
} from "./schemas.ts";

export const OURA_API_BASE = "https://api.ouraring.com";

export class OuraClient extends ProviderHttpClient {
  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    super(accessToken, OURA_API_BASE, fetchFn);
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

  async getDailyReadiness(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyReadiness>> {
    return this.get(
      `/v2/usercollection/daily_readiness?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraDailyReadinessSchema),
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

  async getVO2Max(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraVO2Max>> {
    return this.get(
      `/v2/usercollection/vO2_max?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraVO2MaxSchema),
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

  async getDailyStress(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyStress>> {
    return this.get(
      `/v2/usercollection/daily_stress?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraDailyStressSchema),
    );
  }

  async getDailyResilience(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyResilience>> {
    return this.get(
      `/v2/usercollection/daily_resilience?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraDailyResilienceSchema),
    );
  }

  async getDailyCardiovascularAge(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraDailyCardiovascularAge>> {
    return this.get(
      `/v2/usercollection/daily_cardiovascular_age?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraDailyCardiovascularAgeSchema),
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

  async getSleepTime(
    startDate: string,
    endDate: string,
    nextToken?: string,
  ): Promise<OuraListResponse<OuraSleepTime>> {
    return this.get(
      `/v2/usercollection/sleep_time?${this.#dateQuery(startDate, endDate, nextToken)}`,
      ouraListResponseSchema(ouraSleepTimeSchema),
    );
  }
}
