import { z } from "zod";
import { climbingBoardSchema, climbingWallAngleSchema } from "./climbing-experience.ts";
import { climbingMethodSchema } from "./climbing-log.ts";

const recordedTextSchema = z.string().trim().min(1);
const locationNodeSchema = z.strictObject({
  name: recordedTextSchema,
  externalId: recordedTextSchema.nullable(),
  kind: z.enum(["destination", "area", "subarea", "gym"]).nullable(),
});

export const climbingMetadataSchema = z.strictObject({
  locationPath: z.array(locationNodeSchema),
  board: climbingBoardSchema.nullable(),
  wallAngle: climbingWallAngleSchema.nullable(),
  climbStyle: climbingMethodSchema.nullable(),
  resultStyle: recordedTextSchema.nullable(),
});

export const climbingContextSchema = climbingMetadataSchema.extend({
  providerId: recordedTextSchema,
});

export type ClimbingLocationNode = z.infer<typeof locationNodeSchema>;
export type { ClimbingBoard, ClimbingWallAngle } from "./climbing-experience.ts";
export type ClimbingStyle = z.infer<typeof climbingMethodSchema>;
export type ClimbingMetadata = z.infer<typeof climbingMetadataSchema>;
export type ClimbingContext = z.infer<typeof climbingContextSchema>;

export const climbingSourceLinkSchema = z.strictObject({
  providerId: recordedTextSchema,
  kind: z.enum(["route", "ticks"]),
  url: z.url().startsWith("https://"),
});
export type ClimbingSourceLink = z.infer<typeof climbingSourceLinkSchema>;
