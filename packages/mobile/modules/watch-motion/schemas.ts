import { z } from "zod";

/** A barometric altitude sample transferred from the Apple Watch. */
export const WatchAltitudeSampleSchema = z.object({
  timestamp: z.string(),
  altitudeM: z.number(),
  pressureKPa: z.number().optional(),
});

export type WatchAltitudeSample = z.infer<typeof WatchAltitudeSampleSchema>;
