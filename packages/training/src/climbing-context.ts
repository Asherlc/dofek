import { z } from "zod";

const recordedTextSchema = z.string().trim().min(1);
const locationNodeSchema = z.strictObject({
  name: recordedTextSchema,
  externalId: recordedTextSchema.nullable(),
  kind: z.enum(["destination", "area", "subarea", "gym"]).nullable(),
});
const boardSchema = z.strictObject({
  name: recordedTextSchema,
  externalId: recordedTextSchema.nullable(),
});
const wallAngleSchema = z
  .strictObject({
    value: z.number().finite(),
    unit: z.literal("degrees").nullable(),
  })
  .refine((angle) => angle.unit === null || (angle.value >= -90 && angle.value <= 90), {
    message: "A recorded degree angle must be between -90 and 90.",
  });
const climbStyleSchema = z.enum(["lead", "top-rope", "follow", "solo", "aid"]);

export const climbingMetadataSchema = z.strictObject({
  locationPath: z.array(locationNodeSchema),
  board: boardSchema.nullable(),
  wallAngle: wallAngleSchema.nullable(),
  climbStyle: climbStyleSchema.nullable(),
  resultStyle: recordedTextSchema.nullable(),
});

export const climbingContextSchema = climbingMetadataSchema.extend({
  providerId: recordedTextSchema,
});

export type ClimbingLocationNode = z.infer<typeof locationNodeSchema>;
export type ClimbingBoard = z.infer<typeof boardSchema>;
export type ClimbingWallAngle = z.infer<typeof wallAngleSchema>;
export type ClimbingStyle = z.infer<typeof climbStyleSchema>;
export type ClimbingMetadata = z.infer<typeof climbingMetadataSchema>;
export type ClimbingContext = z.infer<typeof climbingContextSchema>;
