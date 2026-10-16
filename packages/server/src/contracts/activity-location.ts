import { z } from "zod";
import { osmTilePreviewSchema } from "../lib/osm-tile.ts";
import { climbingMapLocationSchema } from "./climbing-log-contracts.ts";

const activitySourcePointSchema = z.object({
  x: z.number(),
  y: z.number(),
  location: climbingMapLocationSchema,
});

export const activityLocationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("recorded_gps"),
    centroidLat: z.number(),
    centroidLng: z.number(),
    mapPreview: osmTilePreviewSchema,
  }),
  z.object({
    kind: z.literal("climbing_source"),
    mapPreview: osmTilePreviewSchema.extend({ routePath: z.null() }),
    sourcePoints: z.array(activitySourcePointSchema).min(1),
  }),
]);

export type ActivityLocation = z.infer<typeof activityLocationSchema>;
