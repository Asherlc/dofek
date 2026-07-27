import { z } from "zod";

export const XertActivitySchema = z.object({
  id: z.number(),
  name: z.string(),
  sport: z.string(),
  startTimestamp: z.number(),
  endTimestamp: z.number(),
  duration: z.number(),
  distance: z.number(),
  power_avg: z.number(),
  power_max: z.number(),
  power_normalized: z.number(),
  heartrate_avg: z.number(),
  heartrate_max: z.number(),
  cadence_avg: z.number(),
  cadence_max: z.number(),
  elevation_gain: z.number(),
  elevation_loss: z.number(),
  xss: z.number(),
  focus: z.number(),
  difficulty: z.number(),
});

export const XertActivityListSchema = z.array(XertActivitySchema);

export type XertActivity = z.infer<typeof XertActivitySchema>;

export interface XertClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface XertTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string | null;
}

export interface XertActivityListOptions {
  /** Earliest activity start time, expressed as Unix seconds. */
  from: number;
  /** Zero-based page number. */
  page?: number;
  /** Number of activities requested per page. */
  limit?: number;
}
