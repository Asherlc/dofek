import { z } from "zod";
import { areaSchema, climbingLogEntrySchema, climbSchema } from "./climbing-log.ts";

const recordedTextSchema = z.string().trim().min(1);
export const climbingContextSchema = climbingLogEntrySchema
  .pick({
    board: true,
    wallAngle: true,
    holdTypes: true,
  })
  .extend({
    providerId: recordedTextSchema,
    climb: climbSchema.nullable(),
    areaPath: z.array(areaSchema),
  });

export type { ClimbingBoard, ClimbingWallAngle } from "./climbing-experience.ts";
export type ClimbingContext = z.infer<typeof climbingContextSchema>;

export const climbingSourceLinkSchema = z.strictObject({
  providerId: recordedTextSchema,
  kind: z.enum(["route", "ticks"]),
  url: z.url().startsWith("https://"),
});
export type ClimbingSourceLink = z.infer<typeof climbingSourceLinkSchema>;
