import { z } from "zod";
import { mapPreviewSchema } from "../lib/map-preview.ts";
import { climbingMapLocationSchema } from "./climbing-log-contracts.ts";

const activitySourcePointSchema = z.object({
  x: z.number(),
  y: z.number(),
  location: climbingMapLocationSchema,
});

export const processingActivityLocationSchema = z.object({ kind: z.literal("processing") });
export const recordedGpsActivityLocationSchema = z.object({
  kind: z.literal("recorded_gps"),
  centroidLat: z.number(),
  centroidLng: z.number(),
  mapPreview: mapPreviewSchema,
});
export const climbingSourceActivityLocationSchema = z.object({
  kind: z.literal("climbing_source"),
  mapPreview: mapPreviewSchema.extend({ routePath: z.null() }),
  sourcePoints: z.array(activitySourcePointSchema).min(1),
});
export const activityLocationSchema = z.discriminatedUnion("kind", [
  processingActivityLocationSchema,
  recordedGpsActivityLocationSchema,
  climbingSourceActivityLocationSchema,
]);

export type ActivityLocation = z.infer<typeof activityLocationSchema>;
