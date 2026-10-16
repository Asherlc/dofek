import { z } from "zod";
import type { ClimbingMapLocation } from "./climbing-map.ts";
import { gpsCoordinatesSchema } from "./gps-coordinates.ts";

export const climbingMapLocationSchema = z.strictObject({
  coordinates: gpsCoordinatesSchema,
  scope: z.enum(["climb", "area"]),
  objectId: z.string(),
  providerId: z.string(),
  name: z.string().nullable(),
}) satisfies z.ZodType<ClimbingMapLocation>;

export const climbingLocationMapEntrySchema = z.object({
  id: z.string(),
  activityId: z.string().nullable(),
  date: z.string(),
  label: z.string(),
  grade: z.string().nullable(),
  location: climbingMapLocationSchema,
});

export const climbingLocationMapNodeSchema = z.object({
  id: z.string(),
  coordinates: gpsCoordinatesSchema,
  count: z.number().int().positive(),
  radius: z.number().positive(),
  minZoom: z.number().int().min(0).max(19),
  maxZoom: z.number().int().min(0).max(19),
  expansionZoom: z.number().int().min(0).max(19).nullable(),
  entries: z.array(climbingLocationMapEntrySchema),
});

/** Server-computed clusters; clients select a zoom band and render its circles. */
export const climbingLocationMapSchema = z.object({
  bounds: z
    .object({ south: z.number(), west: z.number(), north: z.number(), east: z.number() })
    .nullable(),
  nodes: z.array(climbingLocationMapNodeSchema),
});

export type ClimbingLocationMapEntry = z.infer<typeof climbingLocationMapEntrySchema>;
export type ClimbingLocationMapNode = z.infer<typeof climbingLocationMapNodeSchema>;
export type ClimbingLocationMap = z.infer<typeof climbingLocationMapSchema>;
